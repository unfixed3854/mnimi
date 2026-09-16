import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InStatement, TransactionMode } from "@libsql/client";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { uuidv7 } from "uuidv7";
import {
  createTestServer,
  failingDeleteFrom,
  failingInsertInto,
  failingUpdateOn,
} from "./testing.ts";
import { decksRouter } from "./decks.ts";

const { generateNoteAudioMock, resumeOrphanedAudioMock } = vi.hoisted(() => ({
  generateNoteAudioMock: vi.fn(async (): Promise<void> => undefined),
  resumeOrphanedAudioMock: vi.fn(() => undefined),
}));
vi.mock("../tts/jobs.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../tts/jobs.ts")>(),
  generateNoteAudio: generateNoteAudioMock,
  resumeOrphanedAudio: resumeOrphanedAudioMock,
}));

import { notesRouter } from "./notes.ts";
import { startImageJob } from "../ai/jobs.ts";
import type { JobDeps } from "../ai/jobs.ts";
import * as schema from "../db/schema.ts";
import { cards, decks, drafts, notes, reviewLogs } from "../db/schema.ts";
import { withWriteLock } from "../db/write-lock.ts";
import type { AppContext } from "./base.ts";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  generateNoteAudioMock.mockClear();
  resumeOrphanedAudioMock.mockClear();
  server = await createTestServer();
});

afterEach(() => {
  server.close();
});

const CLASSIFICATION = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};

const CARDS = [
  {
    aspect: "meaning",
    front: "die Banane",
    back: "banana",
    imageCue: false,
  },
  {
    aspect: "gender",
    front: "___ Banane",
    back: "die",
    imageCue: false,
  },
];

const IMAGE_CARD = {
  aspect: "plural",
  front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
  back: "I see two bananas.",
  imageCue: true,
};

const AUDIO_CARD = {
  aspect: "production",
  front: "Ich mag {{c1::Bananen::banany}} zum Frühstück.",
  back: null,
  imageCue: false,
};

/** Creates a ready draft directly, bypassing the generation job entirely —
 *  `notes.save` only ever reads the row, so this is enough to exercise it. */
async function seedDraft(
  context: AppContext,
  userId: string,
  overrides: Partial<typeof drafts.$inferInsert> = {},
) {
  const deck = await call(decksRouter.create, { name: "German" }, { context });
  const [draft] = await server.db
    .insert(drafts)
    .values({
      userId,
      deckId: deck.id,
      sourceText: "die Banane",
      status: "ready",
      classification: CLASSIFICATION,
      cards: CARDS,
      imagePrompt: "a banana",
      ...overrides,
    })
    .returning();
  return draft;
}

/** A gate a test can hold open and release on demand, for pausing a fake
 *  image call at a precise point instead of racing real timers. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A ModelCalls stub for `startImageJob`, which never calls it — the image
 *  half of a job doesn't touch the cards model at all. */
const UNUSED_MODEL_CALLS: JobDeps["modelCalls"] = {
  classify: () => {
    throw new Error("not used by startImageJob");
  },
  // eslint-disable-next-line require-yield
  async *generate() {
    throw new Error("not used by startImageJob");
  },
};

