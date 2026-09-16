import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { failingUpdateSet } from "../router/testing.ts";
import { withWriteLock } from "../db/write-lock.ts";
import { decks, drafts, notes, user } from "../db/schema.ts";
import type { Draft } from "../db/schema.ts";
import {
  abortJob,
  claimJobForNote,
  hasJob,
  reconcileDraft,
  reconcileOrphanedDrafts,
  startGenerationJob,
  startImageJob,
  subscribe,
  subscriberCount,
  yieldToMacrotask,
} from "./jobs.ts";
import type { DraftEvent, JobDeps } from "./jobs.ts";
import type { ModelCalls } from "./generate-note.ts";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => void;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values({
    id: "u1",
    name: "Ada",
    email: "ada@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterEach(() => close());

const CLASSIFICATION = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};
const CARD = {
  aspect: "meaning",
  front: "die Banane",
  back: "banana",
  imageCue: false,
};

/** A ModelCalls that emits a whole generation from canned deltas. */
function fakeModelCalls(deltas: string[]): ModelCalls {
  return {
    classify: async () => CLASSIFICATION,
    // eslint-disable-next-line require-yield
    async *generate() {
      for (const delta of deltas) yield delta;
      return {
        imagePrompt: "a ripe banana",
        generationSummary: "Practise the meaning of Banane.",
        cards: [CARD],
      };
    },
  };
}

const DELTAS = [
  `{"imagePrompt":"a ripe banana","generationSummary":"Practise the meaning of Banane."`,
  `,"cards":[`,
  `{"aspect":"meaning","front":"die Banane","back":"banana"}]}`,
];

/** Deps whose image half never fires: these tests are about the cards stage. */
function deps(overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    db,
    modelCalls: fakeModelCalls(DELTAS),
    generateImageBytes: vi.fn(async () => new Uint8Array([1])),
    writeDraftImage: vi.fn(async () => "img-1"),
    claimDraftImage: vi.fn(async () => "u1/n1.png"),
    removeImage: vi.fn(async () => {}),
    removeDraftImage: vi.fn(async () => {}),
    ...overrides,
  };
}

async function seedDraft(): Promise<Draft> {
  const [deck] = await db
    .insert(decks)
    .values({ userId: "u1", name: "German" })
    .returning();
  const [draft] = await db
    .insert(drafts)
    .values({
      userId: "u1",
      deckId: deck.id,
      sourceText: "die Banane",
      status: "generating",
    })
    .returning();
  return draft;
}

