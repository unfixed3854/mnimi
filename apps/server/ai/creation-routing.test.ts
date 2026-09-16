import { describe, expect, it, vi } from "vitest";
import { routeCreation } from "./creation-routing.ts";
import type { ModelPrompts } from "./generate-note.ts";

const LATIN = {
  id: "deck-latin",
  name: "Latin",
  description: "Latin vocabulary and production",
};
const PHILOSOPHY = {
  id: "deck-philosophy",
  name: "Philosophy",
  description: "Thinkers, quotations, and ideas",
};
const INPUT = {
  request: "Myślę więc jestem po łacińsku",
  nativeLanguage: "pl",
  decks: [LATIN, PHILOSOPHY],
};

describe("routeCreation", () => {
  it("returns a confident match only for an owned deck", async () => {
    await expect(routeCreation(INPUT, async () => ({
      kind: "matched",
      deckId: LATIN.id,
      learningGoal: "Practice producing the Latin expression.",
    }))).resolves.toEqual({
      kind: "matched",
      deckId: LATIN.id,
      learningGoal: "Practice producing the Latin expression.",
    });
  });

  it("preserves two distinct learning angles for an ambiguous request", async () => {
    await expect(routeCreation(INPUT, async () => ({
      kind: "ambiguous",
      candidates: [
        {
          deckId: LATIN.id,
          learningGoal: "Practice producing the Latin expression.",
        },
        {
          deckId: PHILOSOPHY.id,
          learningGoal: "Learn the quotation, author, and idea.",
        },
      ],
    }))).resolves.toEqual({
      kind: "ambiguous",
      candidates: [
        {
          deckId: LATIN.id,
          learningGoal: "Practice producing the Latin expression.",
        },
        {
          deckId: PHILOSOPHY.id,
          learningGoal: "Learn the quotation, author, and idea.",
        },
      ],
    });
  });

  it("returns an editable new-deck proposal when no owned deck fits", async () => {
    await expect(routeCreation({ ...INPUT, decks: [] }, async () => ({
      kind: "newDeck",
      proposedName: "Latin",
      proposedDescription: "Latin vocabulary and expressions",
      learningGoal: "Practice producing the Latin expression.",
    }))).resolves.toEqual({
      kind: "newDeck",
      proposedName: "Latin",
      proposedDescription: "Latin vocabulary and expressions",
      learningGoal: "Practice producing the Latin expression.",
    });
  });

  it.each([
    {
      kind: "matched",
      deckId: "foreign-deck",
      learningGoal: "Invented ownership",
    },
    {
      kind: "ambiguous",
      candidates: [{ deckId: LATIN.id, learningGoal: "Only one" }],
    },
    {
      kind: "ambiguous",
      candidates: [
        { deckId: LATIN.id, learningGoal: "First" },
        { deckId: LATIN.id, learningGoal: "Duplicate" },
      ],
    },
    {
      kind: "ambiguous",
      candidates: [
        { deckId: LATIN.id, learningGoal: "One" },
        { deckId: PHILOSOPHY.id, learningGoal: "Two" },
        { deckId: "third", learningGoal: "Three" },
        { deckId: "fourth", learningGoal: "Four" },
      ],
    },
  ])("rejects an unsafe routing result %#", async (unsafe) => {
    await expect(routeCreation(INPUT, async () => unsafe)).rejects.toThrow();
  });

  it("gives the model full pedagogical context without requesting confidence", async () => {
    const call = vi.fn(async (_prompts: ModelPrompts) => ({
      kind: "matched",
      deckId: LATIN.id,
      learningGoal: "Practice producing the Latin expression.",
    }));

    await routeCreation(INPUT, call);

    const prompt = call.mock.calls[0][0];
    expect(prompt.user).toContain(INPUT.request);
    expect(prompt.user).toContain("Native language: pl");
    expect(prompt.user).toContain(LATIN.description);
    expect(prompt.user).toContain(PHILOSOPHY.description);
    expect(prompt.system).toContain("quoted or foreign-language source");
    expect(prompt.system).toContain("ambiguous");
    expect(prompt.system).toContain(
      'kind must be exactly "matched", "ambiguous", or "newDeck"',
    );
    expect(`${prompt.system}\n${prompt.user}`.toLowerCase()).not.toContain(
      "confidence score",
    );
  });
});
