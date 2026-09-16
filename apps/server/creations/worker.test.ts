import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, ne } from "drizzle-orm";
import { Effect, Stream } from "effect";
import { createTestDb } from "../db/testing.ts";
import { creationImageAttempts, decks, drafts, user } from "../db/schema.ts";
import type { CreationModelCalls } from "../ai/model-calls.ts";
import { makeCreationEvents } from "../effect/creation-events.ts";
import { claimCreationWork } from "./scheduler.ts";
import { runCreationAttempt } from "./worker.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;

const CLASSIFICATION = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};
const CARD = {
  aspect: "meaning",
  front: "banana",
  back: "die Banane",
  imageCue: false,
};
const SECOND_CARD = {
  aspect: "article",
  front: "{{c1::die::article}} Banane",
  back: null,
  imageCue: false,
};

beforeEach(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(user).values({
    id: "ada",
    name: "Ada",
    email: "ada@example.com",
    nativeLanguage: "pl",
  });
  await testDb.db.insert(decks).values([
    { id: "german", userId: "ada", name: "German", description: "Vocabulary" },
    { id: "ideas", userId: "ada", name: "Ideas", description: "Concepts" },
  ]);
});

afterEach(() => testDb.close());

type Gate = {
  wait: Promise<void>;
  release(): void;
};

function gate(): Gate {
  let release!: () => void;
  return {
    wait: new Promise<void>((resolve) => release = resolve),
    release,
  };
}

function models(options: {
  routing?: unknown;
  adjustment?: unknown;
  adjustmentGate?: Gate;
  adjustmentError?: Error;
  passes?: Array<{ deltas: string[]; value?: unknown; error?: Error; gate?: Gate }>;
} = {}): CreationModelCalls {
  let passIndex = 0;
  return {
    adjust: async () => {
      if (options.adjustmentGate) await options.adjustmentGate.wait;
      if (options.adjustmentError) throw options.adjustmentError;
      const adjustment = options.adjustment ?? { cards: [CARD] };
      return typeof adjustment === "object" && adjustment !== null
        ? {
          generationSummary: "Practise the meaning of Banane.",
          ...adjustment,
        }
        : adjustment;
    },
    route: async () => options.routing ?? ({
      kind: "matched",
      deckId: "german",
      learningGoal: "Produce useful German vocabulary.",
    }),
    classify: async () => CLASSIFICATION,
    generate: async function* () {
      const passes = options.passes ?? [{
        deltas: [JSON.stringify({
          imagePrompt: "a banana",
          generationSummary: "Practise the meaning of Banane.",
          cards: [CARD],
        })],
        value: {
          imagePrompt: "a banana",
          generationSummary: "Practise the meaning of Banane.",
          cards: [CARD],
        },
      }];
      const pass = passes[Math.min(passIndex++, passes.length - 1)];
      for (const delta of pass.deltas) yield delta;
      if (pass.gate) await pass.gate.wait;
      if (pass.error) throw pass.error;
      return typeof pass.value === "object" && pass.value !== null
        ? {
          generationSummary: "Practise the meaning of Banane.",
          ...pass.value,
        }
        : pass.value;
    },
  };
}

async function seedAndClaim(
  operation: "route_generate" | "generate" | "retry" | "adjust" | "regenerate" =
    "route_generate",
  values: Partial<typeof drafts.$inferInsert> = {},
) {
  await testDb.db.insert(drafts).values({
    id: "creation-1",
    userId: "ada",
    clientRequestId: "request-1",
    sourceText: "die Banane",
    status: "queued",
    operation,
    ...(operation === "route_generate"
      ? {}
      : { deckId: "german", learningGoal: "Produce useful German vocabulary." }),
    ...values,
  });
  const [claim] = await claimCreationWork(testDb.db, "ada", {
    leaseOwner: "worker-1",
    now: new Date(1_000),
  });
  return claim;
}

async function row() {
  return (await testDb.db.select().from(drafts)
    .where(eq(drafts.id, "creation-1")))[0];
}

