import {
  draftReducer,
  initialDraftState,
  isSavable,
} from "@/lib/draft-state";
import type { Draft } from "@/api/drafts";
import { draftStatusText } from "@/lib/draft-status";

const failedDraft: Draft = {
  id: "draft-1",
  deckId: "deck-1",
  sourceText: "die Banane",
  status: "failed",
  classification: { domain: "language", language: "de", partOfSpeech: "noun" },
  cards: [{
    aspect: "meaning",
    front: "die Banane",
    back: "banana",
    imageCue: false,
  }],
  imagePrompt: null,
  imageStatus: "none",
  draftImageId: null,
  error: "Generation failed",
  createdAt: new Date(0),
};

describe("native draft state", () => {
  it("makes a failed generation hand-editable and savable", () => {
    const state = draftReducer(initialDraftState, {
      type: "loaded",
      draft: failedDraft,
    });

    expect(state.status).toBe("failed");
    expect(isSavable(state)).toBe(true);
  });

  it("reconciles terminal status and image state without overwriting local ready-card edits", () => {
    const ready = { ...failedDraft, status: "ready" as const, error: null };
    let state = draftReducer(initialDraftState, {
      type: "loaded",
      draft: ready,
    });
    state = draftReducer(state, {
      type: "edit-card",
      index: 0,
      patch: { back: "locally edited banana" },
    });
    state = draftReducer(state, { type: "deck-changed", deckId: "local-deck" });

    state = draftReducer(state, {
      type: "terminal-snapshot",
      draft: {
        ...ready,
        cards: [{ ...ready.cards[0], back: "stale server value" }],
        imagePrompt: "a yellow banana",
        imageStatus: "ready",
        draftImageId: "image-1",
      },
    });

    expect(state).toMatchObject({
      status: "ready",
      deckId: "local-deck",
      imagePrompt: "a yellow banana",
      imageStatus: "ready",
      draftImageId: "image-1",
      cards: [{ back: "locally edited banana" }],
    });
    expect(draftStatusText(state)).toBe("1 card ready");
  });

  it("adopts a terminal failed snapshot while the local draft is still generating", () => {
    const generating = {
      ...failedDraft,
      status: "generating" as const,
      error: null,
      cards: [],
    };
    const state = draftReducer(
      draftReducer(initialDraftState, { type: "loaded", draft: generating }),
      {
        type: "terminal-snapshot",
        draft: {
          ...failedDraft,
          imageStatus: "failed",
          error: "Image and card generation failed",
        },
      },
    );

    expect(state).toMatchObject({
      status: "failed",
      imageStatus: "failed",
      error: expect.stringContaining("Image and card generation failed"),
      cards: failedDraft.cards,
    });
    expect(draftStatusText(state)).toBe("Generation failed");
  });

  it("rejects incomplete basic and image-cued cards", () => {
    const ready = { ...failedDraft, status: "ready" as const, error: null };
    const basicWithoutBack = draftReducer(initialDraftState, {
      type: "loaded",
      draft: { ...ready, cards: [{ ...ready.cards[0], back: "" }] },
    });
    const imageCueWithoutHint = draftReducer(initialDraftState, {
      type: "loaded",
      draft: {
        ...ready,
        imagePrompt: "a yellow banana",
        cards: [{
          ...ready.cards[0],
          front: "{{c1::Banane}}",
          back: null,
          imageCue: true,
        }],
      },
    });
    const imageCueWithoutPrompt = draftReducer(initialDraftState, {
      type: "loaded",
      draft: {
        ...ready,
        imagePrompt: null,
        cards: [{
          ...ready.cards[0],
          front: "{{c1::Banane::banana}}",
          back: null,
          imageCue: true,
        }],
      },
    });

    expect(isSavable(basicWithoutBack)).toBe(false);
    expect(isSavable(imageCueWithoutHint)).toBe(false);
    expect(isSavable(imageCueWithoutPrompt)).toBe(false);
  });
});
