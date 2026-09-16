import { describe, expect, it, vi } from "vitest";
import { adjustCreationCards } from "./creation-adjustment.ts";
import { BASE_PACK, LANGUAGE_PACK } from "./rule-packs.ts";

const CURRENT = [
  {
    key: "meaning",
    aspect: "meaning",
    front: "die Banane",
    back: "banana",
    imageCue: false,
  },
  {
    key: "article",
    aspect: "article",
    front: "{{c1::die::article}} Banane",
    back: null,
    imageCue: true,
  },
];

const INPUT = {
  request: "Help me remember die Banane",
  nativeLanguage: "pl",
  deck: {
    id: "german",
    name: "German",
    description: "Useful vocabulary",
  },
  learningGoal: "Produce German vocabulary.",
  classification: {
    domain: "language",
    language: "de",
    partOfSpeech: "noun",
  },
  imagePrompt: "a banana on a table",
  cards: CURRENT,
  instruction: "Use fewer cards and keep the picture hint",
  aiInstructions: "Use an everyday example when you add a card.",
};
const SUMMARY = "Practise the meaning of Banane with fewer cards.";

describe("adjustCreationCards", () => {
  it.each([
    { domain: "language", language: "de", partOfSpeech: "noun" },
    { domain: "language", language: "es", partOfSpeech: "verb" },
    { domain: "concept", language: null, partOfSpeech: null },
  ])("passes the applicable shared rules to the model for $domain/$language/$partOfSpeech", async (classification) => {
    const call = vi.fn(async (_prompts: { system: string; user: string }) => ({
      generationSummary: SUMMARY,
      cards: [CURRENT[0]],
    }));

    await adjustCreationCards({ ...INPUT, classification }, call, () => "new-card");

    const { system } = call.mock.calls[0][0];
    expect(system).toContain(BASE_PACK);
    expect(system).toContain(`Domain: ${classification.domain}`);
    if (classification.domain === "language") {
      expect(system).toContain(LANGUAGE_PACK);
      expect(system).toContain(`Target language: ${classification.language}`);
      expect(system).toContain(`Part of speech: ${classification.partOfSpeech}`);
    } else {
      expect(system).not.toContain(LANGUAGE_PACK);
      expect(system).not.toContain("Target language:");
    }
  });

  it.each([INPUT.imagePrompt, null])("passes the retained image intent to the model: %s", async (imagePrompt) => {
    const call = vi.fn(async (_prompts: { system: string; user: string }) => ({
      generationSummary: SUMMARY,
      cards: [CURRENT[0]],
    }));

    await adjustCreationCards({ ...INPUT, imagePrompt }, call, () => "new-card");

    expect(call.mock.calls[0][0].user).toContain(
      `Current imagePrompt: ${JSON.stringify(imagePrompt)}`,
    );
  });

  it("grounds a cards-only request in the original request and deck context", async () => {
    const call = vi.fn(async (_prompts: { system: string; user: string }) => ({
      generationSummary: SUMMARY,
      cards: [CURRENT[1]],
    }));

    await adjustCreationCards(INPUT, call, () => "new-card");

    expect(call).toHaveBeenCalledOnce();
    const [{ system, user }] = call.mock.calls[0];
    expect(system).toContain("Return a concise generationSummary and cards only");
    expect(system).toContain("Do not change the deck or image intent");
    expect(user).toContain(INPUT.request);
    expect(user).toContain(INPUT.deck.name);
    expect(user).toContain(INPUT.deck.description);
    expect(user).toContain(INPUT.learningGoal);
    expect(user).toContain(INPUT.instruction);
    expect(user).toContain(INPUT.aiInstructions);
    expect(user).toContain(JSON.stringify(CURRENT));
  });

  it("preserves known keys and assigns server keys only to additions", async () => {
    const added = {
      key: null,
      aspect: "example",
      front: "Ich esse eine Banane.",
      back: "I eat a banana.",
      imageCue: false,
    };

    await expect(adjustCreationCards(
      INPUT,
      async () => ({ generationSummary: SUMMARY, cards: [CURRENT[1], added] }),
      () => "added-by-server",
    )).resolves.toEqual({
      generationSummary: SUMMARY,
      cards: [
        CURRENT[1],
        { ...added, key: "added-by-server" },
      ],
    });
  });

  it("retries unknown keys and invalid image cues before returning a valid set", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({
        generationSummary: SUMMARY,
        cards: [{ ...CURRENT[0], key: "invented", imageCue: true }],
      })
      .mockResolvedValueOnce({ generationSummary: SUMMARY, cards: [CURRENT[0]] });

    await expect(adjustCreationCards(INPUT, call, () => "new-card"))
      .resolves.toEqual({ generationSummary: SUMMARY, cards: [CURRENT[0]] });

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0].user).toContain("failed validation");
  });

  it("rejects an image cue when the retained creation has no usable image", async () => {
    await expect(adjustCreationCards(
      { ...INPUT, imagePrompt: null },
      async () => ({
        generationSummary: SUMMARY,
        cards: [{ ...CURRENT[1], imageCue: true }],
      }),
      () => "new-card",
    )).rejects.toThrow("failed validation twice");
  });
});
