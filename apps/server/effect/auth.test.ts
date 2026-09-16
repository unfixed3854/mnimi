import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createTestDb } from "../db/testing.ts";
import { createApp } from "../app.ts";
import { Auth, AuthLive } from "./auth.ts";
import { makeAppConfigLayer } from "./config.ts";
import { Database, type DatabaseService } from "./database.ts";
import { InfrastructureFailure } from "./errors.ts";

const { adapterOptions, wrapAdapter } = vi.hoisted(() => ({
  adapterOptions: [] as unknown[],
  wrapAdapter: vi.fn(),
}));

vi.mock("better-auth/adapters/drizzle", async (loadOriginal) => {
  const actual = await loadOriginal<typeof import("better-auth/adapters/drizzle")>();
  return {
    ...actual,
    drizzleAdapter: (
      db: Parameters<typeof actual.drizzleAdapter>[0],
      options: Parameters<typeof actual.drizzleAdapter>[1],
    ) => {
      adapterOptions.push(options);
      wrapAdapter(db, options);
      return actual.drizzleAdapter(db, options);
    },
  };
});

beforeEach(() => {
  adapterOptions.length = 0;
  wrapAdapter.mockClear();
});

afterEach(() => {
  adapterOptions.length = 0;
  wrapAdapter.mockClear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function makeAuthRuntime(env: Record<string, string>) {
  const { db, client, close } = await createTestDb();
  const config = makeAppConfigLayer({ env, argv: [] });
  const service = {
    db,
    client,
    withWriteLock: vi.fn((_operation, work) => work),
    withWriteLockContext: vi.fn((work) => work()),
    transaction: vi.fn(),
    readSnapshot: vi.fn(),
  } satisfies DatabaseService;
  const database = Layer.succeed(Database, service);
  const runtime = ManagedRuntime.make(AuthLive.pipe(
    Layer.provide(Layer.merge(config, database)),
  ));
  return { runtime, close, database: service };
}

async function disposeAuthRuntime(
  runtime: ManagedRuntime.ManagedRuntime<Auth, InfrastructureFailure>,
  close: () => void,
) {
  try {
    await runtime.dispose();
  } finally {
    close();
  }
}

describe("Auth Layer", () => {
  it("reuses one Auth instance and observes adapter options", async () => {
    const { runtime, close, database } = await makeAuthRuntime({
      BETTER_AUTH_URL: "https://api.example.com",
      REGISTRATION_ENABLED: "true",
    });
    try {
      const first = await runtime.runPromise(Effect.gen(function* () { return yield* Auth; }));
      const second = await runtime.runPromise(Effect.gen(function* () { return yield* Auth; }));
      expect(second.instance).toBe(first.instance);
      expect(adapterOptions[0]).toMatchObject({ provider: "sqlite", transaction: false });
      expect(database.withWriteLock).not.toHaveBeenCalled();
    } finally {
      await disposeAuthRuntime(runtime, close);
    }
  });

  it("preserves UUIDv7/custom fields and keeps Auth outside the write queue", async () => {
    const { runtime, close, database } = await makeAuthRuntime({
      BETTER_AUTH_URL: "https://api.example.com",
      CORS_ORIGIN: " https://app.example, ,https://other.example ",
      REGISTRATION_ENABLED: "true",
    });
    try {
      const { instance } = await runtime.runPromise(Effect.gen(function* () { return yield* Auth; }));
      const signedUp = await instance.api.signUpEmail({
        body: { email: "ada@example.com", password: "correct-horse", name: "Ada" },
        returnHeaders: true,
      });
      expect(signedUp.response.user.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const token = signedUp.headers.get("set-auth-token");
      expect(token).toBeTruthy();
      const bearerHeaders = new Headers({ authorization: `Bearer ${token}` });
      const defaults = await instance.api.getSession({ headers: bearerHeaders });
      expect(defaults?.user).toMatchObject({ nativeLanguage: "en", uiLanguage: "en", ttsAutoplay: true });
      await instance.api.updateUser({
        body: { nativeLanguage: "pl", uiLanguage: "pl", ttsAutoplay: false },
        headers: bearerHeaders,
      });
      expect(await instance.api.getSession({ headers: bearerHeaders })).toMatchObject({
        user: { nativeLanguage: "pl", uiLanguage: "pl", ttsAutoplay: false },
      });
      const native = await instance.handler(new Request("https://api.example.com/api/auth/get-session", {
        headers: { authorization: `Bearer ${token}` },
      }));
      expect(native.status).toBe(200);
      const app = createApp({ db: database.db, auth: instance, corsOrigin: "https://app.example" });
      const browser = await app.request("https://api.example.com/api/auth/sign-in/email", {
        method: "POST",
        headers: { Origin: "https://app.example", "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@example.com", password: "correct-horse" }),
      });
      expect(browser.status).toBe(200);
      expect(browser.headers.get("set-auth-token")).toBeNull();
      expect(browser.headers.getSetCookie().join(";")).toMatch(/; HttpOnly/i);
      expect(browser.headers.getSetCookie().join(";")).toMatch(/; Secure/i);
      const rejected = await app.request("https://api.example.com/api/auth/sign-in/email", {
        method: "POST",
        headers: { Origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@example.com", password: "correct-horse" }),
      });
      expect(rejected.status).toBe(403);
      expect(database.withWriteLock).not.toHaveBeenCalled();
    } finally {
      await disposeAuthRuntime(runtime, close);
    }
  });

  it("enforces the captured registration flag", async () => {
    const { runtime, close } = await makeAuthRuntime({
      BETTER_AUTH_URL: "http://localhost:3000",
      REGISTRATION_ENABLED: "false",
    });
    try {
      const { instance } = await runtime.runPromise(Effect.gen(function* () { return yield* Auth; }));
      const response = await instance.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "blocked@example.com", password: "correct-horse", name: "Blocked" }),
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
    } finally {
      await disposeAuthRuntime(runtime, close);
    }
  });
});
