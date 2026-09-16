import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { createTestServer } from "./testing.ts";
import { decksRouter } from "./decks.ts";
import {
  cards,
  creationImageAttempts,
  decks,
  drafts,
  notes,
  reviewLogs,
} from "../db/schema.ts";
import type { AppContext } from "./base.ts";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => {
  server.close();
});

const CLASSIFICATION = {
  domain: "language",
  language: "de",
  partOfSpeech: null,
} as const;

async function seedDeckContents(
  context: AppContext,
  userId: string,
  overrides: {
    deckName?: string;
    imagePath?: string | null;
    audioPath?: string | null;
    draftImageId?: string | null;
    withDraft?: boolean;
  } = {},
) {
  const deck = await call(
    decksRouter.create,
    { name: overrides.deckName ?? "German" },
    { context },
  );
  const [note] = await server.db.insert(notes).values({
    userId,
    deckId: deck.id,
    sourceText: "die Banane",
    domain: "language",
    language: "de",
    metadata: {},
    imagePath: overrides.imagePath ?? null,
  }).returning();
  const [card] = await server.db.insert(cards).values({
    noteId: note.id,
    userId,
    aspect: "production",
    front: "Ich mag {{c1::Bananen::bananas}}.",
    back: null,
    cardType: "cloze",
    imageCue: false,
    audioPath: overrides.audioPath ?? null,
    audioStatus: overrides.audioPath ? "ready" : null,
    due: new Date("2026-08-12T00:00:00.000Z"),
  }).returning();
  const [reviewLog] = await server.db.insert(reviewLogs).values({
    cardId: card.id,
    userId,
    rating: 3,
    state: 0,
    due: new Date("2026-08-12T00:00:00.000Z"),
    stability: 3.5,
    difficulty: 5.1,
    elapsedDays: 0,
    lastElapsedDays: 0,
    scheduledDays: 1,
    learningSteps: 1,
    review: new Date("2026-08-12T00:00:00.000Z"),
  }).returning();
  const [draft] = overrides.withDraft === false
    ? [null]
    : await server.db.insert(drafts).values({
      userId,
      deckId: deck.id,
      sourceText: "die Banane",
      status: "ready",
      classification: CLASSIFICATION,
      cards: [],
      imagePrompt: overrides.draftImageId ? "a banana" : null,
      imageStatus: overrides.draftImageId ? "ready" : "none",
      draftImageId: overrides.draftImageId ?? null,
    }).returning();

  return { deck, note, card, reviewLog, draft };
}

