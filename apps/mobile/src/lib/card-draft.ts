import type { EditableCard, NoteCard, NoteDetails, NoteUpdateInput } from "@/api/notes";
import {
  parseEditableCloze,
  serializeEditableCloze,
  type EditableCloze,
} from "@/lib/native-cloze";

export type CardDraftBase = {
  key: string;
  persistedId: string | null;
  aspect: string;
  imageCue: boolean;
  resetProgress: boolean;
};

export type BasicCardDraft = CardDraftBase & {
  kind: "basic";
  question: string;
  answer: string;
};

export type ClozeCardDraft = CardDraftBase & EditableCloze & {
  kind: "cloze";
  back: string;
};

export type CardDraft = BasicCardDraft | ClozeCardDraft;

export type NoteEditDraft = {
  noteId: string;
  revision: number;
  originalCards: NoteCard[];
  cards: CardDraft[];
};

export type CardDraftErrors = Partial<Record<
  "aspect" | "question" | "answer" | "sentence" | "answerRange" | "hint",
  string
>>;

export function createCardDraft(
  kind: CardDraft["kind"],
  key: string,
): CardDraft {
  const base = {
    key,
    persistedId: null,
    imageCue: false,
    resetProgress: false,
  };
  return kind === "basic"
    ? {
      ...base,
      kind,
      aspect: "Question and answer",
      question: "",
      answer: "",
    }
    : {
      ...base,
      kind,
      aspect: "Fill in the blank",
      sentence: "",
      answerRange: null,
      hint: "",
      back: "",
    };
}

export function validateCardDraft(
  card: CardDraft,
  context: { imageCueAllowed: boolean },
): CardDraftErrors {
  const errors: CardDraftErrors = {};
  if (!card.aspect.trim()) {
    errors.aspect = "Describe what this card practises.";
  }
  if (card.kind === "basic") {
    if (!card.question.trim()) errors.question = "Enter a question.";
    if (!card.answer.trim()) errors.answer = "Enter an answer.";
    return errors;
  }
  if (!card.sentence.trim()) errors.sentence = "Enter a sentence.";
  if (!serializeEditableCloze(card)) {
    errors.answerRange = "Select the text to hide.";
  }
  if (card.imageCue && !context.imageCueAllowed) {
    errors.hint = "Image prompts require a language note with an intended image.";
  } else if (card.imageCue && !card.hint.trim()) {
    errors.hint = "Add the text cue shown with this image.";
  }
  return errors;
}

export function hydrateCardDraft(
  card: Pick<
    NoteCard,
    "id" | "cardType" | "aspect" | "front" | "back" | "imageCue"
  >,
): CardDraft {
  const base = {
    key: card.id,
    persistedId: card.id,
    aspect: card.aspect,
    imageCue: card.imageCue,
    resetProgress: false,
  };
  if (card.cardType === "basic") {
    return {
      ...base,
      kind: "basic",
      question: card.front,
      answer: card.back ?? "",
    };
  }
  const cloze = parseEditableCloze(card.front) ?? {
    sentence: card.front,
    answerRange: null,
    hint: "",
  };
  return { ...base, kind: "cloze", ...cloze, back: card.back ?? "" };
}

export function hydrateNoteEditDraft(details: NoteDetails): NoteEditDraft {
  return {
    noteId: details.note.id,
    revision: details.note.revision,
    originalCards: details.cards,
    cards: details.cards.map(hydrateCardDraft),
  };
}

export function serializeCardDraft(card: CardDraft): EditableCard | null {
  if (card.kind === "basic") {
    return {
      aspect: card.aspect.trim(),
      front: card.question.trim(),
      back: card.answer.trim(),
      imageCue: card.imageCue,
    };
  }
  const front = serializeEditableCloze(card);
  if (!front) return null;
  return {
    aspect: card.aspect.trim(),
    front: front.trim(),
    back: card.back.trim() || null,
    imageCue: card.imageCue,
  };
}

function sameEditableCard(left: EditableCard, right: EditableCard): boolean {
  return left.aspect === right.aspect &&
    left.front === right.front &&
    left.back === right.back &&
    left.imageCue === right.imageCue;
}

export function isNoteEditDirty(draft: NoteEditDraft): boolean {
  try {
    const input = buildNoteUpdateInput(draft);
    return input.creates.length > 0 || input.updates.length > 0 ||
      input.deleteCardIds.length > 0 || input.resetCardIds.length > 0;
  } catch {
    // Invalid in-progress cloze text cannot be serialized yet, but it still
    // represents unsaved local work and must keep navigation protection on.
    return true;
  }
}

function requiredSerializedCard(card: CardDraft): EditableCard {
  const serialized = serializeCardDraft(card);
  if (!serialized) {
    throw new Error("Cannot build an update for an invalid cloze selection.");
  }
  return serialized;
}

export function buildNoteUpdateInput(draft: NoteEditDraft): NoteUpdateInput {
  const currentPersistedIds = new Set(
    draft.cards.flatMap((card) => card.persistedId ? [card.persistedId] : []),
  );
  const originalById = new Map(
    draft.originalCards.map((card) => [card.id, card]),
  );
  const creates: NoteUpdateInput["creates"] = [];
  const updates: NoteUpdateInput["updates"] = [];
  const resetCardIds: string[] = [];

  for (const card of draft.cards) {
    const serialized = requiredSerializedCard(card);
    if (!card.persistedId) {
      creates.push({ clientKey: card.key, card: serialized });
      continue;
    }
    const original = originalById.get(card.persistedId);
    if (original && !sameEditableCard(serialized, original)) {
      updates.push({ cardId: card.persistedId, card: serialized });
    }
    if (card.resetProgress) resetCardIds.push(card.persistedId);
  }

  return {
    noteId: draft.noteId,
    expectedRevision: draft.revision,
    creates,
    updates,
    deleteCardIds: draft.originalCards
      .filter((card) => !currentPersistedIds.has(card.id))
      .map((card) => card.id),
    resetCardIds,
  };
}
