import { describe, expect, it } from "vitest";
import {
  classificationSchema,
  generatedCardSchema,
  generatedNoteSchema,
  generatedNoteSchemaFor,
} from "./schemas.ts";

const LANGUAGE = { domain: "language", language: "de", partOfSpeech: "noun" };
const CONCEPT = { domain: "concept", language: null, partOfSpeech: null };

describe("classificationSchema", () => {
  it("accepts a language classification", () => {
    const parsed = classificationSchema.parse({
      domain: "language",
      language: "de",
      partOfSpeech: "noun",
    });
    expect(parsed.domain).toBe("language");
  });

  it("defaults language and partOfSpeech to null when the model omits them", () => {
    const parsed = classificationSchema.parse({ domain: "concept" });
    expect(parsed.language).toBeNull();
    expect(parsed.partOfSpeech).toBeNull();
  });

  it("rejects a missing domain", () => {
    expect(() => classificationSchema.parse({ language: "de" })).toThrow();
  });
});

describe("generatedNoteSchema", () => {
  it("rejects more than six generated cards", () => {
    const card = {
      aspect: "meaning",
      front: "Question",
      back: "Answer",
      imageCue: false,
    };
    expect(generatedNoteSchema.safeParse({
      imagePrompt: null,
      generationSummary: "Practise the meaning of the card set.",
      cards: Array.from({ length: 7 }, () => card),
    }).success).toBe(false);
  });
  const valid = {
    imagePrompt: "a ripe yellow banana on a white background",
    generationSummary: "Practise the meaning and gender of Banane.",
    cards: [
      {
        aspect: "meaning",
        front: "image",
        back: "die Banane",
        imageCue: false,
      },
      {
        aspect: "gender",
        front: "___ Banane",
        back: "die",
        imageCue: false,
      },
    ],
  };

  it("accepts a well-formed generation", () => {
    expect(generatedNoteSchema.parse(valid).cards).toHaveLength(2);
  });

  it("keeps the AI's generation summary with the completed cards", () => {
    expect(generatedNoteSchema.parse({
      ...valid,
      generationSummary: "Practise the meaning and gender of Banane.",
    }).generationSummary).toBe("Practise the meaning and gender of Banane.");
  });

  it("requires at least one card", () => {
    expect(() => generatedNoteSchema.parse({ ...valid, cards: [] })).toThrow();
  });

  it("rejects a card with an empty front", () => {
    expect(() =>
      generatedNoteSchema.parse({
        ...valid,
        cards: [
          {
            aspect: "meaning",
            front: "",
            back: "x",
            imageCue: false,
          },
        ],
      })
    ).toThrow();
  });

  it("allows an absent imagePrompt for non-visual concepts", () => {
    const parsed = generatedNoteSchema.parse({
      generationSummary: valid.generationSummary,
      cards: valid.cards,
    });
    expect(parsed.imagePrompt).toBeNull();
  });

  it("normalises an empty-string imagePrompt to null", () => {
    // "" left as a distinct legal value from null made a note permanently
    // `imageFailed` with no attempt ever made — see notes.ts's `== null`
    // check, which relies on this boundary normalisation.
    const parsed = generatedNoteSchema.parse({ ...valid, imagePrompt: "" });
    expect(parsed.imagePrompt).toBeNull();
  });
});

const CLOZE = {
  aspect: "meaning",
  front: "Ich mag {{c1::Bananen::banany}} zum Frühstück.",
  back: "Lubię banany na śniadanie.",
  imageCue: false,
};

describe("generatedCardSchema", () => {
  it("accepts a well-formed cloze card", () => {
    expect(generatedCardSchema.safeParse(CLOZE).success).toBe(true);
  });

  it("accepts a cloze card with no back", () => {
    expect(generatedCardSchema.safeParse({ ...CLOZE, back: null }).success)
      .toBe(
        true,
      );
  });

  it("normalises an empty back to null", () => {
    const parsed = generatedCardSchema.parse({ ...CLOZE, back: "" });
    expect(parsed.back).toBeNull();
  });

  it("accepts a basic card with a back", () => {
    const basic = {
      aspect: "meaning",
      front: "Poseidon",
      back: "sea god",
      imageCue: false,
    };
    expect(generatedCardSchema.safeParse(basic).success).toBe(true);
  });

  it("rejects a basic card with no back", () => {
    const basic = {
      aspect: "meaning",
      front: "Poseidon",
      back: null,
      imageCue: false,
    };
    expect(generatedCardSchema.safeParse(basic).success).toBe(false);
  });

  it("rejects malformed markup rather than treating it as plain text", () => {
    const broken = { ...CLOZE, front: "Ich mag {{c1::}} zum Frühstück." };
    expect(generatedCardSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects two deletions in one card", () => {
    const two = { ...CLOZE, front: "{{c1::Ich}} mag {{c2::Bananen}}." };
    expect(generatedCardSchema.safeParse(two).success).toBe(false);
  });

  it("explains the failure in a way the retry loop can act on", () => {
    const broken = { ...CLOZE, front: "Ich mag {{c1::Bananen" };
    const result = generatedCardSchema.safeParse(broken);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("cloze");
  });

  it("accepts an image cue with a cloze fallback hint", () => {
    const card = {
      aspect: "plural",
      front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
      back: "I see two bananas.",
      imageCue: true,
    };
    expect(generatedCardSchema.safeParse(card).success).toBe(true);
    expect(
      generatedNoteSchemaFor(LANGUAGE).safeParse({
        imagePrompt: "two bananas",
        generationSummary: "Practise the plural of Banane.",
        cards: [card],
      }).success,
    ).toBe(true);
  });

  it("rejects an image cue without an inline fallback hint", () => {
    const result = generatedCardSchema.safeParse({
      ...CLOZE,
      imageCue: true,
      front: "Ich sehe zwei {{c1::Bananen}}.",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("fallback hint");
  });

  it("rejects image cues outside an image-backed language note", () => {
    const card = {
      ...CLOZE,
      imageCue: true,
      front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
    };
    expect(
      generatedNoteSchemaFor(LANGUAGE).safeParse({
        imagePrompt: null,
        generationSummary: "Practise the plural of Banane.",
        cards: [card],
      })
        .success,
    ).toBe(false);
    expect(
      generatedNoteSchemaFor(CONCEPT).safeParse({
        imagePrompt: "Poseidon",
        generationSummary: "Practise the concept of Poseidon.",
        cards: [card],
      })
        .success,
    ).toBe(false);
  });
});
