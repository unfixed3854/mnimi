import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Redacted from "effect/Redacted";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  configureSync,
  getConfig,
  getLogger,
  resetSync,
  type LogLevel,
  type LogRecord,
} from "@logtape/logtape";
import { makeAppConfigLayer } from "./config.ts";
import { Logging, LoggingLive, makeSanitizingSink } from "./logging.ts";
import { makeTestRuntime } from "./testing.ts";

const records: LogRecord[] = [];
const recordSink = (record: LogRecord) => {
  records.push(record);
};

beforeEach(() => {
  records.length = 0;
  resetSync();
  configureSync({
    reset: true,
    sinks: { recording: makeSanitizingSink(recordSink) },
    loggers: [
      { category: ["mnimi"], sinks: ["recording"], lowestLevel: "trace" },
      { category: ["logtape", "meta"], sinks: ["recording"], lowestLevel: "error" },
    ],
  });
});

afterEach(() => {
  resetSync();
});

describe("sanitized LogTape logging", () => {
  it("sanitizes category, level, message, properties, and preserves metadata", () => {
    const input: LogRecord = {
      category: ["mnimi", Redacted.make("secret-category") as unknown as string],
      level: Redacted.make("secret-level") as unknown as LogLevel,
      message: ["token=", Redacted.make("secret"), { nested: [Redacted.make("inner")] }],
      rawMessage: "token={token}",
      timestamp: 123,
      properties: { authorization: Redacted.make("header"), nested: { key: Redacted.make("value") } },
    };

    makeSanitizingSink(recordSink)(input);

    expect(records[0].category).toEqual(["mnimi", "<redacted>"]);
    expect(records[0].level).toBe("<redacted>" as unknown as LogLevel);
    expect(records[0].message).toEqual(["token=", "<redacted>", { nested: ["<redacted>"] }]);
    expect(records[0].properties).toEqual({ authorization: "<redacted>", nested: { key: "<redacted>" } });
    expect(records[0].rawMessage).toBe(input.rawMessage);
    expect(records[0].timestamp).toBe(123);
  });

  it("passes primitive values through while sanitizing nested arrays and objects", () => {
    const input: LogRecord = {
      category: ["mnimi"],
      level: "info",
      message: [null, false, 42, { nested: ["plain", Redacted.make("secret")] }],
      rawMessage: "values",
      timestamp: 456,
      properties: { value: 42, nested: { value: Redacted.make("secret") } },
    };

    makeSanitizingSink(recordSink)(input);

    expect(records[0].message).toEqual([null, false, 42, { nested: ["plain", "<redacted>"] }]);
    expect(records[0].properties).toEqual({ value: 42, nested: { value: "<redacted>" } });
  });

  it("sanitizes direct, child, and context logger records through one sink", () => {
    const logger = getLogger(["mnimi"]);
    logger.info("direct", { secret: Redacted.make("direct-secret") });
    logger.getChild("child").warning("child", { secret: Redacted.make("child-secret") });
    logger.with({ secret: Redacted.make("context-secret") }).error("context");

    expect(records).toHaveLength(3);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("direct-secret");
    expect(serialized).not.toContain("child-secret");
    expect(serialized).not.toContain("context-secret");
    expect(records.every((record) => record.properties?.secret === "<redacted>")).toBe(true);
  });

  it("acquires and releases the scoped Logging service", async () => {
    const runtime = makeTestRuntime(
      LoggingLive.pipe(Layer.provide(makeAppConfigLayer({ env: { PORT: "8787" }, argv: [] }))),
    );

    const logger = await runtime.runPromise(
      Effect.gen(function* () {
        return (yield* Logging).getLogger(["mnimi"]);
      }),
    );
    expect(logger.category).toEqual(["mnimi"]);
    expect(getConfig()).not.toBeNull();

    await runtime.dispose();
    expect(getConfig()).toBeNull();
  });

  it("maps configureSync failures to InfrastructureFailure", async () => {
    const cause = new Error("configure failed");
    vi.resetModules();
    vi.doMock("@logtape/logtape", async () => {
      const actual = await vi.importActual<typeof import("@logtape/logtape")>("@logtape/logtape");
      return {
        ...actual,
        configureSync: () => {
          throw cause;
        },
      };
    });

    try {
      const config = await import("./config.ts");
      const logging = await import("./logging.ts");
      const errors = await import("./errors.ts");
      const runtime = makeTestRuntime(
        logging.LoggingLive.pipe(Layer.provide(config.makeAppConfigLayer({ env: { PORT: "8787" }, argv: [] }))),
      );
      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          return yield* logging.Logging;
        }),
      );
      await runtime.dispose();

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(errors.InfrastructureFailure);
          expect(failure.value).toMatchObject({
            operation: "logging.configure",
            message: "configure failed",
            cause,
          });
        }
      }
    } finally {
      vi.doUnmock("@logtape/logtape");
      vi.resetModules();
    }
  });

  it("dies with InfrastructureFailure when resetSync fails during runtime disposal", async () => {
    const cause = new Error("reset failed");
    vi.resetModules();
    vi.doMock("@logtape/logtape", async () => {
      const actual = await vi.importActual<typeof import("@logtape/logtape")>("@logtape/logtape");
      return {
        ...actual,
        resetSync: () => {
          throw cause;
        },
      };
    });

    try {
      const config = await import("./config.ts");
      const logging = await import("./logging.ts");
      const errors = await import("./errors.ts");
      const runtime = makeTestRuntime(
        logging.LoggingLive.pipe(Layer.provide(config.makeAppConfigLayer({ env: { PORT: "8787" }, argv: [] }))),
      );
      await runtime.runPromise(
        Effect.gen(function* () {
          return yield* logging.Logging;
        }),
      );

      const disposeExit = await Effect.runPromiseExit(runtime.disposeEffect);
      expect(Exit.isFailure(disposeExit)).toBe(true);
      if (Exit.isFailure(disposeExit)) {
        const defects = Array.from(Cause.defects(disposeExit.cause));
        const failure = defects.find((defect) => defect instanceof errors.InfrastructureFailure);
        expect(failure).toBeInstanceOf(errors.InfrastructureFailure);
        expect(failure).toMatchObject({
          operation: "logging.reset",
          message: "reset failed",
          cause,
        });
      }
    } finally {
      vi.doUnmock("@logtape/logtape");
      vi.resetModules();
    }
  });

  it("does not reset active config when the guarded shim loads", async () => {
    const before = getConfig();
    vi.resetModules();
    await import("../logging.ts");
    expect(getConfig()).toBe(before);
  });
});
