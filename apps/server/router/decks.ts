import * as z from "zod";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  authed,
  runDetachedWorkflow,
  runRouter,
} from "./base.ts";
import type { AuthedContext } from "./base.ts";
import { removeAudio } from "../audio.ts";
import {
  cards,
  creationImageAttempts,
  decks,
  drafts,
  notes,
} from "../db/schema.ts";
import { removeDraftImage, removeImage } from "../images.ts";
import { abortJob } from "../ai/jobs.ts";
import { Application } from "../effect/application.ts";
import type { CreationEventsService } from "../effect/creation-events.ts";
import { DatabaseFailure, InfrastructureFailure, NotFound } from "../effect/errors.ts";

const databaseEffect = <A>(operation: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new DatabaseFailure({ operation, cause }),
  });

function referencesDeck(
  creation: typeof drafts.$inferSelect,
  deckId: string,
): boolean {
  if (creation.deckId === deckId || creation.targetDeckId === deckId) return true;
  return creation.routing?.kind === "ambiguous" &&
    creation.routing.candidates.some((candidate) => candidate.deckId === deckId);
}

function creationEvents(context: AuthedContext): CreationEventsService {
  const events = context.workflows?.events ?? context.events;
  if (!events) {
    throw new InfrastructureFailure({
      operation: "router.creation-events",
      message: "Creation event service is not configured",
    });
  }
  return events;
}

const list = authed
  .input(z.object({}))
  .handler(({ context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    return yield* databaseEffect("decks.list", () => database.db
      .select()
      .from(decks)
      .where(eq(decks.userId, context.userId))
      .orderBy(asc(decks.createdAt)));
  })));

const create = authed
  .input(
    z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).nullish(),
    }),
  )
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    return yield* database.withWriteLock("decks.create", Effect.gen(function* () {
      const [deck] = yield* databaseEffect("decks.create", () => database.db
        .insert(decks)
        .values({
          userId: context.userId,
          name: input.name,
          description: input.description ?? null,
        })
        .returning());
      return deck;
    }));
  })));

const updatePronunciationSpeed = authed
  .input(z.object({
    deckId: z.uuidv7(),
    pronunciationSpeed: z.enum(["slow", "normal", "fast"]),
  }))
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    return yield* database.withWriteLock("decks.update-pronunciation", Effect.gen(function* () {
      const [deck] = yield* databaseEffect("decks.update-pronunciation", () => database.db
        .update(decks)
        .set({ pronunciationSpeed: input.pronunciationSpeed })
        .where(and(
          eq(decks.id, input.deckId),
          eq(decks.userId, context.userId),
        ))
        .returning());
      if (!deck) return yield* Effect.fail(new NotFound({ message: "Deck not found" }));
      return deck;
    }));
  })));

