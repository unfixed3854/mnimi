import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  makeOpenRouter,
  makeOpenRouterModelCalls,
  type OpenRouterService,
  type OpenRouterClient,
} from "./openrouter.ts";
import type { EffectPull } from "./ai-generation.ts";
import { ProviderFailure } from "./errors.ts";

const config = {
  apiKey: "test-key",
  classifyModel: "classify-model",
  generateModel: "generate-model",
  imageModel: "author/image-model",
  classifyEffort: "low",
  generateEffort: "high",
};

function clientFixture() {
  const listModels = vi.fn(async () => ({ data: [{ id: "author/image-model" }] }));
  const generate = vi.fn(async () => ({ data: [{ b64Json: "AQID" }] }));
  const send = vi.fn();
  const get = vi.fn();
  const client: OpenRouterClient = {
    images: { listModels, generate },
    chat: { send },
    models: { get },
  };
  return { client, listModels, generate, send, get };
}

async function run<A>(effect: Effect.Effect<A, unknown>) {
  return await Effect.runPromise(effect);
}

describe("OpenRouter", () => {
  it("does no SDK work until the first operation", async () => {
    const createClient = vi.fn(() => clientFixture().client);
    makeOpenRouter(config, { createClient });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("keeps missing credentials lazy and exact", async () => {
    const service = makeOpenRouter({ ...config, apiKey: "" });
    expect(() => service.classify({ system: "s", user: "u" })).not.toThrow();
    await expect(run(service.classify({ system: "s", user: "u" })))
      .rejects.toMatchObject({ message: "OPENROUTER_API_KEY is not set" });
  });

  it("uses the exact structured call shape and reasoning option", async () => {
    const chat = vi.fn(async (_options: Record<string, unknown>) => ({
      domain: "language",
      language: "de",
      partOfSpeech: "noun",
    }));
    const adapter = vi.fn(() => "adapter" as never);
    const service = makeOpenRouter(config, { chat, createTextAdapter: adapter });
    await run(service.classify({ system: "system", user: "user" }));
    expect(adapter).toHaveBeenCalledWith("classify-model", "test-key");
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      adapter: "adapter",
      systemPrompts: ["system"],
      messages: [{ role: "user", content: "user" }],
      stream: false,
      modelOptions: { reasoning: { effort: "low" } },
    }));
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["invalid", "bogus"],
  ])("omits reasoning options when the effort is %s", async (_label, effort) => {
    const chat = vi.fn(async (_options: Record<string, unknown>) => ({
      domain: "language",
      language: "de",
      partOfSpeech: "noun",
    }));
    const adapter = vi.fn(() => "adapter" as never);
    const service = makeOpenRouter({ ...config, classifyEffort: effort }, {
      chat,
      createTextAdapter: adapter,
    });

    await run(service.classify({ system: "system", user: "user" }));

    const request = chat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).not.toHaveProperty("modelOptions");
  });

  it("filters streamed deltas, returns the structured object, and surfaces RUN_ERROR", async () => {
    const stream = (async function* () {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" };
      yield { type: "CUSTOM", name: "structured-output.complete", value: { object: { ok: true } } };
    })();
    const chat = vi.fn(() => stream);
    const service = makeOpenRouter(config, { chat, createTextAdapter: () => "adapter" as never });
    const result = await run(service.generate({ system: "s", user: "u" }));
    const deltas: string[] = [];
    let step = await run(result.next());
    while (!step.done) {
      deltas.push(step.value);
      step = await run(result.next());
    }
    expect(deltas).toEqual(["hello"]);
    expect(step.value).toEqual({ ok: true });
  });

  it("rethrows the exact original late stream error at the Promise boundary", async () => {
    const sentinel = new Error("late sentinel");
    const stream = (async function* () {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" };
      throw sentinel;
    })();
    const chat = vi.fn(() => stream);
    const calls = makeOpenRouterModelCalls(makeOpenRouter(config, {
      chat,
      createTextAdapter: () => "adapter" as never,
    }));

    const consume = async () => {
      for await (const _delta of calls.generate({ system: "s", user: "u" })) {
        // Drain the stream so the late failure is observed.
      }
    };
    await expect(consume()).rejects.toBe(sentinel);
  });

  it("preserves a primary pull failure when OpenRouter cleanup fails too", async () => {
    const primary = new Error("primary");
    const cleanup = new Error("cleanup");
    const failure = (cause: unknown) => new ProviderFailure({
      provider: "openrouter",
      operation: "openrouter.generate",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
    const pull: EffectPull<string, unknown, ProviderFailure> = {
      next: () => Effect.fail(failure(primary)),
      return: () => Effect.fail(failure(cleanup)),
    };
    const service = {
      generate: () => Effect.succeed(pull),
    } as unknown as OpenRouterService;
    const generator = makeOpenRouterModelCalls(service).generate({ system: "s", user: "u" });

    await expect(generator.next()).rejects.toBe(primary);
  });

  it("keeps OpenRouter cleanup failure visible on early close", async () => {
    const cleanup = new Error("cleanup");
    const failure = new ProviderFailure({
      provider: "openrouter",
      operation: "openrouter.generate",
      message: cleanup.message,
      cause: cleanup,
    });
    const pull: EffectPull<string, unknown, ProviderFailure> = {
      next: () => Effect.succeed({ done: false, value: "chunk" }),
      return: () => Effect.fail(failure),
    };
    const service = {
      generate: () => Effect.succeed(pull),
    } as unknown as OpenRouterService;
    const generator = makeOpenRouterModelCalls(service).generate({ system: "s", user: "u" });

    await expect(generator.next()).resolves.toMatchObject({ done: false, value: "chunk" });
    await expect(generator.return!(undefined)).rejects.toBe(cleanup);
  });

  it("caches route discovery, coalesces calls, and evicts failures", async () => {
    const first = clientFixture();
    let release!: (value: { data: Array<{ id: string }> }) => void;
    first.listModels.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const service = makeOpenRouter(config, { createClient: () => first.client });
    const pendingOne = run(service.imageGenerationRoute("author/image-model"));
    const pendingTwo = run(service.imageGenerationRoute("author/image-model"));
    expect(first.listModels).toHaveBeenCalledTimes(1);
    release({ data: [{ id: "author/image-model" }] });
    await expect(Promise.all([pendingOne, pendingTwo])).resolves.toEqual([
      { endpoint: "images" },
      { endpoint: "images" },
    ]);
    await run(service.imageGenerationRoute("author/image-model"));
    expect(first.listModels).toHaveBeenCalledTimes(1);

    const failing = clientFixture();
    failing.listModels.mockRejectedValueOnce(new Error("discovery failed"));
    const retrying = makeOpenRouter(config, { createClient: () => failing.client });
    await expect(run(retrying.imageGenerationRoute("author/image-model"))).rejects.toThrow("discovery failed");
    await expect(run(retrying.imageGenerationRoute("author/image-model"))).resolves.toEqual({ endpoint: "images" });
    expect(failing.listModels).toHaveBeenCalledTimes(2);
  });

  it("makes image requests with the suffix and decodes data URLs", async () => {
    const fixture = clientFixture();
    fixture.listModels.mockResolvedValue({ data: [] });
    fixture.get.mockResolvedValue({ data: { architecture: { outputModalities: ["text", "image"] } } });
    fixture.send.mockResolvedValue({ choices: [{ message: {
      images: [{ imageUrl: { url: "data:image/png;base64,AQID" } }],
    } }] });
    const service = makeOpenRouter({ ...config, imageModel: "author/model" }, {
      createClient: () => fixture.client,
    });
    await expect(run(service.generateImageBytes("a pear"))).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(fixture.send).toHaveBeenCalledWith({ chatRequest: {
      model: "author/model",
      stream: false,
      modalities: ["text", "image"],
      messages: [{ role: "user", content: "a pear. Photographic, plain background, no text, no letters, no words anywhere in the image." }],
    } });
  });

  it("adapts one service instance to the current Promise model-calls contract", async () => {
    const chat = vi.fn(async () => ({ domain: "concept", language: null, partOfSpeech: null }));
    const calls = makeOpenRouterModelCalls(makeOpenRouter(config, {
      chat,
      createTextAdapter: () => "adapter" as never,
    }));
    await expect(calls.classify({ system: "s", user: "u" })).resolves.toEqual({
      domain: "concept", language: null, partOfSpeech: null,
    });
  });
});
