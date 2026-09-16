import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Redacted } from "effect";
import type { AppConfigValue } from "./effect/config.ts";

const state = vi.hoisted(() => ({
  events: [] as string[],
  signals: new Map<string, () => void>(),
  config: null as unknown as AppConfigValue,
  database: { db: {} },
  auth: { instance: {} },
  provider: {},
  media: {},
  workflows: null as unknown as Record<string, unknown>,
  acquire: vi.fn(),
  dispose: vi.fn(),
  run: vi.fn(),
  app: vi.fn(),
  recover: vi.fn(),
  stop: vi.fn(),
  serve: vi.fn(),
  serverStop: vi.fn(),
}));

vi.mock("./effect/application.ts", () => ({
  makeApplicationRuntime: () => ({ dispose: state.dispose, runPromise: state.run }),
  acquireApplication: state.acquire,
}));
vi.mock("./app.ts", () => ({ createApp: state.app }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.events.length = 0;
  state.signals.clear();
  state.config = {
    server: { hostname: "127.0.0.1", port: 8787 },
    browser: { corsOrigin: "https://app.example", origins: [] },
    registration: { enabled: false },
    database: { url: "file::memory:" },
    media: { imagesDir: "images", audioDir: "audio" },
    elevenLabs: { apiKey: Redacted.make("secret"), model: "model", voiceId: "voice" },
    auth: { baseURL: "https://api.example", secret: Redacted.make("secret"), useSecureCookies: true },
    ai: {
      selected: "openrouter",
      openRouter: { apiKey: Redacted.make("secret"), classifyModel: "classify", generateModel: "generate", imageModel: "image", classifyEffort: undefined, generateEffort: undefined },
      codex: { classifyModel: undefined, generateModel: undefined, classifyEffort: undefined, generateEffort: undefined, codexHome: "" },
    },
    runtime: { nodeEnv: "test", devtoolsEnabled: false, readyToken: Redacted.make("ready") },
    legacyEnvironment: {},
  } as AppConfigValue;
  state.stop.mockImplementation(() => Effect.sync(() => {
    state.events.push("workflows.stop");
  }));
  state.recover.mockImplementation(() => Effect.sync(() => {
    state.events.push("recoverAndStart");
  }));
  state.workflows = {
    kickText: () => Effect.void,
    stop: state.stop,
    images: {}, events: {}, audio: {}, legacy: {}, notifications: {},
    recoverAndStart: state.recover,
  };
  state.acquire.mockImplementation(async () => {
    state.events.push("application.acquire");
    return {
      config: state.config,
      database: state.database,
      auth: state.auth,
      provider: state.provider,
      media: state.media,
      workflows: state.workflows,
    };
  });
  state.dispose.mockImplementation(async () => {
    await Effect.runPromise(state.stop());
    state.events.push("provider.dispose", "core.dispose");
  });
  state.run.mockImplementation((effect) => Effect.runPromise(effect));
  state.app.mockImplementation(() => {
    state.events.push("app");
    return { fetch: () => new Response() };
  });
  state.serverStop.mockImplementation(() => { state.events.push("server.stop"); });
  state.serve.mockImplementation(() => {
    state.events.push("serve");
    return { stop: state.serverStop };
  });
  vi.stubGlobal("Bun", { serve: state.serve });
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      state.signals.set(event, listener as () => void);
    }
    return process;
  });
  vi.spyOn(console, "log").mockImplementation((line) => {
    if (line === "ready") state.events.push("ready");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("production workflow bootstrap", () => {
  it("acquires one application graph before recovery, bind, and readiness", async () => {
    await import("./main.ts");

    expect(state.events).toEqual([
      "application.acquire",
      "app",
      "recoverAndStart",
      "serve",
      "ready",
    ]);
    expect(state.acquire).toHaveBeenCalledOnce();
    expect(state.run).toHaveBeenCalledOnce();
    const app = state.app.mock.calls[0]![0];
    expect(app).toMatchObject({
      db: state.database.db,
      auth: state.auth.instance,
      registrationEnabled: false,
    });
    expect(app.runtime).toBeDefined();
    expect(app.media).toBe(state.media);
  });

  it("fences, stops HTTP, then disposes the application scope only once across signals", async () => {
    await import("./main.ts");
    state.events.length = 0;

    state.signals.get("SIGTERM")!();
    state.signals.get("SIGINT")!();
    await vi.waitFor(() => expect(state.dispose).toHaveBeenCalledOnce());

    expect(state.serverStop).toHaveBeenCalledWith(true);
    expect(state.events).toEqual([
      "server.stop",
      "workflows.stop",
      "provider.dispose",
      "core.dispose",
    ]);
  });

  it("disposes the application scope when startup fails before binding", async () => {
    const primary = new Error("app failed");
    state.app.mockImplementationOnce(() => { throw primary; });

    await expect(import("./main.ts")).rejects.toBe(primary);

    expect(state.dispose).toHaveBeenCalledOnce();
    expect(state.serve).not.toHaveBeenCalled();
  });

  it("does not bind after shutdown begins during recovery", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    state.recover.mockImplementationOnce(() => Effect.promise(() => {
      entered.resolve();
      return release.promise;
    }));

    const boot = import("./main.ts");
    await entered.promise;
    state.signals.get("SIGTERM")!();
    await vi.waitFor(() => expect(state.dispose).toHaveBeenCalledOnce());
    release.resolve();
    await boot;

    expect(state.serve).not.toHaveBeenCalled();
  });

  it("does not print an empty readiness token", async () => {
    state.config = {
      ...state.config,
      runtime: { ...state.config.runtime, readyToken: Redacted.make("") },
    };

    await import("./main.ts");

    expect(console.log).not.toHaveBeenCalled();
  });
});