const remove = authed
  .input(z.object({ deckId: z.uuidv7() }))
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database, workflows } = yield* Application;
    const [deck] = yield* databaseEffect("decks.remove.find-deck", () => database.db
      .select({ id: decks.id })
      .from(decks)
      .where(and(eq(decks.id, input.deckId), eq(decks.userId, context.userId)))
      .limit(1));
    if (!deck) return yield* Effect.fail(new NotFound({ message: "Deck not found" }));

    const deckDrafts = yield* databaseEffect("decks.remove.find-creations", () => database.db
      .select()
      .from(drafts)
      .where(eq(drafts.userId, context.userId)));
    const affectedIds = deckDrafts
      .filter((creation) => referencesDeck(creation, input.deckId))
      .map((creation) => creation.id);
    yield* Effect.forEach(affectedIds, (id) => context.workflows
      ? workflows.legacy.abortJob(id)
      : Effect.sync(() => abortJob(id)), { discard: true });

    const { deckNotes, deckCards, creationDraftImages } = yield* database.withWriteLock(
      "decks.remove",
      databaseEffect("decks.remove", () => database.db.transaction(async (tx) => {
        const deckNotes = await tx
          .select({ imagePath: notes.imagePath })
          .from(notes)
          .where(and(eq(notes.deckId, input.deckId), eq(notes.userId, context.userId)));
        const deckCards = await tx
          .select({ audioPath: cards.audioPath })
          .from(cards)
          .innerJoin(notes, eq(cards.noteId, notes.id))
          .where(and(eq(notes.deckId, input.deckId), eq(cards.userId, context.userId)));
        const creations = await tx.select().from(drafts)
          .where(eq(drafts.userId, context.userId));
        const creationDraftImages: string[] = [];
        const now = new Date();
        for (const creation of creations) {
          if (!referencesDeck(creation, input.deckId)) continue;
          const selectedDeckDeleted = creation.deckId === input.deckId;
          const targetOnlyDeleted = !selectedDeckDeleted &&
            creation.targetDeckId === input.deckId;
          if (targetOnlyDeleted) {
            const retainsReviewedContent = creation.cards.length > 0;
            await tx.update(drafts).set({
              targetDeckId: null,
              targetLearningGoal: null,
              activeAttemptId: null,
              attemptCards: [],
              leaseOwner: null,
              leaseExpiresAt: null,
              status: retainsReviewedContent ? "failed" : "queued",
              operation: retainsReviewedContent ? null : "route_generate",
              errorCategory: retainsReviewedContent ? "routing_failed" : null,
              errorStage: retainsReviewedContent ? "routing" : null,
              error: retainsReviewedContent
                ? "The selected deck is no longer available. Choose another deck."
                : null,
              ...(!retainsReviewedContent ? { queuedAt: now } : {}),
              revision: creation.revision + 1,
              updatedAt: now,
            }).where(and(
              eq(drafts.id, creation.id),
              eq(drafts.userId, context.userId),
              eq(drafts.revision, creation.revision),
            ));
            continue;
          }
          const retainsReviewedFailure = creation.status === "failed" &&
            creation.cards.length > 0;
          if (!retainsReviewedFailure) {
            const [attempt] = creation.imageAttemptId
              ? await tx.select({
                draftImageId: creationImageAttempts.draftImageId,
              }).from(creationImageAttempts).where(and(
                eq(creationImageAttempts.id, creation.imageAttemptId),
                eq(creationImageAttempts.userId, context.userId),
                eq(creationImageAttempts.creationId, creation.id),
              )).limit(1)
              : [];
            const draftImageId = attempt?.draftImageId ?? creation.draftImageId;
            if (draftImageId) creationDraftImages.push(draftImageId);
            if (creation.imageAttemptId) {
              await tx.update(creationImageAttempts).set({
                status: "canceled",
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: now,
              }).where(and(
                eq(creationImageAttempts.id, creation.imageAttemptId),
                eq(creationImageAttempts.userId, context.userId),
              ));
            }
          }
          await tx.update(drafts).set({
            deckId: null,
            targetDeckId: null,
            targetLearningGoal: null,
            routing: null,
            activeAttemptId: null,
            attemptCards: [],
            leaseOwner: null,
            leaseExpiresAt: null,
            ...(!retainsReviewedFailure
              ? {
                imageAttemptId: null,
                imagePrompt: null,
                imageStatus: "none" as const,
                draftImageId: null,
              }
              : {}),
            status: retainsReviewedFailure ? "failed" : "queued",
            operation: retainsReviewedFailure ? null : "route_generate",
            ...(retainsReviewedFailure
              ? {
                errorCategory: "routing_failed" as const,
                errorStage: "routing" as const,
                error: "Choose a deck before retrying these cards.",
              }
              : {
                errorCategory: null,
                errorStage: null,
                error: null,
                queuedAt: now,
              }),
            revision: creation.revision + 1,
            updatedAt: now,
          }).where(and(
            eq(drafts.id, creation.id),
            eq(drafts.userId, context.userId),
            eq(drafts.revision, creation.revision),
          ));
        }
        await tx.delete(decks).where(and(
          eq(decks.id, input.deckId),
          eq(decks.userId, context.userId),
        ));
        return { deckNotes, deckCards, creationDraftImages };
      })),
    );

    if (affectedIds.length > 0) {
      if (context.workflows) {
        // The deck transaction has committed. Admission must therefore
        // outlive the HTTP request that caused it, including a disconnect
        // between commit and this scheduler kick.
        yield* Effect.uninterruptible(databaseEffect(
          "decks.remove.kick-text",
          () => runDetachedWorkflow(context, workflows.kickText(context.userId)),
        ));
      }
      yield* creationEvents(context).publishInbox(
          context.userId,
          affectedIds[0] ?? null,
          null,
      );
    }

    const imageRemover = context.removeImage ?? removeImage;
    const audioRemover = context.removeAudio ?? removeAudio;
    const draftImageRemover = context.removeDraftImage ?? removeDraftImage;
    const cleanup = [
      ...deckNotes
        .map(({ imagePath }) => imagePath)
        .filter((path): path is string => path !== null)
        .map((path) => () => imageRemover(path)),
      ...deckCards
        .map(({ audioPath }) => audioPath)
        .filter((path): path is string => path !== null)
        .map((path) => () => audioRemover(path)),
      ...creationDraftImages.map((draftImageId) => () =>
        draftImageRemover(context.userId, draftImageId),
      ),
    ];

    // Cleanup is also a post-commit obligation. It owns no request state and
    // remains uninterruptible after a disconnect, while still completing
    // before this procedure resolves as it did before the migration.
    const cleanupWork = Effect.forEach(cleanup, (work) => Effect.catchAll(
      Effect.tryPromise({ try: work, catch: (cause) => cause }),
      (cause) => Effect.sync(() => console.error("deck media cleanup failed", cause)),
    ), { concurrency: "unbounded", discard: true });
    yield* Effect.uninterruptible(databaseEffect(
      "decks.remove.media-cleanup",
      () => runDetachedWorkflow(context, cleanupWork),
    ));

    return { id: input.deckId };
  })));

export const decksRouter = { list, create, updatePronunciationSpeed, remove };