describe("creation worker", () => {
  it("persists a matched deck and goal before producing a ready card set", async () => {
    const claim = await seedAndClaim();

    await runCreationAttempt(claim, {
      db: testDb.db,
      models: models(),
      nextId: (() => {
        let index = 0;
        return () => `card-${++index}`;
      })(),
      kick: vi.fn(),
    });

    const creation = await row();
    expect(creation).toMatchObject({
      deckId: "german",
      learningGoal: "Produce useful German vocabulary.",
      status: "ready",
      activeAttemptId: null,
      leaseOwner: null,
      imagePrompt: "a banana",
      cards: [{ key: "card-1", ...CARD }],
    });
    expect(creation.imageStatus).toBe("queued");
    expect(creation.imageAttemptId).not.toBeNull();
    expect(await testDb.db.select().from(creationImageAttempts)).toEqual([
      expect.objectContaining({
        id: creation.imageAttemptId,
        creationId: creation.id,
        prompt: "a banana",
        status: "queued",
      }),
    ]);
  });

  it("persists the AI generation summary with the completed card set", async () => {
    const claim = await seedAndClaim("generate");

    await runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ passes: [{
        deltas: [JSON.stringify({
          imagePrompt: null,
          generationSummary: "Practise the meaning of Banane.",
          cards: [CARD],
        })],
        value: {
          imagePrompt: null,
          generationSummary: "Practise the meaning of Banane.",
          cards: [CARD],
        },
      }] }),
      nextId: () => "card-1",
      kick: vi.fn(),
    });

    expect((await row()).generationSummary)
      .toBe("Practise the meaning of Banane.");
  });

  it.each([
    {
      kind: "ambiguous" as const,
      candidates: [
        { deckId: "german", learningGoal: "Language production" },
        { deckId: "ideas", learningGoal: "Understand the idea" },
      ],
    },
    {
      kind: "newDeck" as const,
      proposedName: "German phrases",
      proposedDescription: "Useful expressions",
      learningGoal: "Produce the expression.",
    },
  ])("persists $kind routing as a durable choice and releases the slot", async (routing) => {
    const claim = await seedAndClaim();

    await runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ routing }),
      kick: vi.fn(),
    });

    expect(await row()).toMatchObject({
      status: "needs_choice",
      routing,
      activeAttemptId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("commits each complete prefix before publishing it", async () => {
    const generationGate = gate();
    const claim = await seedAndClaim("generate");
    const events = makeCreationEvents({
      readDetail: async (userId, creationId) => {
        const [creation] = await testDb.db.select().from(drafts).where(and(
          eq(drafts.id, creationId),
          eq(drafts.userId, userId),
        )).limit(1);
        return creation ?? null;
      },
      readInbox: (userId) => testDb.db.select().from(drafts).where(and(
        eq(drafts.userId, userId),
        ne(drafts.status, "removed"),
      )).orderBy(desc(drafts.updatedAt), desc(drafts.id)),
    });
    const subscribe = async () => Stream.toAsyncIterable(
      await Effect.runPromise(events.subscribeDetail("ada", "creation-1")),
    )[Symbol.asyncIterator]();
    const subscription = await subscribe();
    await subscription.next();
    const running = runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ passes: [{
        deltas: [
          `{"imagePrompt":null,"cards":[${JSON.stringify(CARD)},`,
          `{"aspect":"unfinished`,
        ],
        value: { imagePrompt: null, cards: [CARD, SECOND_CARD] },
        gate: generationGate,
      }] }),
      nextId: () => "card-1",
      kick: vi.fn(),
      publish: async (_db, creation, attemptId) => {
        await Effect.runPromise(events.publish(creation, attemptId));
      },
    });

    let event = await subscription.next();
    while (event.value?.creation?.attemptCards.length === 0) {
      event = await subscription.next();
    }
    expect(event.value?.creation.attemptCards).toEqual([
      { key: "card-1", ...CARD },
    ]);
    expect((await row()).attemptCards).toEqual(event.value?.creation.attemptCards);
    const reconnected = await subscribe();
    await expect(reconnected.next()).resolves.toMatchObject({
      value: { creation: { attemptCards: [{ key: "card-1", ...CARD }] } },
    });

    generationGate.release();
    await running;
    await reconnected.return?.();
    await subscription.return?.();
  });

  it("fences a validation retry with a new attempt and clears rejected cards", async () => {
    const retryGate = gate();
    const published: Array<{ activeAttemptId: string | null; attemptId: string | null }> = [];
    const invalid = { imagePrompt: null, cards: [CARD, { ...SECOND_CARD, imageCue: true }] };
    const claim = await seedAndClaim("generate");
    const running = runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ passes: [
        { deltas: [JSON.stringify(invalid)], value: invalid },
        {
          deltas: [],
          value: { imagePrompt: null, cards: [CARD] },
          gate: retryGate,
        },
      ] }),
      publish: async (_db, creation, attemptId) => {
        published.push({ activeAttemptId: creation.activeAttemptId, attemptId });
      },
      kick: vi.fn(),
    });

    await vi.waitFor(async () => {
      expect((await row()).activeAttemptId).not.toBe(claim.attemptId);
    });
    expect((await row()).attemptCards).toEqual([]);
    const retrySnapshot = published.find((event) =>
      event.activeAttemptId !== null && event.activeAttemptId !== claim.attemptId
    );
    expect(retrySnapshot?.attemptId).toBe(retrySnapshot?.activeAttemptId);

    retryGate.release();
    await running;
    expect(await row()).toMatchObject({ status: "ready", cards: [expect.objectContaining(CARD)] });
  });

  it("keeps complete streamed cards reviewable after provider failure", async () => {
    const claim = await seedAndClaim("generate");

    await runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ passes: [{
        deltas: [
          `{"imagePrompt":null,"cards":[${JSON.stringify(CARD)},`,
          `{"aspect":"unfinished`,
        ],
        error: new Error("provider secret diagnostic"),
      }] }),
      nextId: () => "card-safe",
      kick: vi.fn(),
    });

    expect(await row()).toMatchObject({
      status: "failed",
      errorCategory: "generation_failed",
      error: "We couldn't create these cards. Try again.",
      cards: [{ key: "card-safe", ...CARD }],
      leaseOwner: null,
    });
  });

  it("does not replace reviewed cards until a retry fully succeeds", async () => {
    const generationGate = gate();
    const reviewed = [{ key: "reviewed", ...SECOND_CARD }];
    const claim = await seedAndClaim("retry", { cards: reviewed });
    const running = runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ passes: [{
        deltas: [
          `{"imagePrompt":null,"cards":[${JSON.stringify(CARD)},`,
          `{"aspect":"unfinished`,
        ],
        value: { imagePrompt: null, cards: [CARD] },
        gate: generationGate,
      }] }),
      kick: vi.fn(),
    });

    await vi.waitFor(async () => expect((await row()).attemptCards).toHaveLength(1));
    expect((await row()).cards).toEqual(reviewed);
    generationGate.release();
    await running;
    expect((await row()).cards).toEqual([expect.objectContaining(CARD)]);
  });

  it("keeps reviewed cards visible and atomically creates an exact adjustment undo", async () => {
    const adjustmentGate = gate();
    const reviewed = [{ key: "reviewed", ...SECOND_CARD }];
    const replacement = [
      { key: "reviewed", ...SECOND_CARD, aspect: "grammar" },
      { key: null, ...CARD, aspect: "example" },
    ];
    const claim = await seedAndClaim("adjust", {
      status: "queued",
      cards: reviewed,
      classification: CLASSIFICATION,
      adjustmentInstruction: "Add an example",
      generationSummary: "Practise the article and meaning of Banane.",
      imagePrompt: "a banana",
      imageStatus: "ready",
      draftImageId: "image-before-adjustment",
    });
    const running = runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ adjustment: {
        generationSummary: "Practise the article and use Banane in an example.",
        cards: replacement,
      }, adjustmentGate }),
      nextId: () => "new-card",
      kick: vi.fn(),
    });

    await vi.waitFor(async () => expect((await row()).status).toBe("adjusting"));
    expect((await row()).cards).toEqual(reviewed);
    adjustmentGate.release();
    await running;

    expect(await row()).toMatchObject({
      status: "ready",
      operation: null,
      cards: [
        { ...replacement[0], key: "reviewed" },
        { ...replacement[1], key: "new-card" },
      ],
      undoCards: reviewed,
      generationSummary: "Practise the article and use Banane in an example.",
      undoGenerationSummary: "Practise the article and meaning of Banane.",
      adjustmentInstruction: null,
      imagePrompt: "a banana",
      imageStatus: "ready",
      draftImageId: "image-before-adjustment",
    });
  });

  it("retains cards and the previous undo boundary when adjustment fails", async () => {
    const reviewed = [{ key: "reviewed", ...SECOND_CARD }];
    const previousUndo = [{ key: "older", ...CARD }];
    const claim = await seedAndClaim("adjust", {
      cards: reviewed,
      undoCards: previousUndo,
      classification: CLASSIFICATION,
      adjustmentInstruction: "Make these simpler",
    });

    await runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ adjustmentError: new Error("provider secret") }),
      kick: vi.fn(),
    });

    expect(await row()).toMatchObject({
      status: "failed",
      cards: reviewed,
      undoCards: previousUndo,
      error: "We couldn't create these cards. Try again.",
    });
  });

  it("regenerates against a target deck and swaps context only after validation", async () => {
    const generationGate = gate();
    const reviewed = [{ key: "reviewed", ...SECOND_CARD }];
    const claim = await seedAndClaim("regenerate", {
      cards: reviewed,
      classification: CLASSIFICATION,
      targetDeckId: "ideas",
      targetLearningGoal: "Understand the underlying idea.",
      undoCards: [{ key: "older", ...CARD }],
    });
    const running = runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ passes: [{
        deltas: [
          `{"imagePrompt":null,"cards":[${JSON.stringify(CARD)},`,
          `{"aspect":"unfinished`,
        ],
        value: { imagePrompt: null, cards: [CARD] },
        gate: generationGate,
      }] }),
      nextId: () => "regenerated",
      kick: vi.fn(),
    });

    await vi.waitFor(async () => expect((await row()).attemptCards).toHaveLength(1));
    expect(await row()).toMatchObject({ deckId: "german", cards: reviewed });
    generationGate.release();
    await running;

    expect(await row()).toMatchObject({
      status: "ready",
      deckId: "ideas",
      learningGoal: "Understand the underlying idea.",
      targetDeckId: null,
      targetLearningGoal: null,
      cards: [{ key: "regenerated", ...CARD }],
      undoCards: null,
    });
  });

  it("cancels and cleans only the superseded image when replacement needs none", async () => {
    const removed: string[] = [];
    const claim = await seedAndClaim("regenerate", {
      cards: [{ key: "reviewed", ...SECOND_CARD }],
      classification: CLASSIFICATION,
      targetDeckId: "ideas",
      targetLearningGoal: "Understand the underlying idea.",
      imageAttemptId: "image-attempt-old",
      imagePrompt: "a banana",
      imageStatus: "ready",
      draftImageId: "draft-image-old",
    });
    await testDb.db.insert(creationImageAttempts).values({
      id: "image-attempt-old",
      userId: "ada",
      creationId: "creation-1",
      prompt: "a banana",
      status: "ready",
      draftImageId: "draft-image-old",
    });

    await runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ passes: [{
        deltas: [JSON.stringify({ imagePrompt: null, cards: [CARD] })],
        value: { imagePrompt: null, cards: [CARD] },
      }] }),
      removeDraftImage: async (_userId, draftImageId) => {
        removed.push(draftImageId);
      },
      kick: vi.fn(),
    });

    expect(await row()).toMatchObject({
      status: "ready",
      imageAttemptId: null,
      imagePrompt: null,
      imageStatus: "none",
      draftImageId: null,
    });
    expect((await testDb.db.select().from(creationImageAttempts))[0])
      .toMatchObject({ status: "canceled", draftImageId: "draft-image-old" });
    expect(removed).toEqual(["draft-image-old"]);
  });

  it("reroutes a regeneration when its target deck was deleted", async () => {
    const reviewed = [{ key: "reviewed", ...SECOND_CARD }];
    const claim = await seedAndClaim("regenerate", {
      cards: reviewed,
      classification: CLASSIFICATION,
      targetDeckId: "ideas",
      targetLearningGoal: "Understand the underlying idea.",
    });
    await testDb.db.delete(decks).where(eq(decks.id, "ideas"));
    const model = models();
    const generate = vi.spyOn(model, "generate");

    await runCreationAttempt(claim, {
      db: testDb.db,
      models: model,
      kick: vi.fn(),
    });

    expect(generate).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({
      status: "failed",
      operation: null,
      deckId: "german",
      targetDeckId: null,
      targetLearningGoal: null,
      cards: reviewed,
      errorCategory: "routing_failed",
      errorStage: "routing",
    });
  });

  it("ignores a worker whose attempt fence no longer matches", async () => {
    const claim = await seedAndClaim("generate");
    await testDb.db.update(drafts).set({ activeAttemptId: "replacement" })
      .where(eq(drafts.id, claim.creationId));
    const model = models();
    const generate = vi.spyOn(model, "generate");

    await runCreationAttempt(claim, {
      db: testDb.db,
      models: model,
      kick: vi.fn(),
    });

    expect(generate).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({
      activeAttemptId: "replacement",
      status: "generating",
      cards: [],
    });
  });

  it("stops renewing its lease after reaching a terminal state", async () => {
    const generationGate = gate();
    const claim = await seedAndClaim("generate");
    const renewLease = vi.fn(async () => true);
    const running = runCreationAttempt(claim, {
      db: testDb.db,
      models: models({ passes: [{
        deltas: [],
        value: { imagePrompt: null, cards: [CARD] },
        gate: generationGate,
      }] }),
      renewLease,
      heartbeatMs: 1,
      kick: vi.fn(),
    });

    await vi.waitFor(() => expect(renewLease).toHaveBeenCalled());
    generationGate.release();
    await running;
    const callsAtCompletion = renewLease.mock.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(renewLease).toHaveBeenCalledTimes(callsAtCompletion);
    expect((await row()).status).toBe("ready");
  });
});
