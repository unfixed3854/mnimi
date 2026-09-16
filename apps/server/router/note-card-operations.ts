import * as z from "zod";
import {
  BASIC_CARD_NEEDS_BACK,
  cardHasAnAnswer,
  clozeMarkupIsWellFormed,
  IMAGE_CUE_NEEDS_HINT,
  imageCueHasFallback,
  MALFORMED_CLOZE,
} from "../ai/card-rules.ts";
import { Validation } from "../effect/errors.ts";

export const editableCardInput = z.object({
  aspect: z.string().transform((value) => value.trim()),
  front: z.string().transform((value) => value.trim()),
  back: z.string().transform((value) => value.trim()).nullable(),
  imageCue: z.boolean(),
});

const createOperation = z.object({
  clientKey: z.string().min(1).max(100),
  card: editableCardInput,
});

const updateOperation = z.object({
  cardId: z.uuidv7(),
  card: editableCardInput,
});

export const noteUpdateInput = z.object({
  noteId: z.uuidv7(),
  expectedRevision: z.number().int().nonnegative(),
  creates: z.array(createOperation),
  updates: z.array(updateOperation),
  deleteCardIds: z.array(z.uuidv7()),
  resetCardIds: z.array(z.uuidv7()),
});

export type NoteUpdateInput = z.infer<typeof noteUpdateInput>;

export function initialScheduling(now: Date) {
  return {
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
  };
}

function rejectOperationSet(message: string): never {
  throw new Validation({ message, issues: [] });
}

export function validateOperationSets(input: NoteUpdateInput): void {
  const clientKeys = input.creates.map(({ clientKey }) => clientKey);
  const updateCardIds = input.updates.map(({ cardId }) => cardId);

  if (
    input.creates.length === 0 && input.updates.length === 0 &&
    input.deleteCardIds.length === 0 && input.resetCardIds.length === 0
  ) {
    rejectOperationSet("At least one card operation is required");
  }
  if (new Set(clientKeys).size !== clientKeys.length) {
    rejectOperationSet("Create client keys must be unique");
  }
  if (new Set(updateCardIds).size !== updateCardIds.length) {
    rejectOperationSet("Update card IDs must be unique");
  }
  if (new Set(input.deleteCardIds).size !== input.deleteCardIds.length) {
    rejectOperationSet("Delete card IDs must be unique");
  }
  if (new Set(input.resetCardIds).size !== input.resetCardIds.length) {
    rejectOperationSet("Reset card IDs must be unique");
  }

  const deleteIds = new Set(input.deleteCardIds);
  if (updateCardIds.some((cardId) => deleteIds.has(cardId))) {
    rejectOperationSet("A card cannot be updated and deleted in the same save");
  }
  if (input.resetCardIds.some((cardId) => deleteIds.has(cardId))) {
    rejectOperationSet("A card cannot be reset and deleted in the same save");
  }
}

export function validateEditableCard(
  card: z.infer<typeof editableCardInput>,
  identity: { clientKey?: string; cardId?: string },
): void {
  const fail = (
    field: "aspect" | "front" | "back",
    message: string,
  ): never => {
    throw new Validation({
      message,
      issues: [],
      data: { ...identity, field },
    });
  };
  if (!card.aspect) fail("aspect", "Describe what this card practises.");
  if (!card.front) fail("front", "Enter the card prompt.");
  if (!clozeMarkupIsWellFormed(card)) fail("front", MALFORMED_CLOZE);
  if (!imageCueHasFallback(card)) fail("front", IMAGE_CUE_NEEDS_HINT);
  if (!cardHasAnAnswer(card)) fail("back", BASIC_CARD_NEEDS_BACK);
}
