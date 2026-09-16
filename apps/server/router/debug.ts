import * as z from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { Effect } from "effect";
import { authed, pub, runRouter } from "./base.ts";
import type { AuthedContext } from "./base.ts";
import type { Db } from "../db/index.ts";
import { cards, decks, drafts, notes, reviewLogs } from "../db/schema.ts";
import { GERMAN_SEED, GERMAN_SEED_NAME } from "../devtools/german-seed.ts";
import { removeImage, writeImage } from "../images.ts";
import { removeAudio, writeAudio } from "../audio.ts";
import { Conflict, DatabaseFailure, Forbidden } from "../effect/errors.ts";
import { Application } from "../effect/application.ts";

const databaseEffect = <A>(operation: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new DatabaseFailure({ operation, cause }),
  });

function assertDevtoolsEnabled(enabled: boolean | undefined): asserts enabled {
  if (enabled !== true) {
    throw new Forbidden({ message: "Devtools are disabled" });
  }
}

const devtoolsAuthed = authed.use(
  pub.middleware(async ({ context, next }) => {
    assertDevtoolsEnabled(context.devtoolsEnabled);
    return next();
  }),
);

const summary = devtoolsAuthed
  .input(z.object({}))
  .handler(({ context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    const [ownedDecks, ownedCards] = yield* databaseEffect("debug.summary", () => Promise.all([
      database.db
        .select({ id: decks.id, name: decks.name })
        .from(decks)
        .where(eq(decks.userId, context.userId))
        .orderBy(asc(decks.createdAt), asc(decks.id)),
      database.db
        .select({
          id: cards.id,
          deckId: notes.deckId,
          aspect: cards.aspect,
          front: cards.front,
        })
        .from(cards)
        .innerJoin(
          notes,
          and(
            eq(cards.noteId, notes.id),
            eq(notes.userId, context.userId),
          ),
        )
        .where(eq(cards.userId, context.userId))
        .orderBy(asc(cards.createdAt), asc(cards.id)),
    ]));

    const cardCounts = new Map<string, number>();
    for (const card of ownedCards) {
      cardCounts.set(card.deckId, (cardCounts.get(card.deckId) ?? 0) + 1);
    }

    return {
      totalCards: ownedCards.length,
      decks: ownedDecks.map((deck) => ({
        ...deck,
        cardCount: cardCounts.get(deck.id) ?? 0,
      })),
      cards: ownedCards,
    };
  })));

const resetSrsInput = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }),
  z.object({ scope: z.literal("deck"), deckId: z.uuidv7() }),
  z.object({ scope: z.literal("card"), cardId: z.uuidv7() }),
]);

type ResetSrsInput = z.infer<typeof resetSrsInput>;

function buildOwnedTarget(
  db: Pick<Db, "select">,
  userId: string,
  input: ResetSrsInput,
) {
  const ownedNoteIds = input.scope === "deck"
    ? db.select({ id: notes.id }).from(notes).where(
      and(eq(notes.userId, userId), eq(notes.deckId, input.deckId)),
    )
    : null;

  const cardWhere = input.scope === "all"
    ? eq(cards.userId, userId)
    : input.scope === "deck"
    ? and(
      eq(cards.userId, userId),
      inArray(cards.noteId, ownedNoteIds!),
    )
    : and(eq(cards.userId, userId), eq(cards.id, input.cardId));

  return {
    cardWhere,
    cardIds: db.select({ id: cards.id }).from(cards).where(cardWhere),
  };
}

const resetSrs = devtoolsAuthed
  .input(resetSrsInput)
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    return yield* database.withWriteLock("debug.reset-srs", databaseEffect(
      "debug.reset-srs",
      () => database.db.transaction(async (tx) => {
        const target = buildOwnedTarget(tx, context.userId, input);
        const [countRow] = await tx.select({ value: count() }).from(cards)
          .where(target.cardWhere);
        const resetCount = countRow?.value ?? 0;
        if (resetCount === 0) return { resetCount: 0 };

        const now = new Date();
        await tx.update(cards).set({
          due: now,
          stability: 0,
          difficulty: 0,
          elapsedDays: 0,
          scheduledDays: 0,
          learningSteps: 0,
          reps: 0,
          lapses: 0,
          state: 0,
          lastReview: null,
        }).where(target.cardWhere);

        await tx.delete(reviewLogs).where(
          and(
            eq(reviewLogs.userId, context.userId),
            inArray(reviewLogs.cardId, target.cardIds),
          ),
        );

        return { resetCount };
      }),
    ));
  })));

type SeedPlan = {
  deckId: string;
  notes: Array<{
    id: string;
    fixture: (typeof GERMAN_SEED.notes)[number];
    cards: Array<{
      id: string;
      fixture: (typeof GERMAN_SEED.notes)[number]["cards"][number];
    }>;
  }>;
};

type PreparedSeedMedia = {
  imagePaths: string[];
  audioPaths: string[];
  noteImagePaths: Map<string, string>;
  cardAudioPaths: Map<string, string>;
};

