import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { z } from "zod";
import {
  AiGeneration,
  type AiGenerationService,
  type EffectPull,
  type StreamProgress,
  makeAiGeneration,
  makeGenerationPromiseFacade,
  runGenerationPromise,
} from "./ai-generation.ts";

const schema = z.object({ name: z.string() });

async function run<A>(effect: Effect.Effect<A, unknown>) {
  return await Effect.runPromise(effect);
}

describe("AiGeneration", () => {
  it("retries one structured-output validation failure and preserves issues", async () => {
    const issues = [{ path: ["name"], message: "required" }];
    let calls = 0;
    const service = makeAiGeneration();
    const result = await run(service.parseWithRetry(schema, (feedback) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(Object.assign(new Error("invalid"), {
          code: "structured-output-validation-failed",
          cause: { issues },
        }));
      }
      expect(feedback).toContain("required");
      return Promise.resolve({ name: "fixed" });
    }));

    expect(result).toEqual({ name: "fixed" });
    expect(calls).toBe(2);
  });

  it("does not retry unrelated provider errors", async () => {
    let calls = 0;
    const service = makeAiGeneration();
    await expect(run(service.parseWithRetry(schema, () => {
      calls += 1;
      return Promise.reject(new Error("rate limited"));
    }))).rejects.toThrow("rate limited");
    expect(calls).toBe(1);
  });

  it("resets streamed accumulated text before the single retry", async () => {
    let attempt = 0;
    const service = makeAiGeneration();
    const stream = await run(service.streamWithRetry(schema, () => {
      attempt += 1;
      return (async function* () {
        if (attempt === 1) {
          yield "bad";
          return { nope: true };
        }
        yield '{"name":"ok"}';
        return { name: "ok" };
      })();
    }));

    const events: unknown[] = [];
    let step = await run(stream.next());
    while (!step.done) {
      events.push(step.value);
      step = await run(stream.next());
    }
    expect(events).toEqual([
      { type: "partial", raw: "bad" },
      { type: "retry" },
      { type: "partial", raw: '{"name":"ok"}' },
    ]);
    expect(step.value).toEqual({ name: "ok" });
  });

  it("runs each streamed pull in the Effect channel", async () => {
    const sentinel = new Error("late sentinel");
    const service = makeAiGeneration();
    const stream = await run(service.streamWithRetry(schema, () => (async function* () {
      yield '{"name":"ok"}';
      throw sentinel;
    })()));

    const first = stream.next();
    expect(Effect.isEffect(first)).toBe(true);
    await expect(run(first)).resolves.toMatchObject({ done: false, value: { type: "partial" } });
    await expect(runGenerationPromise(stream.next())).rejects.toBe(sentinel);
  });

  it("runs early pull cleanup in the Effect channel", async () => {
    let closed = false;
    const source = (async function* () {
      try {
        yield '{"name":"ok"}';
      } finally {
        closed = true;
      }
    })();
    const service = makeAiGeneration();
    const stream = await run(service.streamWithRetry(schema, () => source));

    await run(stream.next());
    await run(stream.return!());
    expect(closed).toBe(true);
  });

  it("preserves a primary stream failure when cleanup fails too", async () => {
    const primary = new Error("primary");
    const cleanup = new Error("cleanup");
    const source = {
      next: () => Promise.reject(primary),
      return: () => Promise.reject(cleanup),
    } as unknown as AsyncGenerator<string, unknown>;
    const service = makeAiGeneration();
    const stream = await run(service.streamWithRetry(schema, () => source));

    await expect(runGenerationPromise(stream.next())).rejects.toBe(primary);
  });

  it("keeps Promise facade cleanup failure visible on early close", async () => {
    const cleanup = new Error("cleanup");
    const pull: EffectPull<StreamProgress, unknown, unknown> = {
      next: () => Effect.succeed({ done: false, value: { type: "partial", raw: "x" } }),
      return: () => Effect.fail(cleanup),
    };
    const service = {
      ...makeAiGeneration(),
      streamWithRetry: () => Effect.succeed(pull),
    } as unknown as AiGenerationService;
    const generator = makeGenerationPromiseFacade(service).streamWithRetry(schema, () =>
      (async function* () {})(),
    );

    await expect(generator.next()).resolves.toMatchObject({ done: false, value: { raw: "x" } });
    await expect(generator.return!(undefined as never)).rejects.toBe(cleanup);
  });

  it("keeps the Promise facade shape while delegating to the service", async () => {
    const facade = makeGenerationPromiseFacade(makeAiGeneration());
    await expect(facade.parseWithRetry(schema, () => Promise.resolve({ name: "ok" })))
      .resolves.toEqual({ name: "ok" });
    expect(facade.projectCards({ cards: [{ aspect: "meaning" }] })).toEqual([
      { aspect: "meaning", front: null, back: null, imageCue: null },
    ]);
  });

  it("exposes a Context service for Effect composition", async () => {
    const service = makeAiGeneration();
    const program = Effect.gen(function* () {
      return (yield* AiGeneration).projectCards({ cards: [] });
    });
    expect(await Effect.runPromise(Effect.provideService(program, AiGeneration, service)))
      .toEqual([]);
  });
});
