import { describe, expect, it } from "vitest";
import {
  generateNote,
  type GenerationEvent,
  type ModelCalls,
} from "./generate-note.ts";

const INPUT = {
  text: "die Banane",
  nativeLanguage: "en",
  deck: {
    id: "deck-german",
    name: "German",
    description: "German vocabulary and production",
  },
  learningGoal: "Produce the German word in a useful sentence.",
};

const CLASSIFICATION = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};

const NOTE = {
  imagePrompt: "a banana",
  generationSummary: "Practise the meaning of Banane.",
  cards: [
    {
      aspect: "meaning",
      front: "banana",
      back: "die Banane",
      imageCue: false,
    },
  ],
};

/** One generate pass: the deltas it streams, then the object it returns. */
type Pass = { deltas: string[]; object: unknown };

/**
 * A ModelCalls that replays canned passes. The last pass repeats if the
 * generator asks for more, so a test only lists the passes it cares about.
 */
function models(
  passes: Pass[],
  classification: unknown = CLASSIFICATION,
): ModelCalls {
  let index = 0;
  return {
    classify: () => Promise.resolve(classification),
    generate: async function* () {
      const pass = passes[Math.min(index++, passes.length - 1)];
      for (const delta of pass.deltas) yield delta;
      return typeof pass.object === "object" && pass.object !== null
        ? {
          generationSummary: "Practise the meaning of Banane.",
          ...pass.object,
        }
        : pass.object;
    },
  };
}

async function collect(
  calls: ModelCalls,
  input = INPUT,
): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const event of generateNote(input, calls)) out.push(event);
  return out;
}

