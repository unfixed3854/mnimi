import * as z from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import { parseCloze } from "@mnimi/shared";
import { authed, notFound, runDetachedWorkflow, runRouter, runWorkflow } from "./base.ts";
import type { AuthedContext } from "./base.ts";
import { removeAudio } from "../audio.ts";
import type { Db } from "../db/index.ts";
import { cards, decks, drafts, notes, reviewLogs } from "../db/schema.ts";
import { withReadTransaction } from "../db/read-transaction.ts";
import { hasFsErrorCode } from "../fs-errors.ts";
import { claimDraftImage, removeImage, setNoteImageFailed } from "../images.ts";
import { claimJobForNote, hasJobForNote } from "../ai/jobs.ts";
import { ttsTextForCard } from "../tts/eligibility.ts";
import {
  generateNoteAudio,
  invalidateCardAudioJob,
  resumeOrphanedAudio,
} from "../tts/jobs.ts";
import { Conflict, DatabaseFailure, NotFound, Validation } from "../effect/errors.ts";
import { Application } from "../effect/application.ts";
import { audioCardView } from "../tts/transport.ts";
import {
  initialScheduling,
  noteUpdateInput,
  validateEditableCard,
  validateOperationSets,
} from "./note-card-operations.ts";
import {
  BASIC_CARD_NEEDS_BACK,
  cardHasAnAnswer,
  clozeMarkupIsWellFormed,
  IMAGE_CUE_NEEDS_HINT,
  IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
  imageCueHasFallback,
  imageCuesMatchContext,
  MALFORMED_CLOZE,
} from "../ai/card-rules.ts";

const saveNoteInput = z.object({
  draftId: z.uuidv7(),
  // The one field the client is authoritative for. Sending it explicitly
  // means an autosave debounce still in flight can never cost an edit.
  cards: z
    .array(
      z
        .object({
          aspect: z.string().min(1),
          front: z.string().min(1),
          back: z.string().min(1).nullable(),
          imageCue: z.boolean(),
        })
        // The editor is a free-text field, so a hand-typed "{{c1::}}" reaches
        // here as readily as a generated card does. Rejecting it at the
        // boundary is what stops a card that renders a permanently empty blank
        // from being written and scheduled. Same rules as the generation
        // schema, from the same module, so the two cannot drift.
        .refine(clozeMarkupIsWellFormed, {
          message: MALFORMED_CLOZE,
          path: ["front"],
        })
        .refine(imageCueHasFallback, {
          message: IMAGE_CUE_NEEDS_HINT,
          path: ["front"],
        })
        .refine(cardHasAnAnswer, {
          message: BASIC_CARD_NEEDS_BACK,
          path: ["back"],
        }),
    )
    .min(1),
});

/** What a note records when the classify pass never completed. */
const UNCLASSIFIED = { domain: "concept", language: null, partOfSpeech: null };

const databaseEffect = <A>(operation: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => cause instanceof Conflict ||
        cause instanceof NotFound ||
        cause instanceof Validation
      ? cause
      : new DatabaseFailure({ operation, cause }),
  });

function generateAudio(
  context: AuthedContext,
  cardIds: readonly string[],
  noteId?: string,
): void {
  const report = (error: unknown) => console.error(
    "note audio generation failed",
    noteId,
    error,
  );
  if (context.workflows) {
    void runDetachedWorkflow(
      context,
      context.workflows.audio.generateNote(context.userId, cardIds),
    ).catch(report);
    return;
  }
  void generateNoteAudio(context.db, context.userId, [...cardIds]).catch(report);
}

async function claimLegacyImageJob(
  context: AuthedContext,
  draftId: string,
  noteId: string,
): Promise<boolean> {
  return context.workflows
    ? await runWorkflow(
      context,
      context.workflows.legacy.claimJobForNote(draftId, noteId),
    )
    : claimJobForNote(draftId, noteId);
}

