import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer } from "./testing.ts";
import { decksRouter } from "./decks.ts";
import { draftsRouter } from "./drafts.ts";
import { drafts } from "../db/schema.ts";
import { hasJob } from "../ai/jobs.ts";
import type { ModelCalls } from "../ai/generate-note.ts";
import type { AppContext } from "./base.ts";

vi.mock("../ai/model-calls.ts", () => ({
  openRouterCalls: {
    classify() { throw new Error("Unexpected OpenRouter fallback"); },
    generate() { throw new Error("Unexpected OpenRouter fallback"); },
  },
}));
vi.mock("../ai/openrouter-image.ts", () => ({
  generateOpenRouterImageBytes() { throw new Error("Unexpected OpenRouter fallback"); },
}));

describe("draft provider dependencies", () => {
  it.each(["modelCalls", "generateImageBytes"] as const)("rejects missing %s before creating a draft", async (dependency) => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    delete context[dependency];
    const deck = await seedDeck(context);
    await expect(call(draftsRouter.start, { deckId: deck.id, text: "die Banane" }, { context }))
      .rejects.toThrow("AI provider is not configured");
    expect(await server.db.select().from(drafts)).toHaveLength(0);
  });
});

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

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

const IMAGE_CARD = {
  aspect: "plural",
  front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
  back: "I see two bananas.",
  imageCue: true,
};

function fakeCalls(): ModelCalls {
  return {
    // Spied so a test can prove a rejected `start` never reached a model —
    // `expect(...).toBeDefined()` on this object would be true by
    // construction and prove nothing.
    classify: vi.fn(async () => CLASSIFICATION),
    async *generate() {
      yield `{"imagePrompt":null,"generationSummary":"Practise the meaning of Banane.","cards":[`;
      yield `{"aspect":"meaning","front":"die Banane","back":"banana","imageCue":false}]}`;
      return {
        imagePrompt: null,
        generationSummary: "Practise the meaning of Banane.",
        cards: [CARD],
      };
    },
  };
}

/** Context with every model and disk seam replaced. */
function draftContext(base: AppContext): AppContext {
  return {
    ...base,
    modelCalls: fakeCalls(),
    generateImageBytes: vi.fn(async () => new Uint8Array([1])),
    writeDraftImage: vi.fn(async () => "img-1"),
    claimDraftImage: vi.fn(async () => "u/n.png"),
    removeImage: vi.fn(async () => {}),
    removeDraftImage: vi.fn(async () => {}),
  };
}

async function seedDeck(context: AppContext) {
  return await call(decksRouter.create, { name: "German" }, { context });
}

async function readDraft(draftId: string) {
  const [row] = await server.db.select().from(drafts).where(
    eq(drafts.id, draftId),
  );
  return row;
}

/** A gate a test can hold open and release on demand, for pinning a fake
 *  model call at a precise point instead of racing the real (near-instant)
 *  fake generation to observe a "still generating" window. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Like {@link fakeCalls}, but `classify` blocks on `gate` — so the draft is
 *  provably still `status: "generating"` for as long as the test holds the
 *  gate shut, rather than merely "probably still generating because nothing
 *  awaited yet". */
function gatedFakeCalls(gate: Promise<void>): ModelCalls {
  return {
    classify: vi.fn(async () => {
      await gate;
      return CLASSIFICATION;
    }),
    async *generate() {
      yield `{"imagePrompt":null,"generationSummary":"Practise the meaning of Banane.","cards":[`;
      yield `{"aspect":"meaning","front":"die Banane","back":"banana","imageCue":false}]}`;
      return {
        imagePrompt: null,
        generationSummary: "Practise the meaning of Banane.",
        cards: [CARD],
      };
    },
  };
}

/** Like {@link gatedFakeCalls}, but the generation carries an image prompt —
 *  which is what makes "did the image stage ever run?" observable through the
 *  injected `generateImageBytes`. */
