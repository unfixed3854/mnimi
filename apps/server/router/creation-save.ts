import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { parseCloze } from "@mnimi/shared";
import { uuidv7 } from "uuidv7";
import { notFound, runDetachedWorkflow, runWorkflow } from "./base.ts";
import type { AuthedContext } from "./base.ts";
import {
  cards,
  creationImageAttempts,
  creationSaveReceipts,
  drafts,
  notes,
} from "../db/schema.ts";
import { normalizeStoredCards } from "../creations/contracts.ts";
import {
  IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
  imageCuesMatchContext,
} from "../ai/card-rules.ts";
import { claimDraftImage } from "../images.ts";
import { ttsTextForCard } from "../tts/eligibility.ts";
import { generateNoteAudio } from "../tts/jobs.ts";
import { initialScheduling } from "./note-card-operations.ts";
import { claimJobForNote } from "../ai/jobs.ts";
import { Application } from "../effect/application.ts";
import { Conflict, DatabaseFailure, NotFound, Validation } from "../effect/errors.ts";

export type SaveCreationInput = {
  creationId: string;
  expectedRevision: number;
  saveRequestId: string;
};

export type SaveCreationResult = {
  noteId: string;
  deckId: string;
  sourceText: string;
};

const databaseEffect = <A>(operation: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => cause instanceof Conflict ||
        cause instanceof NotFound ||
        cause instanceof Validation
      ? cause
      : new DatabaseFailure({ operation, cause }),
  });

async function receiptResult(
  db: AuthedContext["db"],
  userId: string,
  creationId: string,
  saveRequestId: string,
): Promise<SaveCreationResult | null> {
  const [byCreation] = await db.select({
    creationId: creationSaveReceipts.creationId,
    saveRequestId: creationSaveReceipts.saveRequestId,
    noteId: creationSaveReceipts.noteId,
    deckId: creationSaveReceipts.deckId,
    sourceText: notes.sourceText,
  }).from(creationSaveReceipts).innerJoin(
    notes,
    eq(notes.id, creationSaveReceipts.noteId),
  ).where(and(
    eq(creationSaveReceipts.userId, userId),
    eq(creationSaveReceipts.creationId, creationId),
  )).limit(1);
  if (byCreation) {
    return {
      noteId: byCreation.noteId,
      deckId: byCreation.deckId,
      sourceText: byCreation.sourceText,
    };
  }

  const [byRequest] = await db.select({
    creationId: creationSaveReceipts.creationId,
    noteId: creationSaveReceipts.noteId,
    deckId: creationSaveReceipts.deckId,
    sourceText: notes.sourceText,
  }).from(creationSaveReceipts).innerJoin(
    notes,
    eq(notes.id, creationSaveReceipts.noteId),
  ).where(and(
    eq(creationSaveReceipts.userId, userId),
    eq(creationSaveReceipts.saveRequestId, saveRequestId),
  )).limit(1);
  if (!byRequest) return null;
  if (byRequest.creationId !== creationId) {
    throw new Conflict({
      message: "This save request was already used.",
    });
  }
  return {
    noteId: byRequest.noteId,
    deckId: byRequest.deckId,
    sourceText: byRequest.sourceText,
  };
}

export function saveCreation(
  context: AuthedContext,
  input: SaveCreationInput,
): Effect.Effect<
  SaveCreationResult,
  Conflict | DatabaseFailure | NotFound | Validation,
  Application