async function hasLegacyImageJob(
  context: AuthedContext,
  noteId: string,
): Promise<boolean> {
  return context.workflows
    ? await runWorkflow(context, context.workflows.legacy.hasJobForNote(noteId))
    : hasJobForNote(noteId);
}

function resumeAudio(
  context: AuthedContext,
  rows: Parameters<typeof resumeOrphanedAudio>[2],
): void {
  if (context.workflows) {
    void runDetachedWorkflow(
      context,
      context.workflows.audio.resumeOrphaned(context.userId, rows),
    ).catch((error) => console.error("orphaned audio recovery failed", error));
    return;
  }
  resumeOrphanedAudio(context.db, context.userId, rows);
}

const listByDeck = authed
  .input(z.object({ deckId: z.uuidv7() }))
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    const [deck] = yield* databaseEffect("notes.list-by-deck.find-deck", () =>
      database.db.select({ id: decks.id }).from(decks).where(and(
        eq(decks.id, input.deckId),
        eq(decks.userId, context.userId),
      )).limit(1));
    if (!deck) return yield* Effect.fail(new NotFound({ message: "Deck not found" }));
    return yield* databaseEffect("notes.list-by-deck", () => database.db
      .select()
      .from(notes)
      .where(
        and(eq(notes.deckId, input.deckId), eq(notes.userId, context.userId)),
      )
      .orderBy(desc(notes.createdAt)));
  })));

const save = authed
  .input(saveNoteInput)
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    const now = new Date();
    // Generated here rather than left to the column default so the image's
    // destination path is known before anything is written.
    const noteId = uuidv7();

    // Reading the draft, consuming it and retiring it are ONE locked section,
    // exactly as the spec's §3.3 describes. Splitting the read out of the
    // lock is what let two tabs both hitting Save see the same ready draft
    // and mint the same note twice: the loser has to find the row already
    // gone, which is the same answer it would get for a draft that never
    // existed.
    //
    // This program owns the write lock. The Drizzle transaction nested below
    // must use its database handle directly, never acquire another lock.
    const saved = yield* database.withWriteLock(
      "notes.save",
      databaseEffect("notes.save", async () => {
      const [draft] = await database.db
        .select()
        .from(drafts)
        .where(
          and(eq(drafts.id, input.draftId), eq(drafts.userId, context.userId)),
        )
        .limit(1);
      if (!draft) throw notFound("Draft not found");
      if (draft.status === "generating") {
        throw new Conflict({
          message: "This draft is still generating",
        });
      }
      if (!draft.deckId) {
        throw new Conflict({
          message: "This draft needs a deck before it can be saved",
        });
      }
      const draftDeckId = draft.deckId;

      const classification = draft.classification ?? UNCLASSIFIED;
      const cardValues = input.cards.map((card) => {
        const id = uuidv7();
        const eligible = ttsTextForCard(classification, card) !== null;
        return {
          id,
          noteId,
          userId: context.userId,
          ...card,
          cardType: parseCloze(card.front)
            ? ("cloze" as const)
            : ("basic" as const),
          audioStatus: eligible ? ("pending" as const) : null,
          due: now,
        };
      });

      if (
        !imageCuesMatchContext(
          input.cards,
          classification.domain,
          draft.imagePrompt,
        )
      ) {
        throw new Validation({
          message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
          issues: [],
        });
      }

      const note = await database.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(notes)
          .values({
            id: noteId,
            userId: context.userId,
            deckId: draftDeckId,
            sourceText: draft.sourceText,
            domain: classification.domain,
            language: classification.language,
            metadata: {
              partOfSpeech: classification.partOfSpeech,
              imagePrompt: draft.imagePrompt,
              ...(draft.status === "failed" ? { generationFailed: true } : {}),
            },
          })
          .returning();

        await tx.insert(cards).values(cardValues);

        return inserted;
      });

      const settled = await settleImage(context, database.db, note, draft);
      return {
        note: settled,
        eligibleCardIds: cardValues
          .filter((card) => card.audioStatus === "pending")
          .map((card) => card.id),
      };
      }),
    );

    generateAudio(context, saved.eligibleCardIds, saved.note.id);
    return saved.note;
  })));

