import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateNote } from "../generate-note.ts";
import { parseWithRetry } from "../generate.ts";
import { classificationSchema } from "../schemas.ts";
import type { CodexRoleConfig } from "./config.ts";
import * as configModule from "./config.ts";
import * as clientModule from "./app-server-client.ts";
import type { AppServerConnection } from "./app-server-client.ts";
import type {
  CodexClient,
  CodexCompletedTurn,
} from "./operation.ts";
import { runCodexTurn } from "./operation.ts";
import { CodexProviderError } from "./protocol.ts";
import { createCodexImageGenerator, createCodexModelCalls, createCodexProvider } from "./provider.ts";
import { FakeAppServerProcess } from "./test-process.ts";

function handshakeProcess() {
  const fake = new FakeAppServerProcess();
  const write = fake.write.bind(fake);
  fake.write = (line) => {
    write(line);
    const message = JSON.parse(line);
    if (message.method === "initialize") queueMicrotask(() => fake.respond(message.id, {}));
  };
  return fake;
}

const CONFIG: CodexRoleConfig = {
  classify: { model: "classify-model", effort: "low" },
  generate: { model: "generate-model", effort: "high" },
  codexHome: "/unused",
};

const CLIENT = {} as CodexClient;

type TurnRequest = Parameters<typeof runCodexTurn>[1];
type TurnPlan = {
  items?: unknown[];
  deltas?: string[];
  error?: unknown;
};

function completedTurn(items: unknown[]): CodexCompletedTurn {
  return { id: "turn-1", status: "completed", items };
}

function fakeRunTurn(
  plan: (request: TurnRequest, call: number) => TurnPlan,
  requests: TurnRequest[] = [],
): typeof runCodexTurn {
  let calls = 0;
  return async (_client, request, consume, onDelta) => {
    requests.push(request);
    const next = plan(request, calls++);
    for (const delta of next.deltas ?? []) onDelta?.(delta);
    if (next.error !== undefined) throw next.error;
    return await consume(completedTurn(next.items ?? []), "/unused");
  };
}

async function drain(generator: AsyncGenerator<string, unknown>): Promise<unknown> {
  let step = await generator.next();
  while (!step.done) step = await generator.next();
  return step.value;
}

function providerEnvironment(codexHome = "/unused"): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: codexHome,
    CLASSIFY_MODEL: "classify-model",
    CLASSIFY_EFFORT: "low",
    GENERATE_MODEL: "generate-model",
    GENERATE_EFFORT: "high",
  };
}

