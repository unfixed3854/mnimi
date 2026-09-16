import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { createTestServer, failingInsertInto } from "./testing.ts";
import { decksRouter } from "./decks.ts";
import { draftsRouter } from "./drafts.ts";
import { decks, drafts } from "../db/schema.ts";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => server = await createTestServer());
afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

const CARD = {
  key: "card-1",
  aspect: "meaning",
  front: "die Banane",
  back: "banana",
  imageCue: false,
};

describe("creation submission and inbox", () => {
  it("trims accepted input and rejects empty or over-limit input without insertion", async () => {
    const ada = await server.signIn("ada@example.com");

    for (const text of ["   ", "x".repeat(2_001)]) {
      await expect(call(draftsRouter.submit, {
        clientRequestId: `request-${text.length}`,
        text,
      }, { context: ada.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await server.db.select().from(drafts)).toHaveLength(0);

    const result = await call(draftsRouter.submit, {
      clientRequestId: "request-valid",
      text: "  die Banane  ",
    }, { context: ada.context });
    expect(result).toMatchObject({ clientRequestId: "request-valid" });
    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      sourceText: "die Banane",
      status: "queued",
      operation: "route_generate",
    });
  });

  it("returns one creation for simultaneous retries of one client request", async () => {
    const ada = await server.signIn("ada@example.com");
    const [first, second] = await Promise.all([
      call(draftsRouter.submit, {
        clientRequestId: "same-request",
        text: "first delivery",
      }, { context: ada.context }),
      call(draftsRouter.submit, {
        clientRequestId: "same-request",
        text: "uncertain retry",
      }, { context: ada.context }),
    ]);

    expect(first.creationId).toBe(second.creationId);
    expect(await server.db.select().from(drafts)).toHaveLength(1);
    expect((await server.db.select().from(drafts))[0].sourceText)
      .toBe("first delivery");
  });

  it("accepts three rapid distinct requests and lists grouped summaries only", async () => {
    const ada = await server.signIn("ada@example.com");
    const ids = await Promise.all(["a", "b", "c"].map(async (text) =>
      (await call(draftsRouter.submit, {
        clientRequestId: `request-${text}`,
        text,
      }, { context: ada.context })).creationId));
    await server.db.update(drafts).set({
      status: "ready",
      cards: [CARD],
      classification: { domain: "language", language: "de", partOfSpeech: "noun" },
    }).where(eq(drafts.id, ids[1]));
    await server.db.update(drafts).set({
      status: "needs_choice",
      routing: {
        kind: "newDeck",
        proposedName: "German",
        proposedDescription: "Vocabulary",
        learningGoal: "Produce German vocabulary.",
      },
    }).where(eq(drafts.id, ids[2]));

    const inbox = await call(draftsRouter.list, {}, { context: ada.context });
    expect(inbox.map((item) => item.group)).toEqual([
      "needsChoice",
      "ready",
      "queued",
    ]);
    expect(inbox[0]).not.toHaveProperty("cards");
    expect(inbox[0]).not.toHaveProperty("classification");
    expect(inbox[0]).not.toHaveProperty("leaseOwner");
  });

  it("returns complete detail only to its owner", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const submitted = await call(draftsRouter.submit, {
      clientRequestId: "request-detail",
      text: "die Banane",
    }, { context: ada.context });
    await server.db.update(drafts).set({ status: "ready", cards: [CARD] })
      .where(eq(drafts.id, submitted.creationId));

    await expect(call(draftsRouter.get, {
      creationId: submitted.creationId,
    }, { context: bob.context })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const detail = await call(draftsRouter.get, {
      creationId: submitted.creationId,
    }, { context: ada.context });
    expect(detail.cards).toEqual([CARD]);
    expect(detail).not.toHaveProperty("leaseOwner");
    expect(detail).not.toHaveProperty("classification");
  });

  it("names ambiguous deck candidates in the creation detail response", async () => {
    const ada = await server.signIn("ada@example.com");
    const german = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const greek = await call(decksRouter.create, { name: "Greek" }, {
      context: ada.context,
    });
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-ambiguous-detail",
      sourceText: "Klej w sztyfcie",
      status: "needs_choice",
      operation: null,
      routing: {
        kind: "ambiguous",
        candidates: [
          { deckId: german.id, learningGoal: "Translate 'glue stick' to German." },
          { deckId: greek.id, learningGoal: "Translate 'glue stick' to Greek." },
        ],
      },
    }).returning();

    const detail = await call(draftsRouter.get, {
      creationId: creation.id,
    }, { context: ada.context });

    expect(detail.routing).toEqual({
      kind: "ambiguous",
      candidates: [
        {
          deckId: german.id,
          deckName: "German",
          learningGoal: "Translate 'glue stick' to German.",
        },
        {
          deckId: greek.id,
          deckName: "Greek",
          learningGoal: "Translate 'glue stick' to Greek.",
        },
      ],
    });
  });

  it("starts detail and inbox watches with owner-scoped public snapshots", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const submitted = await call(draftsRouter.submit, {
      clientRequestId: "request-watch",
      text: "watch me",
    }, { context: ada.context });
    const detail = await call(draftsRouter.watch, {
      creationId: submitted.creationId,
    }, { context: ada.context });
    const inbox = await call(draftsRouter.watchInbox, {}, { context: ada.context });

    const firstDetail = await detail.next();
    expect(firstDetail.value).toMatchObject({
      creationId: submitted.creationId,
      creation: { sourceText: "watch me", status: "queued" },
    });
    if (!firstDetail.value || !("creation" in firstDetail.value)) {
      throw new Error("Expected a creation detail snapshot");
    }
    expect(firstDetail.value?.creation).not.toHaveProperty("leaseOwner");
    const firstInbox = await inbox.next();
    expect(firstInbox.value?.creations).toHaveLength(1);
    expect(firstInbox.value?.creations[0]).not.toHaveProperty("cards");

    await expect((async () => {
      for await (const _event of await call(draftsRouter.watch, {
        creationId: submitted.creationId,
      }, { context: bob.context })) { /* drain */ }
    })()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await detail.return(undefined);
    await inbox.return(undefined);
  });

  it("keeps unresolved and removed rows out of the legacy current adapter", async () => {
    const ada = await server.signIn("ada@example.com");
    await server.db.insert(drafts).values([
      {
        userId: ada.userId,
        clientRequestId: "request-choice",
        sourceText: "choice",
        status: "needs_choice",
        operation: null,
      },
      {
        userId: ada.userId,
        clientRequestId: "request-queued",
        sourceText: "queued",
        status: "queued",
        operation: "route_generate",
      },
    ]);

    const legacy = await call(draftsRouter.current, {}, { context: ada.context });
    expect(legacy).toMatchObject({ sourceText: "queued", status: "generating" });
  });
});