/**
 * Attaches the picture and retires the draft.
 *
 * Called from INSIDE `save`'s locked section and never takes the lock itself:
 * that is what makes this and a running image stage's own settle unable to
 * interleave — whichever takes the write lock first, the other sees a settled
 * world (see the spec's §3.3).
 *
 * Every failure in here is swallowed rather than thrown: `delete(drafts)` is
 * the last statement of that locked section, and throwing before it would
 * commit the note while leaving the draft row alive. The user's obvious next
 * move — retry the save — would then re-consume that same draft and mint a
 * SECOND note. Degrading to "note without image" and still deleting the
 * draft is the only outcome that can't double-save.
 */
async function settleImage(
  context: AuthedContext,
  db: AuthedContext["db"],
  note: typeof notes.$inferSelect,
  draft: typeof drafts.$inferSelect,
) {
  // Read off the note rather than the draft: the two are the same fact here,
  // and the note's metadata is the copy that outlives the row.
  const imageWanted = note.metadata.imagePrompt != null;
  const draftId = draft.id;

  // Declared out here, and every attach failure caught below, so that
  // `delete(drafts)` genuinely is unconditional. The three
  // `setNoteImageFailed` calls each issue their own UPDATE, and any of them
  // failing used to escape and abandon the draft row.
  let result = note;

  try {
    if (draft.imageStatus === "ready" && draft.draftImageId) {
      let imagePath: string | null = null;
      try {
        imagePath = await (context.claimDraftImage ?? claimDraftImage)(
          context.userId,
          draft.draftImageId,
          note.id,
        );
      } catch (error) {
        // ENOENT is expected: swept, or already claimed. Anything else is
        // a real I/O fault and worth telling apart from that.
        if (hasFsErrorCode(error, "ENOENT")) {
          console.error("draft image was swept or already claimed", error);
        } else {
          console.error("could not claim the draft image", error);
        }
      }

      if (imagePath != null) {
        try {
          await db
            .update(notes)
            .set({ imagePath })
            .where(eq(notes.id, note.id));
          result = { ...note, imagePath };
        } catch (error) {
          // The claim itself already succeeded — the file really did move
          // onto the note's path — so this must NOT be logged as "could not
          // claim": that would send a future debugger chasing a file that is
          // sitting exactly where it belongs.
          //
          // It does leave a PNG at the note's path with `imagePath: null`,
          // outside the sweep's reach (which only walks DRAFTS_DIR).
          // Accepted: the same failure sets `imageFailed`, which is what
          // turns on the note screen's retry, and that retry's
          // `ai.generateImage → writeImage(uid, noteId)` writes to precisely
          // this path. Worst case, if the user never retries, is one leaked
          // file — cheaper than a compensating delete that could remove a
          // picture a concurrent write had just made valid.
          console.error(
            "claimed the draft image but could not record its path",
            error,
          );
          await setNoteImageFailed(db, context.userId, note.id, true);
          result = {
            ...note,
            metadata: { ...note.metadata, imageFailed: true },
          };
        }
      } else {
        await setNoteImageFailed(db, context.userId, note.id, true);
        result = { ...note, metadata: { ...note.metadata, imageFailed: true } };
      }
    } else if (await claimLegacyImageJob(context, draftId, note.id)) {
      // The picture is still rendering. The stage now writes straight onto
      // the note, so this is not a failure and must not be recorded as one.
    } else if (imageWanted) {
      await setNoteImageFailed(db, context.userId, note.id, true);
      result = { ...note, metadata: { ...note.metadata, imageFailed: true } };
    }
  } catch (error) {
    // `result` is whatever last landed, so the caller is told what is
    // actually on the row rather than what was intended.
    console.error("could not settle the draft image", error);
  }

  await db.delete(drafts).where(eq(drafts.id, draftId));
  return result;
}

