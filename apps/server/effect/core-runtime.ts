import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect";
import type { AppConfigValue } from "./config.ts";
import { AppConfig } from "./config.ts";
import type { AuthService } from "./auth.ts";
import { Auth } from "./auth.ts";
import type { DatabaseService } from "./database.ts";
import { Database } from "./database.ts";
import type { LoggingService } from "./logging.ts";
import { Logging } from "./logging.ts";
import type { CoreLayerError, CoreServices } from "./live.ts";
import { DatabaseFailure, InfrastructureFailure } from "./errors.ts";

export type CoreServicesValue = Readonly<{
  config: AppConfigValue;
  logging: LoggingService;
  database: DatabaseService;
  auth: AuthService;
}>;

function causeToError(cause: Cause.Cause<unknown>): Error {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure instanceof InfrastructureFailure) {
    return failure.cause instanceof Error
      ? failure.cause
      : new Error(failure.message);
  }
  if (failure instanceof DatabaseFailure) {
    return failure.cause instanceof Error
      ? failure.cause
      : new Error("Database startup failed during database acquisition");
  }
  const defect = Option.getOrUndefined(Cause.dieOption(cause));
  return defect instanceof Error ? defect : new Error(Cause.pretty(cause));
}

const acquisition = Effect.gen(function* () {
  return {
    config: yield* AppConfig,
    logging: yield* Logging,
    database: yield* Database,
    auth: yield* Auth,
  } satisfies CoreServicesValue;
});

export async function acquireCoreServices(
  runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>,
): Promise<CoreServicesValue> {
  const exit = await runtime.runPromiseExit(acquisition);
  if (Exit.isSuccess(exit)) return exit.value;

  const primary = causeToError(exit.cause);
  const cleanup = await Effect.runPromiseExit(runtime.disposeEffect);
  if (Exit.isSuccess(cleanup)) throw primary;
  throw new AggregateError(
    [primary, causeToError(cleanup.cause)],
    "Core startup failed",
  );
}

export async function disposeCoreRuntime(
  runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>,
): Promise<void> {
  const exit = await Effect.runPromiseExit(runtime.disposeEffect);
  if (Exit.isFailure(exit)) throw causeToError(exit.cause);
}
