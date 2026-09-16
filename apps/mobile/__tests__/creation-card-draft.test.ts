import {
  createBlankCreationCardDraft,
  hydrateCreationCardDraft,
  learnerSafeCreationPreview,
  serializeCreationCardDraft,
} from "@/lib/creation-card-draft";
import { validateCardDraft } from "@/lib/card-draft";

describe("creation card draft", () => {
  it("hydrates a basic card into learner-facing fields", () => {
    expect(hydrateCreationCardDraft({
      key: "card-1",
      aspect: "definition",
      front: "What is inertia?",
      back: "Resistance to a change in motion.",
      imageCue: false,
    })).toEqual(expect.objectContaining({
      key: "card-1",
      kind: "basic",
      question: "What is inertia?",
      answer: "Resistance to a change in motion.",
    }));
  });

  it("hydrates and serializes a cloze without exposing markup in local state", () => {
    const draft = hydrateCreationCardDraft({
      key: "card-2",
      aspect: "meaning",
      front: "Das ist ein {{c1::Haus::house}}.",
      back: "This is a house.",
      imageCue: true,
    });

    expect(draft).toEqual(expect.objectContaining({
      kind: "cloze",
      sentence: "Das ist ein Haus.",
      answerRange: { start: 12, end: 16 },
      hint: "house",
    }));
    expect(JSON.stringify(draft)).not.toContain("{{c1::");
    expect(serializeCreationCardDraft(draft)).toEqual({
      key: "card-2",
      aspect: "meaning",
      front: "Das ist ein {{c1::Haus::house}}.",
      back: "This is a house.",
      imageCue: true,
    });
  });

  it("creates stable neutral blank drafts for both card types", () => {
    expect(createBlankCreationCardDraft("basic", "new-basic")).toEqual(
      expect.objectContaining({
        key: "new-basic",
        kind: "basic",
        aspect: "Question and answer",
      }),
    );
    expect(createBlankCreationCardDraft("cloze", "new-cloze")).toEqual(
      expect.objectContaining({
        key: "new-cloze",
        kind: "cloze",
        aspect: "Fill in the blank",
      }),
    );
  });

  it("uses the shared field-specific validation and image-cue rules", () => {
    const draft = createBlankCreationCardDraft("cloze", "new-cloze");
    expect(validateCardDraft(draft, { imageCueAllowed: true })).toMatchObject({
      sentence: expect.any(String),
      answerRange: expect.any(String),
    });
    expect(serializeCreationCardDraft(draft)).toBeNull();
  });

  it("renders an invalid stored cloze as safe copy", () => {
    const draft = hydrateCreationCardDraft({
      key: "broken",
      aspect: "meaning",
      front: "Broken {{c1::markup",
      back: null,
      imageCue: false,
    });
    expect(learnerSafeCreationPreview(draft)).toBe(
      "Fix the card fields to preview it.",
    );
    expect(learnerSafeCreationPreview(draft)).not.toContain("{{");
  });
});