const get = authed
  .input(z.object({ noteId: z.uuidv7() }))
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    return yield* databaseEffect(
      "notes.get",
      () => loadNoteDetails(context, database.db, input.noteId),
    );
  })));

type NoteReadDb = Pick<Db, "select">;

async function loadNoteSnapshot(
  db: NoteReadDb,
  userId: string,
  noteId: string,
) {
  const [row] = await db
    .select({
      note: notes,
      pronunciationSpeed: decks.pronunciationSpeed,
    })
    .from(notes)
    .innerJoin(decks, eq(notes.deckId, decks.id))
    .where(and(
      eq(notes.id, noteId),
      eq(notes.userId, userId),
      eq(decks.userId, userId),
    ))
    .limit(1);
  if (!row) throw notFound("Note not found");
  const { note, pronunciationSpeed } = row;

  const noteCards = await db
    .select()
    .from(cards)
    .where(and(eq(cards.noteId, note.id), eq(cards.userId, userId)))
    .orderBy(asc(cards.createdAt), asc(cards.id));

  return { note, cards: noteCards, pronunciationSpeed };
}

function noteDetailsFromSnapshot(
  snapshot: Awaited<ReturnType<typeof loadNoteSnapshot>>,
  imageGenerating = false,
) {
  // `imagePath === null` alone can't tell "never wanted one" / "failed"
  // apart from "a redirected job is still rendering it" — see
  // `claimJobForNote`. This is what lets the note screen tell them apart.
  return {
    note: snapshot.note,
    cards: snapshot.cards.map((card) =>
      audioCardView(card, snapshot.note)
    ),
    pronunciationSpeed: snapshot.pronunciationSpeed,
    imageGenerating,
  };
}

async function loadNoteDetails(
  context: AuthedContext,
  db: AuthedContext["db"],
  noteId: string,
) {
  const snapshot = await withReadTransaction(db, (tx) =>
    loadNoteSnapshot(tx, context.userId, noteId)
  );
  resumeAudio(context, snapshot.cards);
  return noteDetailsFromSnapshot(
    snapshot,
    await hasLegacyImageJob(context, snapshot.note.id),
  );
}

type AudioChanges = {
  audioPathsToRemove: string[];
  audioCardIdsToGenerate: string[];
};

async function settleAudioChanges(
  context: AuthedContext,
  changes: AudioChanges,
): Promise<void> {
  const audioRemover = context.removeAudio ?? removeAudio;
  const removals = await Promise.allSettled(
    changes.audioPathsToRemove.map((path) => audioRemover(path)),
  );
  for (const [index, result] of removals.entries()) {
    if (result.status === "rejected") {
      console.error(
        "note card audio cleanup failed",
        changes.audioPathsToRemove[index],
        result.reason,
      );
    }
  }

  generateAudio(context, changes.audioCardIdsToGenerate);
}

