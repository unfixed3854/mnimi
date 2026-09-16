import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { routeCreation } from "./creation-routing.ts";
import { openRouterCalls } from "./model-calls.ts";

// Keep TanStack chat, schema conversion, and the OpenRouter adapter/SDK real.
// Only replace HTTP so schema incompatibilities still fail before the request.
const fetchMock = vi.fn<typeof fetch>();

const GERMAN = {
  id: "deck-german",
  name: "German",
  description: "German vocabulary",
};
const COOKING = {
  id: "deck-cooking",
  name: "Cooking",
  description: "Ingredients and cooking techniques",
};
const PROPOSAL = {
  kind: "newDeck",
  proposedName: "German",
  proposedDescription: "German vocabulary and expressions",
  learningGoal: "Learn the German word for bell pepper.",
};

function respondWith(outcome: unknown) {
  fetchMock.mockImplementation(async () => {
    const chunk = {
      id: "test-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{
        index: 0,
        delta: { role: "assistant", content: JSON.stringify({ outcome }) },
        finish_reason: "stop",
      }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("creation routing through the OpenRouter adapter", () => {
  it.each([
    { label: "no decks exist", decks: [], outcome: PROPOSAL },
    { label: "no existing deck fits", decks: [COOKING], outcome: PROPOSAL },
    {
      label: "an existing deck matches",
      decks: [GERMAN],
      outcome: {
        kind: "matched",
        deckId: GERMAN.id,
        learningGoal: "Learn the German word for bell pepper.",
      },
    },
    {
      label: "two decks offer different learning angles",
      decks: [GERMAN, COOKING],
      outcome: {
        kind: "ambiguous",
        candidates: [
          { deckId: GERMAN.id, learningGoal: "Practise German vocabulary." },
          { deckId: COOKING.id, learningGoal: "Learn how to use bell peppers." },
        ],
      },
    },
  ])("returns the routing decision when $label", async ({ decks, outcome }) => {
    respondWith(outcome);

    await expect(routeCreation({
      request: "die Paprika",
      nativeLanguage: "pl",
      decks,
    }, openRouterCalls.route)).resolves.toEqual(outcome);

    const request = await (fetchMock.mock.calls[0][0] as Request).json();
    expect(request.response_format.json_schema.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(JSON.stringify(request.response_format.json_schema.schema))
      .not.toContain('"oneOf"');
  });

  it("normalizes the provider's proposed alias to a new-deck outcome", async () => {
    respondWith({ ...PROPOSAL, kind: "proposed" });

    await expect(routeCreation({
      request: "Klej w języku niemieckim",
      nativeLanguage: "pl",
      decks: [],
    }, openRouterCalls.route)).resolves.toEqual(PROPOSAL);
  });

  it("rejects an incomplete proposed alias after one corrective retry", async () => {
    respondWith({
      kind: "proposed",
      proposedName: "German",
      proposedDescription: "German vocabulary, expressions, and grammar.",
    });

    await expect(routeCreation({
      request: "Klej w języku niemieckim",
      nativeLanguage: "pl",
      decks: [],
    }, openRouterCalls.route)).rejects.toThrow(
      "Model output failed validation twice",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still rejects an invented deck returned through the provider", async () => {
    respondWith({
      kind: "matched",
      deckId: "foreign-deck",
      learningGoal: "Learn German vocabulary.",
    });

    await expect(routeCreation({
      request: "die Paprika",
      nativeLanguage: "pl",
      decks: [],
    }, openRouterCalls.route)).rejects.toThrow("Matched deck is not owned");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
