import { describe, expect, it, vi } from "vitest";

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));

// `chat` is a direct import from `@tanstack/ai`, not an injected seam like
// `ModelCalls` — mocking the module is the only way to substitute it without
// reaching OpenRouter. `openrouter.ts` is mocked too: `textAdapter` reads
// `OPENROUTER_API_KEY` from the environment and throws when it is unset,
// which it always is under vitest.
vi.mock("@tanstack/ai", () => ({ chat: chatMock }));
vi.mock("./openrouter.ts", () => ({
  classifyModel: () => "classify-model",
  classifyReasoning: () => ({ effort: "low" }),
  generateModel: () => "generate-model",
  generateReasoning: () => ({ effort: "high" }),
  textAdapter: (model: string) => model,
}));

import { openRouterCalls } from "./model-calls.ts";

function stream(...chunks: unknown[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

/** Drains `generate`'s deltas and captures its return value, the way
 *  `generate-note.ts`'s own `.next()` loop consumes it. */
async function collect(generator: AsyncGenerator<string, unknown>) {
  const deltas: string[] = [];
  let step = await generator.next();
  while (!step.done) {
    deltas.push(step.value);
    step = await generator.next();
  }
  return { deltas, object: step.value };
}

describe("openRouterCalls.generate", () => {
  it("yields text deltas as the stream produces them", async () => {
    const object = { cards: [], imagePrompt: null };
    chatMock.mockReturnValueOnce(
      stream(
        { type: "TEXT_MESSAGE_CONTENT", delta: '{"cards":' },
        { type: "TEXT_MESSAGE_CONTENT", delta: "[]}" },
        {
          type: "CUSTOM",
          name: "structured-output.complete",
          value: { object },
        },
      ),
    );

    const { deltas } = await collect(
      openRouterCalls.generate({ system: "s", user: "u" }),
    );

    expect(deltas).toEqual(['{"cards":', "[]}"]);
  });

  it("returns the object extracted from structured-output.complete", async () => {
    const object = {
      cards: [
        {
          aspect: "meaning",
          front: "banana",
          back: "die Banane",
          imageCue: false,
        },
      ],
      imagePrompt: null,
    };
    chatMock.mockReturnValueOnce(
      stream(
        { type: "TEXT_MESSAGE_CONTENT", delta: JSON.stringify(object) },
        {
          type: "CUSTOM",
          name: "structured-output.complete",
          value: { object },
        },
      ),
    );

    const { object: result } = await collect(
      openRouterCalls.generate({ system: "s", user: "u" }),
    );

    expect(result).toEqual(object);
  });

  it("throws with the RUN_ERROR chunk's message instead of returning undefined", async () => {
    // Unhandled, this would leave `object` undefined and streamWithRetry
    // would treat it as a validation failure, burning a pointless retry
    // against a provider that just failed.
    chatMock.mockReturnValueOnce(
      stream(
        { type: "TEXT_MESSAGE_CONTENT", delta: "partial" },
        { type: "RUN_ERROR", message: "provider exploded" },
      ),
    );

    await expect(collect(openRouterCalls.generate({ system: "s", user: "u" })))
      .rejects.toThrow(
        "provider exploded",
      );
  });
});

describe("openRouterCalls.route", () => {
  it("uses a validated non-streaming structured call", async () => {
    const outcome = {
      kind: "matched",
      deckId: "deck-latin",
      learningGoal: "Practise producing the expression.",
    };
    chatMock.mockResolvedValueOnce({ outcome });

    await expect(openRouterCalls.route({ system: "route", user: "request" }))
      .resolves.toEqual(outcome);

    expect(chatMock).toHaveBeenLastCalledWith(expect.objectContaining({
      systemPrompts: ["route"],
      messages: [{ role: "user", content: "request" }],
      stream: false,
      outputSchema: expect.anything(),
    }));
  });
});

describe("openRouterCalls.adjust", () => {
  it("uses a validated non-streaming cards-only call", async () => {
    const output = {
      cards: [{
        key: "meaning",
        aspect: "meaning",
        front: "die Banane",
        back: "banana",
        imageCue: false,
      }],
    };
    chatMock.mockResolvedValueOnce(output);

    await expect(openRouterCalls.adjust({ system: "adjust", user: "simplify" }))
      .resolves.toEqual(output);

    expect(chatMock).toHaveBeenLastCalledWith(expect.objectContaining({
      systemPrompts: ["adjust"],
      messages: [{ role: "user", content: "simplify" }],
      stream: false,
      outputSchema: expect.anything(),
    }));
  });
});