describe("createCodexModelCalls", () => {
  it("preserves prompts and maps every call to its role and a strict response schema", async () => {
    const requests: TurnRequest[] = [];
    const texts = [
      '{"domain":"concept","language":null,"partOfSpeech":null}',
      '{"outcome":{"kind":"matched","deckId":"deck-1","learningGoal":"Review it"}}',
      '{"generationSummary":"Practise the concept.","cards":[]}',
      '{"imagePrompt":null,"generationSummary":"Practise the concept.","cards":[]}',
    ];
    const calls = createCodexModelCalls({
      client: CLIENT,
      config: CONFIG,
      runTurn: fakeRunTurn((_request, call) => ({
        items: [{ type: "agentMessage", text: texts[call] }],
      }), requests),
    });

    await calls.classify({ system: "classify system", user: "apple" });
    await calls.route({ system: "route system", user: "choose deck" });
    await calls.adjust({ system: "adjust system", user: "simplify" });
    await drain(calls.generate({ system: "generate system", user: "pear" }));

    expect(requests.map(({ model, effort, system, user }) => ({
      model,
      effort,
      system,
      user,
    }))).toEqual([
      { model: "classify-model", effort: "low", system: "classify system", user: "apple" },
      { model: "classify-model", effort: "low", system: "route system", user: "choose deck" },
      { model: "generate-model", effort: "high", system: "adjust system", user: "simplify" },
      { model: "generate-model", effort: "high", system: "generate system", user: "pear" },
    ]);
    expect(requests[0]?.outputSchema).toMatchObject({
      type: "object",
      required: ["domain", "language", "partOfSpeech"],
      additionalProperties: false,
    });
    expect(requests[3]?.outputSchema).toMatchObject({
      type: "object",
      required: ["imagePrompt", "generationSummary", "cards"],
      additionalProperties: false,
      properties: {
        cards: {
          items: {
            type: "object",
            required: ["aspect", "front", "back", "imageCue"],
            additionalProperties: false,
          },
        },
      },
    });
    for (const [requestIndex, request] of requests.entries()) {
      const pending: Array<{ path: string; value: unknown }> = [{
        path: "$",
        value: request.outputSchema,
      }];
      let objects = 0;
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (Array.isArray(current.value)) {
          current.value.forEach((value, index) => pending.push({
            path: `${current.path}[${index}]`,
            value,
          }));
          continue;
        }
        if (!current.value || typeof current.value !== "object") continue;
        const schema = current.value as Record<string, unknown>;
        for (const [key, value] of Object.entries(schema)) {
          pending.push({ path: `${current.path}.${key}`, value });
        }
        if (schema.type !== "object") continue;
        objects++;
        const properties = schema.properties as Record<string, unknown>;
        expect(schema.additionalProperties, `request ${requestIndex} ${current.path}`)
          .toBe(false);
        expect(
          [...(schema.required as string[])].sort(),
          `request ${requestIndex} ${current.path}`,
        ).toEqual(Object.keys(properties).sort());
      }
      expect(objects).toBeGreaterThan(0);
    }
  });

  it("uses the last completed message for classification and adjustment", async () => {
    const texts = [
      '{"domain":"concept","language":null,"partOfSpeech":null}',
      '{"cards":[{"key":null,"aspect":"meaning","front":"front","back":"back","imageCue":false}]}',
    ];
    const calls = createCodexModelCalls({
      client: CLIENT,
      config: CONFIG,
      runTurn: fakeRunTurn((_request, call) => ({ items: [
        { type: "agentMessage", text: '{"wrong":true}' },
        { type: "reasoning", text: "ignore this too" },
        { type: "agentMessage", text: texts[call] },
      ] })),
    });

    await expect(calls.classify({ system: "s", user: "u" })).resolves.toEqual({
      domain: "concept",
      language: null,
      partOfSpeech: null,
    });
    await expect(calls.adjust({ system: "s", user: "u" })).resolves.toEqual({
      cards: [{
        key: null,
        aspect: "meaning",
        front: "front",
        back: "back",
        imageCue: false,
      }],
    });
  });

  it("unwraps the last routing response and normalizes proposed to newDeck", async () => {
    const calls = createCodexModelCalls({
      client: CLIENT,
      config: CONFIG,
      runTurn: fakeRunTurn(() => ({ items: [
        { type: "agentMessage", text: '{"outcome":{"kind":"matched","deckId":"wrong","learningGoal":"wrong"}}' },
        { type: "agentMessage", text: JSON.stringify({ outcome: {
          kind: "proposed",
          proposedName: "Fruit",
          proposedDescription: "Fruit vocabulary",
          learningGoal: "Name fruit",
        } }) },
      ] })),
    });

    await expect(calls.route({ system: "s", user: "u" })).resolves.toEqual({
      kind: "newDeck",
      proposedName: "Fruit",
      proposedDescription: "Fruit vocabulary",
      learningGoal: "Name fruit",
    });
  });

  it("yields deltas unchanged and in order, starts once, and returns the completed message", async () => {
    let starts = 0;
    const calls = createCodexModelCalls({
      client: CLIENT,
      config: CONFIG,
      runTurn: fakeRunTurn(() => {
        starts++;
        return {
          deltas: ['{"cards":', "[]}"],
          items: [{
            type: "agentMessage",
            text: '{"cards":[],"imagePrompt":null,"generationSummary":"Practise the concept."}',
          }],
        };
      }),
    });

    const generator = calls.generate({ system: "generate system", user: "pear" });
    const first = await generator.next();
    expect(first).toEqual({ done: false, value: '{"cards":' });
    const second = await generator.next();
    expect(second).toEqual({ done: false, value: "[]}" });
    const completed = await generator.next();
    expect(completed).toEqual({
      done: true,
      value: {
        cards: [],
        imagePrompt: null,
        generationSummary: "Practise the concept.",
      },
    });
    expect(starts).toBe(1);
  });

  it.each(["classify", "route", "adjust", "generate"] as const)(
    "throws a protocol provider error when %s has no completed agent message",
    async (method) => {
      const calls = createCodexModelCalls({
        client: CLIENT,
        config: CONFIG,
        runTurn: fakeRunTurn(() => ({
          items: [{ type: "reasoning", text: "no answer" }],
        })),
      });
      const prompts = { system: "s", user: "u" };
      const result = method === "generate"
        ? drain(calls.generate(prompts))
        : calls[method](prompts);

      await expect(result).rejects.toMatchObject({
        name: "CodexProviderError",
        category: "protocol",
      });
    },
  );

  it("returns invalid completed JSON raw so the validation layer retries once", async () => {
    const requests: TurnRequest[] = [];
    const calls = createCodexModelCalls({
      client: CLIENT,
      config: CONFIG,
      runTurn: fakeRunTurn((_request, call) => ({
        items: [{
          type: "agentMessage",
          text: call === 0
            ? "not valid JSON"
            : '{"domain":"concept","language":null,"partOfSpeech":null}',
        }],
      }), requests),
    });

    const result = await parseWithRetry(classificationSchema, (feedback) =>
      calls.classify({
        system: "classification system",
        user: feedback ?? "apple",
      }));

    expect(result).toEqual({
      domain: "concept",
      language: null,
      partOfSpeech: null,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain("failed validation");
  });

  it("propagates a rejected streamed turn through the channel without a validation retry", async () => {
    const failure = new CodexProviderError("connection", "Codex disconnected");
    let callsMade = 0;
    const calls = createCodexModelCalls({
      client: CLIENT,
      config: CONFIG,
      runTurn: fakeRunTurn((_request, call) => {
        callsMade++;
        if (call === 0) {
          return { items: [{
            type: "agentMessage",
            text: '{"domain":"concept","language":null,"partOfSpeech":null}',
          }] };
        }
        return { deltas: ["partial"], error: failure };
      }),
    });
    const input = {
      text: "entropy",
      nativeLanguage: "en",
      deck: { id: "deck-1", name: "Concepts", description: null },
      learningGoal: "Recall the definition",
    };

    const consume = async () => {
      for await (const _event of generateNote(input, calls)) {
        // Drive the real application generator until the provider fails.
      }
    };
    await expect(consume()).rejects.toBe(failure);
    expect(callsMade).toBe(2);
  });

  it.each([
    new CodexProviderError("usage-limit", "Codex turn failed"),
    new CodexProviderError("process-exit", "Codex disconnected"),
  ])("preserves non-streamed provider failures", async (failure) => {
    const calls = createCodexModelCalls({
      client: CLIENT,
      config: CONFIG,
      runTurn: fakeRunTurn(() => ({ error: failure })),
    });

    await expect(calls.classify({ system: "s", user: "u" })).rejects.toBe(
      failure,
    );
  });
});

describe("Codex images and provider lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delegates every AiProvider operation through the injected Effect runtime and closes its scope once", async () => {
    vi.spyOn(configModule, "validateCodexStartup").mockResolvedValue(undefined);
    const fixture = await mkdtemp(join(tmpdir(), "mnimi-image-facade-"));
    const codexHome = join(fixture, "codex");
    const imagePath = join(codexHome, "generated_images", "thread-1", "image.png");
    await mkdir(join(codexHome, "generated_images", "thread-1"), { recursive: true });
    const requests: TurnRequest[] = [];
    const dispose = vi.fn(async () => {});
    const createClient = vi.fn((_home: string, validator: clientModule.ConnectionValidator) => ({
      connect: async () => {
        await validator({ request: async <T>() => undefined as T });
        return {} as AppServerConnection;
      },
      [Symbol.asyncDispose]: dispose,
    }));
    const runTurn: typeof runCodexTurn = async (_client, request, consume, onDelta) => {
      requests.push(request);
      if (request.user.startsWith("$imagegen")) {
        const workspace = await mkdtemp(join(fixture, "workspace-"));
        try {
          await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
          return await consume(completedTurn([{
            id: "image-1", type: "imageGeneration", status: "completed",
            result: "generated", failure: null, savedPath: imagePath,
          }]), workspace);
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }
      onDelta?.("delta");
      const text = request.user === "classify"
        ? '{"domain":"concept","language":null,"partOfSpeech":null}'
        : request.user === "route"
          ? '{"outcome":{"kind":"matched","deckId":"deck-1","learningGoal":"Review it"}}'
          : request.user === "adjust"
            ? '{"generationSummary":"Practise the meaning of pear.","cards":[{"key":null,"aspect":"meaning","front":"pear","back":"fruit","imageCue":false}]}'
            : '{"imagePrompt":null,"generationSummary":"Practise the meaning of pear.","cards":[{"aspect":"meaning","front":"pear","back":"fruit","imageCue":false}]}'
      return await consume(completedTurn([{ type: "agentMessage", text }]), "/unused");
    };
    const provider = await createCodexProvider({
      env: providerEnvironment(codexHome),
      createClient,
      runTurn,
    });

    await expect(provider.modelCalls.classify({ system: "s", user: "classify" })).resolves.toEqual({
      domain: "concept", language: null, partOfSpeech: null,
    });
    await expect(provider.modelCalls.route({ system: "s", user: "route" })).resolves.toEqual({
      kind: "matched", deckId: "deck-1", learningGoal: "Review it",
    });
    await expect(provider.modelCalls.adjust({ system: "s", user: "adjust" })).resolves.toEqual({
      generationSummary: "Practise the meaning of pear.",
      cards: [{ key: null, aspect: "meaning", front: "pear", back: "fruit", imageCue: false }],
    });
    const generated = provider.modelCalls.generate({ system: "s", user: "generate" });
    await expect(generated.next()).resolves.toEqual({ done: false, value: "delta" });
    await expect(generated.next()).resolves.toEqual({
      done: true,
      value: {
        imagePrompt: null,
        generationSummary: "Practise the meaning of pear.",
        cards: [{ aspect: "meaning", front: "pear", back: "fruit", imageCue: false }],
      },
    });
    await expect(provider.generateImageBytes("pear")).resolves.toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
    expect(requests).toHaveLength(5);

    await provider[Symbol.asyncDispose]();
    await provider[Symbol.asyncDispose]();
    expect(dispose).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledOnce();
    await rm(fixture, { recursive: true, force: true });
  });

  it("unwraps original non-stream and streamed Codex errors without replay", async () => {
    vi.spyOn(configModule, "validateCodexStartup").mockResolvedValue(undefined);
    const nonStreamFailure = new CodexProviderError("usage-limit", "Codex turn failed");
    const streamFailure = new CodexProviderError("connection", "Codex disconnected");
    let calls = 0;
    const dispose = vi.fn(async () => {});
    const createClient = vi.fn((_home: string, validator: clientModule.ConnectionValidator) => ({
      connect: async () => {
        await validator({ request: async <T>() => undefined as T });
        return {} as AppServerConnection;
      },
      [Symbol.asyncDispose]: dispose,
    }));
    const runTurn: typeof runCodexTurn = async (_client, request, _consume, onDelta) => {
      calls += 1;
      if (request.user === "stream-error") {
        onDelta?.("partial");
        throw streamFailure;
      }
      throw nonStreamFailure;
    };
    const provider = await createCodexProvider({
      env: providerEnvironment(),
      createClient,
      runTurn,
    });

    await expect(provider.modelCalls.classify({ system: "s", user: "classify-error" }))
      .rejects.toBe(nonStreamFailure);
    await expect(drain(provider.modelCalls.generate({ system: "s", user: "stream-error" })))
      .rejects.toBe(streamFailure);
    expect(calls).toBe(2);
    await provider[Symbol.asyncDispose]();
  });

  it("runs the exact imagegen prompt with the generate role and reads the Codex-owned artifact", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "mnimi-image-provider-"));
    const workspace = join(fixture, "workspace");
    const codexHome = join(fixture, "codex");
    const imagePath = join(codexHome, "generated_images", "thread-1", "image.png");
    await mkdir(workspace);
    await mkdir(join(codexHome, "generated_images", "thread-1"), { recursive: true });
    const requests: TurnRequest[] = [];
    const runTurn: typeof runCodexTurn = async (_client, request, consume) => {
      requests.push(request);
      await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
      return await consume(completedTurn([{
        id: "image-1", type: "imageGeneration", status: "completed",
        result: "iVBORw0KGgo=", revisedPrompt: "a pear", failure: null, savedPath: imagePath,
      }]), workspace);
    };
    const env = Object.defineProperty({
      CODEX_HOME: codexHome, CLASSIFY_MODEL: "classify-model", CLASSIFY_EFFORT: "low",
      GENERATE_MODEL: "generate-model", GENERATE_EFFORT: "high",
    }, "IMAGE_MODEL", { enumerable: true, get() { throw new Error("IMAGE_MODEL must never be read"); } });
    try {
      const generateImageBytes = createCodexImageGenerator({
        client: CLIENT, config: configModule.readCodexRoleConfig(env), runTurn,
      });
      expect(await generateImageBytes("a pear")).toEqual(new Uint8Array([137, 80, 78, 71]));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: "generate-model", effort: "high",
        user: "$imagegen Create this image: a pear. Photographic, plain background, no text, no letters, no words anywhere in the image. Save the generated image inside the current workspace.",
      });
      expect(requests[0]).not.toHaveProperty("outputSchema");
      await expect(access(imagePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("anchors the Codex artifact root before the image turn starts", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "mnimi-image-provider-root-race-"));
    const workspace = join(fixture, "workspace");
    const codexHome = join(fixture, "codex");
    const artifactRoot = join(codexHome, "generated_images");
    const replacementImage = join(artifactRoot, "thread-1", "image.png");
    const replacementBytes = new Uint8Array([83, 69, 67, 82, 69, 84]);
    await mkdir(workspace);
    await mkdir(artifactRoot, { recursive: true });
    const runTurn: typeof runCodexTurn = async (_client, _request, consume) => {
      await rename(artifactRoot, `${artifactRoot}-original`);
      await mkdir(join(artifactRoot, "thread-1"), { recursive: true });
      await writeFile(replacementImage, replacementBytes);
      return await consume(completedTurn([{
        id: "image-1", type: "imageGeneration", status: "completed",
        result: "iVBORw0KGgo=", revisedPrompt: "a pear", failure: null,
        savedPath: replacementImage,
      }]), workspace);
    };
    try {
      const generate = createCodexImageGenerator({
        client: CLIENT,
        config: { ...CONFIG, codexHome },
        runTurn,
      });
      await expect(generate("a pear")).rejects.toMatchObject({ category: "image" });
      expect(new Uint8Array(await readFile(replacementImage))).toEqual(replacementBytes);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("preserves image turn failures", async () => {
    const failure = new CodexProviderError("usage-limit", "Codex turn failed");
    const fixture = await mkdtemp(join(tmpdir(), "mnimi-image-provider-failure-"));
    try {
      const config = { ...CONFIG, codexHome: fixture };
      const generate = createCodexImageGenerator({ client: CLIENT, config, runTurn: fakeRunTurn(() => ({ error: failure })) });
      await expect(generate("a pear")).rejects.toBe(failure);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("awaits exactly one startup validation with configured home before returning the complete provider", async () => {
    let finish!: () => void;
    const validated = new Promise<void>((resolve) => { finish = resolve; });
    const validate = vi.spyOn(configModule, "validateCodexStartup").mockReturnValue(validated);
    const fake = handshakeProcess();
    let client!: clientModule.CodexAppServerClient;
    const createClient = vi.fn((_home: string, validate: clientModule.ConnectionValidator) => {
      client = new clientModule.CodexAppServerClient({ spawn: () => fake, validate });
      return client;
    });
    const env = Object.defineProperty({
      CODEX_HOME: "/dedicated-test-home", CLASSIFY_MODEL: "classify-model", CLASSIFY_EFFORT: "low",
      GENERATE_MODEL: "generate-model", GENERATE_EFFORT: "high",
    }, "IMAGE_MODEL", { enumerable: true, get() { throw new Error("IMAGE_MODEL must never be read"); } });
    let returned = false;
    const pending = createCodexProvider({ env, createClient }).then((value) => { returned = true; return value; });
    const dispose = vi.spyOn(client, Symbol.asyncDispose);
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    expect(createClient).toHaveBeenCalledExactlyOnceWith("/dedicated-test-home", expect.any(Function));
    expect(validate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ request: expect.any(Function) }), { ...CONFIG, codexHome: "/dedicated-test-home" });
    expect(dispose).not.toHaveBeenCalled();
    finish();
    const provider = await pending;
    for (const name of ["classify", "route", "generate", "adjust"] as const) expect(provider.modelCalls[name]).toBeTypeOf("function");
    expect(provider.generateImageBytes).toBeTypeOf("function");
    await provider[Symbol.asyncDispose]();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("closes once and preserves the validation failure even if close rejects: %s", async (closeFails) => {
    const failure = new CodexProviderError("unauthenticated", "Codex requires login");
    const validate = vi.spyOn(configModule, "validateCodexStartup").mockRejectedValue(failure);
    const fake = handshakeProcess();
    const close = vi.fn();
    await expect(createCodexProvider({ env: { CODEX_HOME: "/unused" }, createClient: (_home, validate) => {
      const client = new clientModule.CodexAppServerClient({ spawn: () => fake, validate });
      const originalDispose = client[Symbol.asyncDispose].bind(client);
      client[Symbol.asyncDispose] = async () => {
        close();
        await originalDispose();
        if (closeFails) throw new Error("cleanup failed");
      };
      return client;
    } })).rejects.toBe(failure);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("constructs the default client with its spawn option, dedicated environment and no API key", async () => {
    const spawn = vi.spyOn(clientModule, "spawnCodexAppServer").mockImplementation(() => { throw new Error("offline spawn boundary"); });
    vi.spyOn(configModule, "validateCodexStartup").mockImplementation(async (client) => { await client.request("account/read", {}); });
    const env = Object.defineProperty({ CODEX_HOME: "/dedicated-test-home", PATH: "/test-bin", OPENAI_API_KEY: "test-secret" }, "IMAGE_MODEL", {
      enumerable: true, get() { throw new Error("IMAGE_MODEL must never be read"); },
    });
    await expect(createCodexProvider({ env })).rejects.toMatchObject({ category: "connection" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["app-server", "--strict-config", "--stdio"]));
    expect(spawn.mock.calls[0]?.[1]).toEqual({ CODEX_HOME: "/dedicated-test-home", PATH: "/test-bin" });
  });
});
