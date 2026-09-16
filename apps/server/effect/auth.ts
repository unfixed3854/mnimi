import { Context, Effect, Layer } from "effect";
import * as Redacted from "effect/Redacted";
import type { Auth as LegacyAuth } from "../auth.ts";
import { createAuth } from "../auth.ts";
import { AppConfig } from "./config.ts";
import { Database } from "./database.ts";
import { InfrastructureFailure } from "./errors.ts";

export type AuthService = Readonly<{ instance: LegacyAuth }>;
export class Auth extends Context.Tag("@mnimi/server/Auth")<Auth, AuthService>() {}

export const AuthLive: Layer.Layer<Auth, InfrastructureFailure, AppConfig | Database> = Layer.scoped(
  Auth,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const database = yield* Database;
    try {
      return {
        instance: createAuth(database.db, {
          secret: Redacted.value(config.auth.secret),
          baseURL: config.auth.baseURL,
          trustedOrigins: [...config.browser.origins],
          registrationEnabled: config.registration.enabled,
          useSecureCookies: config.auth.useSecureCookies,
        }),
      } satisfies AuthService;
    } catch (cause) {
      return yield* Effect.fail(new InfrastructureFailure({
        operation: "auth.construct",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }));
    }
  }),
);
