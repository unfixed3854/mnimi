import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { uuidv7 } from "uuidv7";
import type { Db } from "./db/index.ts";
import { account, session, user, verification } from "./db/schema.ts";
import { isRegistrationEnabled } from "./registration.ts";
import { browserOrigins } from "./browser-origins.ts";

/**
 * Split from the module-level singleton so tests can build an instance over an
 * in-memory database without touching the real one.
 */
export function createAuth(
  db: Db,
  options?: {
    secret?: string;
    baseURL?: string;
    trustedOrigins?: string[];
    registrationEnabled?: boolean;
    autoSignIn?: boolean;
    useSecureCookies?: boolean;
  },
) {
  const baseURL = options?.baseURL ?? process.env.BETTER_AUTH_URL ??
    "http://127.0.0.1:8788";
  return betterAuth({
    baseURL,
    secret: options?.secret ?? process.env.BETTER_AUTH_SECRET ?? "",
    // better-auth runs its own origin/CSRF check independent of the Hono CORS
    // middleware in app.ts, so every browser origin must stay explicitly
    // allowlisted. Native bearer clients have no Origin header; Better Auth
    // permits those originless requests without broadening this list.
    trustedOrigins: options?.trustedOrigins ??
      browserOrigins(),
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user, session, account, verification },
      // Left at its default. Enabling it makes the adapter open deferred
      // transactions, which on SQLite can fail SQLITE_BUSY_SNAPSHOT in a way
      // busy_timeout cannot retry.
      transaction: false,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !(options?.registrationEnabled ?? isRegistrationEnabled()),
      autoSignIn: options?.autoSignIn,
    },
    user: {
      additionalFields: {
        // No `input: false` here: that flag blocks updateUser as well as
        // sign-up, so the settings screen could never save a language.
        nativeLanguage: { type: "string", required: false, defaultValue: "en" },
        uiLanguage: { type: "string", required: false, defaultValue: "en" },
        ttsAutoplay: { type: "boolean", required: false, defaultValue: true },
        aiInstructions: { type: "string", required: false, defaultValue: "" },
      },
    },
    // Without this better-auth mints 32-char nanoid-style ids, leaving user.id
    // in a different format from every foreign key that references it.
    advanced: {
      database: { generateId: () => uuidv7() },
      useSecureCookies: options?.useSecureCookies ??
        (process.env.NODE_ENV === "production" || baseURL.startsWith("https://")),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    plugins: [bearer()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