describe("notes.save", () => {
  it("initializes eligible card audio and launches generation after saving", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });

    const saved = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );
    const savedCards = await server.db.select().from(cards).where(
      eq(cards.noteId, saved.id),
    );

    expect(saved.id).toBeTruthy();
    expect(savedCards.map((card) => card.audioStatus)).toEqual(["pending"]);
    expect(generateNoteAudioMock).toHaveBeenCalledWith(
      server.db,
      ada.userId,
      expect.arrayContaining(savedCards.map((card) => card.id)),
    );
  });

  it("leaves concept card audio uninitialized", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      classification: {
        domain: "concept",
        language: null,
        partOfSpeech: null,
      },
      imagePrompt: null,
    });

    const saved = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );
    const savedCards = await server.db.select().from(cards).where(
      eq(cards.noteId, saved.id),
    );

    expect(savedCards.every((card) => card.audioStatus === null)).toBe(true);
    expect(generateNoteAudioMock).toHaveBeenCalledWith(
      server.db,
      ada.userId,
      [],
    );
  });

  it("leaves plain language card audio uninitialized", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });

    const saved = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );
    const savedCards = await server.db.select().from(cards).where(
      eq(cards.noteId, saved.id),
    );

    expect(savedCards.every((card) => card.audioStatus === null)).toBe(true);
    expect(generateNoteAudioMock).toHaveBeenCalledWith(
      server.db,
      ada.userId,
      [],
    );
  });

  it("resolves save without waiting for audio generation", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const generation = deferred();
    generateNoteAudioMock.mockImplementationOnce(() => generation.promise);

    const saved = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );

    expect(saved.id).toBeTruthy();
    expect(generateNoteAudioMock).toHaveBeenCalledTimes(1);
    generation.release();
  });

  it("promotes the draft into a note and deletes the draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId);

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );

    expect(note.userId).toBe(ada.userId);
    expect(note.sourceText).toBe("die Banane");
    expect(note.deckId).toBe(draft.deckId);
    expect(note.metadata.partOfSpeech).toBe("noun");
    expect(note.metadata.imagePrompt).toBe("a banana");

    expect(
      await server.db.select().from(cards).where(eq(cards.noteId, note.id)),
    )
      .toHaveLength(2);
    expect(await server.db.select().from(drafts)).toHaveLength(0);
  });

  it("saves the client's cards, not the row's, so an in-flight edit is never lost", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId);

    const note = await call(
      notesRouter.save,
      {
        draftId: draft.id,
        cards: [
          {
            aspect: "meaning",
            front: "edited",
            back: "banana",
            imageCue: false,
          },
        ],
      },
      { context: ada.context },
    );

    const saved = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].front).toBe("edited");
  });

  it("claims a picture that is already there", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imageStatus: "ready",
      draftImageId: "img-1",
    });
    const claimDraftImage = vi.fn(async (
      u: string,
      _d: string,
      noteId: string,
    ) => `${u}/${noteId}.png`);

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: { ...ada.context, claimDraftImage } },
    );

    expect(claimDraftImage).toHaveBeenCalledWith(ada.userId, "img-1", note.id);
    expect(note.imagePath).toBe(`${ada.userId}/${note.id}.png`);
    expect(note.metadata.imageFailed).toBeUndefined();

    // The returned object alone doesn't prove the write landed — a handler
    // that computed `imagePath` and handed it back without ever persisting
    // it would satisfy the assertions above. Re-read the row.
    const [saved] = await server.db.select().from(notes).where(
      eq(notes.id, note.id),
    );
    expect(saved.imagePath).toBe(`${ada.userId}/${note.id}.png`);
  });

  it("marks the picture failed when one was wanted and never arrived", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imageStatus: "failed",
    });

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );

    expect(note.metadata.imageFailed).toBe(true);
  });

  it("records no failure when no picture was ever wanted", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );

    expect(note.metadata.imageFailed).toBeUndefined();
  });

  it("persists an image cue on an image-backed language card", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      cards: [IMAGE_CARD],
      imagePrompt: "two bananas",
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [IMAGE_CARD] },
      { context: ada.context },
    );
    const [saved] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    expect(saved.imageCue).toBe(true);
  });

  it("refuses an image cue when the draft has no image prompt", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      cards: [IMAGE_CARD],
      imagePrompt: null,
    });

    await expect(
      call(notesRouter.save, { draftId: draft.id, cards: [IMAGE_CARD] }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an image cue on a concept draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      classification: { domain: "concept", language: null, partOfSpeech: null },
      cards: [IMAGE_CARD],
      imagePrompt: "two bananas",
    });

    await expect(
      call(notesRouter.save, { draftId: draft.id, cards: [IMAGE_CARD] }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an image cue when the cloze has no inline hint", async () => {
    const ada = await server.signIn("ada@example.com");
    const unhinted = {
      ...IMAGE_CARD,
      front: "Ich sehe zwei {{c1::Bananen}}.",
    };
    const draft = await seedDraft(ada.context, ada.userId, {
      cards: [unhinted],
      imagePrompt: "two bananas",
    });

    await expect(
      call(notesRouter.save, { draftId: draft.id, cards: [unhinted] }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("saves a draft whose classification never landed", async () => {
    // A generation that failed before the classify pass committed leaves the
    // column null. The note still has to be insertable — `domain` is NOT NULL
    // — so the fallback is what makes "save the cards I typed myself" work at
    // all after a failure.
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      classification: null,
      imagePrompt: null,
    });

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );

    expect(note.domain).toBe("concept");
    expect(note.language).toBeNull();
    expect(note.metadata.partOfSpeech).toBeNull();
  });

  it("records generationFailed for a hand-written draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      status: "failed",
      error: "Generation failed",
    });

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );

    expect(note.metadata.generationFailed).toBe(true);
  });

  it("refuses a draft that is still generating", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      status: "generating",
    });

    await expect(
      call(notesRouter.save, { draftId: draft.id, cards: CARDS }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const draft = await seedDraft(bob.context, bob.userId);

    await expect(
      call(notesRouter.save, { draftId: draft.id, cards: CARDS }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await server.db.select().from(notes)).toHaveLength(0);
  });

  it("reports a nonexistent draft the same way as another user's", async () => {
    // A row that never existed and a row someone else owns must be
    // indistinguishable from the caller's side — otherwise the response
    // itself leaks whether an id is in use.
    const ada = await server.signIn("ada@example.com");

    await expect(
      call(
        notesRouter.save,
        { draftId: uuidv7(), cards: CARDS },
        { context: ada.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects an empty card list", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId);

    await expect(
      call(notesRouter.save, { draftId: draft.id, cards: [] }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("leaves no orphaned note when the cards insert fails", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId);

    // The failure must happen INSIDE the transaction, after the note row is
    // already inserted. Invalid input cannot produce that: oRPC validates
    // against saveNoteInput before the handler runs, so the call would fail
    // with BAD_REQUEST and the transaction would never open — passing whether
    // or not `save` is transactional at all.
    const context = {
      ...ada.context,
      db: failingInsertInto(server.db, cards),
    };

    await expect(
      call(notesRouter.save, { draftId: draft.id, cards: CARDS }, { context }),
    ).rejects.toThrow("simulated insert failure");

    // The note insert succeeded before the cards insert threw. Without the
    // transaction it would still be here.
    expect(await server.db.select().from(notes)).toHaveLength(0);
    expect(await server.db.select().from(cards)).toHaveLength(0);
  });

  it("still commits the note and its cards when the claim fails", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imageStatus: "ready",
      draftImageId: "img-2",
    });
    const context = {
      ...ada.context,
      claimDraftImage: async () => {
        throw Object.assign(new Error("swept"), { code: "ENOENT" });
      },
    };

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context },
    );

    const [saved] = await server.db.select().from(notes).where(
      eq(notes.id, note.id),
    );
    expect(saved.imagePath).toBeNull();
    expect(saved.metadata.imageFailed).toBe(true);
    // Every failure degrades to "note without image", which is a valid note.
    const savedCards = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    expect(savedCards).toHaveLength(2);
  });

  it("degrades to a failed image, without throwing, when the claim succeeds but recording its path fails", async () => {
    // The claim itself moved the file onto the note's path — the note and its
    // cards must still commit, and the draft must still be retired, exactly
    // like every other image failure: a throw here would leave the note
    // committed with the draft alive, and the user's obvious retry would
    // re-consume that surviving draft into a SECOND note.
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imageStatus: "ready",
      draftImageId: "img-4",
    });
    const context = {
      ...ada.context,
      claimDraftImage: async (
        userId: string,
        _draftId: string,
        noteId: string,
      ) => `${userId}/${noteId}.png`,
      db: failingUpdateOn(server.db, notes),
    };

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context },
    );

    expect(note.metadata.imageFailed).toBe(true);

    const [saved] = await server.db.select().from(notes).where(
      eq(notes.id, note.id),
    );
    expect(saved.imagePath).toBeNull();
    expect(saved.metadata.imageFailed).toBe(true);
    const savedCards = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    expect(savedCards).toHaveLength(2);
    expect(await server.db.select().from(drafts)).toHaveLength(0);
  });

  it("still retires the draft when recording a failed picture blows up", async () => {
    // `settleImage` claims every failure in it is swallowed, because throwing
    // after the note has committed but before the draft is deleted leaves the
    // user's obvious next move — retry the save — free to re-consume that
    // same draft into a SECOND note. Three `setNoteImageFailed` calls, the
    // final `delete` and (before this) the initial select sat outside any
    // `try`, so the claim was simply false on the commonest image path there
    // is: a picture was wanted and never arrived.
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imageStatus: "failed",
    });
    const context = { ...ada.context, db: failingUpdateOn(server.db, notes) };

    await call(notesRouter.save, { draftId: draft.id, cards: CARDS }, {
      context,
    });

    // Degraded to "note without image", exactly like every other image
    // failure, and the draft is gone.
    expect(await server.db.select().from(notes)).toHaveLength(1);
    expect(await server.db.select().from(cards)).toHaveLength(2);
    expect(await server.db.select().from(drafts)).toHaveLength(0);

    // The double-save this exists to prevent: with the draft retired there is
    // nothing left for a retry to consume.
    await expect(
      call(notesRouter.save, { draftId: draft.id, cards: CARDS }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await server.db.select().from(notes)).toHaveLength(1);
  });

  it("mints exactly one note when two saves race on the same draft", async () => {
    // Two tabs, both on the confirm screen, both hitting Save. The check that
    // the draft is still there and the insert that consumes it have to be in
    // ONE locked section (the spec's §3.3), or both reads see the row, both
    // insert, and the user ends up with the same note twice.
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });

    // The lock is held shut across both calls on purpose. Fired without it,
    // the loser's read lands after the winner's delete about three times in
    // four and the test silently stops testing anything; holding it pins the
    // interleaving this is actually about — both callers looking at the draft
    // before either has consumed it.
    const hold = deferred();
    const held = withWriteLock(() => hold.promise);

    const saves = Promise.allSettled([
      call(notesRouter.save, { draftId: draft.id, cards: CARDS }, {
        context: ada.context,
      }),
      call(notesRouter.save, { draftId: draft.id, cards: CARDS }, {
        context: ada.context,
      }),
    ]);
    // Reading the draft is the only thing either handler can do before it
    // blocks on the lock, so this window puts both of them there.
    await new Promise((resolve) => setTimeout(resolve, 50));
    hold.release();
    await held;

    const results = await saves;

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The draft is gone by the time the loser looks, and a row that is gone
    // reports exactly like one that was never there.
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "NOT_FOUND",
    });

    expect(await server.db.select().from(notes)).toHaveLength(1);
    expect(await server.db.select().from(cards)).toHaveLength(2);
    expect(await server.db.select().from(drafts)).toHaveLength(0);
  });

  it("redirects a still-rendering picture onto the note instead of flagging it failed", async () => {
    // The branch spec §3.3 exists for: saving while the image stage is still
    // in flight must hand the job the note's id rather than fall through to
    // "wanted and never arrived".
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imageStatus: "none",
      draftImageId: null,
    });
    const gate = deferred();
    const claimDraftImage = vi.fn(async (
      u: string,
      _d: string,
      noteId: string,
    ) => `${u}/${noteId}.png`);
    const jobDeps: JobDeps = {
      db: server.db,
      modelCalls: UNUSED_MODEL_CALLS,
      generateImageBytes: vi.fn(async () => {
        await gate.promise;
        return new Uint8Array([1]);
      }),
      writeDraftImage: vi.fn(async () => "img-live"),
      claimDraftImage,
      removeImage: vi.fn(async () => {}),
      removeDraftImage: vi.fn(async () => {}),
    };
    const run = startImageJob(jobDeps, draft);

    await vi.waitFor(async () => {
      const [row] = await server.db.select().from(drafts).where(
        eq(drafts.id, draft.id),
      );
      expect(row.imageStatus).toBe("generating");
    });

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: { ...ada.context, claimDraftImage } },
    );

    // Not yet resolved: the picture is still rendering, so this must NOT be
    // recorded as a failure.
    expect(note.metadata.imageFailed).toBeUndefined();
    expect(note.imagePath).toBeNull();

    gate.release();
    await run;

    const [saved] = await server.db.select().from(notes).where(
      eq(notes.id, note.id),
    );
    expect(saved.imagePath).toBe(`${ada.userId}/${note.id}.png`);
    expect(claimDraftImage).toHaveBeenCalledWith(
      ada.userId,
      "img-live",
      note.id,
    );
  });
});