type OldGermanMedia = {
  noteIds: string[];
  cardIds: string[];
  imagePaths: string[];
  audioPaths: string[];
};

const GERMAN_SEED_ASSET_ROOT = new URL(
  "./../devtools/seed-assets/german/",
  import.meta.url,
);
const MODULE_DIR = import.meta.dirname ??
  path.dirname(fileURLToPath(import.meta.url));

function germanSeedAsset(asset: string): URL | string {
  return GERMAN_SEED_ASSET_ROOT.protocol === "file:"
    ? new URL(asset, GERMAN_SEED_ASSET_ROOT)
    : path.join(
      MODULE_DIR,
      "..",
      "devtools",
      "seed-assets",
      "german",
      asset,
    );
}

function seedImagePath(userId: string, noteId: string): string {
  return `${userId}/${noteId}.png`;
}

function seedAudioPath(userId: string, cardId: string): string {
  return `${userId}/${cardId}.mp3`;
}

function rememberPath(paths: string[], path: string): void {
  if (!paths.includes(path)) paths.push(path);
}

function planGermanSeed(): SeedPlan {
  return {
    deckId: uuidv7(),
    notes: GERMAN_SEED.notes.map((fixture) => ({
      id: uuidv7(),
      fixture,
      cards: fixture.cards.map((card) => ({ id: uuidv7(), fixture: card })),
    })),
  };
}

async function cleanUpNewMedia(
  context: AuthedContext,
  media: PreparedSeedMedia,
): Promise<void> {
  const deleteImage = context.removeImage ?? removeImage;
  const deleteAudio = context.removeAudio ?? removeAudio;
  const removals = await Promise.allSettled([
    ...media.imagePaths.map((path) => deleteImage(path)),
    ...media.audioPaths.map((path) => deleteAudio(path)),
  ]);
  const errors = removals.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed to clean up German seed media");
  }
}

async function rethrowAfterCleanup(
  cause: unknown,
  context: AuthedContext,
  media: PreparedSeedMedia,
): Promise<never> {
  try {
    await cleanUpNewMedia(context, media);
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      "German seed failed and media cleanup also failed",
    );
  }
  throw cause;
}

async function prepareGermanSeedMedia(
  context: AuthedContext,
  seed: SeedPlan,
): Promise<PreparedSeedMedia> {
  const storeImage = context.writeImage ?? writeImage;
  const storeAudio = context.writeAudio ?? writeAudio;
  const media: PreparedSeedMedia = {
    imagePaths: [],
    audioPaths: [],
    noteImagePaths: new Map(),
    cardAudioPaths: new Map(),
  };

  try {
    for (const note of seed.notes) {
      const bytes = await readFile(
        germanSeedAsset(note.fixture.imageAsset),
      );
      const intendedPath = seedImagePath(context.userId, note.id);
      rememberPath(media.imagePaths, intendedPath);
      const path = await storeImage(context.userId, note.id, bytes);
      rememberPath(media.imagePaths, path);
      media.noteImagePaths.set(note.id, path);
    }

    for (const note of seed.notes) {
      for (const card of note.cards) {
        const bytes = await readFile(
          germanSeedAsset(card.fixture.audioAsset),
        );
        const intendedPath = seedAudioPath(context.userId, card.id);
        rememberPath(media.audioPaths, intendedPath);
        const path = await storeAudio(context.userId, card.id, bytes);
        rememberPath(media.audioPaths, path);
        media.cardAudioPaths.set(card.id, path);
      }
    }
  } catch (error) {
    return await rethrowAfterCleanup(error, context, media);
  }

  return media;
}

async function selectOldGermanMedia(
  db: Pick<Db, "select">,
  userId: string,
): Promise<OldGermanMedia> {
  const germanDecks = await db.select({ id: decks.id }).from(decks).where(
    and(eq(decks.userId, userId), eq(decks.name, GERMAN_SEED_NAME)),
  );
  if (germanDecks.length === 0) {
    return { noteIds: [], cardIds: [], imagePaths: [], audioPaths: [] };
  }

  const oldNotes = await db.select({ id: notes.id, imagePath: notes.imagePath })
    .from(notes)
    .where(
      and(
        eq(notes.userId, userId),
        inArray(notes.deckId, germanDecks.map((deck) => deck.id)),
      ),
    );
  const noteIds = oldNotes.map((note) => note.id);
  const oldCards = noteIds.length === 0
    ? []
    : await db.select({ id: cards.id, audioPath: cards.audioPath }).from(cards)
      .where(
        and(eq(cards.userId, userId), inArray(cards.noteId, noteIds)),
      );

  return {
    noteIds,
    cardIds: oldCards.map((card) => card.id),
    imagePaths: [
      ...new Set(
        oldNotes.flatMap((note) => note.imagePath ? [note.imagePath] : []),
      ),
    ],
    audioPaths: [
      ...new Set(
        oldCards.flatMap((card) => card.audioPath ? [card.audioPath] : []),
      ),
    ],
  };
}

