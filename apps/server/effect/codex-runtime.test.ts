import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { AppConfig, makeAppConfigLayer } from "./config.ts";
import {
  CodexRuntime,
  makeCodexRuntime,
  makeCodexRuntimeLayer,
  makeCodexRuntimeLayerFromConfig,
  type CodexRuntimeClient,
} from "./codex-runtime.ts";
import { ProviderFailure } from "./errors.ts";
import type { CodexRoleConfig } from "../ai/codex/config.ts";
import * as codexConfig from "../ai/codex/config.ts";
import type { CodexCompletedTurn, CodexClient } from "../ai/codex/operation.ts";
import type {
  AppServerConnection,
  ConnectionValidator,
} from "../ai/codex/app-server-client.ts";
import { CodexProviderError } from "../ai/codex/protocol.ts";
import type { CreationModelCalls } from "../ai/model-calls.ts";

const CONFIG: CodexRoleConfig = {
  classify: { model: "classify-model", effort: "low" },
  generate: { model: "generate-model", effort: "high" },
  codexHome: "/dedicated-codex-home",
};

const COMPLETED: CodexCompletedTurn = {
  id: "turn-1",
  status: "completed",
  items: [{
    type: "agentMessage",
    text: '{"domain":"concept","language":null,"partOfSpeech":null}',
  }],
};

const CONNECTION = {} as AppServerConnection;

function fakeRunTurn(
  calls: { count: number },
  error?: unknown,
): typeof import("../ai/codex/operation.ts").runCodexTurn {
  return vi.fn(async (_client, _request, consume) => {
    calls.count += 1;
    if (error !== undefined) throw error;
    return await consume(COMPLETED, "/unused");
  }) as unknown as typeof import("../ai/codex/operation.ts").runCodexTurn;
}

function fakeClient(
  events: string[],
  validator?: ConnectionValidator,
  dispose: () => Promise<void> = async () => {},
): CodexRuntimeClient {
  return {
    async connect() {
      events.push("connect");
      if (validator) await validator({ request: async <T>() => undefined as T });
      return CONNECTION;
    },
    [Symbol.asyncDispose]: dispose,
  } satisfies CodexRuntimeClient;
}

function readService<E>(runtime: ManagedRuntime.ManagedRuntime<CodexRuntime, E>) {
  return runtime.runPromise(Effect.gen(function* () {
    return yield* CodexRuntime;
  }));
}

describe("CodexRuntime", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires an explicit environment for a config-derived Layer", () => {
    expect(() => makeCodexRuntimeLayerFromConfig(CONFIG, {
      createClient: vi.fn(),
    } as never)).toThrow("Codex runtime environment is required");
  });

  it("constructs without connecting and runs one typed operation without replay", async () => {
    const calls = { count: 0 };
    const client = {
      connect: vi.fn(async () => CONNECTION),
    } satisfies CodexClient;
    const service = makeCodexRuntime({
      client,
      config: CONFIG,
      runTurn: fakeRunTurn(calls),
    });

    expect(client.connect).not.toHaveBeenCalled();
    const result = await Effect.runPromise(
      service.modelCalls.classify({ system: "system", user: "apple" }),
    );

    expect(result).toEqual({ domain: "concept", language: null, partOfSpeech: null });
    expect(calls.count).toBe(1);
  });

  it("maps a low-level failure to a sanitized ProviderFailure while retaining its cause", async () => {
    const cause = new CodexProviderError("usage-limit", "Codex turn failed (usage-limit)");
    const service = makeCodexRuntime({
      client: { connect: async () => CONNECTION },
      config: CONFIG,
      runTurn: fakeRunTurn({ count: 0 }, cause),
    });

    const failure = await Effect.runPromiseExit(
      service.modelCalls.classify({ system: "system", user: "apple" }),
    );

    expect(failure.toString()).toContain("ProviderFailure");
    expect(failure.toString()).toContain("usage-limit");
    if (failure._tag === "Failure") {
      expect(failure.cause.toString()).toContain("Codex turn failed (usage-limit)");
    }
  });

  it("acquires one client per Layer runtime, validates eagerly, and releases idempotently", async () => {
    const events: string[] = [];
    const dispose = vi.fn(async () => { events.push("dispose"); });
    const validate = vi.spyOn(codexConfig, "validateCodexStartup").mockImplementation(async () => {
      events.push("validate");
    });
    const createClient = vi.fn((_home: string, validator: ConnectionValidator) =>
      fakeClient(events, validator, dispose));
    const runtime = ManagedRuntime.make(
      makeCodexRuntimeLayerFromConfig(CONFIG, {
        createClient,
        env: { CODEX_HOME: "/dedicated-codex-home" },
      }),
    );

    await expect(readService(runtime)).resolves.toBeDefined();
    await expect(readService(runtime)).resolves.toBeDefined();
    expect(createClient).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
    expect(events).toEqual(["connect", "validate"]);

    const closing = runtime.dispose();
    await closing;
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("closes a partially acquired client and preserves the startup failure", async () => {
    const primary = new CodexProviderError("unauthenticated", "Codex requires login");
    const dispose = vi.fn(async () => { throw new Error("cleanup failed"); });
    vi.spyOn(codexConfig, "validateCodexStartup").mockRejectedValue(primary);
    const createClient = vi.fn((_home: string, validator: ConnectionValidator) =>
      fakeClient([], validator, dispose));
    const runtime = ManagedRuntime.make(
      makeCodexRuntimeLayerFromConfig(CONFIG, {
        createClient,
        env: { CODEX_HOME: "/dedicated-codex-home" },
      }),
    );

    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      return yield* CodexRuntime;
    }));
    expect(exit.toString()).toContain("ProviderFailure");
    expect(exit.toString()).toContain("codex.connect");
    expect(exit.toString()).toContain("Codex requires login");
    expect(dispose).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("derives role defaults from AppConfig without reading process.env", async () => {
    const createClient = vi.fn((_home: string, _validator: ConnectionValidator) =>
      fakeClient([]));
    const config = makeAppConfigLayer({
      env: { CODEX_HOME: "/configured-home" },
      argv: [],
    });
    const runtime = ManagedRuntime.make(
      makeCodexRuntimeLayer({ createClient }).pipe(Layer.provide(config)),
    );
    await expect(readService(runtime)).resolves.toBeDefined();
    expect(createClient).toHaveBeenCalledWith("/configured-home", expect.any(Function));
    await runtime.dispose();
  });

  it("keeps explicit blank role values as the existing eager configuration error", async () => {
    const createClient = vi.fn((_home: string, _validator: ConnectionValidator) =>
      fakeClient([]));
    const config = makeAppConfigLayer({
      env: { CLASSIFY_MODEL: "   ", CODEX_HOME: "/configured-home" },
      argv: [],
    });
    const runtime = ManagedRuntime.make(
      makeCodexRuntimeLayer({ createClient }).pipe(Layer.provide(config)),
    );

    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      return yield* CodexRuntime;
    }));
    expect(exit.toString()).toContain("ProviderFailure");
    expect(exit.toString()).toContain("CLASSIFY_MODEL must not be empty");
    expect(createClient).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("exposes Effect operations for the Promise facade to own", () => {
    const service = makeCodexRuntime({
      client: { connect: async () => CONNECTION },
      config: CONFIG,
      runTurn: fakeRunTurn({ count: 0 }),
    });
    const modelCalls: CreationModelCalls = service.modelCalls as unknown as CreationModelCalls;
    expect(modelCalls.classify).toBeTypeOf("function");
    expect(service.generateImageBytes("prompt")).toBeDefined();
  });
});