describe("notes.save and cloze cards", () => {
  it("stores a cloze card as cloze, with a null back allowed", async () => {
    const { context, userId } = await server.signIn("cloze@example.com");
    const draft = await seedDraft(context, userId);

    const note = await call(
      notesRouter.save,
      {
        draftId: draft.id,
        cards: [
          {
            aspect: "production",
            front: "Ich mag {{c1::Bananen::banany}} zum Frühstück.",
            back: null,
            imageCue: false,
          },
        ],
      },
      { context },
    );

    const [saved] = await server.db
      .select()
      .from(cards)
      .where(eq(cards.noteId, note.id));

    expect(saved.cardType).toBe("cloze");
    expect(saved.back).toBeNull();
    expect(saved.front).toContain("{{c1::Bananen::banany}}");
  });

  it("stores a card with no deletion as basic", async () => {
    const { context, userId } = await server.signIn("basic@example.com");
    const draft = await seedDraft(context, userId);

    const note = await call(
      notesRouter.save,
      {
        draftId: draft.id,
        cards: [
          {
            aspect: "meaning",
            front: "Poseidon",
            back: "sea god",
            imageCue: false,
          },
        ],
      },
      { context },
    );

    const [saved] = await server.db
      .select()
      .from(cards)
      .where(eq(cards.noteId, note.id));

    expect(saved.cardType).toBe("basic");
    expect(saved.back).toBe("sea god");
  });

  it("rejects malformed markup instead of saving an empty blank", async () => {
    const { context, userId } = await server.signIn("broken@example.com");
    const draft = await seedDraft(context, userId);

    await expect(
      call(
        notesRouter.save,
        {
          draftId: draft.id,
          cards: [
            {
              aspect: "production",
              front: "Ich mag {{c1::}}.",
              back: null,
              imageCue: false,
            },
          ],
        },
        { context },
      ),
    ).rejects.toThrow();
  });

  it("rejects a basic card with no back", async () => {
    const { context, userId } = await server.signIn("noback@example.com");
    const draft = await seedDraft(context, userId);

    await expect(
      call(
        notesRouter.save,
        {
          draftId: draft.id,
          cards: [
            {
              aspect: "meaning",
              front: "Poseidon",
              back: null,
              imageCue: false,
            },
          ],
        },
        { context },
      ),
    ).rejects.toThrow();
  });
});

