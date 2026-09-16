import * as Layer from "effect/Layer";
import { AppConfig, makeAppConfigLayer } from "./config.ts";
import { Auth, AuthLive } from "./auth.ts";
import { Database, DatabaseLive } from "./database.ts";
import { InfrastructureFailure, DatabaseFailure } from "./errors.ts";
import { Logging, LoggingLive } from "./logging.ts";

export type CoreServices = AppConfig | Logging | Database | Auth;
export type CoreLayerError = InfrastructureFailure | DatabaseFailure;

export function makeAppLayer(input?: {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
}): Layer.Layer<CoreServices, CoreLayerError, never> {
  const config = makeAppConfigLayer(input);
  const configAndLogging = Layer.provideMerge(LoggingLive, config);
  const configLoggingDatabase = Layer.provideMerge(DatabaseLive, configAndLogging);
  const core: Layer.Layer<CoreServices, CoreLayerError, never> = Layer.provideMerge(
    AuthLive,
    configLoggingDatabase,
  );
  return core;
}