describe("generateNote", () => {
  it("classifies, streams cards, then reports the validated note", async () => {
    const events = await collect(
      models([{ deltas: [JSON.stringify(NOTE)], object: NOTE }]),
    );

    // `image-prompt` lands as soon as the single delta parses, which is also
    // the moment `cards` first appears — so it precedes "cards" here too.
    expect(events.map((event) => event.type)).toEqual([
      "classified",
      "image-prompt",
      "cards",
      "done",
    ]);
    expect(events[0]).toEqual({
      type: "classified",
      classification: CLASSIFICATION,
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      classification: CLASSIFICATION,
      generation: NOTE,
    });
  });

  it("emits only closed and individually valid cards before the set finishes", async () => {
    const first = NOTE.cards[0];
    const second = {
      aspect: "gender",
      front: "The article is {{c1::die::the feminine article}} Banane.",
      back: null,
      imageCue: false,
    };
    const complete = { imagePrompt: "a banana", cards: [first, second] };
    const events = await collect(
      models([
        {
          deltas: [
            `{"imagePrompt":"a banana","cards":[${JSON.stringify(first)},`,
            '{"aspect":"gender","front":"The article is ',
            '{{c1::die::the feminine article}} Banane.","back":null,"imageCue":false}]}',
          ],
          object: complete,
        },
      ]),
    );

    const cards = events.filter((event) => event.type === "cards");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({
      type: "cards",
      cards: [first],
    });
    expect(cards.at(-1)).toEqual({
      type: "cards",
      cards: [first, second],
    });
  });

  it("does not re-emit cards when a delta changes nothing it renders", async () => {
    const events = await collect(
      models([
        {
          deltas: [
            '{"cards":[{"aspect":"meaning","front":"banana","back":"die Banane"}]',
            ',"imagePrompt":"a bana',
            'na"}',
          ],
          object: NOTE,
        },
      ]),
    );

    // The last two deltas only extend imagePrompt, which complete-card
    // projection drops.
    expect(events.filter((event) => event.type === "cards")).toHaveLength(1);
  });

  it("announces a retry and discards the failed attempt's cards", async () => {
    const events = await collect(
      models([
        { deltas: ['{"cards":[{"aspect":"junk"}]}'], object: { cards: [] } },
        { deltas: [JSON.stringify(NOTE)], object: NOTE },
      ]),
    );

    // The invalid attempt has no complete cards. The retry starts image and
    // complete-card announcements over.
    expect(events.map((event) => event.type)).toEqual([
      "classified",
      "image-prompt",
      "retry",
      "image-prompt",
      "cards",
      "done",
    ]);
    expect(events.at(-2)).toEqual({
      type: "cards",
      cards: [
        {
          aspect: "meaning",
          front: "banana",
          back: "die Banane",
          imageCue: false,
        },
      ],
    });
  });

  it("re-emits the validated set after a retry", async () => {
    const invalidHint = {
      cards: [
        {
          aspect: "meaning",
          front: "banana",
          back: "die Banane",
          imageCue: 123,
        },
      ],
      imagePrompt: "a banana",
    };

    const events = await collect(
      models([
        { deltas: [JSON.stringify(invalidHint)], object: invalidHint },
        { deltas: [JSON.stringify(NOTE)], object: NOTE },
      ]),
    );

    const types = events.map((event) => event.type);
    const retryIndex = types.indexOf("retry");
    expect(retryIndex).toBeGreaterThan(-1);
    expect(types.slice(retryIndex + 1)).toContain("cards");
  });

  it("uses deck context and asks for the smallest useful card set", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const calls: ModelCalls = {
      classify: (prompts) => {
        seen.push(prompts);
        return Promise.resolve(CLASSIFICATION);
      },
      generate: async function* (prompts) {
        seen.push(prompts);
        yield JSON.stringify(NOTE);
        return NOTE;
      },
    };

    await collect(calls);

    const prompt = seen.at(-1)?.user ?? "";
    expect(prompt).toContain("Deck: German");
    expect(prompt).toContain("German vocabulary and production");
    expect(prompt).toContain(INPUT.learningGoal);
    expect(prompt).toContain("one to six cards");
    expect(prompt).toContain("smallest useful set");
  });

  it("announces the image prompt as soon as the cards key proves it complete", async () => {
    const events = await collect(
      models([
        {
          deltas: [
            `{"imagePrompt":"a ripe`,
            ` banana"`,
            `,"cards":[`,
            `{"aspect":"meaning","front":"die Banane","back":"banana","imageCue":false}]}`,
          ],
          object: {
            imagePrompt: "a ripe banana",
            cards: [
              {
                aspect: "meaning",
                front: "die Banane",
                back: "banana",
                imageCue: false,
              },
            ],
          },
        },
      ]),
    );

    const prompts = events.filter((event) => event.type === "image-prompt");
    expect(prompts).toEqual([{
      type: "image-prompt",
      prompt: "a ripe banana",
    }]);

    // It must arrive before any card, which is the entire point of the reorder.
    expect(events.findIndex((event) => event.type === "image-prompt"))
      .toBeLessThan(
        events.findIndex((event) => event.type === "cards"),
      );
  });

  it("announces a null prompt too — no picture wanted is a decision", async () => {
    const events = await collect(
      models([
        {
          deltas: [
            `{"imagePrompt":null,"cards":[`,
            `{"aspect":"meaning","front":"entropy","back":"disorder","imageCue":false}]}`,
          ],
          object: {
            imagePrompt: null,
            cards: [
              {
                aspect: "meaning",
                front: "entropy",
                back: "disorder",
                imageCue: false,
              },
            ],
          },
        },
      ]),
    );

    expect(events.filter((event) => event.type === "image-prompt")).toEqual([
      { type: "image-prompt", prompt: null },
    ]);
  });

  it("re-announces the prompt after a retry discards the first attempt", async () => {
    const events = await collect(
      models([
        // Fails validation: cards is empty.
        {
          deltas: [`{"imagePrompt":"first","cards":[]}`],
          object: { imagePrompt: "first", cards: [] },
        },
        {
          deltas: [
            `{"imagePrompt":"second","cards":[`,
            `{"aspect":"meaning","front":"f","back":"b","imageCue":false}]}`,
          ],
          object: {
            imagePrompt: "second",
            cards: [
              {
                aspect: "meaning",
                front: "f",
                back: "b",
                imageCue: false,
              },
            ],
          },
        },
      ]),
    );

    expect(
      events.filter((event) => event.type === "image-prompt").map((event) =>
        event.prompt
      ),
    ).toEqual(["first", "second"]);
    expect(events.findIndex((event) => event.type === "retry")).toBeGreaterThan(
      0,
    );
  });

  it("throws when the classify pass never validates", async () => {
    const calls = models([{ deltas: [], object: NOTE }], { domain: 42 });
    await expect(collect(calls)).rejects.toThrow();
  });

  it("propagates a provider failure rather than swallowing it", async () => {
    const calls: ModelCalls = {
      classify: () => Promise.resolve(CLASSIFICATION),
      generate: async function* () {
        throw new Error("provider exploded");
      },
    };

    await expect(collect(calls)).rejects.toThrow("provider exploded");
  });
});