describe("creation deck decisions", () => {
  it("resolves an owned candidate revision-safely and requeues generation", async () => {
    const ada = await server.signIn("ada@example.com");
    const german = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const ideas = await call(decksRouter.create, { name: "Ideas" }, {
      context: ada.context,
    });
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-choice",
      sourceText: "request",
      status: "needs_choice",
      operation: null,
      routing: {
        kind: "ambiguous",
        candidates: [
          { deckId: german.id, learningGoal: "Produce German." },
          { deckId: ideas.id, learningGoal: "Understand the idea." },
        ],
      },
    }).returning();

    await expect(call(draftsRouter.resolveDeck, {
      creationId: creation.id,
      expectedRevision: 1,
      deckId: german.id,
    }, { context: ada.context })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(call(draftsRouter.resolveDeck, {
      creationId: creation.id,
      expectedRevision: 0,
      deckId: german.id,
    }, { context: ada.context })).resolves.toMatchObject({ status: "queued" });

    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      deckId: german.id,
      learningGoal: "Produce German.",
      routing: null,
      status: "queued",
      operation: "generate",
      revision: 1,
    });
  });

  it("resolves a proposed new deck into an existing owned deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const german = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-existing-deck",
      sourceText: "request",
      status: "needs_choice",
      operation: null,
      routing: {
        kind: "newDeck",
        proposedName: "German phrases",
        proposedDescription: "Expressions",
        learningGoal: "Produce useful German expressions.",
      },
    }).returning();

    await expect(call(draftsRouter.resolveDeck, {
      creationId: creation.id,
      expectedRevision: 0,
      deckId: german.id,
    }, { context: ada.context })).resolves.toMatchObject({ status: "queued" });

    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      deckId: german.id,
      learningGoal: "Produce useful German expressions.",
      routing: null,
      status: "queued",
      operation: "generate",
      revision: 1,
    });
  });

  it("rejects another user's deck without changing the pending creation", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const bobDeck = await call(decksRouter.create, { name: "Bob's deck" }, {
      context: bob.context,
    });
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-foreign-deck",
      sourceText: "request",
      status: "needs_choice",
      operation: null,
      routing: {
        kind: "newDeck",
        proposedName: "German phrases",
        proposedDescription: "Expressions",
        learningGoal: "Produce useful German expressions.",
      },
    }).returning();

    await expect(call(draftsRouter.resolveDeck, {
      creationId: creation.id,
      expectedRevision: 0,
      deckId: bobDeck.id,
    }, { context: ada.context })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect((await server.db.select().from(drafts).where(eq(
      drafts.id,
      creation.id,
    )))[0]).toMatchObject({
      deckId: null,
      revision: 0,
      status: "needs_choice",
      routing: { kind: "newDeck" },
    });
  });

  it("resolves an ambiguous creation into another owned deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const suggested = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const selected = await call(decksRouter.create, { name: "Travel" }, {
      context: ada.context,
    });
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-other-deck",
      sourceText: "request",
      status: "needs_choice",
      operation: null,
      routing: {
        kind: "ambiguous",
        candidates: [
          { deckId: suggested.id, learningGoal: "Produce German." },
        ],
      },
    }).returning();

    await call(draftsRouter.resolveDeck, {
      creationId: creation.id,
      expectedRevision: 0,
      deckId: selected.id,
    }, { context: ada.context });

    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      deckId: selected.id,
      learningGoal: "Create useful cards for this request in the Travel deck.",
      routing: null,
      status: "queued",
      operation: "generate",
    });
  });

  it("reroutes when a persisted candidate was deleted", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(decksRouter.create, { name: "Gone" }, {
      context: ada.context,
    });
    const deletedCandidate = uuidv7();
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-stale",
      sourceText: "request",
      status: "needs_choice",
      operation: null,
      routing: {
        kind: "ambiguous",
        candidates: [
          { deckId: deck.id, learningGoal: "One" },
          { deckId: deletedCandidate, learningGoal: "Two" },
        ],
      },
    }).returning();

    const result = await call(draftsRouter.resolveDeck, {
      creationId: creation.id,
      expectedRevision: 0,
      deckId: deletedCandidate,
    }, { context: ada.context });

    expect(result).toMatchObject({ status: "queued", rerouting: true });
    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      status: "queued",
      operation: "route_generate",
      routing: null,
    });
  });

  it("confirms a proposed deck and creation assignment atomically", async () => {
    const ada = await server.signIn("ada@example.com");
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-new-deck",
      sourceText: "request",
      status: "needs_choice",
      operation: null,
      routing: {
        kind: "newDeck",
        proposedName: "Latin",
        proposedDescription: "Expressions",
        learningGoal: "Produce Latin expressions.",
      },
    }).returning();

    const result = await call(draftsRouter.confirmNewDeck, {
      creationId: creation.id,
      expectedRevision: 0,
      name: " Latin ",
      description: " Expressions ",
    }, { context: ada.context });

    expect(result).toMatchObject({ status: "queued" });
    const [createdDeck] = await server.db.select().from(decks);
    expect(createdDeck).toMatchObject({ name: "Latin", description: "Expressions" });
    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      deckId: createdDeck.id,
      learningGoal: "Produce Latin expressions.",
      operation: "generate",
      revision: 1,
    });
  });

  it("rolls a new deck back when assigning the creation fails", async () => {
    const ada = await server.signIn("ada@example.com");
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-rollback",
      sourceText: "request",
      status: "needs_choice",
      operation: null,
      routing: {
        kind: "newDeck",
        proposedName: "Latin",
        proposedDescription: "Expressions",
        learningGoal: "Produce Latin expressions.",
      },
    }).returning();

    await expect(call(draftsRouter.confirmNewDeck, {
      creationId: creation.id,
      expectedRevision: 0,
      name: "Latin",
      description: null,
    }, {
      context: { ...ada.context, db: failingInsertInto(server.db, decks) },
    })).rejects.toThrow("simulated insert failure");

    expect(await server.db.select().from(decks)).toHaveLength(0);
    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      status: "needs_choice",
      revision: 0,
      deckId: null,
    });
  });
});