function gatedImageCalls(gate: Promise<void>): ModelCalls {
  return {
    classify: vi.fn(async () => {
      await gate;
      return CLASSIFICATION;
    }),
    async *generate() {
      yield `{"imagePrompt":"a ripe banana","generationSummary":"Practise the meaning of Banane.","cards":[`;
      yield `{"aspect":"meaning","front":"die Banane","back":"banana","imageCue":false}]}`;
      return {
        imagePrompt: "a ripe banana",
        generationSummary: "Practise the meaning of Banane.",
        cards: [CARD],
      };
    },
  };
}

/**
 * Wraps a Drizzle handle so `before` runs — and finishes — between
 * `delete(table)` being built and the statement actually executing.
 *
 * That gap is the whole subject of the discard test below: an image settle
 * landing after discard's snapshot read but before its delete. Firing the two
 * concurrently and hoping would leave the interleaving to chance, and the
 * chance that matters here is small.
 */
function delayedDelete<T extends object>(
  db: T,
  before: () => Promise<void>,
): T {
  // deno-lint-ignore no-explicit-any
  const step = (target: any): any =>
    new Proxy(target, {
      get(inner, prop) {
        const value = Reflect.get(inner, prop, inner);
        if (prop === "returning") {
          return async (...args: unknown[]) => {
            await before();
            return await value.apply(inner, args);
          };
        }
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            const result = value.apply(inner, args);
            return result && typeof result === "object" ? step(result) : result;
          };
        }
        return value;
      },
    });

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "delete") {
        // deno-lint-ignore no-explicit-any
        return (arg: unknown) => step((target as any).delete(arg));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Waits until the job registry has no entry for this draft — i.e. the
 *  detached job (cards, and any image stage it started) has fully drained
 *  and cleaned itself up. A plain `status === "ready"` poll can observe the
 *  row before `jobs.delete` runs; later assertions or the next test's fresh
 *  db must not race that gap. */
async function waitUntilSettled(draftId: string) {
  await vi.waitFor(() => {
    expect(hasJob(draftId)).toBe(false);
  });
}

describe("drafts.start", () => {
  it("creates the draft and runs the generation to completion", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);

    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });

    const row = await readDraft(draftId);
    expect(row.userId).toBe(ada.userId);
    expect(row.sourceText).toBe("die Banane");
    expect(row.cards).toEqual([CARD]);
    expect(row.imageStatus).toBe("none");

    await waitUntilSettled(draftId);
  });

  it("refuses a second draft while one exists", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);

    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context },
    );
    await expect(
      call(draftsRouter.start, { deckId: deck.id, text: "b" }, { context }),
    ).rejects.toThrow(ORPCError);

    // Let the first draft's detached job settle before the test ends, so it
    // cannot leak a write into whatever runs next.
    await waitUntilSettled(draftId);
  });

  it("refuses another user's deck before spending a generation", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const bobDeck = await seedDeck(bob.context);
    const context = draftContext(ada.context);

    await expect(
      call(draftsRouter.start, { deckId: bobDeck.id, text: "a" }, { context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The generation is real money once it starts; a wrong-owner deck must
    // be caught before any model is ever called, not merely before the
    // response comes back.
    expect(context.modelCalls?.classify).not.toHaveBeenCalled();
    expect(await server.db.select().from(drafts)).toHaveLength(0);
  });

  it("allows exactly one of two concurrent starts to succeed", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);

    // Fired together, not sequentially: this is what proves the check-then-
    // insert really serialises on the write lock rather than merely working
    // when called one at a time, which the sequential test above cannot
    // distinguish from a version with no locking at all.
    //
    // Measured against a `start` with the lock removed, this catches it about
    // four runs in ten — it is a net, not a proof. A deterministic barrier is
    // NOT constructible: any gate between the check and the insert sits
    // inside the locked section, so the CORRECT implementation is the one it
    // would deadlock. The real backstops are the sequential test above and
    // the unique index on `drafts.userId`; this run adds the only pressure
    // available on the ordering itself, so it stays.
    const results = await Promise.allSettled([
      call(draftsRouter.start, { deckId: deck.id, text: "a" }, { context }),
      call(draftsRouter.start, { deckId: deck.id, text: "b" }, { context }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });

    const rows = await server.db.select().from(drafts).where(
      eq(drafts.userId, ada.userId),
    );
    expect(rows).toHaveLength(1);

    const { draftId } =
      (fulfilled[0] as PromiseFulfilledResult<{ draftId: string }>).value;
    await waitUntilSettled(draftId);
  });
});