> {
  return Effect.gen(function* () {
    const { database } = yield* Application;
    const saved = yield* database.withWriteLock(
      "creation-save",
      databaseEffect("creation-save", async () => {
    const receipt = await receiptResult(
      database.db,
      context.userId,
      input.creationId,
      input.saveRequestId,
    );
    if (receipt) return { result: receipt, eligibleCardIds: [] as string[] };

    const [creation] = await database.db.select().from(drafts).where(and(
      eq(drafts.id, input.creationId),
      eq(drafts.userId, context.userId),
    )).limit(1);
    if (!creation) throw notFound("Creation not found");
    const reviewable = creation.status === "ready" || creation.status === "failed";
    if (creation.revision !== input.expectedRevision || !reviewable ||
      creation.operation !== null || creation.activeAttemptId !== null) {
      throw new Conflict({
        message: "This creation is not ready to save.",
      });
    }
    if (!creation.deckId) {
      throw new Conflict({
        message: "Choose a deck before saving this creation.",
      });
    }
    const reviewedCards = normalizeStoredCards(creation.id, creation.cards);
    if (reviewedCards.length === 0 || reviewedCards.length > 6 ||
      reviewedCards.length !== creation.cards.length) {
      throw new Validation({
        message: "Review the complete card set before saving.",
        issues: [],
      });
    }
    const classification = creation.classification ?? {
      domain: "concept",
      language: null,
      partOfSpeech: null,
    };
    if (!imageCuesMatchContext(
      reviewedCards,
      classification.domain,
      creation.imagePrompt,
    )) {
      throw new Validation({
        message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
        issues: [],
      });
    }

    const now = new Date();
    const noteId = uuidv7();
    const cardValues = reviewedCards.map(({ key: _key, ...card }) => {
      const id = uuidv7();
      const eligible = ttsTextForCard(classification, card) !== null;
      return {
        id,
        noteId,
        userId: context.userId,
        ...card,
        cardType: parseCloze(card.front) ? "cloze" as const : "basic" as const,
        audioStatus: eligible ? "pending" as const : null,
        ...initialScheduling(now),
      };
    });
    const claim = context.claimDraftImage ?? claimDraftImage;

    return await database.db.transaction(async (tx) => {
      const metadata: {
        partOfSpeech: string | null;
        imagePrompt: string | null;
        generationFailed?: boolean;
        imageFailed?: boolean;
      } = {
        partOfSpeech: classification.partOfSpeech,
        imagePrompt: creation.imagePrompt,
        ...(creation.status === "failed" ? { generationFailed: true } : {}),
      };
      const [inserted] = await tx.insert(notes).values({
        id: noteId,
        userId: context.userId,
        deckId: creation.deckId!,
        sourceText: creation.sourceText,
        domain: classification.domain,
        language: classification.language,
        metadata,
      }).returning();
      await tx.insert(cards).values(cardValues);
      // Establish idempotency before touching the filesystem. A duplicate or
      // injected receipt failure rolls back note/cards without moving image
      // bytes out of generation-owned storage.
      await tx.insert(creationSaveReceipts).values({
        userId: context.userId,
        creationId: creation.id,
        saveRequestId: input.saveRequestId,
        noteId,
        deckId: creation.deckId!,
      });

      let imagePath: string | null = null;
      if (creation.imageAttemptId) {
        const [attempt] = await tx.select().from(creationImageAttempts).where(and(
          eq(creationImageAttempts.id, creation.imageAttemptId),
          eq(creationImageAttempts.userId, context.userId),
          eq(creationImageAttempts.creationId, creation.id),
        )).limit(1);
        if (attempt?.status === "ready" && attempt.draftImageId) {
          try {
            imagePath = await claim(
              context.userId,
              attempt.draftImageId,
              noteId,
            );
            await tx.update(notes).set({ imagePath }).where(eq(notes.id, noteId));
            await tx.update(creationImageAttempts).set({
              creationId: null,
              noteId,
              draftImageId: null,
              updatedAt: now,
            }).where(eq(creationImageAttempts.id, attempt.id));
          } catch (error) {
            console.error("could not claim creation image", error);
            metadata.imageFailed = true;
            await tx.update(notes).set({ metadata }).where(eq(notes.id, noteId));
            await tx.update(creationImageAttempts).set({
              creationId: null,
              noteId,
              updatedAt: now,
            }).where(eq(creationImageAttempts.id, attempt.id));
          }
        } else if (attempt?.status === "queued" || attempt?.status === "generating") {
          await tx.update(creationImageAttempts).set({
            creationId: null,
            noteId,
            updatedAt: now,
          }).where(eq(creationImageAttempts.id, attempt.id));
        } else if (attempt?.status === "failed") {
          metadata.imageFailed = true;
          await tx.update(notes).set({ metadata }).where(eq(notes.id, noteId));
          await tx.update(creationImageAttempts).set({
            creationId: null,
            noteId,
            updatedAt: now,
          }).where(eq(creationImageAttempts.id, attempt.id));
        }
      } else if (creation.imageStatus === "ready" && creation.draftImageId) {
        try {
          imagePath = await claim(
            context.userId,
            creation.draftImageId,
            noteId,
          );
          await tx.update(notes).set({ imagePath }).where(eq(notes.id, noteId));
        } catch (error) {
          console.error("could not claim legacy creation image", error);
          metadata.imageFailed = true;
          await tx.update(notes).set({ metadata }).where(eq(notes.id, noteId));
        }
      } else if (creation.imagePrompt &&
        !(context.workflows
          ? await runWorkflow(
            context,
            context.workflows.legacy.claimJobForNote(creation.id, noteId),
          )
          : claimJobForNote(creation.id, noteId))) {
        metadata.imageFailed = true;
        await tx.update(notes).set({ metadata }).where(eq(notes.id, noteId));
      }

      await tx.delete(drafts).where(and(
        eq(drafts.id, creation.id),
        eq(drafts.userId, context.userId),
        eq(drafts.revision, input.expectedRevision),
      ));

      return {
        result: {
          noteId,
          deckId: creation.deckId!,
          sourceText: inserted.sourceText,
        },
        eligibleCardIds: cardValues
          .filter((card) => card.audioStatus === "pending")
          .map((card) => card.id),
      };
    });
      }),
    );

  if (saved.eligibleCardIds.length > 0) {
    if (context.workflows) {
      void runDetachedWorkflow(
        context,
        context.workflows.audio.generateNote(context.userId, saved.eligibleCardIds),
      ).catch((error) => console.error(
        "note audio generation failed",
        saved.result.noteId,
        error,
      ));
    } else {
      void generateNoteAudio(database.db, context.userId, saved.eligibleCardIds)
        .catch((error) => console.error(
          "note audio generation failed",
          saved.result.noteId,
          error,
        ));
    }
  }
    return saved.result;
  });
}