async function cleanUpOldMedia(
  context: AuthedContext,
  media: OldGermanMedia,
): Promise<void> {
  const deleteImage = context.removeImage ?? removeImage;
  const deleteAudio = context.removeAudio ?? removeAudio;
  await Promise.all([
    ...media.imagePaths.map(async (path) => {
      try {
        await deleteImage(path);
      } catch (error) {
        console.error(
          "failed to remove replaced German seed image",
          path,
          error,
        );
      }
    }),
    ...media.audioPaths.map(async (path) => {
      try {
        await deleteAudio(path);
      } catch (error) {
        console.error(
          "failed to remove replaced German seed audio",
          path,
          error,
        );
      }
    }),
  ]);
}

const seedGerman = devtoolsAuthed
  .input(z.object({ replace: z.boolean() }))
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    return yield* database.withWriteLock("debug.seed-german", Effect.gen(function* () {
      const existingDecks = yield* databaseEffect("debug.seed-german.find-decks", () => database.db
        .select({ id: decks.id })
        .from(decks)
        .where(
          and(
            eq(decks.userId, context.userId),
            eq(decks.name, GERMAN_SEED_NAME),
          ),
        )
        .orderBy(asc(decks.createdAt), asc(decks.id)));
      if (!input.replace && existingDecks[0]) {
        return {
          status: "needs-confirmation" as const,
          existingDeckId: existingDecks[0].id,
        };
      }
      if (input.replace && existingDecks.length > 0) {
        const [activeDraft] = yield* databaseEffect("debug.seed-german.find-draft", () => database.db
          .select({ id: drafts.id })
          .from(drafts)
          .where(
            and(
              eq(drafts.userId, context.userId),
              inArray(drafts.deckId, existingDecks.map((deck) => deck.id)),
            ),
          )
          .limit(1));
        if (activeDraft) {
          return yield* Effect.fail(new Conflict({
            message: "Save or discard the active draft before replacing German",
          }));
        }
      }

      const seed = planGermanSeed();
      const media = yield* Effect.tryPromise({
        try: () => prepareGermanSeedMedia(context, seed),
        catch: (cause) => cause,
      });
      const seedRows = Effect.gen(function* () {
        const oldMedia = input.replace
          ? yield* databaseEffect(
            "debug.seed-german.find-old-media",
            () => selectOldGermanMedia(database.db, context.userId),
          )
          : { noteIds: [], cardIds: [], imagePaths: [], audioPaths: [] };
        const result = yield* databaseEffect("debug.seed-german.write", () =>
          database.db.transaction(async (tx) => {
          const currentDecks = await tx.select({ id: decks.id }).from(decks)
            .where(
              and(
                eq(decks.userId, context.userId),
                eq(decks.name, GERMAN_SEED_NAME),
              ),
            )
            .orderBy(asc(decks.createdAt), asc(decks.id));
          if (!input.replace && currentDecks[0]) {
            return {
              status: "needs-confirmation" as const,
              existingDeckId: currentDecks[0].id,
            };
          }

          if (input.replace && currentDecks.length > 0) {
            await tx.delete(decks).where(
              and(
                eq(decks.userId, context.userId),
                eq(decks.name, GERMAN_SEED_NAME),
              ),
            );
          }

          const [deck] = await tx.insert(decks).values({
            id: seed.deckId,
            userId: context.userId,
            name: GERMAN_SEED_NAME,
          }).returning();
          const due = new Date();
          for (const note of seed.notes) {
            await tx.insert(notes).values({
              id: note.id,
              userId: context.userId,
              deckId: deck.id,
              sourceText: note.fixture.sourceText,
              domain: note.fixture.domain,
              language: note.fixture.language,
              metadata: note.fixture.metadata,
              imagePath: media.noteImagePaths.get(note.id)!,
            });
            await tx.insert(cards).values(note.cards.map((card) => ({
              id: card.id,
              noteId: note.id,
              userId: context.userId,
              aspect: card.fixture.aspect,
              front: card.fixture.front,
              back: card.fixture.back,
              imageCue: card.fixture.imageCue,
              cardType: "cloze" as const,
              audioPath: media.cardAudioPaths.get(card.id)!,
              audioStatus: "ready" as const,
              due,
            })));
          }

          return {
            status: "seeded" as const,
            deckId: deck.id,
            replaced: currentDecks.length > 0,
            noteCount: seed.notes.length,
            cardCount: seed.notes.reduce(
              (count, note) => count + note.cards.length,
              0,
            ),
          };
          }),
        );

        if (result.status === "needs-confirmation") {
          yield* Effect.tryPromise({
            try: () => cleanUpNewMedia(context, media),
            catch: (cause) => cause,
          });
          return result;
        }

        yield* Effect.tryPromise({
          try: () => cleanUpOldMedia(context, oldMedia),
          catch: (cause) => cause,
        });
        return result;
      });
      return yield* Effect.catchAll(seedRows, (cause) => Effect.tryPromise({
        try: () => rethrowAfterCleanup(cause, context, media),
        catch: (cleanupError) => cleanupError,
      }));
    }));
  })));

export const debugRouter = { summary, resetSrs, seedGerman };