describe("creation recovery and removal", () => {
  it("retries only the failed card stage and preserves reviewed cards and image", async () => {
    const ada = await server.signIn("ada@example.com");
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-retry",
      sourceText: "request",
      status: "failed",
      operation: null,
      cards: [CARD],
      imagePrompt: "a banana",
      imageStatus: "ready",
      draftImageId: "image-ready",
      errorCategory: "generation_failed",
      errorStage: "cards",
      error: "We couldn't create these cards. Try again.",
    }).returning();

    await call(draftsRouter.retry, {
      creationId: creation.id,
      stage: "cards",
    }, { context: ada.context });

    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      status: "queued",
      operation: "retry",
      cards: [CARD],
      imageStatus: "ready",
      draftImageId: "image-ready",
      errorCategory: null,
    });
  });

  it("guards manual cards by revision and preserves stored content on conflict", async () => {
    const ada = await server.signIn("ada@example.com");
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      clientRequestId: "request-update",
      sourceText: "request",
      status: "ready",
      cards: [CARD],
      undoCards: [{ ...CARD, key: "older", back: "old answer" }],
      revision: 2,
    }).returning();
    const changed = [{ ...CARD, back: "fruit" }];

    await expect(call(draftsRouter.update, {
      creationId: creation.id,
      expectedRevision: 1,
      cards: changed,
    }, { context: ada.context })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await server.db.select().from(drafts))[0].cards).toEqual([CARD]);

    await call(draftsRouter.update, {
      creationId: creation.id,
      expectedRevision: 2,
      cards: changed,
    }, { context: ada.context });
    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      cards: changed,
      undoCards: null,
      revision: 3,
    });
  });

  it.each([
    {
      name: "adjustment",
      fields: { adjustmentInstruction: "Make these simpler" },
      operation: "adjust",
    },
    {
      name: "deck regeneration",
      fields: {
        targetDeckId: "target-placeholder",
        targetLearningGoal: "Understand the idea.",
      },
      operation: "regenerate",
    },
  ])("retries a failed $name as the same replacement operation", async ({
    fields,
    operation,
  }) => {
    const ada = await server.signIn("ada@example.com");
    const current = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const target = await call(decksRouter.create, { name: "Ideas" }, {
      context: ada.context,
    });
    const resolvedFields = "targetDeckId" in fields
      ? { ...fields, targetDeckId: target.id }
      : fields;
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      deckId: current.id,
      sourceText: "request",
      learningGoal: "Produce German.",
      status: "failed",
      operation: null,
      classification: {
        domain: "language",
        language: "de",
        partOfSpeech: "noun",
      },
      cards: [CARD],
      errorCategory: "generation_failed",
      errorStage: "cards",
      error: "We couldn't create these cards. Try again.",
      ...resolvedFields,
    }).returning();

    await call(draftsRouter.retry, {
      creationId: creation.id,
      stage: "cards",
    }, { context: ada.context });

    expect((await server.db.select().from(drafts)
      .where(eq(drafts.id, creation.id)))[0]).toMatchObject({
        status: "queued",
        operation,
        cards: creation.cards,
      });
  });

  it("soft-removes queued work, restores its accepted order, and discards one ready item", async () => {
    const ada = await server.signIn("ada@example.com");
    const acceptedAt = new Date(100);
    const [queued, ready] = await server.db.insert(drafts).values([
      {
        userId: ada.userId,
        clientRequestId: "request-queued",
        sourceText: "queued",
        status: "queued",
        operation: "route_generate",
        queuedAt: acceptedAt,
      },
      {
        userId: ada.userId,
        clientRequestId: "request-ready",
        sourceText: "ready",
        status: "ready",
        operation: null,
        cards: [CARD],
      },
    ]).returning();

    await call(draftsRouter.cancel, {
      creationId: queued.id,
      expectedRevision: 0,
    }, { context: ada.context });
    expect((await server.db.select().from(drafts)
      .where(eq(drafts.id, queued.id)))[0]).toMatchObject({
        status: "removed",
        activeAttemptId: null,
      });

    await call(draftsRouter.restore, { creationId: queued.id }, {
      context: ada.context,
    });
    const restored = (await server.db.select().from(drafts)
      .where(eq(drafts.id, queued.id)))[0];
    expect(restored.status).toBe("queued");
    expect(restored.queuedAt).toEqual(acceptedAt);

    await call(draftsRouter.discard, {
      creationId: ready.id,
      expectedRevision: 0,
    }, { context: ada.context });
    expect(await server.db.select().from(drafts)).toHaveLength(1);
    expect((await server.db.select().from(drafts))[0].id).toBe(queued.id);
  });
});