const deleteNote = authed
  .input(z.object({
    noteId: z.uuidv7(),
    expectedRevision: z.number().int().nonnegative(),
  }))
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    const removed = yield* database.withWriteLock(
      "notes.delete",
      databaseEffect("notes.delete", () => database.db.transaction(async (tx) => {
        const [note] = await tx
          .select()
          .from(notes)
          .where(
            and(eq(notes.id, input.noteId), eq(notes.userId, context.userId)),
          )
          .limit(1);
        if (!note) throw notFound("Note not found");
        if (note.revision !== input.expectedRevision) {
          throw new Conflict({
            message:
              "This note changed somewhere else. Reload it before deleting.",
          });
        }

        const noteCards = await tx
          .select({ audioPath: cards.audioPath })
          .from(cards)
          .where(
            and(eq(cards.noteId, note.id), eq(cards.userId, context.userId)),
          );
        await tx.delete(notes).where(
          and(eq(notes.id, note.id), eq(notes.userId, context.userId)),
        );
        return {
          id: note.id,
          deckId: note.deckId,
          imagePath: note.imagePath,
          audioPaths: noteCards.flatMap(({ audioPath }) =>
            audioPath ? [audioPath] : []
          ),
        };
      })),
    );

    const imageRemover = context.removeImage ?? removeImage;
    const audioRemover = context.removeAudio ?? removeAudio;
    const imagePath = removed.imagePath;
    const cleanup = [
      ...(imagePath ? [() => imageRemover(imagePath)] : []),
      ...removed.audioPaths.map((path) => () => audioRemover(path)),
    ];
    // The row is already gone. Detached, uninterruptible cleanup preserves
    // the old wait-for-cleanup response contract without request cancellation
    // being able to orphan media after commit.
    const cleanupWork = Effect.forEach(cleanup, (work) => Effect.catchAll(
      Effect.tryPromise({ try: work, catch: (cause) => cause }),
      (cause) => Effect.sync(() => console.error("note media cleanup failed", cause)),
    ), { concurrency: "unbounded", discard: true });
    yield* Effect.uninterruptible(Effect.tryPromise({
      try: () => runDetachedWorkflow(context, cleanupWork),
      catch: (cause) => new DatabaseFailure({
        operation: "notes.delete.media-cleanup",
        cause,
      }),
    }));

    return { id: removed.id, deckId: removed.deckId };
  })));

