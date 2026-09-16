import { and, asc, eq } from "drizzle-orm";
import { Cause, Effect, SynchronizedRef } from "effect";
import { uuidv7 } from "uuidv7";
import type { CreationModelCalls } from "../ai/model-calls.ts";
import type { CreationGenerationEvent } from "../ai/creation-generation.ts";
import type { Db } from "../db/index.ts";
import { creationImageAttempts, decks, drafts, user } from "../db/schema.ts";
import type { Draft, DraftErrorStage } from "../db/schema.ts";
import { removeDraftImage } from "../images.ts";
import { normalizeStoredCards } from "../creations/contracts.ts";
import type { ClaimedCreationWork, DurableTextAttemptLease, DurableTextDatabase } from "./durable-text.ts";
import type { BackgroundProviderService } from "./background-provider.ts";
import { makeEffectPull } from "./ai-generation.ts";
import { adjustText, generateText, routeText, textProviderFailure } from "./durable-text-models.ts";
import { DatabaseFailure, MediaFailure, ProviderFailure } from "./errors.ts";

type AttemptFailure = DatabaseFailure | ProviderFailure | MediaFailure;

export type DurableTextAttemptDeps = {
  database: DurableTextDatabase;
  provider?: BackgroundProviderService;
  lease?: DurableTextAttemptLease;
  /** Retained only for the public Promise worker compatibility facade. */
  models?: CreationModelCalls;
  nextId?: () => string;
  publishEffect?: (creation: Draft, attemptId: string | null) => Effect.Effect<void, DatabaseFailure>;
  kickEffect?: (userId: string) => Effect.Effect<void>;
  kickImagesEffect?: () => Effect.Effect<void>;
  removeDraftImageEffect?: (userId: string, draftImageId: string) => Effect.Effect<void, MediaFailure>;
  notifyEffect?: (userId: string, creationId: string) => Effect.Effect<void>;
  /** Explicit legacy-worker adapter; live workflows use publishEffect. */
  publish?: (db: Db, creation: Draft, attemptId: string | null) => Promise<void>;
  kick?: (userId: string) => void;
  renewLease?: (db: Db, work: ClaimedCreationWork, now?: Date) => Promise<boolean>;
  heartbeatMs?: number;
  /** Explicit legacy-worker adapter; live workflows use removeDraftImageEffect. */
  removeDraftImage?: (userId: string, draftImageId: string) => Promise<void>;
  notify?: (userId: string, creationId: string) => void;
};

type DraftPatch = Partial<Omit<Draft, "id" | "userId" | "createdAt">>;

function dbEffect<A>(operation: string, work: () => Promise<A>): Effect.Effect<A, DatabaseFailure> {
  return Effect.tryPromise({ try: work, catch: (cause) => new DatabaseFailure({ operation, cause }) });
}

/** Convert old model calls once at the retained worker facade boundary. */
function compatibilityProvider(models: CreationModelCalls): BackgroundProviderService {
  const call = (operation: string, work: () => Promise<unknown>) => Effect.tryPromise({
    try: work, catch: (cause) => textProviderFailure(operation, cause),
  });
  return {
    classify: (prompts) => call("classify", () => models.classify(prompts)),
    route: (prompts) => call("route", () => models.route(prompts)),
    adjust: (prompts) => call("adjust", () => models.adjust(prompts)),
    generate: (prompts) => Effect.sync(() => makeEffectPull(models.generate(prompts), (cause) => textProviderFailure("generate", cause))),
    generateImageBytes: () => Effect.die("Text attempts do not generate image bytes"),
  };
}

function fence(work: ClaimedCreationWork) {
  return and(eq(drafts.id, work.creationId), eq(drafts.userId, work.userId),
    eq(drafts.activeAttemptId, work.attemptId), eq(drafts.leaseOwner, work.leaseOwner));
}

/**
 * One claimed state machine in the caller's fiber. Reads/provider pulls remain
 * interruptible; guarded writes, publication and compensation settle together.
 * An interrupted model call leaves the claim intact for startup/lease recovery.
 */
