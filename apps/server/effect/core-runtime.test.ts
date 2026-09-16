import { describe, expect, it, vi } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import * as Redacted from "effect/Redacted";
import { AppConfig, type AppConfigValue } from "./config.ts";
import { Auth, type AuthService } from "./auth.ts";
import { Database, type DatabaseService } from "./database.ts";
import { Logging, type LoggingService } from "./logging.ts";
import {
  DatabaseFailure,
  InfrastructureFailure,
} from "./errors.ts";
import type { CoreLayerError, CoreServices } from "./live.ts";
import {
  acquireCoreServices,
  disposeCoreRuntime,
} from "./core-runtime.ts";

const fakeLogging = { getLogger: () => ({}) } as unknown as LoggingService;
const fakeDatabase = { db: {}, client: {} } as DatabaseService;
const fakeAuth = { instance: {} } as AuthService;
const fakeConfig: AppConfigValue = {
  server: { hostname: "127.0.0.1", port: 8787 },
  browser: { corsOrigin: "", origins: [] },
  registration: { enabled: false },
  database: { url: "file::memory:" },
  media: { imagesDir: "", audioDir: "" },
  auth: { baseURL: "", secret: Redacted.make(""), useSecureCookies: false },
  ai: {
    selected: "test",
    openRouter: {
      apiKey: Redacted.make(""),
      classifyModel: "classify",
      generateModel: "generate",
      imageModel: "image",
      classifyEffort: undefined,
      generateEffort: undefined,
    },
    codex: {
      classifyModel: undefined,
      classifyEffort: undefined,
      generateModel: undefined,
      generateEffort: undefined,
      codexHome: "",
    },
  },
  elevenLabs: {
    apiKey: Redacted.make(""),
    model: "",
    voiceId: "",
  },
  runtime: {
    nodeEnv: undefined,
    devtoolsEnabled: false,
    readyToken: Redacted.make(""),
  },
  legacyEnvironment: {},
};

function runtimeFailingWith(
  failure: CoreLayerError,
): ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError> {
  const failingTag = failure.operation === "config.capture" ? AppConfig
    : failure.operation === "logging.configure" ? Logging
    : failure.operation.startsWith("database.") ? Database
    : Auth;
  const config = failingTag === AppConfig
    ? Layer.effect(AppConfig, Effect.fail(failure))
    : Layer.succeed(AppConfig, fakeConfig);
  const logging = failingTag === Logging
    ? Layer.effect(Logging, Effect.fail(failure))
    : Layer.succeed(Logging, fakeLogging);
  const database = failingTag === Database
    ? Layer.effect(Database, Effect.fail(failure))
    : Layer.succeed(Database, fakeDatabase);
  const auth = failingTag === Auth
    ? Layer.effect(Auth, Effect.fail(failure))
    : Layer.succeed(Auth, fakeAuth);
  return ManagedRuntime.make(Layer.mergeAll(config, logging, database, auth));
}

function runtimeDefectWith(
  defect: unknown,
): ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError> {
  return {
    runPromiseExit: vi.fn(async () => Exit.die(defect)),
    disposeEffect: Effect.void,
  } as unknown as ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>;
}

function runtimeWithFinalizerDefect(
  primary: CoreLayerError,
  cleanup: Error,
): {
  runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>;
  events: string[];
} {
  const events: string[] = [];
  const config = Layer.scoped(
    AppConfig,
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push("config.acquire");
        return fakeConfig;
      }),
      () => Effect.sync(() => {
        events.push("config.release");
      }),
    ),
  );
  const logging = Layer.scoped(
    Logging,
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push("logging.acquire");
        return fakeLogging;
      }),
      () => Effect.die(cleanup).pipe(Effect.ensuring(Effect.sync(() => {
        events.push("logging.release");
      }))),
    ),
  );
  const database = Layer.scoped(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push("database.acquire");
        return fakeDatabase;
      }),
      () => Effect.sync(() => {
        events.push("database.release");
      }),
    ),
  );
  const auth = Layer.effect(Auth, Effect.gen(function* () {
    events.push("auth.acquire");
    return yield* Effect.fail(primary);
  }));
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      auth,
      Layer.provideMerge(database, Layer.provideMerge(logging, config)),
    ),
  );
  return { runtime, events };
}

describe("core runtime Cause boundary", () => {
  it.each([
    [
      new InfrastructureFailure({
        operation: "config.capture",
        message: "PORT must be an integer between 1 and 65535",
        cause: new Error("PORT must be an integer between 1 and 65535"),
      }),
      "PORT must be an integer between 1 and 65535",
      true,
    ],
    [
      new InfrastructureFailure({
        operation: "auth.construct",
        message: "wrapped",
        cause: new Error("actionable"),
      }),
      "actionable",
      true,
    ],
    [
      new InfrastructureFailure({
        operation: "auth.construct",
        message: "wrapped",
        cause: "diagnostic",
      }),
      "wrapped",
      false,
    ],
    [
      new DatabaseFailure({
        operation: "database.acquire",
        cause: new Error("driver detail"),
      }),
      "driver detail",
      true,
    ],
    [
      new DatabaseFailure({
        operation: "database.acquire",
        cause: "diagnostic",
      }),
      "Database startup failed during database acquisition",
      false,
    ],
    [
      new DatabaseFailure({ operation: "database.acquire" }),
      "Database startup failed during database acquisition",
      false,
    ],
  ] as const)("converts tagged Cause values", async (failure, message, preservesIdentity) => {
    const runtime = runtimeFailingWith(failure);
    const error = await acquireCoreServices(runtime).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    if (preservesIdentity && failure.cause instanceof Error) {
      expect(error).toBe(failure.cause);
    }
  });

  it("uses Cause.pretty for an unexpected defect", async () => {
    const error = await acquireCoreServices(runtimeDefectWith(new Error("unexpected defect")))
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("unexpected defect");
  });

  it("puts cleanup defects after the primary", async () => {
    const primary = new Error("primary startup failure");
    const { runtime, events } = runtimeWithFinalizerDefect(
      new InfrastructureFailure({
        operation: "config.capture",
        message: primary.message,
        cause: primary,
      }),
      new Error("close failed"),
    );
    const error = await acquireCoreServices(runtime).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([primary, expect.any(Error)]);
    expect((error as AggregateError).message).toBe("Core startup failed");
    expect(events).toEqual([
      "config.acquire", "logging.acquire", "database.acquire", "auth.acquire",
      "database.release", "logging.release", "config.release",
    ]);
  });

  it("uses the outer disposal runner and reports reset defects", async () => {
    const runPromiseExit = vi.fn(async () => Exit.fail(new Error("acquire failed")));
    const disposeEffect = Effect.die(new Error("reset failed"));
    const runtime = {
      runPromiseExit,
      disposeEffect,
    } as unknown as ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>;
    await expect(disposeCoreRuntime(runtime)).rejects.toThrow("reset failed");
    expect(runPromiseExit).toHaveBeenCalledTimes(0);
  });

  it.each([
    new DatabaseFailure({
      operation: "database.close",
      cause: new Error("client close failed"),
    }),
    new InfrastructureFailure({
      operation: "logging.reset",
      message: "reset failed",
      cause: new Error("reset failed"),
    }),
  ])("surfaces tagged close/reset defects from the outer runner", async (defect) => {
    const runtime = {
      disposeEffect: Effect.die(defect),
    } as unknown as ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>;
    await expect(disposeCoreRuntime(runtime)).rejects.toBe(defect);
  });
});
