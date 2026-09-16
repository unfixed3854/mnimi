import { describe, expect, it } from "vitest";
import type { ModelCalls } from "./generate-note.ts";
import { streamCreationGeneration } from "./creation-generation.ts";

const INPUT = {
  text: "die Banane",
  nativeLanguage: "en",
  deck: { id: "german", name: "German", description: null },
  learningGoal: "Produce useful German vocabulary.",
};
const CLASSIFICATION = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};
const FIRST = {
  aspect: "meaning",
  front: "banana",
  back: "die Banane",
  imageCue: false,
};
const SECOND = {
  aspect: "article",
  front: "{{c1::die::article}} Banane",
  back: null,
  imageCue: false,
};
const SUMMARY = "Practise the meaning and article of Banane.";

function calls(passes: unknown[]): ModelCalls {
  let index = 0;
  return {
    classify: async () => CLASSIFICATION,
    generate: async function* () {
      const value = passes[Math.min(index++, passes.length - 1)];
      yield JSON.stringify(value);
      return value;
    },
  };
}

describe("streamCreationGeneration", () => {
  it("keeps server card keys stable while a complete prefix grows", async () => {
    let key = 0;
    const model: ModelCalls = {
      classify: async () => CLASSIFICATION,
      generate: async function* () {
        yield `{"imagePrompt":null,"generationSummary":${JSON.stringify(SUMMARY)},"cards":[${JSON.stringify(FIRST)},`;
        yield `${JSON.stringify(SECOND)}]}`;
        return { imagePrompt: null, generationSummary: SUMMARY, cards: [FIRST, SECOND] };
      },
    };

    const events = [];
    for await (const event of streamCreationGeneration(
      INPUT,
      model,
      () => `card-${++key}`,
    )) events.push(event);

    const cardEvents = events.filter((event) => event.type === "cards");
    expect(cardEvents).toEqual([
      { type: "cards", cards: [{ key: "card-1", ...FIRST }] },
      {
        type: "cards",
        cards: [
          { key: "card-1", ...FIRST },
          { key: "card-2", ...SECOND },
        ],
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      cards: [
        { key: "card-1", ...FIRST },
        { key: "card-2", ...SECOND },
      ],
    });
  });

  it("starts card identity over after model validation retries", async () => {
    let key = 0;
    const invalid = {
      imagePrompt: null,
      generationSummary: SUMMARY,
      cards: [{ ...FIRST, imageCue: 1 }],
    };
    const events = [];
    for await (const event of streamCreationGeneration(
      INPUT,
      calls([invalid, { imagePrompt: null, generationSummary: SUMMARY, cards: [FIRST] }]),
      () => `card-${++key}`,
    )) events.push(event);

    expect(events.map((event) => event.type)).toContain("retry");
    expect(events.at(-1)).toMatchObject({
      type: "done",
      cards: [{ key: "card-1", ...FIRST }],
    });
  });
});