describe("creation review mutations", () => {
  async function seedReviewable() {
    const ada = await server.signIn("ada@example.com");
    const german = await call(decksRouter.create, {
      name: "German",
      description: "Vocabulary",
    }, { context: ada.context });
    const ideas = await call(decksRouter.create, {
      name: "Ideas",
      description: "Concepts",
    }, { context: ada.context });
    const [creation] = await server.db.insert(drafts).values({
      userId: ada.userId,
      deckId: german.id,
      sourceText: "die Banane",
      learningGoal: "Produce German vocabulary.",
      status: "ready",
      operation: null,
      classification: {
        domain: "language",
        language: "de",
        partOfSpeech: "noun",
      },
      cards: [CARD],
      undoCards: [{ ...CARD, key: "older", back: "older answer" }],
      generationSummary: "Practise the meaning of Banane.",
      undoGenerationSummary: "Practise the older Banane card.",
      revision: 3,
    }).returning();
    return { ada, german, ideas, creation };
  }

  it("queues an AI adjustment without hiding cards or clearing the prior undo", async () => {
    const { ada, creation } = await seedReviewable();

    await expect(call(draftsRouter.adjust, {
      creationId: creation.id,
      expectedRevision: 2,
      instruction: "  Make these simpler  ",
    }, { context: ada.context })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(call(draftsRouter.adjust, {
      creationId: creation.id,
      expectedRevision: 3,
      instruction: "  Make these simpler  ",
    }, { context: ada.context })).resolves.toMatchObject({
      status: "queued",
      revision: 4,
    });

    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      status: "queued",
      operation: "adjust",
      adjustmentInstruction: "Make these simpler",
      cards: creation.cards,
      undoCards: creation.undoCards,
      revision: 4,
    });
  });

  it("cancels a queued or running replacement and fences its late result", async () => {
    const { ada, creation } = await seedReviewable();
    await server.db.update(drafts).set({
      status: "adjusting",
      operation: "adjust",
      adjustmentInstruction: "Make these simpler",
      activeAttemptId: "attempt-old",
      leaseOwner: "worker-old",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(drafts.id, creation.id));

    await call(draftsRouter.cancelAdjustment, {
      creationId: creation.id,
      expectedRevision: 3,
    }, { context: ada.context });

    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      status: "ready",
      operation: null,
      activeAttemptId: null,
      leaseOwner: null,
      adjustmentInstruction: null,
      cards: creation.cards,
      undoCards: creation.undoCards,
      revision: 4,
    });
  });

  it("cancels a failed replacement back to the current reviewed version", async () => {
    const { ada, ideas, creation } = await seedReviewable();
    await server.db.update(drafts).set({
      status: "failed",
      operation: null,
      targetDeckId: ideas.id,
      targetLearningGoal: "Understand the idea.",
      errorCategory: "generation_failed",
      errorStage: "cards",
      error: "We couldn't create these cards. Try again.",
    }).where(eq(drafts.id, creation.id));

    await call(draftsRouter.cancelAdjustment, {
      creationId: creation.id,
      expectedRevision: 3,
    }, { context: ada.context });

    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      status: "ready",
      targetDeckId: null,
      targetLearningGoal: null,
      cards: creation.cards,
      undoCards: creation.undoCards,
      errorCategory: null,
      revision: 4,
    });
  });

  it("restores the exact previous set once and clears the undo boundary", async () => {
    const { ada, creation } = await seedReviewable();

    await expect(call(draftsRouter.undoAdjustment, {
      creationId: creation.id,
      expectedRevision: 2,
    }, { context: ada.context })).rejects.toMatchObject({ code: "CONFLICT" });
    await call(draftsRouter.undoAdjustment, {
      creationId: creation.id,
      expectedRevision: 3,
    }, { context: ada.context });

    const restored = (await server.db.select().from(drafts))[0];
    expect(restored.cards).toEqual(creation.undoCards);
    expect(restored).toMatchObject({
      generationSummary: "Practise the older Banane card.",
      undoCards: null,
      undoGenerationSummary: null,
      revision: 4,
    });
    await expect(call(draftsRouter.undoAdjustment, {
      creationId: creation.id,
      expectedRevision: 4,
    }, { context: ada.context })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("queues target-deck regeneration while retaining current context and cards", async () => {
    const { ada, german, ideas, creation } = await seedReviewable();

    await expect(call(draftsRouter.changeDeck, {
      creationId: creation.id,
      expectedRevision: 3,
      deckId: german.id,
    }, { context: ada.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(call(draftsRouter.changeDeck, {
      creationId: creation.id,
      expectedRevision: 3,
      deckId: ideas.id,
    }, { context: ada.context })).resolves.toMatchObject({
      status: "queued",
      revision: 4,
    });

    expect((await server.db.select().from(drafts))[0]).toMatchObject({
      status: "queued",
      operation: "regenerate",
      deckId: german.id,
      targetDeckId: ideas.id,
      cards: creation.cards,
      undoCards: creation.undoCards,
      revision: 4,
    });
  });

  it("rejects another user's target deck without changing the creation", async () => {
    const { ada, creation } = await seedReviewable();
    const bob = await server.signIn("bob@example.com");
    const foreign = await call(decksRouter.create, { name: "Private" }, {
      context: bob.context,
    });

    await expect(call(draftsRouter.changeDeck, {
      creationId: creation.id,
      expectedRevision: 3,
      deckId: foreign.id,
    }, { context: ada.context })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await server.db.select().from(drafts)
      .where(eq(drafts.id, creation.id)))[0]).toMatchObject({
        status: "ready",
        deckId: creation.deckId,
        targetDeckId: null,
        revision: 3,
      });
  });
});
