import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  parseWithRetry,
  projectCards,
  type StreamProgress,
  streamWithRetry,
} from "./generate.ts";

const schema = z.object({ name: z.string() });

function structuredOutputValidationFailure() {
  return Object.assign(
    new Error("Validation failed", {
      cause: {
        issues: [{
          path: ["outcome", "kind"],
          message: 'Invalid input: expected "newDeck"',
        }],
      },
    }),
    { code: "structured-output-validation-failed" },
  );
}

describe("parseWithRetry", () => {
  it("returns the parsed value when the first attempt is valid", async () => {
    const attempt = vi.fn().mockResolvedValue({ name: "ok" });
    await expect(parseWithRetry(schema, attempt)).resolves.toEqual({
      name: "ok",
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("passes null feedback on the first attempt", async () => {
    const attempt = vi.fn().mockResolvedValue({ name: "ok" });
    await parseWithRetry(schema, attempt);
    expect(attempt).toHaveBeenCalledWith(null);
  });

  it("retries once with the validation error as feedback", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ nome: "typo" })
      .mockResolvedValueOnce({ name: "fixed" });

    await expect(parseWithRetry(schema, attempt)).resolves.toEqual({
      name: "fixed",
    });
    expect(attempt).toHaveBeenCalledTimes(2);

    const feedback = attempt.mock.calls[1][0] as string;
    expect(feedback).toContain("name");
  });

  it("retries when the provider adapter rejects malformed structured output", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(structuredOutputValidationFailure())
      .mockResolvedValueOnce({ name: "fixed" });

    await expect(parseWithRetry(schema, attempt)).resolves.toEqual({
      name: "fixed",
    });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls[1][0]).toContain("newDeck");
  });

  it("does not retry provider errors unrelated to structured output", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("Rate limited"));

    await expect(parseWithRetry(schema, attempt)).rejects.toThrow("Rate limited");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("stops after two adapter-level structured output failures", async () => {
    const attempt = vi.fn().mockRejectedValue(structuredOutputValidationFailure());

    await expect(parseWithRetry(schema, attempt)).rejects.toThrow(
      "Model output failed validation twice",
    );
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("throws after a second failure rather than retrying forever", async () => {
    const attempt = vi.fn().mockResolvedValue({ wrong: true });
    await expect(parseWithRetry(schema, attempt)).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe("streamWithRetry", () => {
  type Pass = { deltas: string[]; object: unknown };

  /** Replays canned passes and records the feedback each one was given. */
  function attemptOf(...passes: Pass[]) {
    const feedback: Array<string | null> = [];
    let index = 0;
    const attempt = (given: string | null) => {
      feedback.push(given);
      const pass = passes[Math.min(index++, passes.length - 1)];
      return (async function* () {
        for (const delta of pass.deltas) yield delta;
        return pass.object;
      })();
    };
    return { attempt, feedback };
  }

  async function drive<T>(generator: AsyncGenerator<StreamProgress, T>) {
    const progress: StreamProgress[] = [];
    let step = await generator.next();
    while (!step.done) {
      progress.push(step.value);
      step = await generator.next();
    }
    return { progress, value: step.value };
  }

  it("returns the parsed value and never retries when the first attempt is valid", async () => {
    const { attempt, feedback } = attemptOf({
      deltas: [],
      object: { name: "ok" },
    });

    const { progress, value } = await drive(streamWithRetry(schema, attempt));

    expect(value).toEqual({ name: "ok" });
    expect(progress).toEqual([]);
    expect(feedback).toEqual([null]);
  });

  it("reports accumulated text rather than individual deltas", async () => {
    const { attempt } = attemptOf({
      deltas: ['{"na', 'me":"ok"}'],
      object: { name: "ok" },
    });

    const { progress } = await drive(streamWithRetry(schema, attempt));

    expect(progress).toEqual([
      { type: "partial", raw: '{"na' },
      { type: "partial", raw: '{"name":"ok"}' },
    ]);
  });

  it("resets the accumulator before the retry so partial output is discarded", async () => {
    const { attempt } = attemptOf(
      { deltas: ["junk"], object: { nome: "typo" } },
      { deltas: ['{"name":"fixed"}'], object: { name: "fixed" } },
    );

    const { progress, value } = await drive(streamWithRetry(schema, attempt));

    expect(value).toEqual({ name: "fixed" });
    expect(progress).toEqual([
      { type: "partial", raw: "junk" },
      { type: "retry" },
      { type: "partial", raw: '{"name":"fixed"}' },
    ]);
  });

  it("retries with the validation error as feedback", async () => {
    const { attempt, feedback } = attemptOf(
      { deltas: [], object: { nome: "typo" } },
      { deltas: [], object: { name: "fixed" } },
    );

    await drive(streamWithRetry(schema, attempt));

    expect(feedback[0]).toBeNull();
    expect(feedback[1]).toContain("name");
  });

  it("throws after a second failure rather than retrying forever", async () => {
    const { attempt, feedback } = attemptOf({
      deltas: [],
      object: { wrong: true },
    });

    await expect(drive(streamWithRetry(schema, attempt))).rejects.toThrow();
    expect(feedback).toHaveLength(2);
  });
});

describe("projectCards", () => {
  it("returns nothing until the cards array exists", () => {
    expect(projectCards(undefined)).toEqual([]);
    expect(projectCards({})).toEqual([]);
    expect(projectCards({ cards: "not an array" })).toEqual([]);
  });

  it("nulls every field the model has not reached yet", () => {
    expect(projectCards({ cards: [{ aspect: "gender" }] })).toEqual([
      { aspect: "gender", front: null, back: null, imageCue: null },
    ]);
  });

  it("passes a half-written string through so it renders as it arrives", () => {
    expect(
      projectCards({ cards: [{ aspect: "meaning", front: "die Ba" }] }),
    ).toEqual([{
      aspect: "meaning",
      front: "die Ba",
      back: null,
      imageCue: null,
    }]);
  });

  it("drops non-string values rather than leaking them to the client", () => {
    expect(projectCards({ cards: [{ aspect: 7, front: null, back: {} }] }))
      .toEqual(
        [{ aspect: null, front: null, back: null, imageCue: null }],
      );
  });

  it("keeps only the three fields the streaming UI renders", () => {
    expect(
      projectCards({
        cards: [{ aspect: "meaning", front: "a", back: "b" }],
      }),
    ).toEqual([{ aspect: "meaning", front: "a", back: "b", imageCue: null }]);
  });

  it("projects imageCue once the boolean arrives", () => {
    expect(
      projectCards({
        cards: [{ aspect: "plural", front: "f", back: "b", imageCue: true }],
      }),
    ).toEqual([
      { aspect: "plural", front: "f", back: "b", imageCue: true },
    ]);
  });
});