describe("drafts.current", () => {
  it("returns null when there is no draft, and the row when there is", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    expect(await call(draftsRouter.current, {}, { context })).toBeNull();

    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );

    const current = await call(draftsRouter.current, {}, { context });
    expect(current?.id).toBe(draftId);

    await waitUntilSettled(draftId);
  });

  it("never returns another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context: adaContext },
    );

    expect(
      await call(draftsRouter.current, {}, {
        context: draftContext(bob.context),
      }),
    ).toBeNull();

    await waitUntilSettled(draftId);
  });
});

describe("drafts.watch", () => {
  it("hands a settled draft its snapshot and stops", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );

    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });

    const events = [];
    for await (
      const event of await call(draftsRouter.watch, { draftId }, { context })
    ) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("snapshot");

    await waitUntilSettled(draftId);
  });

  it("reconciles a row left generating by a dead process before handing out its snapshot", async () => {
    // `reconcileDraft` is well covered on its own; nothing covered `watch`
    // actually calling it. Without that call a post-restart row is handed
    // straight back saying "generating", and the tab that reconnects to it
    // spins on a job that no longer exists.
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    // Inserted directly: a `generating` row with no job behind it is exactly
    // what a restart leaves, and `start` would give it a live job.
    const [draft] = await server.db
      .insert(drafts)
      .values({
        userId: ada.userId,
        deckId: deck.id,
        sourceText: "die Banane",
        status: "generating",
      })
      .returning();

    const events = [];
    for await (
      const event of await call(draftsRouter.watch, { draftId: draft.id }, {
        context,
      })
    ) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "snapshot",
      draft: {
        status: "failed",
        error: "The server restarted while this was generating.",
      },
    });
    // Persisted, not merely reported: a reload must not find it generating.
    expect((await readDraft(draft.id)).status).toBe("failed");
  });

  it("refuses another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context: adaContext },
    );

    await expect(
      (async () => {
        for await (
          const _ of await call(
            draftsRouter.watch,
            { draftId },
            { context: draftContext(bob.context) },
          )
        ) { /* drained for the rejection */ }
      })(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await waitUntilSettled(draftId);
  });
});

