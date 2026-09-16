import { parseCloze } from "@/lib/native-cloze";
import type { Draft, DraftCard, DraftEvent } from "@/api/drafts";

export type DraftState =
  | { status: "loading" }
  | { status: "none" }
  | {
    status: "generating" | "ready" | "failed";
    draftId: string;
    deckId: string;
    text: string;
    startedAt: number;
    classification: Draft["classification"];
    cards: DraftCard[];
    retried: boolean;
    imagePrompt: string | null;
    imageStatus: Draft["imageStatus"];
    draftImageId: string | null;
    error: string | null;
  };

export type LiveDraftState = Exclude<
  DraftState,
  { status: "loading" } | { status: "none" }
>;
export type DraftAction =
  | DraftEvent
  | { type: "loaded"; draft: Draft | null }
  | { type: "terminal-snapshot"; draft: Draft }
  | { type: "edit-card"; index: number; patch: Partial<DraftCard> }
  | { type: "remove-card"; index: number }
  | { type: "deck-changed"; deckId: string };

export const initialDraftState: DraftState = { status: "loading" };
const SELF_WRITE = "you can still write the card yourself.";
const isLive = (state: DraftState): state is LiveDraftState =>
  state.status !== "loading" && state.status !== "none";

function onFailure(text: string, cards: DraftCard[], message: string | null) {
  return {
    cards: cards.length ? cards : [{
      aspect: "meaning",
      front: text,
      back: null,
      imageCue: false,
    }],
    error: message
      ? `${message} — ${SELF_WRITE}`
      : "You can still write the card yourself.",
  };
}

function fromRow(draft: Draft): LiveDraftState {
  const cards = draft.cards.map((card) => ({
    ...card,
    imageCue: card.imageCue === undefined ? false : card.imageCue,
  }));
  const state: LiveDraftState = {
    status: draft.status,
    draftId: draft.id,
    deckId: draft.deckId,
    text: draft.sourceText,
    startedAt: new Date(draft.createdAt).getTime(),
    classification: draft.classification,
    cards,
    retried: false,
    imagePrompt: draft.imagePrompt,
    imageStatus: draft.imageStatus,
    draftImageId: draft.draftImageId,
    error: draft.error,
  };
  return draft.status === "failed"
    ? { ...state, ...onFailure(draft.sourceText, cards, draft.error) }
    : state;
}

export function draftReducer(
  state: DraftState,
  action: DraftAction,
): DraftState {
  switch (action.type) {
    case "loaded":
      return action.draft ? fromRow(action.draft) : { status: "none" };
    case "snapshot":
      return fromRow(action.draft);
    case "terminal-snapshot": {
      const snapshot = fromRow(action.draft);
      if (
        !isLive(state) || state.draftId !== snapshot.draftId ||
        state.status === "generating"
      ) return snapshot;
      return {
        ...snapshot,
        cards: state.cards,
        deckId: state.deckId,
        retried: state.retried,
      };
    }
    case "classified":
      return isLive(state)
        ? { ...state, classification: action.classification }
        : state;
    case "image-prompt":
      return isLive(state)
        ? {
          ...state,
          imagePrompt: action.prompt,
          imageStatus: action.prompt ? "generating" : "none",
        }
        : state;
    case "cards":
      return state.status === "generating"
        ? { ...state, cards: action.cards }
        : state;
    case "retry":
      return state.status === "generating"
        ? { ...state, cards: [], retried: true }
        : state;
    case "done":
      return isLive(state)
        ? {
          ...state,
          status: "ready",
          classification: action.classification,
          cards: action.generation.cards,
          imagePrompt: action.generation.imagePrompt,
          imageStatus:
            state.imageStatus === "none" && action.generation.imagePrompt
              ? "generating"
              : state.imageStatus,
          error: null,
        }
        : state;
    case "image":
      return isLive(state)
        ? {
          ...state,
          imageStatus: action.status,
          draftImageId: action.draftImageId ?? state.draftImageId,
        }
        : state;
    case "failed":
      return isLive(state)
        ? {
          ...state,
          status: "failed",
          ...onFailure(state.text, state.cards, action.message),
        }
        : state;
    case "edit-card":
      return isLive(state) && state.status !== "generating"
        ? {
          ...state,
          cards: state.cards.map((card, index) =>
            index === action.index ? { ...card, ...action.patch } : card
          ),
        }
        : state;
    case "remove-card":
      return isLive(state) && state.status !== "generating"
        ? {
          ...state,
          cards: state.cards.filter((_, index) => index !== action.index),
        }
        : state;
    case "deck-changed":
      return isLive(state) ? { ...state, deckId: action.deckId } : state;
  }
}

/** A running durable image is intentionally not a reason to disable Save. */
export function isSavable(state: DraftState): boolean {
  if (
    !isLive(state) || state.status === "generating" || state.cards.length === 0
  ) return false;
  return state.cards.every((card) => {
    const front = (card.front ?? "").trim();
    if (!front) return false;
    const cloze = parseCloze(front);
    if (card.imageCue) {
      if (
        state.classification?.domain !== "language" ||
        state.imagePrompt === null || !cloze?.hint
      ) return false;
    }
    return Boolean(cloze || (card.back ?? "").trim());
  });
}
