import { Context, Effect, Layer } from "effect";
import * as Redacted from "effect/Redacted";
import {
  configureSync,
  getConsoleSink,
  getLogger,
  resetSync,
  type Logger,
  type LogRecord,
  type Sink,
} from "@logtape/logtape";
import { AppConfig } from "./config.ts";
import { InfrastructureFailure } from "./errors.ts";

export type LoggingService = Readonly<{
  getLogger(category: readonly string[]): Logger;
}>;

export class Logging extends Context.Tag("@mnimi/server/Logging")<
  Logging,
  LoggingService
>() {}

function sanitize(value: unknown): unknown {
  if (Redacted.isRedacted(value)) return "<redacted>";
  if (Array.isArray(value)) return value.map(sanitize);

  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, sanitize(child)]),
      );
    }
  }

  return value;
}

export function makeSanitizingSink(delegate: Sink): Sink {
  return (record) => {
    delegate({
      ...record,
      category: sanitize(record.category) as LogRecord["category"],
      level: sanitize(record.level) as LogRecord["level"],
      message: sanitize(record.message) as LogRecord["message"],
      properties: sanitize(record.properties) as LogRecord["properties"],
    });
  };
}

function failure(operation: "logging.configure" | "logging.reset", cause: unknown): InfrastructureFailure {
  return new InfrastructureFailure({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export const LoggingLive: Layer.Layer<Logging, InfrastructureFailure, AppConfig> = Layer.scoped(
  Logging,
  Effect.gen(function* () {
    yield* AppConfig;

    try {
      configureSync({
        reset: true,
        sinks: { console: makeSanitizingSink(getConsoleSink()) },
        loggers: [
          { category: ["mnimi"], sinks: ["console"], lowestLevel: "warning" },
          { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "error" },
        ],
      });
    } catch (cause) {
      return yield* Effect.fail(failure("logging.configure", cause));
    }

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        try {
          resetSync();
          return Effect.void;
        } catch (cause) {
          return Effect.die(failure("logging.reset", cause));
        }
      })
    );

    return {
      getLogger,
    } satisfies LoggingService;
  }),
);