describe("drafts.update", () => {
  it("stores edited cards and a changed deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const other = await call(decksRouter.create, { name: "Greek" }, {
      context,
    });
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });

    await call(
      draftsRouter.update,
      {
        draftId,
        deckId: other.id,
        cards: [
          {
            aspect: "meaning",
            front: "edited",
            back: "banana",
            imageCue: false,
          },
        ],
      },
      { context },
    );

    const row = await readDraft(draftId);
    expect(row.cards[0].front).toBe("edited");
    expect(row.deckId).toBe(other.id);
  });

  it("stores an image cue on an image-backed language card", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });
    await server.db
      .update(drafts)
      .set({ imagePrompt: "two bananas" })
      .where(eq(drafts.id, draftId));

    await call(
      draftsRouter.update,
      { draftId, cards: [IMAGE_CARD] },
      { context },
    );

    const row = await readDraft(draftId);
    expect(row.cards).toEqual([IMAGE_CARD]);

    await waitUntilSettled(draftId);
  });

  it("refuses an image cue when the draft has no image prompt", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });

    await expect(
      call(draftsRouter.update, { draftId, cards: [IMAGE_CARD] }, { context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await waitUntilSettled(draftId);
  });

  it("refuses an image cue on a concept draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });
    await server.db
      .update(drafts)
      .set({
        classification: {
          domain: "concept",
          language: null,
          partOfSpeech: null,
        },
        imagePrompt: "two bananas",
      })
      .where(eq(drafts.id, draftId));

    await expect(
      call(draftsRouter.update, { draftId, cards: [IMAGE_CARD] }, { context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await waitUntilSettled(draftId);
  });

  it("refuses an image cue when the cloze has no inline hint", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });
    await server.db
      .update(drafts)
      .set({ imagePrompt: "two bananas" })
      .where(eq(drafts.id, draftId));

    await expect(
      call(
        draftsRouter.update,
        {
          draftId,
          cards: [{ ...IMAGE_CARD, front: "Ich sehe zwei {{c1::Bananen}}." }],
        },
        { context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await waitUntilSettled(draftId);
  });

  it("refuses another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context: adaContext },
    );
    // Settled first: otherwise this also passes against an `ownDraft` with no
    // userId filter, because the row is still `status: "generating"` and
    // Bob's call would hit the (also-ORPCError) "still generating" CONFLICT
    // branch instead of ever exercising the ownership check.
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });

    await expect(
      call(
        draftsRouter.update,
        {
          draftId,
          cards: [{
            aspect: "a",
            front: "f",
            back: "b",
            imageCue: false,
          }],
        },
        { context: draftContext(bob.context) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await waitUntilSettled(draftId);
  });

  it("refuses updating onto another user's deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const bobContext = draftContext(bob.context);
    const deck = await seedDeck(adaContext);
    const bobDeck = await seedDeck(bobContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context: adaContext },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });

    await expect(
      call(
        draftsRouter.update,
        { draftId, deckId: bobDeck.id },
        { context: adaContext },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const row = await readDraft(draftId);
    expect(row.deckId).toBe(deck.id);

    await waitUntilSettled(draftId);
  });

  it("refuses to update a draft that is still generating", async () => {
    const ada = await server.signIn("ada@example.com");
    const gate = deferred();
    const context = {
      ...draftContext(ada.context),
      modelCalls: gatedFakeCalls(gate.promise),
    };
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context },
    );

    // `classify` is gated shut, so the row is provably still
    // `status: "generating"` here — not merely "probably still generating
    // because nothing awaited yet". The job owns `cards` until it settles.
    await expect(
      call(
        draftsRouter.update,
        {
          draftId,
          cards: [{
            aspect: "a",
            front: "f",
            back: "b",
            imageCue: false,
          }],
        },
        { context },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    gate.release();
    await waitUntilSettled(draftId);
  });

  it("rejects a patch with neither deckId nor cards", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });

    // Before the fix this reached drizzle's `set({})` and threw a raw
    // "No values to set" driver error instead of an ORPCError.
    await expect(
      call(draftsRouter.update, { draftId }, { context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await waitUntilSettled(draftId);
  });
});

describe("drafts.discard", () => {
  it("removes the row and its picture", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });
    await server.db
      .update(drafts)
      .set({ imageStatus: "ready", draftImageId: "img-1" })
      .where(eq(drafts.id, draftId));

    await call(draftsRouter.discard, { draftId }, { context });

    expect(await server.db.select().from(drafts)).toHaveLength(0);
    expect(context.removeDraftImage).toHaveBeenCalledWith(ada.userId, "img-1");
  });

  it("removes a picture that landed after its own snapshot read", async () => {
    // The image id has to come from the DELETE's own `returning()`. An image
    // settle can commit `draftImageId` onto the row in the gap between
    // discard's snapshot read and its delete, and a pre-delete snapshot would
    // still show it null — silently skipping `removeDraftImage` and leaving
    // the file on disk with nothing that will ever look for it.
    const ada = await server.signIn("ada@example.com");
    const base = draftContext(ada.context);
    const deck = await seedDeck(base);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context: base },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });
    await waitUntilSettled(draftId);
    expect((await readDraft(draftId)).draftImageId).toBeNull();

    const context = {
      ...base,
      db: delayedDelete(server.db, async () => {
        await server.db
          .update(drafts)
          .set({ imageStatus: "ready", draftImageId: "img-late" })
          .where(eq(drafts.id, draftId));
      }),
    };

    await call(draftsRouter.discard, { draftId }, { context });

    expect(base.removeDraftImage).toHaveBeenCalledWith(ada.userId, "img-late");
    expect(await server.db.select().from(drafts)).toHaveLength(0);
  });

  it("aborts the running job, so a discarded draft stops spending on a picture", async () => {
    const ada = await server.signIn("ada@example.com");
    const gate = deferred();
    const context = {
      ...draftContext(ada.context),
      modelCalls: gatedImageCalls(gate.promise),
    };
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context },
    );

    // `classify` is gated shut, so the discard provably lands before the job
    // has processed a single event.
    await call(draftsRouter.discard, { draftId }, { context });
    gate.release();
    await waitUntilSettled(draftId);

    // The abort is checked per event, so the `image-prompt` event is never
    // processed and no stage ever starts. Without it the job runs on against
    // a row that is gone, pays OpenRouter for a picture nobody can ever see,
    // and then deletes it again as ownerless.
    expect(context.generateImageBytes).not.toHaveBeenCalled();
    expect(context.writeDraftImage).not.toHaveBeenCalled();
    expect(context.removeDraftImage).not.toHaveBeenCalled();
  });

  it("refuses another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context: adaContext },
    );

    await expect(
      call(draftsRouter.discard, { draftId }, {
        context: draftContext(bob.context),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await server.db.select().from(drafts)).toHaveLength(1);

    await waitUntilSettled(draftId);
  });
});