describe("decks.create", () => {
  it("stores the deck under the session's user", async () => {
    const ada = await server.signIn("ada@example.com");

    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    expect(deck.name).toBe("German");
    expect(deck.userId).toBe(ada.userId);
    expect(deck.description).toBeNull();
    expect(deck.pronunciationSpeed).toBe("normal");
  });

  it("ignores a userId smuggled into the input", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");

    const deck = await call(
      decksRouter.create,
      // The input schema has no userId, so this is stripped by validation
      // rather than trusted. Cast because it is deliberately off-contract.
      { name: "German", userId: bob.userId } as { name: string },
      { context: ada.context },
    );

    expect(deck.userId).toBe(ada.userId);
  });

  it("rejects an empty name", async () => {
    const ada = await server.signIn("ada@example.com");
    await expect(
      call(decksRouter.create, { name: "" }, { context: ada.context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("decks.updatePronunciationSpeed", () => {
  it("persists the selected speed for the session user's deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });

    const updated = await call(
      decksRouter.updatePronunciationSpeed,
      { deckId: deck.id, pronunciationSpeed: "slow" },
      { context: ada.context },
    );

    expect(updated.pronunciationSpeed).toBe("slow");
    expect(
      (await server.db.select().from(decks).where(eq(decks.id, deck.id)))[0]
        .pronunciationSpeed,
    ).toBe("slow");
  });

  it("does not update another user's deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const deck = await call(decksRouter.create, { name: "German" }, {
      context: bob.context,
    });

    await expect(
      call(
        decksRouter.updatePronunciationSpeed,
        { deckId: deck.id, pronunciationSpeed: "slow" },
        { context: ada.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      (await server.db.select().from(decks).where(eq(decks.id, deck.id)))[0]
        .pronunciationSpeed,
    ).toBe("normal");
  });
});

describe("decks.remove", () => {
  it("removes saved deck content while preserving its creation for rerouting", async () => {
    const ada = await server.signIn("ada@example.com");
    const { deck, note, card, reviewLog, draft } = await seedDeckContents(
      ada.context,
      ada.userId,
    );

    await expect(
      call(decksRouter.remove, { deckId: deck.id }, { context: ada.context }),
    ).resolves.toEqual({ id: deck.id });

    expect(
      await server.db.select().from(decks).where(eq(decks.id, deck.id)),
    ).toHaveLength(0);
    expect(
      await server.db.select().from(notes).where(eq(notes.id, note.id)),
    ).toHaveLength(0);
    expect(
      await server.db.select().from(cards).where(eq(cards.id, card.id)),
    ).toHaveLength(0);
    expect(
      await server.db.select().from(reviewLogs).where(
        eq(reviewLogs.id, reviewLog.id),
      ),
    ).toHaveLength(0);
    if (draft) {
      const preserved =
        await server.db.select().from(drafts).where(eq(drafts.id, draft.id));
      expect(preserved).toHaveLength(1);
      expect(preserved[0]).toMatchObject({
        id: draft.id,
        deckId: null,
        draftImageId: draft.draftImageId,
        status: "queued",
        operation: "route_generate",
        revision: 1,
      });
    }
  });

  it("invalidates ambiguous candidates that reference the deleted deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const removed = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const survivor = await call(decksRouter.create, { name: "Ideas" }, {
      context: ada.context,
    });
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      sourceText: "ambiguous",
      status: "needs_choice",
      operation: null,
      routing: {
        kind: "ambiguous",
        candidates: [
          { deckId: removed.id, learningGoal: "Produce German." },
          { deckId: survivor.id, learningGoal: "Understand the idea." },
        ],
      },
    }).returning();

    await call(decksRouter.remove, { deckId: removed.id }, {
      context: ada.context,
    });

    expect((await server.db.select().from(drafts)
      .where(eq(drafts.id, creation.id)))[0]).toMatchObject({
        status: "queued",
        operation: "route_generate",
        routing: null,
        revision: 1,
      });
  });

  it("keeps reviewed failed content but requires a new deck choice", async () => {
    const ada = await server.signIn("ada@example.com");
    const removed = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      deckId: removed.id,
      sourceText: "reviewed",
      status: "failed",
      operation: null,
      cards: [{
        key: "reviewed-1",
        aspect: "meaning",
        front: "die Banane",
        back: "banana",
        imageCue: false,
      }],
      errorCategory: "generation_failed",
      errorStage: "cards",
      error: "Generation failed.",
    }).returning();

    await call(decksRouter.remove, { deckId: removed.id }, {
      context: ada.context,
    });

    expect((await server.db.select().from(drafts)
      .where(eq(drafts.id, creation.id)))[0]).toMatchObject({
        status: "failed",
        operation: null,
        deckId: null,
        cards: creation.cards,
        errorCategory: "routing_failed",
        errorStage: "routing",
        revision: 1,
      });
  });

  it("cancels a deleted regeneration target without moving reviewed content", async () => {
    const ada = await server.signIn("ada@example.com");
    const current = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const target = await call(decksRouter.create, { name: "Ideas" }, {
      context: ada.context,
    });
    const reviewed = [{
      key: "reviewed",
      aspect: "meaning",
      front: "die Banane",
      back: "banana",
      imageCue: false,
    }];
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      deckId: current.id,
      targetDeckId: target.id,
      targetLearningGoal: "Understand the idea.",
      sourceText: "die Banane",
      status: "regenerating",
      operation: "regenerate",
      activeAttemptId: "attempt-old",
      leaseOwner: "worker-old",
      cards: reviewed,
    }).returning();

    await call(decksRouter.remove, { deckId: target.id }, {
      context: ada.context,
    });

    expect((await server.db.select().from(drafts)
      .where(eq(drafts.id, creation.id)))[0]).toMatchObject({
        status: "failed",
        operation: null,
        deckId: current.id,
        targetDeckId: null,
        targetLearningGoal: null,
        activeAttemptId: null,
        cards: reviewed,
        errorCategory: "routing_failed",
        errorStage: "routing",
      });
  });

  it("fences and removes a rerouted creation image", async () => {
    const ada = await server.signIn("ada@example.com");
    const removedDraftImages: string[] = [];
    const removed = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      deckId: removed.id,
      sourceText: "with image",
      status: "ready",
      operation: null,
      imagePrompt: "a banana",
      imageStatus: "ready",
      draftImageId: "draft-image-1",
    }).returning();
    const [attempt] = await server.db.insert(creationImageAttempts).values({
      userId: ada.userId,
      creationId: creation.id,
      prompt: "a banana",
      status: "ready",
      draftImageId: "draft-image-1",
    }).returning();
    await server.db.update(drafts).set({ imageAttemptId: attempt.id })
      .where(eq(drafts.id, creation.id));

    await call(decksRouter.remove, { deckId: removed.id }, {
      context: {
        ...ada.context,
        removeDraftImage: async (_userId, draftImageId) => {
          removedDraftImages.push(draftImageId);
        },
      },
    });

    expect((await server.db.select().from(drafts)
      .where(eq(drafts.id, creation.id)))[0]).toMatchObject({
        status: "queued",
        imageAttemptId: null,
        imagePrompt: null,
        imageStatus: "none",
        draftImageId: null,
      });
    expect((await server.db.select().from(creationImageAttempts)
      .where(eq(creationImageAttempts.id, attempt.id)))[0]).toMatchObject({
        status: "canceled",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    expect(removedDraftImages).toEqual(["draft-image-1"]);
  });

  it("rejects another user's deck as not found", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const bobDeck = await call(
      decksRouter.create,
      { name: "Bob's deck" },
      { context: bob.context },
    );

    await expect(
      call(decksRouter.remove, { deckId: bobDeck.id }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a missing deck id as not found", async () => {
    const ada = await server.signIn("ada@example.com");

    await expect(
      call(decksRouter.remove, { deckId: uuidv7() }, { context: ada.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cleans up only the deleted deck's owned media paths", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const removedImagePaths: string[] = [];
    const removedAudioPaths: string[] = [];
    const removedDraftImageIds: string[] = [];
    const imagePath = `${ada.userId}/deck-note.png`;
    const audioPath = `${ada.userId}/deck-card.mp3`;
    const draftImageId = "draft-image-target";
    const survivorImagePath = `${ada.userId}/survivor-note.png`;
    const survivorAudioPath = `${ada.userId}/survivor-card.mp3`;
    const bobImagePath = `${bob.userId}/bob-note.png`;
    const bobAudioPath = `${bob.userId}/bob-card.mp3`;

    const context = {
      ...ada.context,
      removeImage: vi.fn(async (path: string) => {
        removedImagePaths.push(path);
      }),
      removeAudio: vi.fn(async (path: string) => {
        removedAudioPaths.push(path);
      }),
      removeDraftImage: vi.fn(async (_userId: string, draftImageId: string) => {
        removedDraftImageIds.push(draftImageId);
      }),
    };
    const { deck } = await seedDeckContents(context, ada.userId, {
      imagePath,
      audioPath,
      draftImageId,
    });
    await seedDeckContents(ada.context, ada.userId, {
      deckName: "Survivor",
      imagePath: survivorImagePath,
      audioPath: survivorAudioPath,
      withDraft: false,
    });
    await seedDeckContents(bob.context, bob.userId, {
      deckName: "Bob",
      imagePath: bobImagePath,
      audioPath: bobAudioPath,
      draftImageId: "draft-image-bob",
    });

    await expect(
      call(decksRouter.remove, { deckId: deck.id }, { context }),
    ).resolves.toEqual({ id: deck.id });

    expect(removedImagePaths).toEqual([imagePath]);
    expect(removedAudioPaths).toEqual([audioPath]);
    expect(removedDraftImageIds).toEqual([draftImageId]);
  });

  it("keeps the deletion committed when media cleanup rejects", async () => {
    const ada = await server.signIn("ada@example.com");
    const imagePath = `${ada.userId}/deck-note.png`;
    const audioPath = `${ada.userId}/deck-card.mp3`;
    const draftImageId = "draft-image-target";
    const { deck } = await seedDeckContents(ada.context, ada.userId, {
      imagePath,
      audioPath,
      draftImageId,
    });

    const context = {
      ...ada.context,
      removeImage: vi.fn(async (path: string) => {
        throw new Error(`remove image failed for ${path}`);
      }),
      removeAudio: vi.fn(async (path: string) => {
        throw new Error(`remove audio failed for ${path}`);
      }),
    };

    await expect(
      call(decksRouter.remove, { deckId: deck.id }, { context }),
    ).resolves.toEqual({ id: deck.id });

    expect(
      await server.db.select().from(decks).where(eq(decks.id, deck.id)),
    ).toHaveLength(0);
  });
});

describe("decks.list", () => {
  it("returns only the session user's decks", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");

    await call(decksRouter.create, { name: "Ada's" }, { context: ada.context });
    await call(decksRouter.create, { name: "Bob's" }, { context: bob.context });

    const adaDecks = await call(decksRouter.list, {}, { context: ada.context });
    expect(adaDecks.map((d) => d.name)).toEqual(["Ada's"]);

    const bobDecks = await call(decksRouter.list, {}, { context: bob.context });
    expect(bobDecks.map((d) => d.name)).toEqual(["Bob's"]);
  });

  it("returns decks oldest first", async () => {
    const ada = await server.signIn("ada@example.com");
    await call(decksRouter.create, { name: "First" }, { context: ada.context });
    await call(decksRouter.create, { name: "Second" }, { context: ada.context });

    const decks = await call(decksRouter.list, {}, { context: ada.context });
    expect(decks.map((d) => d.name)).toEqual(["First", "Second"]);
  });

  it("returns createdAt as a Date", async () => {
    const ada = await server.signIn("ada@example.com");
    await call(decksRouter.create, { name: "German" }, { context: ada.context });

    const [deck] = await call(decksRouter.list, {}, { context: ada.context });
    expect(deck.createdAt).toBeInstanceOf(Date);
  });
});
