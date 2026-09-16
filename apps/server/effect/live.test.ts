import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { makeTestRuntime } from "./testing.ts";

const mockedModules = ["./config.ts", "./logging.ts", "./database.ts", "./auth.ts"] as const;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  for (const module of mockedModules) vi.doUnmock(module);
  vi.resetModules();
});

describe("core ownership layer", () => {
  it("acquires and releases AppConfig, Logging, Database, Auth in order", async () => {
    const events: string[] = [];
    const fakeLayer = (tag: any, name: string) =>
      Layer.scoped(tag, Effect.acquireRelease(
        Effect.sync(() => { events.push(name + ".acquire"); return {}; }),
        () => Effect.sync(() => { events.push(name + ".release"); }),
      ));
    vi.doMock("./config.ts", async () => {
      const actual = await vi.importActual<typeof import("./config.ts")>("./config.ts");
      return { ...actual, makeAppConfigLayer: () => fakeLayer(actual.AppConfig, "config") };
    });
    vi.doMock("./logging.ts", async () => {
      const actual = await vi.importActual<typeof import("./logging.ts")>("./logging.ts");
      return { ...actual, LoggingLive: fakeLayer(actual.Logging, "logging") };
    });
    vi.doMock("./database.ts", async () => {
      const actual = await vi.importActual<typeof import("./database.ts")>("./database.ts");
      return { ...actual, DatabaseLive: fakeLayer(actual.Database, "database") };
    });
    vi.doMock("./auth.ts", async () => {
      const actual = await vi.importActual<typeof import("./auth.ts")>("./auth.ts");
      return { ...actual, AuthLive: fakeLayer(actual.Auth, "auth") };
    });

    const { makeAppLayer } = await import("./live.ts");
    const { AppConfig } = await import("./config.ts");
    const { Logging } = await import("./logging.ts");
    const { Database } = await import("./database.ts");
    const { Auth } = await import("./auth.ts");
    const runtime = makeTestRuntime(makeAppLayer());
    await runtime.runPromise(Effect.gen(function* () {
      yield* AppConfig;
      yield* Logging;
      yield* Database;
      yield* Auth;
    }));
    await runtime.dispose();
    expect(events).toEqual([
      "config.acquire", "logging.acquire", "database.acquire", "auth.acquire",
      "auth.release", "database.release", "logging.release", "config.release",
    ]);
  });

  it("keeps Logging available while the Database finalizer runs", async () => {
    let loggingActive = false;
    let databaseSawLogging = false;
    const scoped = (tag: any, acquire: () => unknown, release: () => void) =>
      Layer.scoped(tag, Effect.acquireRelease(
        Effect.sync(acquire),
        () => Effect.sync(release),
      ));
    vi.doMock("./config.ts", async () => {
      const actual = await vi.importActual<typeof import("./config.ts")>("./config.ts");
      return { ...actual, makeAppConfigLayer: () => scoped(actual.AppConfig, () => ({}), () => {}) };
    });
    vi.doMock("./logging.ts", async () => {
      const actual = await vi.importActual<typeof import("./logging.ts")>("./logging.ts");
      return {
        ...actual,
        LoggingLive: scoped(
          actual.Logging,
          () => { loggingActive = true; return {}; },
          () => { loggingActive = false; },
        ),
      };
    });
    vi.doMock("./database.ts", async () => {
      const actual = await vi.importActual<typeof import("./database.ts")>("./database.ts");
      return {
        ...actual,
        DatabaseLive: scoped(actual.Database, () => ({}), () => {
          databaseSawLogging = loggingActive;
        }),
      };
    });
    vi.doMock("./auth.ts", async () => {
      const actual = await vi.importActual<typeof import("./auth.ts")>("./auth.ts");
      return { ...actual, AuthLive: scoped(actual.Auth, () => ({}), () => {}) };
    });

    const { makeAppLayer } = await import("./live.ts");
    const { AppConfig } = await import("./config.ts");
    const { Logging } = await import("./logging.ts");
    const { Database } = await import("./database.ts");
    const { Auth } = await import("./auth.ts");
    const runtime = makeTestRuntime(makeAppLayer());
    await runtime.runPromise(Effect.gen(function* () {
      yield* AppConfig;
      yield* Logging;
      yield* Database;
      yield* Auth;
    }));
    await runtime.dispose();
    expect(databaseSawLogging).toBe(true);
  });
});