async function drain(source: AsyncIterable<DraftEvent>): Promise<DraftEvent[]> {
  const out: DraftEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

/** A gate a test can hold open and release on demand, for pausing a fake
 *  model call at a precise point instead of racing real timers. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function readDraft(id: string): Promise<Draft> {
  const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
  return row;
}

/** A real note row, so `claimJobForNote`'s destination actually exists to be
 *  matched by an `UPDATE ... WHERE id = ...` or read back afterward. */
async function seedNote(userId: string): Promise<string> {
  const [deck] = await db
    .insert(decks)
    .values({ userId, name: "German" })
    .returning();
  const [note] = await db
    .insert(notes)
    .values({
      userId,
      deckId: deck.id,
      sourceText: "die Banane",
      domain: "language",
    })
    .returning();
  return note.id;
}

describe("startGenerationJob", () => {
  it("runs to completion and persists the result", async () => {
    const draft = await seedDraft();
    await startGenerationJob(deps(), draft, "en");

    const row = await readDraft(draft.id);
    expect(row.status).toBe("ready");
    expect(row.classification).toEqual(CLASSIFICATION);
    expect(row.cards).toEqual([CARD]);
    expect(row.imagePrompt).toBe("a ripe banana");
    // The image stage is real now, not a stub: `startGenerationJob`'s promise
    // only resolves once the finally's drain loop has awaited every image
    // stage, so by this point the picture has already settled too.
    expect(row.imageStatus).toBe("ready");
    expect(row.draftImageId).toBe("img-1");
    expect(hasJob(draft.id)).toBe(false);
  });

  it("gives every subscriber the exact same event sequence, starting with a snapshot", async () => {
    const draft = await seedDraft();
    // The picture is now a concurrent stage that can settle before or after
    // "done" depending on real timing, which would make an exact expected
    // sequence a coin flip. Gating it explicitly until "done" has already
    // landed pins the image event to a deterministic trailing position
    // instead of racing it.
    const imageGate = deferred();
    const run = startGenerationJob(
      deps({
        generateImageBytes: vi.fn(async () => {
          await imageGate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    const a = subscribe(draft.id);
    const b = subscribe(draft.id);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.status).toBe("ready");
    });
    imageGate.release();

    const [seenA, seenB] = await Promise.all([drain(a!), drain(b!), run]);

    // The literal sequence, not just "A and B agree with each other" — two
    // subscribers that both silently dropped every mid-stream event would
    // satisfy a symmetric comparison just as well as two that saw everything.
    const expectedTypes = [
      "snapshot",
      "classified",
      "image-prompt",
      "cards",
      "done",
      "image",
    ];
    expect(seenA.map((e) => e.type)).toEqual(expectedTypes);
    expect(seenB.map((e) => e.type)).toEqual(expectedTypes);
  });

  it("delivers an event published before a subscriber's first read", async () => {
    const draft = await seedDraft();
    const classifyGate = deferred();
    // The picture is gated too, so it cannot arrive before "done" is read
    // below — otherwise its real, concurrent completion would race "done"
    // for last place in the channel and make this assertion a coin flip.
    const imageGate = deferred();
    const gatedModelCalls: ModelCalls = {
      classify: async () => {
        await classifyGate.promise;
        return CLASSIFICATION;
      },
      generate: fakeModelCalls(DELTAS).generate,
    };

    const run = startGenerationJob(
      deps({
        modelCalls: gatedModelCalls,
        generateImageBytes: vi.fn(async () => {
          await imageGate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    // subscribe() registers its channel and reads its snapshot synchronously,
    // in the same block, before returning — well before classify (still
    // gated) can produce anything. Nothing has raced this call.
    const sub = subscribe(draft.id);
    expect(sub).not.toBeNull();

    classifyGate.release();

    // `patch` calls `publish` synchronously right after its own write
    // resolves, with no further await between them — so once this write is
    // observably true, "classified" has already been pushed into every
    // subscriber's channel, `sub`'s included, regardless of whether `sub`
    // has ever been read from.
    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.classification).not.toBeNull();
    });

    // Only now — well after "classified" was published — do we take `sub`'s
    // first read. A `subscribe` that registered its channel lazily (e.g.
    // inside the generator body, on first `next()`, instead of synchronously
    // before returning it) would have missed the event entirely here.
    const first = await sub!.next();
    expect(first.value).toEqual({ type: "snapshot", draft });
    const second = await sub!.next();
    expect(second.value).toEqual({
      type: "classified",
      classification: CLASSIFICATION,
    });

    // Read forward until "done" lands. The picture is still gated shut, so
    // it genuinely cannot have arrived yet — this is deterministic, not a
    // race won by chance.
    const rest: DraftEvent[] = [];
    let event = await sub!.next();
    while (!event.done && event.value.type !== "done") {
      rest.push(event.value);
      event = await sub!.next();
    }
    if (!event.done) rest.push(event.value);
    // The full ordered list, not just "the last one is done" — that check is
    // trivially true of the loop that produced `rest` regardless of what an
    // implementation actually published.
    expect(rest.map((e) => e.type)).toEqual(["image-prompt", "cards", "done"]);

    // Now let the picture land and drain the rest so the job finishes and
    // cleans itself up. Asserted on its own, so an implementation that never
    // publishes "image" cannot pass this unchanged.
    imageGate.release();
    const trailing: DraftEvent[] = [];
    for await (const e of sub!) trailing.push(e);
    expect(trailing.map((e) => e.type)).toEqual(["image"]);
    await run;
  });

  it("starts the image stage from the done safety net when no mid-stream event carried the prompt", async () => {
    const draft = await seedDraft();
    const noMidStreamKey: ModelCalls = {
      classify: async () => CLASSIFICATION,
      async *generate() {
        // Never surfaces a "cards" key while streaming, so generateNote
        // never emits "image-prompt" or "cards" — the model's own retry-free
        // final object is the only place the prompt ever appears.
        yield "{}";
        return { imagePrompt: "a ripe banana", generationSummary: "Practise the meaning of Banane.", cards: [CARD] };
      },
    };

    await startGenerationJob(
      deps({
        modelCalls: noMidStreamKey,
        writeDraftImage: vi.fn(async () => "img-3"),
      }),
      draft,
      "en",
    );

    const row = await readDraft(draft.id);
    expect(row.status).toBe("ready");
    expect(row.imagePrompt).toBe("a ripe banana");
    // Real stage now, not a stub: by the time the job's promise resolves the
    // picture has settled too.
    expect(row.imageStatus).toBe("ready");
    expect(row.draftImageId).toBe("img-3");
  });

  it("returns null from subscribe when no job is running", async () => {
    const draft = await seedDraft();
    expect(subscribe(draft.id)).toBeNull();
  });

  it("unregisters a subscription that is abandoned mid-job", async () => {
    // A closed tab. Its channel would otherwise stay in the job's subscriber
    // set for the rest of the run, accumulating every event nobody will ever
    // read — and one more per reconnect, since a user can rejoin as often as
    // they like.
    const draft = await seedDraft();
    const imageGate = deferred();
    const run = startGenerationJob(
      deps({
        generateImageBytes: vi.fn(async () => {
          await imageGate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    const staying = subscribe(draft.id);
    const leaving = subscribe(draft.id);
    expect(subscriberCount(draft.id)).toBe(2);

    // Started first, then returned: a generator that was never read has no
    // suspended `finally` to run, so this has to be a subscription that had
    // genuinely begun.
    await leaving!.next();
    await leaving!.return(undefined);
    expect(subscriberCount(draft.id)).toBe(1);

    imageGate.release();
    const [seen] = await Promise.all([drain(staying!), run]);
    // The survivor was unaffected by its neighbour leaving.
    expect(seen.map((e) => e.type)).toContain("done");
  });

  it("records a failure on the row and reports it to subscribers", async () => {
    const draft = await seedDraft();
    const failing: ModelCalls = {
      classify: async () => {
        throw new Error("provider exploded");
      },
      async *generate() {
        return {};
      },
    };
    const run = startGenerationJob(deps({ modelCalls: failing }), draft, "en");
    const seen = subscribe(draft.id);
    const [events] = await Promise.all([drain(seen!), run]);

    expect(events.at(-1)).toEqual({
      type: "failed",
      message: "Generation failed",
    });

    const row = await readDraft(draft.id);
    expect(row.status).toBe("failed");
    // The provider's own words never reach the row, and so never reach a screen.
    expect(row.error).toBe("Generation failed");
  });

  it("stops writing once the job is aborted before anything started", async () => {
    const draft = await seedDraft();
    const run = startGenerationJob(deps(), draft, "en");
    abortJob(draft.id);
    await run;

    const row = await readDraft(draft.id);
    expect(row.status).toBe("generating");
    expect(row.classification).toBeNull();
  });

  it("stops writing once the job is aborted mid-stream, keeping what already landed", async () => {
    const draft = await seedDraft();
    const generateGate = deferred();
    const gatedModelCalls: ModelCalls = {
      classify: async () => CLASSIFICATION,
      async *generate() {
        // classify has already landed by the time this runs; pausing here
        // gives the test a window after "classified" but before anything
        // else.
        await generateGate.promise;
        for (const delta of DELTAS) yield delta;
        return { imagePrompt: "a ripe banana", generationSummary: "Practise the meaning of Banane.", cards: [CARD] };
      },
    };

    const run = startGenerationJob(
      deps({ modelCalls: gatedModelCalls }),
      draft,
      "en",
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.classification).not.toBeNull();
    });

    abortJob(draft.id);
    generateGate.release();
    await run;

    const row = await readDraft(draft.id);
    // The abort landed on the very next event, before it was processed: the
    // classification that already made it to the row stays, but generation
    // never reached "ready" and the image stage never started.
    expect(row.status).toBe("generating");
    expect(row.classification).toEqual(CLASSIFICATION);
    expect(row.cards).toEqual([]);
    expect(row.imageStatus).toBe("none");
    expect(hasJob(draft.id)).toBe(false);
  });
});

describe("reconcileOrphanedDrafts", () => {
  it("fails a row that was still generating when the process died", async () => {
    const draft = await seedDraft();

    expect(await reconcileOrphanedDrafts(db)).toBe(1);

    const row = await readDraft(draft.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("The server restarted while this was generating.");
  });

  it("leaves a ready draft ready when only its image was in flight", async () => {
    const draft = await seedDraft();
    await db
      .update(drafts)
      .set({ status: "ready", imageStatus: "generating" })
      .where(eq(drafts.id, draft.id));

    await reconcileOrphanedDrafts(db);

    const row = await readDraft(draft.id);
    expect(row.status).toBe("ready");
    expect(row.imageStatus).toBe("failed");
    expect(row.error).toBeNull();
  });
});

describe("reconcileDraft", () => {
  it("fails a generating row and persists it", async () => {
    const draft = await seedDraft();

    const reconciled = await reconcileDraft(db, draft);
    expect(reconciled.status).toBe("failed");
    expect(reconciled.error).toBe(
      "The server restarted while this was generating.",
    );

    const row = await readDraft(draft.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("The server restarted while this was generating.");
  });

  it("fails only the image status when the cards had already finished", async () => {
    const draft = await seedDraft();
    const [inFlight] = await db
      .update(drafts)
      .set({ status: "ready", imageStatus: "generating" })
      .where(eq(drafts.id, draft.id))
      .returning();

    const reconciled = await reconcileDraft(db, inFlight);
    expect(reconciled.status).toBe("ready");
    expect(reconciled.imageStatus).toBe("failed");
    expect(reconciled.error).toBeNull();

    const row = await readDraft(draft.id);
    expect(row.status).toBe("ready");
    expect(row.imageStatus).toBe("failed");
  });

  it("re-reads the row, so a draft that settled mid-read is not reported failed", async () => {
    // `drafts.watch` reads the row, asks `subscribe`, and only then calls
    // this. A job that commits `done` and deletes itself while that SELECT is
    // in flight leaves the caller holding a row that says "generating" against
    // a database that says "ready" — and the database is the truth. Writing
    // the caller's copy back would tell the user a successful generation had
    // been killed by a server restart.
    const draft = await seedDraft();
    const stale = await readDraft(draft.id);
    await db
      .update(drafts)
      .set({ status: "ready", imageStatus: "ready", cards: [CARD] })
      .where(eq(drafts.id, draft.id));

    const reconciled = await reconcileDraft(db, stale);
    expect(reconciled.status).toBe("ready");
    expect(reconciled.imageStatus).toBe("ready");
    expect(reconciled.error).toBeNull();
    expect(reconciled.cards).toEqual([CARD]);

    const row = await readDraft(draft.id);
    expect(row.status).toBe("ready");
    expect(row.error).toBeNull();
  });

  it("hands back an actionable draft when the row vanished mid-read", async () => {
    // `drafts.watch` reads the row without the lock, asks `subscribe`, and only
    // then arrives here — so a `notes.save` or a `discard` can delete it in
    // between. Returning the caller's copy would return one that still says
    // `generating`: `watch` yields it, the stream ends cleanly, `runDraftWatch`
    // reads a clean end as "settled, nothing to reconnect to", and `/add`'s
    // effect deps never change. The page sits on the skeleton until a reload.
    const draft = await seedDraft();
    const [inFlight] = await db
      .update(drafts)
      .set({ imagePrompt: "a ripe banana", imageStatus: "generating" })
      .where(eq(drafts.id, draft.id))
      .returning();
    await db.delete(drafts).where(eq(drafts.id, draft.id));

    const reconciled = await reconcileDraft(db, inFlight);

    expect(reconciled.status).toBe("failed");
    expect(reconciled.error).toBe(
      "The server restarted while this was generating.",
    );
    expect(reconciled.imageStatus).toBe("failed");
  });

  it("leaves a vanished row's settled image alone", async () => {
    // Only what was still moving is failed. A picture that had already landed
    // before the row was saved away is not a failure to report.
    const draft = await seedDraft();
    const [inFlight] = await db
      .update(drafts)
      .set({ imageStatus: "ready", draftImageId: "img-1" })
      .where(eq(drafts.id, draft.id))
      .returning();
    await db.delete(drafts).where(eq(drafts.id, draft.id));

    const reconciled = await reconcileDraft(db, inFlight);

    expect(reconciled.status).toBe("failed");
    expect(reconciled.imageStatus).toBe("ready");
    expect(reconciled.draftImageId).toBe("img-1");
  });

  it("leaves an already-settled row untouched", async () => {
    const draft = await seedDraft();
    const [ready] = await db
      .update(drafts)
      .set({ status: "ready", imageStatus: "ready" })
      .where(eq(drafts.id, draft.id))
      .returning();

    const reconciled = await reconcileDraft(db, ready);
    expect(reconciled).toEqual(ready);
  });
});

describe("the image stage", () => {
  it("stores the picture on the draft when the draft is still there", async () => {
    const draft = await seedDraft();
    await startGenerationJob(
      deps({ writeDraftImage: vi.fn(async () => "img-1") }),
      draft,
      "en",
    );

    const row = await readDraft(draft.id);
    expect(row.imageStatus).toBe("ready");
    expect(row.draftImageId).toBe("img-1");
  });

  it("records a failed picture without touching the cards", async () => {
    const draft = await seedDraft();
    await startGenerationJob(
      deps({
        generateImageBytes: vi.fn(async () => {
          throw new Error("image provider exploded");
        }),
      }),
      draft,
      "en",
    );

    const row = await readDraft(draft.id);
    expect(row.status).toBe("ready");
    expect(row.cards).toEqual([CARD]);
    expect(row.imageStatus).toBe("failed");
  });

  it("falls back to a failed picture when the row rejects the write", async () => {
    // The catch inside the settle's "row exists" branch is the only thing
    // standing between a failed UPDATE and a row wedged at
    // `imageStatus: "generating"` forever, with no `image` event and a
    // watcher spinning until it gives up. `failingUpdateOn` cannot reach it —
    // it fails the FIRST update on a table and `patch` always writes first —
    // so the write is named by what it says instead.
    const draft = await seedDraft();
    const writeDraftImage = vi.fn(async () => "img-5");

    const run = startGenerationJob(
      deps({
        db: failingUpdateSet(
          db,
          drafts,
          (values) => values.imageStatus === "ready",
        ),
        writeDraftImage,
      }),
      draft,
      "en",
    );
    const seen = subscribe(draft.id);
    const [events] = await Promise.all([drain(seen!), run]);

    // The bytes really were generated and filed before the row refused them,
    // which is what makes this the branch under test and not an earlier one.
    expect(writeDraftImage).toHaveBeenCalledTimes(1);

    const row = await readDraft(draft.id);
    expect(row.status).toBe("ready");
    expect(row.cards).toEqual([CARD]);
    expect(row.imageStatus).toBe("failed");
    expect(events).toContainEqual({
      type: "image",
      status: "failed",
      draftImageId: null,
    });
  });

  it("claims the picture onto the note when the draft was saved first", async () => {
    const draft = await seedDraft();
    // A real row: an id that doesn't exist would make `UPDATE notes SET
    // imagePath ... WHERE id = ...` match zero rows and silently succeed,
    // which would pass even if the branch that issues it were deleted.
    const noteId = await seedNote("u1");
    const claimDraftImage = vi.fn(async () => `u1/${noteId}.png`);
    // Held open so the save lands while the image is still rendering.
    const gate = deferred();

    const run = startGenerationJob(
      deps({
        claimDraftImage,
        generateImageBytes: vi.fn(async () => {
          await gate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    // Wait until the stage is genuinely in flight, then simulate save.
    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("generating");
    });
    expect(claimJobForNote(draft.id, noteId)).toBe(true);
    await db.delete(drafts).where(eq(drafts.id, draft.id));
    gate.release();
    await run;

    expect(claimDraftImage).toHaveBeenCalledWith(
      "u1",
      expect.any(String),
      noteId,
    );
    const [note] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(note.imagePath).toBe(`u1/${noteId}.png`);
  });

  it("removes the claimed picture when replacement deletes the note before persistence", async () => {
    const draft = await seedDraft();
    const noteId = await seedNote("u1");
    const [targetNote] = await db.select().from(notes).where(
      eq(notes.id, noteId),
    );
    const imagePath = `u1/${noteId}.png`;
    const removeImage = vi.fn(async () => {});
    const gate = deferred();
    const claimDraftImage = vi.fn(async () => {
      // Exact durable-path interleaving: the draft file has been renamed to
      // its final note path, then replacement cascades the target note before
      // the job can persist that path on the row.
      await db.delete(decks).where(eq(decks.id, targetNote.deckId));
      return imagePath;
    });

    const run = startGenerationJob(
      deps({
        claimDraftImage,
        removeImage,
        generateImageBytes: vi.fn(async () => {
          await gate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("generating");
    });
    expect(claimJobForNote(draft.id, noteId)).toBe(true);
    await db.delete(drafts).where(eq(drafts.id, draft.id));
    gate.release();
    await run;

    expect(claimDraftImage).toHaveBeenCalledWith(
      "u1",
      expect.any(String),
      noteId,
    );
    expect(await db.select().from(notes).where(eq(notes.id, noteId))).toEqual(
      [],
    );
    expect(removeImage).toHaveBeenCalledWith(imagePath);
  });

  it("marks the note's picture failed when the file can't be claimed onto it", async () => {
    const draft = await seedDraft();
    const noteId = await seedNote("u1");
    const gate = deferred();

    const run = startGenerationJob(
      deps({
        claimDraftImage: vi.fn(async () => {
          throw new Error("rename failed");
        }),
        generateImageBytes: vi.fn(async () => {
          await gate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("generating");
    });
    expect(claimJobForNote(draft.id, noteId)).toBe(true);
    await db.delete(drafts).where(eq(drafts.id, draft.id));
    gate.release();
    await run;

    const [note] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(note.imagePath).toBeNull();
    expect(note.metadata.imageFailed).toBe(true);
  });

  it("deletes the picture when the draft was discarded", async () => {
    const draft = await seedDraft();
    const removeDraftImage = vi.fn(async () => {});
    const gate = deferred();

    const run = startGenerationJob(
      deps({
        removeDraftImage,
        generateImageBytes: vi.fn(async () => {
          await gate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("generating");
    });
    await db.delete(drafts).where(eq(drafts.id, draft.id));
    gate.release();
    await run;

    expect(removeDraftImage).toHaveBeenCalledWith("u1", expect.any(String));
  });
});

/** A draft whose cards are settled and whose picture is ready to be retried —
 *  the exact row `drafts.retryImage` hands `startImageJob`. */
async function seedRetryableDraft(): Promise<Draft> {
  const draft = await seedDraft();
  await db
    .update(drafts)
    .set({
      status: "ready",
      cards: [CARD],
      imagePrompt: "a ripe banana",
      imageStatus: "failed",
    })
    .where(eq(drafts.id, draft.id));
  return await readDraft(draft.id);
}

/** One turn of the macrotask queue, which drains every pending microtask
 *  first. The job tear-down this file guards against is microtasks all the way
 *  down — no I/O — so this is long enough for it to have happened if it is
 *  going to, and asserting afterwards is not a race. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("startImageJob", () => {
  it("no-ops when the draft has no image prompt", async () => {
    const draft = await seedDraft();
    await expect(startImageJob(deps(), draft)).resolves.toBeUndefined();
    expect(hasJob(draft.id)).toBe(false);
  });

  it("no-ops when the job it attaches to has no image prompt", async () => {
    // The model decided no picture helps, so the live job has nothing to
    // regenerate from — even though the row the router read still carried a
    // prompt from an earlier attempt. The attach branch has to consult the
    // JOB's prompt: without that check it re-arms `imageStatus` and calls the
    // image provider with `null`.
    const draft = await seedDraft();
    const classifyGate = deferred();
    const run = startGenerationJob(
      deps({
        modelCalls: {
          classify: async () => {
            await classifyGate.promise;
            return CLASSIFICATION;
          },
          generate: fakeModelCalls(DELTAS).generate,
        },
      }),
      draft,
      "en",
    );
    // Registered synchronously, and classify is gated, so the job is provably
    // live with `imagePrompt` still null.
    expect(hasJob(draft.id)).toBe(true);

    const retryDeps = deps({
      generateImageBytes: vi.fn(async () => new Uint8Array([9])),
      writeDraftImage: vi.fn(async () => "img-never"),
    });
    await startImageJob(retryDeps, {
      ...(await readDraft(draft.id)),
      imagePrompt: "a stale prompt",
    });

    expect(retryDeps.generateImageBytes).not.toHaveBeenCalled();
    expect(retryDeps.writeDraftImage).not.toHaveBeenCalled();
    expect((await readDraft(draft.id)).imageStatus).toBe("none");

    classifyGate.release();
    await run;
  });

  it("runs a fresh image-only job to completion and persists the picture", async () => {
    const draft = await seedDraft();
    await db
      .update(drafts)
      .set({
        status: "ready",
        cards: [CARD],
        imagePrompt: "a ripe banana",
        imageStatus: "failed",
      })
      .where(eq(drafts.id, draft.id));
    const retrying = await readDraft(draft.id);

    await startImageJob(
      deps({ writeDraftImage: vi.fn(async () => "img-2") }),
      retrying,
    );

    const row = await readDraft(draft.id);
    expect(row.imageStatus).toBe("ready");
    expect(row.draftImageId).toBe("img-2");
    expect(hasJob(draft.id)).toBe(false);
  });

  it("re-arms imageStatus when attaching to a job whose picture already failed", async () => {
    const draft = await seedDraft();
    // Cards are held mid-stream so the original generation job stays
    // registered — that's what makes this the attach branch rather than the
    // fresh-job branch below.
    const generateGate = deferred();
    const gatedModelCalls: ModelCalls = {
      classify: async () => CLASSIFICATION,
      async *generate() {
        yield DELTAS[0];
        yield DELTAS[1];
        await generateGate.promise;
        yield DELTAS[2];
        return { imagePrompt: "a ripe banana", generationSummary: "Practise the meaning of Banane.", cards: [CARD] };
      },
    };

    const run = startGenerationJob(
      deps({
        modelCalls: gatedModelCalls,
        generateImageBytes: vi.fn(async () => {
          throw new Error("image provider exploded");
        }),
      }),
      draft,
      "en",
    );

    // The mid-stream image-prompt event's own stage fails while the cards
    // side is still gated open, so the job is still live with a stale
    // "failed" imageStatus — precisely the state a retry attaches to.
    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("failed");
    });
    expect(hasJob(draft.id)).toBe(true);

    // Gated too: the default instant mock could resolve — and the retry
    // race straight past "generating" to "ready" — before the claim check
    // below ever runs.
    const retryImageGate = deferred();
    const retry = startImageJob(
      deps({
        writeDraftImage: vi.fn(async () => "img-retry"),
        generateImageBytes: vi.fn(async () => {
          await retryImageGate.promise;
          return new Uint8Array([1]);
        }),
      }),
      await readDraft(draft.id),
    );

    // Before the fix, the attach branch never wrote "generating", so this
    // stayed "failed" forever and the claim below returned false — exactly
    // the bug that lets `notes.save` mark the note `imageFailed` and delete
    // a picture that is, in fact, still being paid for.
    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("generating");
    });
    expect(claimJobForNote(draft.id, "note-9")).toBe(true);

    generateGate.release();
    retryImageGate.release();
    await Promise.all([run, retry]);

    // The row was never deleted in this test, so the retry's settle takes
    // the "draft still there" branch: the retried picture, not the note
    // claim, is what ends up recorded.
    const row = await readDraft(draft.id);
    expect(row.imageStatus).toBe("ready");
    expect(row.draftImageId).toBe("img-retry");
  });

  it("re-arms imageStatus in memory before the write, not a round trip later", async () => {
    // The window the test above deliberately waits past. It `vi.waitFor`s the
    // ROW to say "generating", i.e. it only looks after the attach branch's
    // `patch` has landed — but `claimJobForNote` gates on the JOB's in-memory
    // copy, and the attach branch claims `pendingStages` synchronously while
    // leaving `job.draft.imageStatus` stale until that `patch` returns. For
    // one whole write-lock round trip the job is registered but unclaimable.
    //
    // A `notes.save` already inside its locked section lands exactly there:
    // `claimJobForNote` sees "failed", returns false, `save` marks the note
    // `imageFailed` and deletes the draft row — and the retry's stage, having
    // no row and no `job.noteId`, deletes the picture it just paid for as
    // ownerless. That is the third state the design's §3.3 says cannot exist.
    //
    // So the claim below runs with NO await between it and `startImageJob`:
    // everything in between is microtasks, which is precisely the reach a
    // synchronous `notes.save` section has.
    const draft = await seedDraft();
    const noteId = await seedNote("u1");
    const generateGate = deferred();
    const gatedModelCalls: ModelCalls = {
      classify: async () => CLASSIFICATION,
      async *generate() {
        yield DELTAS[0];
        yield DELTAS[1];
        await generateGate.promise;
        yield DELTAS[2];
        return { imagePrompt: "a ripe banana", generationSummary: "Practise the meaning of Banane.", cards: [CARD] };
      },
    };
    const ownerRemove = vi.fn(async () => {});

    const run = startGenerationJob(
      deps({
        removeDraftImage: ownerRemove,
        modelCalls: gatedModelCalls,
        generateImageBytes: vi.fn(async () => {
          throw new Error("image provider exploded");
        }),
      }),
      draft,
      "en",
    );

    // The mid-stream picture has failed while the cards are still gated open,
    // so the live job's own `imageStatus` is "failed" — the state a retry
    // attaches to.
    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("failed");
    });
    expect(hasJob(draft.id)).toBe(true);

    const retryGate = deferred();
    const removeDraftImage = vi.fn(async () => {});
    const claimDraftImage = vi.fn(async () => `u1/${noteId}.png`);
    const retrying = await readDraft(draft.id);

    const retry = startImageJob(
      deps({
        removeDraftImage,
        claimDraftImage,
        writeDraftImage: vi.fn(async () => "img-retry"),
        generateImageBytes: vi.fn(async () => {
          await retryGate.promise;
          return new Uint8Array([1]);
        }),
      }),
      retrying,
    );
    // No await above this line since `startImageJob` was called.
    expect(claimJobForNote(draft.id, noteId)).toBe(true);

    // The rest of what `notes.save` does once its claim succeeded.
    await db.delete(drafts).where(eq(drafts.id, draft.id));

    generateGate.release();
    retryGate.release();
    await Promise.all([run, retry]);

    expect(claimDraftImage).toHaveBeenCalledWith("u1", "img-retry", noteId);
    expect(removeDraftImage).not.toHaveBeenCalled();
    expect(ownerRemove).not.toHaveBeenCalled();
    const [note] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(note.imagePath).toBe(`u1/${noteId}.png`);
    expect(note.metadata.imageFailed).toBeUndefined();
  });
});

describe("two overlapping image attempts", () => {
  it("keeps the job — and the picture — alive until the later attempt settles", async () => {
    // The retry button is not disabled while a picture renders, so a
    // double-click or a second tab really does land a second `startImageJob`
    // on a job that is still in flight. The first attempt is superseded and
    // bails immediately; if the job is torn down when THAT happens, `hasJob`
    // lies, a save in the window cannot retarget the stage still rendering,
    // and the finished picture is deleted as ownerless.
    const draft = await seedRetryableDraft();
    const noteId = await seedNote("u1");
    const firstGate = deferred();
    const secondGate = deferred();
    const secondStarted = deferred();
    const removeDraftImage = vi.fn(async () => {});
    const claimDraftImage = vi.fn(async () => `u1/${noteId}.png`);

    const first = startImageJob(
      deps({
        removeDraftImage,
        writeDraftImage: vi.fn(async () => "img-a"),
        generateImageBytes: vi.fn(async () => {
          await firstGate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("generating");
    });

    const second = startImageJob(
      deps({
        removeDraftImage,
        claimDraftImage,
        writeDraftImage: vi.fn(async () => "img-b"),
        generateImageBytes: vi.fn(async () => {
          secondStarted.release();
          await secondGate.promise;
          return new Uint8Array([2]);
        }),
      }),
      await readDraft(draft.id),
    );

    // Waiting for the second stage to be genuinely in flight is what makes
    // the supersession below deterministic: `imageAttempt` is bumped when the
    // stage is pushed, one write-lock round trip after `startImageJob`
    // returns.
    await secondStarted.promise;
    firstGate.release();
    await macrotask();

    expect(hasJob(draft.id)).toBe(true);
    // The save that lands in this window. Standing in for `notes.save`'s
    // locked section, exactly as the image-stage tests above do.
    expect(claimJobForNote(draft.id, noteId)).toBe(true);
    await db.delete(drafts).where(eq(drafts.id, draft.id));

    secondGate.release();
    await Promise.all([first, second]);

    expect(claimDraftImage).toHaveBeenCalledWith("u1", "img-b", noteId);
    expect(removeDraftImage).not.toHaveBeenCalled();
    const [note] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(note.imagePath).toBe(`u1/${noteId}.png`);
    expect(note.metadata.imageFailed).toBeUndefined();
  });

  it("keeps the job registered when a retry attaches while the running settle holds the lock", async () => {
    // The window the test above cannot reach: it waits for the second stage to
    // be pushed, and the bug lives strictly BEFORE that push. `startImageJob`
    // decides to attach synchronously, but `runImageRetry` then awaits a
    // `patch` — a write-lock acquisition plus a round trip. If the running
    // stage's settle is already queued on that lock, the settle completes, the
    // first drain empties, and the tear-down (pure microtasks) beats the
    // retry's `patch` (real I/O). `jobs.delete` runs while the retry's stage is
    // about to start: `hasJob` lies, and a `notes.save` landing in the window
    // gets `false` from `claimJobForNote`, marks the note `imageFailed`, and
    // leaves the picture the retry is still paying for to be deleted as
    // ownerless.
    const draft = await seedRetryableDraft();
    const noteId = await seedNote("u1");
    const firstGate = deferred();
    const lockGate = deferred();
    const secondGate = deferred();
    const writeFirst = vi.fn(async () => "img-a");
    const secondGen = vi.fn(async () => {
      await secondGate.promise;
      return new Uint8Array([2]);
    });
    const removeDraftImage = vi.fn(async () => {});
    const claimDraftImage = vi.fn(async () => `u1/${noteId}.png`);

    const first = startImageJob(
      deps({
        removeDraftImage,
        writeDraftImage: writeFirst,
        generateImageBytes: vi.fn(async () => {
          await firstGate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("generating");
    });

    // Hold the write lock, then let the first attempt finish rendering. Its
    // settle queues behind this holder, and the retry's `patch` queues behind
    // the settle — which is exactly the ordering the bug needs.
    const held = withWriteLock(() => lockGate.promise);
    firstGate.release();
    await vi.waitFor(() => expect(writeFirst).toHaveBeenCalledTimes(1));

    const second = startImageJob(
      deps({
        removeDraftImage,
        claimDraftImage,
        writeDraftImage: vi.fn(async () => "img-b"),
        generateImageBytes: secondGen,
      }),
      await readDraft(draft.id),
    );

    lockGate.release();
    await held;
    // The retry's stage is provably in flight by here, so the job it belongs
    // to must still be findable.
    await vi.waitFor(() => expect(secondGen).toHaveBeenCalledTimes(1));

    expect(hasJob(draft.id)).toBe(true);
    // The save that lands in the window, standing in for `notes.save`'s locked
    // section exactly as the image-stage tests do.
    expect(claimJobForNote(draft.id, noteId)).toBe(true);
    await db.delete(drafts).where(eq(drafts.id, draft.id));

    secondGate.release();
    await Promise.all([first, second]);

    expect(claimDraftImage).toHaveBeenCalledWith("u1", "img-b", noteId);
    expect(removeDraftImage).not.toHaveBeenCalled();
    const [note] = await db.select().from(notes).where(eq(notes.id, noteId));
    expect(note.imagePath).toBe(`u1/${noteId}.png`);
    expect(note.metadata.imageFailed).toBeUndefined();
    expect(hasJob(draft.id)).toBe(false);
  });

  it(
    "releases an attaching retry's claim when its own patch throws",
    async () => {
      // `runImageRetry` releases the claim from a `finally`, not after the push,
      // and that placement is the only thing standing between a rejected `patch`
      // and a permanently wedged process. A claim that is never released leaves
      // `pendingStages` at 1 forever, so the OWNER's `drainImageStages` — which
      // treats a claim as a stage that has not arrived yet — polls an empty
      // array for the rest of the process's life. The job is never deleted, its
      // subscribers are never closed, `hasJob` lies forever, and the request
      // that started the owning job never answers.
      //
      // That failure mode is why this test exists at all and why it is written
      // against a clock: moving the release below the push passes every other
      // assertion in this file, and a regression here does not go red, it hangs.
      // The race turns the hang into a fast, ordinary failure.
      const draft = await seedRetryableDraft();
      const firstGate = deferred();

      const first = startImageJob(
        deps({
          writeDraftImage: vi.fn(async () => "img-a"),
          generateImageBytes: vi.fn(async () => {
            await firstGate.promise;
            return new Uint8Array([1]);
          }),
        }),
        draft,
      );

      await vi.waitFor(async () => {
        const row = await readDraft(draft.id);
        expect(row.imageStatus).toBe("generating");
      });

      // The attach's re-arming `patch` is the write that fails. It is named by
      // what it says rather than by call order: the owner's identical `patch`
      // came first and has to be allowed through, or there would be no live job
      // to attach to.
      const second = startImageJob(
        deps({
          db: failingUpdateSet(
            db,
            drafts,
            (values) => values.imageStatus === "generating",
          ),
        }),
        await readDraft(draft.id),
      );

      // The owner's stage settles, its drain empties — and then either finishes,
      // or starts polling for a stage that is never coming.
      firstGate.release();

      const outcome = await Promise.race([
        Promise.all([first, second]).then(() => "settled" as const),
        new Promise<"HUNG">((resolve) =>
          setTimeout(() => resolve("HUNG"), 3000)
        ),
      ]);
      expect(outcome).toBe("settled");

      // The owner was untouched by its attacher's failure: its picture landed
      // and its job was torn down exactly as if nothing had attached.
      expect(hasJob(draft.id)).toBe(false);
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("ready");
      expect(row.draftImageId).toBe("img-a");
    },
    15_000,
  );

  it("keeps a watcher's stream open until the later attempt publishes", async () => {
    const draft = await seedRetryableDraft();
    const firstGate = deferred();
    const secondGate = deferred();
    const secondStarted = deferred();

    const first = startImageJob(
      deps({
        writeDraftImage: vi.fn(async () => "img-a"),
        generateImageBytes: vi.fn(async () => {
          await firstGate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("generating");
    });

    const watching = subscribe(draft.id);
    expect(watching).not.toBeNull();
    const collected = drain(watching!);

    const second = startImageJob(
      deps({
        writeDraftImage: vi.fn(async () => "img-b"),
        generateImageBytes: vi.fn(async () => {
          secondStarted.release();
          await secondGate.promise;
          return new Uint8Array([2]);
        }),
      }),
      await readDraft(draft.id),
    );

    await secondStarted.promise;
    firstGate.release();
    await macrotask();

    secondGate.release();
    await Promise.all([first, second]);

    // Closing the subscribers when the superseded attempt bailed would end
    // this stream one event early, and the watching tab would sit on a
    // spinner until it reconnected.
    const events = await collected;
    expect(events.map((e) => e.type)).toEqual(["snapshot", "image"]);
    expect(events.at(-1)).toEqual({
      type: "image",
      status: "ready",
      draftImageId: "img-b",
    });
  });
});

describe("yieldToMacrotask", () => {
  it("lets a timer callback run, which a microtask yield never would", async () => {
    // `drainImageStages` polls on this while a claimed stage's `patch` is
    // still in flight, and its loop is unbounded — so if the yield only ever
    // reached the microtask queue, the poll would drain that queue forever and
    // the round trip it is waiting for would never get a turn. That is a hung
    // process, not a failing test: a drain-level probe against a
    // `Promise.resolve()` yield outlived vitest's own per-test timeout,
    // because that timeout is a timer and a starved one.
    //
    // So the property is pinned here instead, where the spin can be BOUNDED
    // and a regression is an ordinary red in milliseconds. A timer registered
    // before the loop is the strictest witness available: nothing but reaching
    // the timers phase can flip it.
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
    }, 0);
    let spins = 0;
    try {
      while (!fired && spins < 1000) {
        await yieldToMacrotask();
        spins++;
      }
    } finally {
      clearTimeout(timer);
    }

    expect(fired).toBe(true);
    // Not just "eventually": one turn is enough, which is what makes this a
    // poll of the queue rather than an accident of how long 1000 spins take.
    expect(spins).toBeLessThanOrEqual(2);
  });
});

describe("claimJobForNote", () => {
  it("returns false when no job is running for the draft", () => {
    expect(claimJobForNote("no-such-draft", "n1")).toBe(false);
  });

  it("returns false when the job's image isn't generating", async () => {
    const draft = await seedDraft();
    const run = startGenerationJob(deps(), draft, "en");
    // The job is registered synchronously before startGenerationJob returns,
    // but classify (and everything after it) is still pending, so the
    // image is still "none".
    expect(hasJob(draft.id)).toBe(true);
    expect(claimJobForNote(draft.id, "n1")).toBe(false);
    await run;
  });

  it("returns true and claims a job whose image is generating", async () => {
    const draft = await seedDraft();
    const generateGate = deferred();
    // The image is real now: without gating it too, it could race to
    // "ready" before the claim check below runs, since the default mock
    // resolves near-instantly.
    const imageGate = deferred();
    const gatedModelCalls: ModelCalls = {
      classify: async () => CLASSIFICATION,
      async *generate() {
        yield DELTAS[0];
        yield DELTAS[1];
        await generateGate.promise;
        yield DELTAS[2];
        return { imagePrompt: "a ripe banana", generationSummary: "Practise the meaning of Banane.", cards: [CARD] };
      },
    };

    const run = startGenerationJob(
      deps({
        modelCalls: gatedModelCalls,
        generateImageBytes: vi.fn(async () => {
          await imageGate.promise;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draft.id);
      expect(row.imageStatus).toBe("generating");
    });

    expect(claimJobForNote(draft.id, "n1")).toBe(true);

    generateGate.release();
    imageGate.release();
    await run;
  });
});