describe("drafts.retryImage", () => {
  it("regenerates from the stored prompt", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });
    await server.db
      .update(drafts)
      .set({ imagePrompt: "a ripe banana", imageStatus: "failed" })
      .where(eq(drafts.id, draftId));

    await call(draftsRouter.retryImage, { draftId }, { context });

    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.imageStatus).toBe("ready");
      expect(row.draftImageId).toBe("img-1");
    });
    expect(context.generateImageBytes).toHaveBeenCalledWith("a ripe banana");

    // The row write and the job registry's own cleanup are two different
    // things settling on two different promise chains; the row landing
    // "ready" does not by itself prove `jobs.delete` has already run.
    await waitUntilSettled(draftId);
  });

  it("refuses another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context: adaContext },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });
    // Without a stored prompt, an id-only `ownDraft` would still land on the
    // (also-ORPCError) "no picture to generate" CONFLICT and never actually
    // exercise the ownership check — exactly the vacuous shape this test had
    // before. Giving the draft a prompt removes that escape hatch.
    await server.db
      .update(drafts)
      .set({ imagePrompt: "a ripe banana", imageStatus: "failed" })
      .where(eq(drafts.id, draftId));

    await expect(
      call(draftsRouter.retryImage, { draftId }, {
        context: draftContext(bob.context),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await waitUntilSettled(draftId);
  });

  it("refuses to retry a draft that is still generating", async () => {
    const ada = await server.signIn("ada@example.com");
    const gate = deferred();
    const context = {
      ...draftContext(ada.context),
      modelCalls: gatedFakeCalls(gate.promise),
    };
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context },
    );

    // Without a stored prompt this test passes with the guard deleted:
    // control falls through to the `!draft.imagePrompt` check and throws the
    // same CONFLICT from a different branch. The neighbouring ownership test
    // was fixed for exactly this and this one was missed. Belt and braces —
    // the prompt removes the escape hatch, the message pins which branch
    // answered.
    await server.db
      .update(drafts)
      .set({ imagePrompt: "a ripe banana" })
      .where(eq(drafts.id, draftId));

    // `classify` is gated shut, so the row is provably still
    // `status: "generating"` here — the window in which the cards job still
    // owns `imagePrompt`. See drafts.ts's comment on this guard.
    await expect(
      call(draftsRouter.retryImage, { draftId }, { context }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This draft is still generating",
    });

    gate.release();
    await waitUntilSettled(draftId);
  });

  it("refuses to retry a draft with no picture to generate", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const row = await readDraft(draftId);
      expect(row.status).toBe("ready");
    });
    // The fixture's generation always returns a null imagePrompt, so the row
    // already has nothing to regenerate from.
    expect((await readDraft(draftId)).imagePrompt).toBeNull();

    await expect(
      call(draftsRouter.retryImage, { draftId }, { context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await waitUntilSettled(draftId);
  });
});