export function runDurableTextAttempt(
  initialWork: ClaimedCreationWork,
  deps: DurableTextAttemptDeps,
): Effect.Effect<void, AttemptFailure> {
  return Effect.suspend(() => {
    const db = deps.database.db;
    const provider = deps.provider ?? (deps.models ? compatibilityProvider(deps.models) : undefined);
    const nextId = deps.nextId ?? uuidv7;
    let work = initialWork;
    let current: Draft | null = null;
    let attemptCards: Draft["attemptCards"] = [];
    let failureStage: DraftErrorStage = "cards";
    const publish = (creation: Draft, attemptId: string | null) =>
      deps.publishEffect?.(creation, attemptId) ?? dbEffect(
        "durable-text.publish",
        async () => { await deps.publish?.(db, creation, attemptId); },
      );
    const kick = () => deps.kickEffect?.(work.userId) ??
      Effect.sync(() => deps.kick?.(work.userId));
    const notify = (creation: Draft) => deps.notifyEffect?.(work.userId, creation.id) ??
      Effect.sync(() => deps.notify?.(work.userId, creation.id));
    const patch = (values: DraftPatch) => deps.database.withWriteLock(
      "durable-text.patch", dbEffect("durable-text.patch", () =>
        db.update(drafts).set(values).where(fence(work)).returning()),
    ).pipe(Effect.map((rows) => rows[0] ?? null));
    const commitAndPublish = (values: DraftPatch): Effect.Effect<Draft | null, DatabaseFailure> =>
      Effect.uninterruptible(Effect.gen(function* () {
        const committed = yield* patch(values);
        if (!committed) return null;
        current = committed;
        yield* publish(committed, work.attemptId);
        return committed;
      }));
    const fail = (stage: DraftErrorStage) => Effect.suspend(() => {
      if (!current) return Effect.void;
      return commitAndPublish({
        status: "failed", operation: null, activeAttemptId: null, attemptCards,
        cards: current.cards.length > 0 ? current.cards : attemptCards,
        leaseOwner: null, leaseExpiresAt: null,
        errorCategory: stage === "routing" ? "routing_failed" : "generation_failed",
        errorStage: stage,
        error: stage === "routing" ? "We couldn't choose a deck. Try again." : "We couldn't create these cards. Try again.",
        revision: current.revision + 1, updatedAt: new Date(),
      }).pipe(Effect.asVoid);
    });
    const finishGeneration = (values: DraftPatch, prompt: string | null): Effect.Effect<Draft | null, AttemptFailure> =>
      Effect.uninterruptible(Effect.gen(function* () {
        const imageAttemptId = prompt ? uuidv7() : null;
        let supersededDraftImageId: string | null = null;
        const rows = yield* deps.database.transaction("durable-text.finish-generation", (tx) =>
          Effect.gen(function* () {
            const completed = yield* dbEffect("durable-text.finish-generation", () => tx.update(drafts).set({
              ...values, imageAttemptId, imagePrompt: prompt,
              imageStatus: prompt ? "queued" : "none", draftImageId: null,
            }).where(fence(work)).returning());
            if (completed.length === 0) return [];
            supersededDraftImageId = current?.draftImageId ?? null;
            if (current?.imageAttemptId) {
              const previousAttemptId = current.imageAttemptId;
              const [previous] = yield* dbEffect("durable-text.read-previous-image", () =>
                tx.select({ draftImageId: creationImageAttempts.draftImageId }).from(creationImageAttempts)
                  .where(and(eq(creationImageAttempts.id, previousAttemptId), eq(creationImageAttempts.userId, work.userId))).limit(1));
              supersededDraftImageId = previous?.draftImageId ?? supersededDraftImageId;
              yield* dbEffect("durable-text.cancel-previous-image", () =>
                tx.update(creationImageAttempts).set({ status: "canceled", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
                  .where(and(eq(creationImageAttempts.id, previousAttemptId), eq(creationImageAttempts.userId, work.userId))));
            }
            if (imageAttemptId && prompt) {
              yield* dbEffect("durable-text.queue-image", () => tx.insert(creationImageAttempts).values({
                id: imageAttemptId, userId: work.userId, creationId: work.creationId, prompt, status: "queued",
              }));
            }
            return completed;
          }));
        const completed = rows[0] ?? null;
        if (!completed) return null;
        current = completed;
        // Cleanup is a finalizer: publication or a requested interruption cannot
        // skip compensation after the image reference has been replaced.
        const cleanup = Effect.suspend(() => {
          if (!supersededDraftImageId) return Effect.void;
          const id = supersededDraftImageId;
          return (deps.removeDraftImageEffect?.(work.userId, id) ?? Effect.tryPromise({
            try: () => (deps.removeDraftImage ?? removeDraftImage)(work.userId, id),
            catch: (cause) => new MediaFailure({ operation: "durable-text.remove-image", message: "Image cleanup failed", cause }),
          })).pipe(Effect.catchAllCause((cause) => Effect.sync(() => console.error("superseded creation image cleanup failed", cause))));
        });
        yield* Effect.gen(function* () {
          yield* publish(completed, work.attemptId);
          if (imageAttemptId) yield* deps.kickImagesEffect?.() ?? Effect.void;
        }).pipe(Effect.ensuring(cleanup));
        return completed;
      }));
    const readOwner = () => dbEffect("durable-text.read-owner", () =>
      db.select({
        nativeLanguage: user.nativeLanguage,
        aiInstructions: user.aiInstructions,
      }).from(user).where(eq(user.id, work.userId)).limit(1));
    const readDeck = (deckId: string) => dbEffect("durable-text.read-deck", () =>
      db.select({ id: decks.id, name: decks.name, description: decks.description }).from(decks)
        .where(and(eq(decks.id, deckId), eq(decks.userId, work.userId))).limit(1));

    const program = Effect.gen(function* () {
      const [claimed] = yield* dbEffect("durable-text.read-claimed", () => db.select().from(drafts).where(fence(work)).limit(1));
      current = claimed ?? null;
      attemptCards = current?.attemptCards ?? [];
      if (!current) return;
      if (!provider) return yield* Effect.fail(textProviderFailure("durable-text.provider", new Error("No text provider")));
      if (work.operation === "route_generate") {
        failureStage = "routing";
        const [owners, catalog] = yield* Effect.all([
          readOwner(),
          dbEffect("durable-text.read-catalog", () => db.select({ id: decks.id, name: decks.name, description: decks.description })
            .from(decks).where(eq(decks.userId, work.userId)).orderBy(asc(decks.createdAt), asc(decks.id))),
        ], { concurrency: "unbounded" });
        const routing = yield* routeText(provider, { request: current.sourceText, nativeLanguage: owners[0]?.nativeLanguage ?? "en", decks: catalog });
        if (routing.kind !== "matched") {
          const choice = yield* commitAndPublish({
            status: "needs_choice", operation: null, routing, deckId: null, learningGoal: null,
            activeAttemptId: null, leaseOwner: null, leaseExpiresAt: null,
            errorCategory: null, errorStage: null, error: null, revision: current.revision + 1, updatedAt: new Date(),
          });
          if (choice) yield* notify(choice);
          return;
        }
        const matched = yield* commitAndPublish({
          deckId: routing.deckId, learningGoal: routing.learningGoal, routing, operation: "generate", status: "generating",
          errorCategory: null, errorStage: null, error: null, revision: current.revision + 1, updatedAt: new Date(),
        });
        if (!matched) return;
        current = matched;
        work = { ...work, operation: "generate" };
      }
      if (work.operation === "adjust") {
        const { deckId, learningGoal, classification, adjustmentInstruction: instruction } = current;
        if (!deckId || !learningGoal || !classification || !instruction || current.cards.length === 0) {
          return yield* Effect.fail(textProviderFailure("durable-text.adjust", new Error("Creation has no adjustment context")));
        }
        const [[deck], [owner]] = yield* Effect.all([readDeck(deckId), readOwner()], { concurrency: "unbounded" });
        if (!deck) return yield* Effect.fail(textProviderFailure("durable-text.adjust", new Error("Creation deck no longer exists")));
        const previousCards = normalizeStoredCards(current.id, current.cards);
        if (previousCards.length !== current.cards.length) return yield* Effect.fail(textProviderFailure("durable-text.adjust", new Error("Creation cards are incomplete")));
        const adjusted = yield* adjustText(provider, {
          request: current.sourceText, nativeLanguage: owner?.nativeLanguage ?? "en",
          aiInstructions: owner?.aiInstructions ?? "", deck, learningGoal,
          classification, imagePrompt: current.imagePrompt, cards: previousCards, instruction,
        }, nextId);
        const ready = yield* commitAndPublish({
          status: "ready", operation: null, activeAttemptId: null, attemptCards: [], cards: adjusted.cards,
          generationSummary: adjusted.generationSummary,
          undoCards: previousCards, undoGenerationSummary: current.generationSummary,
          adjustmentInstruction: null, leaseOwner: null, leaseExpiresAt: null,
          errorCategory: null, errorStage: null, error: null, revision: current.revision + 1, updatedAt: new Date(),
        });
        if (ready) yield* notify(ready);
        return;
      }
      failureStage = "cards";
      if (work.operation !== "generate" && work.operation !== "retry" && work.operation !== "regenerate") {
        return yield* Effect.fail(textProviderFailure("durable-text.generate", new Error(`Unsupported creation operation: ${work.operation}`)));
      }
      const regenerating = work.operation === "regenerate";
      const deckId = regenerating ? current.targetDeckId : current.deckId;
      const learningGoal = regenerating ? current.targetLearningGoal : current.learningGoal;
      const missingTarget = () => commitAndPublish({
        status: "failed", operation: null, activeAttemptId: null, attemptCards: [],
        targetDeckId: null, targetLearningGoal: null, leaseOwner: null, leaseExpiresAt: null,
        errorCategory: "routing_failed", errorStage: "routing",
        error: "The selected deck is no longer available. Choose another deck.",
        revision: current!.revision + 1, updatedAt: new Date(),
      }).pipe(Effect.asVoid);
      if (!deckId || !learningGoal) {
        if (regenerating) return yield* missingTarget();
        return yield* Effect.fail(textProviderFailure("durable-text.generate", new Error("Creation has no deck context")));
      }
      const [deck] = yield* readDeck(deckId);
      if (!deck) {
        if (regenerating) return yield* missingTarget();
        return yield* Effect.fail(textProviderFailure("durable-text.generate", new Error("Creation deck no longer exists")));
      }
      const [owner] = yield* readOwner();
      const consume = (event: CreationGenerationEvent): Effect.Effect<boolean, AttemptFailure> => Effect.gen(function* () {
        if (event.type === "image-prompt") return true;
        if (event.type === "classified") return (yield* commitAndPublish({ classification: event.classification, updatedAt: new Date() })) !== null;
        if (event.type === "cards") {
          attemptCards = event.cards;
          return (yield* commitAndPublish({ attemptCards, updatedAt: new Date() })) !== null;
        }
        if (event.type === "retry") {
          return yield* Effect.uninterruptible(Effect.gen(function* () {
            const nextAttemptId = nextId();
            const rotate = () => patch({ activeAttemptId: nextAttemptId, attemptCards: [], updatedAt: new Date() });
            // A renewal using the previous attempt must finish before rotation;
            // the next renewal observes the replacement fence after commit.
            const committed = yield* deps.lease
              ? SynchronizedRef.modifyEffect(deps.lease, (currentClaim) => rotate().pipe(
                Effect.map((committed) => [committed, committed
                  ? { ...currentClaim, attemptId: nextAttemptId }
                  : currentClaim] as const),
              ))
              : rotate();
            if (!committed) return false;
            work = { ...work, attemptId: nextAttemptId };
            current = committed;
            attemptCards = [];
            yield* publish(committed, nextAttemptId);
            return true;
          }));
        }
        attemptCards = event.cards;
        const completed = yield* finishGeneration({
          status: "ready", operation: null, activeAttemptId: null, classification: event.classification,
          attemptCards: [], cards: event.cards,
          ...(regenerating ? {
            deckId,
            learningGoal,
            targetDeckId: null,
            targetLearningGoal: null,
            undoCards: null,
            undoGenerationSummary: null,
          } : {}),
          generationSummary: event.generationSummary,
          imagePrompt: event.imagePrompt, leaseOwner: null, leaseExpiresAt: null,
          errorCategory: null, errorStage: null, error: null, revision: current!.revision + 1, updatedAt: new Date(),
        }, event.imagePrompt);
        if (completed) yield* notify(completed);
        return completed !== null;
      });
      yield* generateText(provider, {
        text: current.sourceText,
        nativeLanguage: owner?.nativeLanguage ?? "en",
        aiInstructions: owner?.aiInstructions ?? "",
        deck,
        learningGoal,
      }, nextId, consume);
    });
    return program.pipe(
      Effect.catchAllCause((cause) => {
        if (Cause.isInterruptedOnly(cause)) return Effect.failCause(cause);
        return Effect.zipRight(Effect.sync(() => console.error("creation text attempt failed", Cause.squash(cause))), fail(failureStage));
      }),
      Effect.ensuring(Effect.suspend(kick)),
    );
  });
}
