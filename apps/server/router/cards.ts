import * as z from "zod";
import { and, asc, count, eq, lte } from "drizzle-orm";
import { Effect, Either } from "effect";
import { authed, notFound, runRouter } from "./base.ts";
import { cards, decks, notes, reviewLogs } from "../db/schema.ts";
import { audioCardView } from "../tts/transport.ts";
import {
  AudioCardIneligibleError,
  AudioCardNotFoundError,
  generateCardAudio,
} from "../tts/jobs.ts";
import {
  AudioCardIneligibleError as EffectAudioCardIneligibleError,
  AudioCardNotFoundError as EffectAudioCardNotFoundError,
} from "../effect/audio-jobs.ts";
import { DatabaseFailure, NotFound, Validation } from "../effect/errors.ts";
import { Application } from "../effect/application.ts";

const databaseEffect = <A>(operation: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new DatabaseFailure({ operation, cause }),
  });

/** The scheduling state ts-fsrs produces for a graded card. */
const fsrsColumnsSchema = z.object({
  due: z.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsedDays: z.number().int(),
  scheduledDays: z.number().int(),
  learningSteps: z.number().int(),
  reps: z.number().int(),
  lapses: z.number().int(),
  state: z.number().int().min(0).max(3),
  lastReview: z.date().nullable(),
});

const reviewLogInputSchema = z.object({
  rating: z.number().int().min(1).max(4),
  state: z.number().int().min(0).max(3),
  due: z.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsedDays: z.number().int(),
  lastElapsedDays: z.number().int(),
  scheduledDays: z.number().int(),
  learningSteps: z.number().int(),
  review: z.date(),
});

const dueFilterInput = z.object({ deckId: z.uuidv7().nullish() });
const dueQueueInput = dueFilterInput.extend({
  shuffleSeed: z.number().int().min(0).max(0xffff_ffff).optional(),
});

/**
 * Gives each card a session-specific rank. Ranking cards independently keeps
 * the remaining order stable when a graded card disappears on refetch.
 */
function orderForReviewSession<T extends { id: string }>(
  items: T[],
  shuffleSeed: number,
): T[] {
  const rank = (id: string) =>
    (Number.parseInt(id.slice(-8), 16) ^ shuffleSeed) >>> 0;

  return [...items].sort((left, right) =>
    rank(left.id) - rank(right.id) || left.id.localeCompare(right.id)
  );
}

const due = authed
  .input(dueQueueInput)
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    const rows = yield* databaseEffect("cards.due", () => database.db
      .select({
        card: cards,
        imagePath: notes.imagePath,
        domain: notes.domain,
        language: notes.language,
        pronunciationSpeed: decks.pronunciationSpeed,
      })
      .from(cards)
      .innerJoin(notes, eq(cards.noteId, notes.id))
      .innerJoin(decks, eq(notes.deckId, decks.id))
      .where(
        and(
          eq(cards.userId, context.userId),
          eq(cards.suspended, false),
          lte(cards.due, new Date()),
          input.deckId ? eq(notes.deckId, input.deckId) : undefined,
        ),
      )
      .orderBy(asc(cards.due))
      // 100 is a review session's worth. dueCount below deliberately does not
      // share this cap: a "Today" counter built on it would tell a user with
      // 120 cards due that only 100 are.
      .limit(100));

    // A boolean, not the path: the review screen only needs to know whether
    // to render, and the stored path is a server-side detail.
    const projected = rows.map((row) => ({
      ...audioCardView(row.card, {
        domain: row.domain,
        language: row.language,
      }),
      hasImage: row.imagePath !== null,
      pronunciationSpeed: row.pronunciationSpeed,
    }));

    return input.shuffleSeed === undefined
      ? projected
      : orderForReviewSession(projected, input.shuffleSeed);
  })));

const generateAudio = authed
  .input(z.object({ cardId: z.uuidv7() }))
  .handler(async ({ input, context }) => {
    if (context.runtime) {
      return runRouter(context, Effect.gen(function* () {
        const { workflows } = yield* Application;
        const audio = yield* Effect.either(
          workflows.audio.generateCard(context.userId, input.cardId),
        );
        if (Either.isLeft(audio)) {
          if (audio.left instanceof EffectAudioCardNotFoundError) {
            return yield* Effect.fail(new NotFound({ message: "Card not found" }));
          }
          if (audio.left instanceof EffectAudioCardIneligibleError) {
            return yield* Effect.fail(new Validation({
              message: "Card is not eligible for audio",
              issues: [],
            }));
          }
          return yield* Effect.fail(audio.left);
        }
        return { hasAudio: true as const, audioStatus: "ready" as const };
      }) as Effect.Effect<
        { hasAudio: true; audioStatus: "ready" },
        unknown,
        Application
      >);
    }

    try {
      await generateCardAudio(context.db, context.userId, input.cardId);
    } catch (error) {
      if (error instanceof AudioCardNotFoundError ||
        error instanceof EffectAudioCardNotFoundError) {
        throw notFound("Card not found");
      }
      if (error instanceof AudioCardIneligibleError ||
        error instanceof EffectAudioCardIneligibleError) {
        throw new Validation({
          message: "Card is not eligible for audio",
          issues: [],
        });
      }
      throw error;
    }

    return { hasAudio: true, audioStatus: "ready" as const };
  });

const dueCount = authed
  .input(dueFilterInput)
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    const [row] = yield* databaseEffect("cards.due-count", () => database.db
      .select({ value: count() })
      .from(cards)
      .innerJoin(notes, eq(cards.noteId, notes.id))
      .where(
        and(
          eq(cards.userId, context.userId),
          eq(cards.suspended, false),
          lte(cards.due, new Date()),
          input.deckId ? eq(notes.deckId, input.deckId) : undefined,
        ),
      ));

    return row?.value ?? 0;
  })));

const grade = authed
  .input(
    z.object({
      cardId: z.uuidv7(),
      card: fsrsColumnsSchema,
      log: reviewLogInputSchema,
    }),
  )
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    // Ownership first, outside the transaction, so a wrong-owner id costs a
    // cheap lookup rather than an opened write transaction.
    const [owned] = yield* databaseEffect("cards.find-owned", () => database.db
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.id, input.cardId), eq(cards.userId, context.userId)))
      .limit(1));
    if (!owned) return yield* Effect.fail(new NotFound({ message: "Card not found" }));

    // The card update and its log are one unit: a card whose state advanced
    // without a log would silently lose review history.
    //
    // withWriteLock queues it behind any other open write transaction — a
    // grade arriving mid-`notes.save` would otherwise fail SQLITE_BUSY
    // instantly, and React Query does not retry mutations.
    yield* database.withWriteLock("cards.grade", databaseEffect(
      "cards.grade",
      () => database.db.transaction(async (tx) => {
        await tx
          .update(cards)
          .set(input.card)
          .where(
            and(eq(cards.id, input.cardId), eq(cards.userId, context.userId)),
          );

        await tx.insert(reviewLogs).values({
          ...input.log,
          cardId: input.cardId,
          userId: context.userId,
        });
      }),
    ));
  })));

export const cardsRouter = { due, dueCount, generateAudio, grade };