describe("notes.update", () => {
  it("atomically creates, updates, resets, and deletes cards", async () => {
    const ada = await server.signIn("update-note@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );
    const before = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    await server.db.insert(reviewLogs).values({
      cardId: before[0].id,
      userId: ada.userId,
      rating: 3,
      state: 2,
      due: new Date(10),
      stability: 4,
      difficulty: 5,
      elapsedDays: 6,
      lastElapsedDays: 6,
      scheduledDays: 7,
      learningSteps: 1,
      review: new Date(9),
    });

    const result = await call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 0,
      creates: [{
        clientKey: "new-1",
        card: {
          aspect: "chemistry",
          front: "What is oxidation?",
          back: "Loss of electrons.",
          imageCue: false,
        },
      }],
      updates: [{
        cardId: before[0].id,
        card: {
          aspect: "past tense",
          front: "Corrected question",
          back: "Corrected answer",
          imageCue: false,
        },
      }],
      deleteCardIds: [before[1].id],
      resetCardIds: [before[0].id],
    }, { context: ada.context });

    expect(result.note.revision).toBe(1);
    expect(result.createdIds).toEqual([
      { clientKey: "new-1", cardId: expect.any(String) },
    ]);
    expect(result.cards.map((card) => card.aspect)).toEqual([
      "past tense",
      "chemistry",
    ]);
    const reset = result.cards[0];
    expect(reset).toMatchObject({
      reps: 0,
      lapses: 0,
      state: 0,
      lastReview: null,
    });
    expect(
      await server.db.select().from(reviewLogs).where(
        eq(reviewLogs.cardId, reset.id),
      ),
    ).toHaveLength(0);
  });

  it("preserves FSRS state, review logs, and unchanged speech on an ordinary edit", async () => {
    const ada = await server.signIn("preserve-review@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );
    const [before] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    const audioPath = `${ada.userId}/${before.id}.mp3`;
    const due = new Date("2026-09-15T12:00:00Z");
    const lastReview = new Date("2026-08-25T12:00:00Z");
    await server.db.update(cards).set({
      due,
      stability: 12.5,
      difficulty: 6.25,
      elapsedDays: 14,
      scheduledDays: 21,
      learningSteps: 3,
      reps: 8,
      lapses: 2,
      state: 2,
      lastReview,
      suspended: true,
      audioPath,
      audioStatus: "ready",
    }).where(eq(cards.id, before.id));
    await server.db.insert(reviewLogs).values({
      cardId: before.id,
      userId: ada.userId,
      rating: 4,
      state: 2,
      due,
      stability: 12.5,
      difficulty: 6.25,
      elapsedDays: 14,
      lastElapsedDays: 14,
      scheduledDays: 21,
      learningSteps: 3,
      review: lastReview,
    });
    generateNoteAudioMock.mockClear();
    const removeAudio = vi.fn(async () => {});

    const result = await call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 0,
      creates: [],
      updates: [{
        cardId: before.id,
        card: {
          ...AUDIO_CARD,
          aspect: "corrected production",
          back: "A corrected translation.",
        },
      }],
      deleteCardIds: [],
      resetCardIds: [],
    }, { context: { ...ada.context, removeAudio } });

    expect(result.cards[0]).toMatchObject({
      id: before.id,
      due,
      stability: 12.5,
      difficulty: 6.25,
      elapsedDays: 14,
      scheduledDays: 21,
      learningSteps: 3,
      reps: 8,
      lapses: 2,
      state: 2,
      lastReview,
      suspended: true,
      hasAudio: true,
      audioStatus: "ready",
    });
    expect(
      await server.db.select().from(reviewLogs).where(
        eq(reviewLogs.cardId, before.id),
      ),
    ).toHaveLength(1);
    expect(removeAudio).not.toHaveBeenCalled();
  });

  it("invalidates stale speech and starts replacement generation after commit", async () => {
    const ada = await server.signIn("replace-audio@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );
    const [before] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    const audioPath = `${ada.userId}/${before.id}.mp3`;
    await server.db.update(cards).set({
      audioPath,
      audioStatus: "ready",
    }).where(eq(cards.id, before.id));
    generateNoteAudioMock.mockClear();
    const removeAudio = vi.fn(async () => {});

    const result = await call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 0,
      creates: [],
      updates: [{
        cardId: before.id,
        card: {
          ...AUDIO_CARD,
          front: "Ich esse {{c1::Äpfel::jabłka}} zum Frühstück.",
        },
      }],
      deleteCardIds: [],
      resetCardIds: [],
    }, { context: { ...ada.context, removeAudio } });

    expect(result.cards[0]).toMatchObject({
      id: before.id,
      hasAudio: false,
      audioStatus: "pending",
    });
    expect(removeAudio).toHaveBeenCalledWith(audioPath);
    expect(generateNoteAudioMock).toHaveBeenCalledWith(
      server.db,
      ada.userId,
      [before.id],
    );
  });

  it("returns its committed snapshot when cleanup overlaps a second update", async () => {
    const ada = await server.signIn("snapshot-update@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );
    const [before] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    await server.db.update(cards).set({
      audioPath: `${ada.userId}/${before.id}.mp3`,
      audioStatus: "ready",
    }).where(eq(cards.id, before.id));
    const cleanupStarted = deferred();
    const cleanupGate = deferred();
    const removeAudio = vi.fn(async () => {
      cleanupStarted.release();
      await cleanupGate.promise;
    });
    const firstCard = {
      ...AUDIO_CARD,
      front: "Ich esse {{c1::Äpfel::jabłka}} zum Frühstück.",
    };
    const secondCard = {
      ...AUDIO_CARD,
      front: "Ich esse {{c1::Birnen::gruszki}} zum Frühstück.",
    };

    const firstRun = call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 0,
      creates: [],
      updates: [{ cardId: before.id, card: firstCard }],
      deleteCardIds: [],
      resetCardIds: [],
    }, { context: { ...ada.context, removeAudio } });
    await cleanupStarted.promise;

    const second = await call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 1,
      creates: [],
      updates: [{ cardId: before.id, card: secondCard }],
      deleteCardIds: [],
      resetCardIds: [],
    }, { context: ada.context });
    expect(second.note.revision).toBe(2);

    cleanupGate.release();
    const first = await firstRun;
    expect(first.note.revision).toBe(1);
    expect(first.cards[0].front).toBe(firstCard.front);
  });

  it("returns its committed snapshot when cleanup overlaps deletion", async () => {
    const ada = await server.signIn("snapshot-delete@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );
    const [before] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    await server.db.update(cards).set({
      audioPath: `${ada.userId}/${before.id}.mp3`,
      audioStatus: "ready",
    }).where(eq(cards.id, before.id));
    const cleanupStarted = deferred();
    const cleanupGate = deferred();
    const removeAudio = vi.fn(async () => {
      cleanupStarted.release();
      await cleanupGate.promise;
    });
    const firstCard = {
      ...AUDIO_CARD,
      front: "Ich esse {{c1::Äpfel::jabłka}} zum Frühstück.",
    };

    const firstRun = call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 0,
      creates: [],
      updates: [{ cardId: before.id, card: firstCard }],
      deleteCardIds: [],
      resetCardIds: [],
    }, { context: { ...ada.context, removeAudio } });
    await cleanupStarted.promise;

    await call(notesRouter.delete, {
      noteId: note.id,
      expectedRevision: 1,
    }, { context: ada.context });
    cleanupGate.release();

    const first = await firstRun;
    expect(first.note.revision).toBe(1);
    expect(first.cards[0].front).toBe(firstCard.front);
  });

  it("deletes the only card while retaining the note and tolerating cleanup failure", async () => {
    const ada = await server.signIn("delete-only-card@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );
    const [before] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    const audioPath = `${ada.userId}/${before.id}.mp3`;
    await server.db.update(cards).set({ audioPath, audioStatus: "ready" }).where(
      eq(cards.id, before.id),
    );
    const removeAudio = vi.fn(async () => {
      throw new Error("simulated audio cleanup failure");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 0,
      creates: [],
      updates: [],
      deleteCardIds: [before.id],
      resetCardIds: [],
    }, { context: { ...ada.context, removeAudio } });

    expect(result.note).toMatchObject({ id: note.id, revision: 1 });
    expect(result.cards).toEqual([]);
    expect(
      await server.db.select().from(notes).where(eq(notes.id, note.id)),
    ).toHaveLength(1);
    expect(removeAudio).toHaveBeenCalledWith(audioPath);
    expect(error).toHaveBeenCalledWith(
      "note card audio cleanup failed",
      audioPath,
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("rejects a stale revision without changing any row", async () => {
    const ada = await server.signIn("stale-update@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );
    const beforeCards = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );

    await expect(call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 1,
      creates: [{ clientKey: "stale-create", card: CARDS[0] }],
      updates: [{
        cardId: beforeCards[0].id,
        card: { ...CARDS[0], front: "stale correction" },
      }],
      deleteCardIds: [beforeCards[1].id],
      resetCardIds: [],
    }, { context: ada.context })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(
      await server.db.select().from(cards).where(eq(cards.noteId, note.id)),
    ).toEqual(beforeCards);
    expect(
      await server.db.select().from(notes).where(eq(notes.id, note.id)),
    ).toEqual([note]);
  });

  it("reports another user's note and card IDs as missing", async () => {
    const ada = await server.signIn("owned-update@example.com");
    const bob = await server.signIn("foreign-update@example.com");
    const adaDraft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const bobDraft = await seedDraft(bob.context, bob.userId, {
      imagePrompt: null,
    });
    const adaNote = await call(
      notesRouter.save,
      { draftId: adaDraft.id, cards: CARDS },
      { context: ada.context },
    );
    const bobNote = await call(
      notesRouter.save,
      { draftId: bobDraft.id, cards: CARDS },
      { context: bob.context },
    );
    const [bobCard] = await server.db.select().from(cards).where(
      eq(cards.noteId, bobNote.id),
    );

    await expect(call(notesRouter.update, {
      noteId: bobNote.id,
      expectedRevision: 0,
      creates: [],
      updates: [{ cardId: bobCard.id, card: CARDS[0] }],
      deleteCardIds: [],
      resetCardIds: [],
    }, { context: ada.context })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(call(notesRouter.update, {
      noteId: adaNote.id,
      expectedRevision: 0,
      creates: [],
      updates: [{ cardId: bobCard.id, card: CARDS[0] }],
      deleteCardIds: [],
      resetCardIds: [],
    }, { context: ada.context })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each([
    {
      name: "updated card",
      creates: [],
      updates: (cardId: string) => [{
        cardId,
        card: {
          aspect: "production",
          front: "Broken {{c1::}} cloze",
          back: null,
          imageCue: false,
        },
      }],
      identity: (cardId: string) => ({ cardId, field: "front" }),
    },
    {
      name: "created card",
      creates: [{
        clientKey: "image-without-hint",
        card: {
          aspect: "production",
          front: "Ich esse {{c1::Äpfel}}.",
          back: null,
          imageCue: true,
        },
      }],
      updates: () => [],
      identity: () => ({ clientKey: "image-without-hint", field: "front" }),
    },
    {
      name: "updated basic card with a whitespace-only answer",
      creates: [],
      updates: (cardId: string) => [{
        cardId,
        card: {
          aspect: "meaning",
          front: "Poseidon",
          back: "   ",
          imageCue: false,
        },
      }],
      identity: (cardId: string) => ({ cardId, field: "back" }),
    },
    {
      name: "created basic card with a whitespace-only answer",
      creates: [{
        clientKey: "blank-basic-answer",
        card: {
          aspect: "meaning",
          front: "Poseidon",
          back: "   ",
          imageCue: false,
        },
      }],
      updates: () => [],
      identity: () => ({ clientKey: "blank-basic-answer", field: "back" }),
    },
  ])("returns card-local validation data for an invalid $name", async ({
    creates,
    updates,
    identity,
  }) => {
    const ada = await server.signIn("invalid-card@example.com");
    const draft = await seedDraft(ada.context, ada.userId);
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );
    const [before] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );

    await expect(call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 0,
      creates,
      updates: updates(before.id),
      deleteCardIds: [],
      resetCardIds: [],
    }, { context: ada.context })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: identity(before.id),
    });
  });

  it("rolls back create, update, reset, and revision when deletion fails", async () => {
    const ada = await server.signIn("rollback-update@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );
    const beforeCards = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    await server.db.update(cards).set({
      due: new Date(99),
      stability: 4,
      difficulty: 5,
      elapsedDays: 6,
      scheduledDays: 7,
      learningSteps: 1,
      reps: 8,
      lapses: 2,
      state: 2,
      lastReview: new Date(98),
    }).where(eq(cards.id, beforeCards[0].id));
    await server.db.insert(reviewLogs).values({
      cardId: beforeCards[0].id,
      userId: ada.userId,
      rating: 3,
      state: 2,
      due: new Date(99),
      stability: 4,
      difficulty: 5,
      elapsedDays: 6,
      lastElapsedDays: 6,
      scheduledDays: 7,
      learningSteps: 1,
      review: new Date(98),
    });
    const persistedBefore = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    const context = {
      ...ada.context,
      db: failingDeleteFrom(server.db, cards),
    };

    await expect(call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 0,
      creates: [{ clientKey: "rolled-back", card: CARDS[0] }],
      updates: [{
        cardId: beforeCards[0].id,
        card: { ...CARDS[0], front: "must roll back" },
      }],
      deleteCardIds: [beforeCards[1].id],
      resetCardIds: [beforeCards[0].id],
    }, { context })).rejects.toThrow("simulated delete failure");

    expect(
      await server.db.select().from(cards).where(eq(cards.noteId, note.id)),
    ).toEqual(persistedBefore);
    expect(
      await server.db.select().from(reviewLogs).where(
        eq(reviewLogs.cardId, beforeCards[0].id),
      ),
    ).toHaveLength(1);
    expect(
      await server.db.select().from(notes).where(eq(notes.id, note.id)),
    ).toEqual([note]);
  });
});