const update = authed
  .input(noteUpdateInput)
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    yield* Effect.try({
      try: () => {
        validateOperationSets(input);
        for (const operation of input.creates) {
          validateEditableCard(operation.card, {
            clientKey: operation.clientKey,
          });
        }
        for (const operation of input.updates) {
          validateEditableCard(operation.card, { cardId: operation.cardId });
        }
      },
      catch: (cause) => cause instanceof Validation
        ? cause
        : new DatabaseFailure({ operation: "notes.update.validate", cause }),
    });

    const now = new Date();
    const changed = yield* database.withWriteLock(
      "notes.update",
      databaseEffect("notes.update", () => database.db.transaction(async (tx) => {
        const [note] = await tx
          .select()
          .from(notes)
          .where(
            and(
              eq(notes.id, input.noteId),
              eq(notes.userId, context.userId),
            ),
          )
          .limit(1);
        if (!note) throw notFound("Note not found");
        if (note.revision !== input.expectedRevision) {
          throw new Conflict({
            message:
              "This note changed somewhere else. Reload it before saving.",
          });
        }

        const existing = await tx
          .select()
          .from(cards)
          .where(
            and(
              eq(cards.noteId, note.id),
              eq(cards.userId, context.userId),
            ),
          );
        const byId = new Map(existing.map((card) => [card.id, card]));
        const referenced = [
          ...input.updates.map(({ cardId }) => cardId),
          ...input.deleteCardIds,
          ...input.resetCardIds,
        ];
        if (referenced.some((cardId) => !byId.has(cardId))) {
          throw notFound("Card not found");
        }

        const updateById = new Map(
          input.updates.map((operation) => [
            operation.cardId,
            operation.card,
          ]),
        );
        const deleteIds = new Set(input.deleteCardIds);
        const resultingCards = [
          ...existing
            .filter((card) => !deleteIds.has(card.id))
            .map((card) => updateById.get(card.id) ?? card),
          ...input.creates.map(({ card }) => card),
        ];
        if (
          !imageCuesMatchContext(
            resultingCards,
            note.domain,
            note.metadata.imagePrompt ?? null,
          )
        ) {
          throw new Validation({
            message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
            issues: [],
          });
        }

        const createdIds: Array<{ clientKey: string; cardId: string }> = [];
        const audioPathsToRemove: string[] = [];
        const audioCardIdsToGenerate: string[] = [];
        const audioJobsToInvalidate = new Set<string>();

        for (const { cardId, card } of input.updates) {
          const previous = byId.get(cardId)!;
          const previousText = ttsTextForCard(note, previous);
          const nextText = ttsTextForCard(note, card);
          const textChanged = previousText !== nextText;
          if (textChanged) {
            audioJobsToInvalidate.add(cardId);
            if (previous.audioPath) {
              audioPathsToRemove.push(previous.audioPath);
            }
            if (nextText !== null) audioCardIdsToGenerate.push(cardId);
          }
          await tx
            .update(cards)
            .set({
              ...card,
              cardType: parseCloze(card.front) ? "cloze" : "basic",
              ...(textChanged
                ? {
                  audioPath: null,
                  audioStatus: nextText === null ? null : "pending",
                }
                : {}),
            })
            .where(
              and(
                eq(cards.id, cardId),
                eq(cards.noteId, note.id),
                eq(cards.userId, context.userId),
              ),
            );
        }

        for (const [index, { clientKey, card }] of input.creates.entries()) {
          const cardId = uuidv7();
          const text = ttsTextForCard(note, card);
          await tx.insert(cards).values({
            id: cardId,
            noteId: note.id,
            userId: context.userId,
            ...card,
            cardType: parseCloze(card.front) ? "cloze" : "basic",
            audioStatus: text === null ? null : "pending",
            createdAt: new Date(now.getTime() + index),
            ...initialScheduling(now),
          });
          createdIds.push({ clientKey, cardId });
          if (text !== null) audioCardIdsToGenerate.push(cardId);
        }

        if (input.resetCardIds.length > 0) {
          await tx.delete(reviewLogs).where(
            and(
              inArray(reviewLogs.cardId, input.resetCardIds),
              eq(reviewLogs.userId, context.userId),
            ),
          );
          await tx
            .update(cards)
            .set(initialScheduling(now))
            .where(
              and(
                inArray(cards.id, input.resetCardIds),
                eq(cards.noteId, note.id),
                eq(cards.userId, context.userId),
              ),
            );
        }

        if (input.deleteCardIds.length > 0) {
          for (const cardId of input.deleteCardIds) {
            const previous = byId.get(cardId)!;
            audioJobsToInvalidate.add(cardId);
            if (previous.audioPath) {
              audioPathsToRemove.push(previous.audioPath);
            }
          }
          await tx.delete(cards).where(
            and(
              inArray(cards.id, input.deleteCardIds),
              eq(cards.noteId, note.id),
              eq(cards.userId, context.userId),
            ),
          );
        }

        await tx
          .update(notes)
          .set({ revision: note.revision + 1 })
          .where(
            and(
              eq(notes.id, note.id),
              eq(notes.userId, context.userId),
            ),
        );
        for (const cardId of audioJobsToInvalidate) {
          if (context.workflows) {
            await runWorkflow(
              context,
              context.workflows.audio.invalidate(cardId),
            );
          } else {
            invalidateCardAudioJob(cardId);
          }
        }
        const snapshot = await loadNoteSnapshot(
          tx,
          context.userId,
          note.id,
        );
        return {
          createdIds,
          audioPathsToRemove,
          audioCardIdsToGenerate,
          snapshot,
        };
      })),
    );

    yield* Effect.tryPromise({
      try: () => settleAudioChanges(context, changed),
      catch: (cause) => new DatabaseFailure({ operation: "notes.update.audio", cause }),
    });
    yield* Effect.sync(() => resumeAudio(context, changed.snapshot.cards));
    const details = noteDetailsFromSnapshot(
      changed.snapshot,
      yield* Effect.tryPromise({
        try: () => hasLegacyImageJob(context, changed.snapshot.note.id),
        catch: (cause) => new DatabaseFailure({
          operation: "notes.update.image-job",
          cause,
        }),
      }),
    );
    return { ...details, createdIds: changed.createdIds };
  })));

export const notesRouter = {
  get,
  listByDeck,
  save,
  update,
  delete: deleteNote,
};
