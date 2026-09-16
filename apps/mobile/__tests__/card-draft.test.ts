import {
  buildNoteUpdateInput,
  createCardDraft,
  hydrateNoteEditDraft,
  isNoteEditDirty,
  validateCardDraft,
} from "@/lib/card-draft";
import type { NoteDetails } from "@/api/notes";

const details: NoteDetails = {
  pronunciationSpeed: "normal",
  note: {
    id: "note-1",
    deckId: "deck-1",
    sourceText: "Haus",
    revision: 4,
    domain: "language",
    language: "de",
    imagePath: "u/note-1.png",
    metadata: { imagePrompt: "a house" },
  },
  cards: [
    {
      id: "card-1",
      cardType: "cloze",
      aspect: "past_tense",
      front: "Ich sehe ein {{c1::Haus::dom}}.",
      back: "Widzę dom.",
      imageCue: true,
      audioEligible: true,
      hasAudio: true,
      audioStatus: "ready",
    },
    {
      id: "card-2",
      cardType: "basic",
      aspect: "definition",
      front: "What is a house?",
      back: "A building used as a home.",
      imageCue: false,
      audioEligible: false,
      hasAudio: false,
      audioStatus: null,
    },
  ],
  imageGenerating: false,
};

describe("card draft", () => {
  it("hydrates raw cloze into a clean draft and starts clean", () => {
    const draft = hydrateNoteEditDraft(details);
    expect(draft.cards[0]).toMatchObject({
      kind: "cloze",
      sentence: "Ich sehe ein Haus.",
      answerRange: { start: 13, end: 17 },
      hint: "dom",
      back: "Widzę dom.",
    });
    expect(isNoteEditDirty(draft)).toBe(false);
  });

  it("treats surrounding whitespace as a zero-operation edit", () => {
    const draft = hydrateNoteEditDraft(details);
    const [cloze, basic] = draft.cards;
    if (cloze.kind !== "cloze" || basic.kind !== "basic") {
      throw new Error("Expected cloze and basic drafts");
    }
    const whitespaceOnly = {
      ...draft,
      cards: [
        {
          ...cloze,
          aspect: `  ${cloze.aspect}  `,
          sentence: `  ${cloze.sentence}  `,
          answerRange: cloze.answerRange
            ? {
              start: cloze.answerRange.start + 2,
              end: cloze.answerRange.end + 2,
            }
            : null,
          hint: `  ${cloze.hint}  `,
          back: `  ${cloze.back}  `,
        },
        {
          ...basic,
          aspect: `  ${basic.aspect}  `,
          question: `  ${basic.question}  `,
          answer: `  ${basic.answer}  `,
        },
      ],
    };

    expect(isNoteEditDirty(whitespaceOnly)).toBe(false);
    expect(buildNoteUpdateInput(whitespaceOnly)).toMatchObject({
      creates: [],
      updates: [],
      deleteCardIds: [],
      resetCardIds: [],
    });
  });

  it("keeps aspects open and validates card-type rules", () => {
    const card = createCardDraft("cloze", "new-1");
    expect(card.aspect).toBe("Fill in the blank");
    expect(validateCardDraft(card, { imageCueAllowed: true })).toMatchObject({
      sentence: expect.any(String),
      answerRange: expect.any(String),
    });
  });

  it("builds explicit create, update, delete, and reset operations", () => {
    const draft = hydrateNoteEditDraft(details);
    const existing = {
      ...draft.cards[0],
      aspect: "arbitrary focus",
      resetProgress: true,
    };
    const created = {
      ...createCardDraft("basic", "new-1"),
      aspect: "physics definition",
      question: "What is inertia?",
      answer: "Resistance to a change in motion.",
    };
    const input = buildNoteUpdateInput({ ...draft, cards: [existing, created] });
    expect(input).toEqual({
      noteId: "note-1",
      expectedRevision: 4,
      creates: [{
        clientKey: "new-1",
        card: {
          aspect: "physics definition",
          front: "What is inertia?",
          back: "Resistance to a change in motion.",
          imageCue: false,
        },
      }],
      updates: [{
        cardId: "card-1",
        card: {
          aspect: "arbitrary focus",
          front: "Ich sehe ein {{c1::Haus::dom}}.",
          back: "Widzę dom.",
          imageCue: true,
        },
      }],
      deleteCardIds: ["card-2"],
      resetCardIds: ["card-1"],
    });
  });
});