describe("notes.delete", () => {
  it("deletes an owned note, its cards and review logs, then cleans up stored media", async () => {
    const ada = await server.signIn("delete-note@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );
    const [card] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    const imagePath = `${ada.userId}/${note.id}.png`;
    const audioPath = `${ada.userId}/${card.id}.mp3`;
    await server.db.update(notes).set({ imagePath }).where(
      eq(notes.id, note.id),
    );
    await server.db.update(cards).set({ audioPath }).where(
      eq(cards.id, card.id),
    );
    await server.db.insert(reviewLogs).values({
      cardId: card.id,
      userId: ada.userId,
      rating: 3,
      state: 2,
      due: new Date(10),
      stability: 4,
      difficulty: 5,
      elapsedDays: 6,
      lastElapsedDays: 6,
      scheduledDays: 7,
      learningSteps: 1,
      review: new Date(9),
    });
    const removeImage = vi.fn(async () => undefined);
    const removeAudio = vi.fn(async () => undefined);

    const result = await call(notesRouter.delete, {
      noteId: note.id,
      expectedRevision: 0,
    }, { context: { ...ada.context, removeImage, removeAudio } });

    expect(result).toEqual({ id: note.id, deckId: draft.deckId });
    expect(
      await server.db.select().from(notes).where(eq(notes.id, note.id)),
    ).toHaveLength(0);
    expect(
      await server.db.select().from(cards).where(eq(cards.noteId, note.id)),
    ).toHaveLength(0);
    expect(
      await server.db
        .select()
        .from(reviewLogs)
        .where(eq(reviewLogs.cardId, card.id)),
    ).toHaveLength(0);
    expect(removeImage).toHaveBeenCalledWith(imagePath);
    expect(removeAudio).toHaveBeenCalledWith(audioPath);
  });

  it("reports another user's note as missing", async () => {
    const ada = await server.signIn("delete-owner@example.com");
    const bob = await server.signIn("delete-foreign@example.com");
    const draft = await seedDraft(bob.context, bob.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: bob.context },
    );

    await expect(call(notesRouter.delete, {
      noteId: note.id,
      expectedRevision: 0,
    }, { context: ada.context })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      await server.db.select().from(notes).where(eq(notes.id, note.id)),
    ).toHaveLength(1);
  });

  it("rejects a stale revision before deleting data or media", async () => {
    const ada = await server.signIn("delete-stale@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );
    const [card] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    const imagePath = `${ada.userId}/${note.id}.png`;
    const audioPath = `${ada.userId}/${card.id}.mp3`;
    await server.db.update(notes).set({ imagePath, revision: 1 }).where(
      eq(notes.id, note.id),
    );
    await server.db.update(cards).set({ audioPath }).where(
      eq(cards.id, card.id),
    );
    const removeImage = vi.fn(async () => undefined);
    const removeAudio = vi.fn(async () => undefined);

    await expect(call(notesRouter.delete, {
      noteId: note.id,
      expectedRevision: 0,
    }, { context: { ...ada.context, removeImage, removeAudio } }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    expect(
      await server.db.select().from(notes).where(eq(notes.id, note.id)),
    ).toHaveLength(1);
    expect(
      await server.db.select().from(cards).where(eq(cards.noteId, note.id)),
    ).toHaveLength(1);
    expect(removeImage).not.toHaveBeenCalled();
    expect(removeAudio).not.toHaveBeenCalled();
  });

  it("keeps a committed deletion when media cleanup fails", async () => {
    const ada = await server.signIn("delete-cleanup@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );
    const [card] = await server.db.select().from(cards).where(
      eq(cards.noteId, note.id),
    );
    await server.db.update(notes).set({
      imagePath: `${ada.userId}/${note.id}.png`,
    }).where(eq(notes.id, note.id));
    await server.db.update(cards).set({
      audioPath: `${ada.userId}/${card.id}.mp3`,
    }).where(eq(cards.id, card.id));
    const removeImage = vi.fn(async () => {
      throw new Error("simulated image cleanup failure");
    });
    const removeAudio = vi.fn(async () => {
      throw new Error("simulated audio cleanup failure");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await call(notesRouter.delete, {
      noteId: note.id,
      expectedRevision: 0,
    }, { context: { ...ada.context, removeImage, removeAudio } });

    expect(result).toEqual({ id: note.id, deckId: draft.deckId });
    expect(
      await server.db.select().from(notes).where(eq(notes.id, note.id)),
    ).toHaveLength(0);
    expect(
      await server.db.select().from(cards).where(eq(cards.noteId, note.id)),
    ).toHaveLength(0);
    expect(removeImage).toHaveBeenCalledOnce();
    expect(removeAudio).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "note media cleanup failed",
      expect.any(Error),
    );
    error.mockRestore();
  });
});

describe("notes.listByDeck", () => {
  it("returns the deck's notes newest first", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    for (const text of ["first", "second"]) {
      const [draft] = await server.db
        .insert(drafts)
        .values({
          userId: ada.userId,
          deckId: deck.id,
          sourceText: text,
          status: "ready",
          classification: CLASSIFICATION,
          cards: CARDS,
          imagePrompt: null,
        })
        .returning();

      await call(
        notesRouter.save,
        { draftId: draft.id, cards: CARDS },
        { context: ada.context },
      );
    }

    const list = await call(
      notesRouter.listByDeck,
      { deckId: deck.id },
      { context: ada.context },
    );
    expect(list.map((n) => n.sourceText)).toEqual(["second", "first"]);
  });

  it("refuses another user's deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const bobDeck = await call(
      decksRouter.create,
      { name: "Bob's" },
      { context: bob.context },
    );

    await expect(
      call(
        notesRouter.listByDeck,
        { deckId: bobDeck.id },
        { context: ada.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps a note out of another user's view even if its userId is wrong", async () => {
    // listByDeck filters on notes.userId as well as deck ownership. Under the
    // current write path a note's deckId already implies its owner, so that
    // clause is defence in depth — this pins it so a future refactor cannot
    // quietly drop it.
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    await server.db.insert(notes).values({
      userId: bob.userId,
      deckId: deck.id,
      sourceText: "bob's row in ada's deck",
      domain: "concept",
      metadata: {},
    });

    const list = await call(
      notesRouter.listByDeck,
      { deckId: deck.id },
      { context: ada.context },
    );
    expect(list).toHaveLength(0);
  });
});

describe("notes.get", () => {
  it("returns the owning deck's pronunciation speed", async () => {
    const ada = await server.signIn("note-speed@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const saved = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );
    await server.db.update(decks).set({ pronunciationSpeed: "slow" }).where(
      eq(decks.id, saved.deckId),
    );

    const result = await call(notesRouter.get, { noteId: saved.id }, {
      context: ada.context,
    });

    expect(result.pronunciationSpeed).toBe("slow");
  });

  it("holds a consistent read snapshot without blocking a concurrent update", async () => {
    await server.client.execute("PRAGMA journal_mode = WAL");
    const ada = await server.signIn("read-snapshot@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const saved = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );
    const savedCards = await server.db.select().from(cards).where(
      eq(cards.noteId, saved.id),
    );
    const meaning = savedCards.find((card) => card.aspect === "meaning");
    if (!meaning) throw new Error("Expected the saved meaning card");

    const snapshotStarted = deferred();
    const snapshotGate = deferred();
    const gatedClient = new Proxy(server.client, {
      get(target, property) {
        if (property === "transaction") {
          return async (mode?: TransactionMode) => {
            const transaction = await target.transaction(mode);
            let firstRead = true;
            return new Proxy(transaction, {
              get(transactionTarget, transactionProperty) {
                if (transactionProperty === "execute") {
                  return async (statement: InStatement) => {
                    const result = await transactionTarget.execute(statement);
                    if (firstRead) {
                      firstRead = false;
                      // The first SELECT has executed, so SQLite has fixed the
                      // snapshot. Hold it before the card SELECT while another
                      // real connection commits the update.
                      snapshotStarted.release();
                      await snapshotGate.promise;
                    }
                    return result;
                  };
                }
                const member = Reflect.get(
                  transactionTarget,
                  transactionProperty,
                  transactionTarget,
                );
                return typeof member === "function"
                  ? member.bind(transactionTarget)
                  : member;
              },
            });
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const readDb = drizzle({ client: gatedClient, schema });
    const readRun = call(
      notesRouter.get,
      { noteId: saved.id },
      { context: { ...ada.context, db: readDb } },
    );
    await snapshotStarted.promise;

    const changedCard = {
      aspect: meaning.aspect,
      front: "die Frucht",
      back: "fruit",
      imageCue: false,
    };
    const updateOutcome = await call(notesRouter.update, {
      noteId: saved.id,
      expectedRevision: 0,
      creates: [],
      updates: [{ cardId: meaning.id, card: changedCard }],
      deleteCardIds: [],
      resetCardIds: [],
    }, { context: ada.context }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    snapshotGate.release();
    const snapshot = await readRun;
    if ("error" in updateOutcome) throw updateOutcome.error;

    expect(updateOutcome.result.note.revision).toBe(1);
    expect(updateOutcome.result.cards.find((card) => card.id === meaning.id))
      .toMatchObject(changedCard);
    expect(snapshot.note.revision).toBe(0);
    expect(snapshot.cards.find((card) => card.id === meaning.id)).toMatchObject({
      front: meaning.front,
      back: meaning.back,
    });
  });

  it("returns revision and cards in stable creation order instead of due order", async () => {
    const ada = await server.signIn("stable-order@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const saved = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );
    const rows = await server.db
      .select()
      .from(cards)
      .where(eq(cards.noteId, saved.id));
    const meaning = rows.find((card) => card.aspect === "meaning");
    const gender = rows.find((card) => card.aspect === "gender");
    if (!meaning || !gender) throw new Error("Expected both saved cards");
    await server.db
      .update(cards)
      .set({ createdAt: new Date(1_000), due: new Date(2_000) })
      .where(eq(cards.id, meaning.id));
    await server.db
      .update(cards)
      .set({ createdAt: new Date(2_000), due: new Date(1_000) })
      .where(eq(cards.id, gender.id));

    const result = await call(
      notesRouter.get,
      { noteId: saved.id },
      { context: ada.context },
    );

    expect(result.note.revision).toBe(0);
    expect(result.cards.map((card) => card.aspect)).toEqual([
      "meaning",
      "gender",
    ]);
    expect(result.cards.map((card) => card.cardType)).toEqual(["basic", "basic"]);
  });

  it("returns sanitized audio state and resumes orphaned work", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });
    const saved = await call(
      notesRouter.save,
      { draftId: draft.id, cards: [AUDIO_CARD] },
      { context: ada.context },
    );

    const result = await call(notesRouter.get, { noteId: saved.id }, {
      context: ada.context,
    });

    expect(result.cards[0]).toMatchObject({
      hasAudio: false,
      audioStatus: "pending",
      audioEligible: true,
    });
    expect(result.cards[0]).not.toHaveProperty("audioPath");
    expect(resumeOrphanedAudioMock).toHaveBeenCalledWith(
      server.db,
      ada.userId,
      expect.arrayContaining([
        expect.objectContaining({
          id: result.cards[0].id,
          audioStatus: "pending",
        }),
      ]),
    );
  });

  it("returns the note with its cards", async () => {
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imagePrompt: null,
    });

    const saved = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: ada.context },
    );

    const result = await call(notesRouter.get, { noteId: saved.id }, {
      context: ada.context,
    });

    expect(result.note.sourceText).toBe("die Banane");
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].aspect).toBe("meaning");
  });

  it("reports another user's note as missing", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const draft = await seedDraft(bob.context, bob.userId, {
      imagePrompt: null,
    });
    const bobNote = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: bob.context },
    );

    await expect(
      call(notesRouter.get, { noteId: bobNote.id }, { context: ada.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports imageGenerating while a redirected job is still rendering the picture", async () => {
    // Issue #27: a note saved mid-generation looks identical to one whose
    // picture genuinely never arrived — `imagePath` is null either way. This
    // is what lets the note screen tell "still running in the background"
    // apart from "failed, offer a retry".
    const ada = await server.signIn("ada@example.com");
    const draft = await seedDraft(ada.context, ada.userId, {
      imageStatus: "none",
      draftImageId: null,
    });
    const gate = deferred();
    const claimDraftImage = vi.fn(async (
      u: string,
      _d: string,
      noteId: string,
    ) => `${u}/${noteId}.png`);
    const jobDeps: JobDeps = {
      db: server.db,
      modelCalls: UNUSED_MODEL_CALLS,
      generateImageBytes: vi.fn(async () => {
        await gate.promise;
        return new Uint8Array([1]);
      }),
      writeDraftImage: vi.fn(async () => "img-live"),
      claimDraftImage,
      removeImage: vi.fn(async () => {}),
      removeDraftImage: vi.fn(async () => {}),
    };
    const run = startImageJob(jobDeps, draft);

    await vi.waitFor(async () => {
      const [row] = await server.db.select().from(drafts).where(
        eq(drafts.id, draft.id),
      );
      expect(row.imageStatus).toBe("generating");
    });

    const note = await call(
      notesRouter.save,
      { draftId: draft.id, cards: CARDS },
      { context: { ...ada.context, claimDraftImage } },
    );

    const whileRendering = await call(
      notesRouter.get,
      { noteId: note.id },
      { context: ada.context },
    );
    expect(whileRendering.imageGenerating).toBe(true);
    expect(whileRendering.note.imagePath).toBeNull();

    gate.release();
    await run;

    const afterSettled = await call(
      notesRouter.get,
      { noteId: note.id },
      { context: ada.context },
    );
    expect(afterSettled.imageGenerating).toBe(false);
    expect(afterSettled.note.imagePath).toBe(`${ada.userId}/${note.id}.png`);
  });
});
