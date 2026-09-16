import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./db/testing.ts";
import { createAuth } from "./auth.ts";
import { createApp, serverOptions } from "./app.ts";
import type { Auth } from "./auth.ts";
import type { Db } from "./db/index.ts";
import { decks, drafts, notes } from "./db/schema.ts";
import { hasJob } from "./ai/jobs.ts";
import { Application } from "./effect/application.ts";
import { makeAppRuntime } from "./effect/runtime.ts";
import { Layer } from "effect";

vi.mock("./ai/model-calls.ts", () => ({
  openRouterCalls: { classify() { throw new Error("Unexpected OpenRouter fallback"); } },
}));
vi.mock("./ai/openrouter-image.ts", () => ({
  generateOpenRouterImageBytes() { throw new Error("Unexpected OpenRouter fallback"); },
}));

let close: Awaited<ReturnType<typeof createTestDb>>["close"];
let app: ReturnType<typeof createApp>;
let db: Db;
let auth: Auth;

beforeEach(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  db = testDb.db;
  auth = createAuth(db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    registrationEnabled: true,
  });
  app = createApp({ db, auth, corsOrigin: "http://localhost:1420" });
});

afterEach(() => {
  close();
});

async function signUp() {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "ada@example.com",
      password: "correct-horse",
      name: "ada",
    }),
  });
  return response;
}

describe("app", () => {
  it("injects the selected text and image capabilities into authenticated RPCs", async () => {
    const registration = await signUp();
    const token = registration.headers.get("set-auth-token");
    const { user } = await registration.json();
    const [deck] = await db.insert(decks).values({ userId: user.id, name: "German" }).returning();
    const [note] = await db.insert(notes).values({ userId: user.id, deckId: deck.id, sourceText: "banana", domain: "language" }).returning();
    const card = { aspect: "meaning", front: "die Banane", back: "banana", imageCue: false };
    const imagePrompts: string[] = [];
    const configured = createApp({
      db, auth,
      modelCalls: {
        classify: async () => ({ domain: "language", language: "de", partOfSpeech: "noun" }),
        async *generate() {
          const result = {
            imagePrompt: null,
            generationSummary: "Practise the meaning of Banane.",
            cards: [card],
          };
          yield JSON.stringify(result);
          return result;
        },
      },
      generateImageBytes: async (prompt) => {
        imagePrompts.push(prompt);
        throw new Error(`selected image provider: ${prompt}`);
      },
    });
    const rpc = (path: string, input: unknown) => configured.request(`/rpc/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ json: input }),
    });
    const started = await rpc("drafts/start", { deckId: deck.id, text: "die Banane" });
    expect(started.status).toBe(200);
    await vi.waitFor(async () => {
      const [draft] = await db.select().from(drafts);
      expect(draft.status).toBe("ready");
      expect(draft.cards).toEqual([card]);
      expect(hasJob(draft.id)).toBe(false);
    });
    const imageResponse = await rpc("ai/generateImage", { noteId: note.id, prompt: "banana" });
    expect(imageResponse.status).toBe(500);
    expect(imagePrompts).toEqual(["banana"]);
  });

  it("binds the API to the configured LAN host", () => {
    expect(serverOptions({ PORT: "8787", HOST: "192.168.1.20" })).toEqual({
      hostname: "192.168.1.20",
      port: 8787,
    });
  });

  it("uses port 8788 when PORT is unset", () => {
    expect(serverOptions({})).toEqual({ hostname: "0.0.0.0", port: 8788 });
  });

  it.each(["invalid", "", "8787.5", "0", "-1", "65536"])(
    "rejects invalid PORT %j",
    (port) => {
      expect(() => serverOptions({ PORT: port })).toThrow(
        "PORT must be an integer between 1 and 65535",
      );
    },
  );

  it.each(["1", "65535"])("accepts configured TCP boundary %j", (port) => {
    expect(serverOptions({ PORT: port }).port).toBe(Number(port));
  });

  it("serves the better-auth handler", async () => {
    const response = await signUp();
    expect(response.status).toBe(200);
  });

  it("accepts Expo browser cookie authentication with the default origins", async () => {
    const webAuth = createAuth(db, {
      secret: "test-secret-at-least-32-characters-long",
      baseURL: "http://localhost:3000",
      registrationEnabled: true,
    });
    const webApp = createApp({ db, auth: webAuth });
    const response = await webApp.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:8081",
      },
      body: JSON.stringify({ email: "browser@example.com", password: "correct-horse", name: "Browser" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    expect(response.headers.get("set-auth-token")).toBeNull();
    const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token=");
    const session = await webApp.request("/api/auth/get-session", {
      headers: { Origin: "http://localhost:8081", Cookie: cookie },
    });
    expect((await session.json()).user.email).toBe("browser@example.com");
  });

  it("reports public registration as disabled by default", async () => {
    const response = await app.request("/api/registration");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
  });

  it("reports public registration as enabled when configured", async () => {
    const enabledApp = createApp({
      db,
      auth,
      corsOrigin: "http://localhost:1420",
      registrationEnabled: true,
    });

    const response = await enabledApp.request("/api/registration");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
  });

  it("rejects new HTTP admissions once shutdown starts", async () => {
    const closingApp = createApp({
      db,
      auth,
      isShuttingDown: () => true,
    });

    const response = await closingApp.request("/api/registration");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Server is shutting down" });
  });

  it("provides the bearer response header for native clients", async () => {
    const response = await signUp();
    expect(response.headers.get("set-auth-token")).toBeTruthy();
    expect(
      response.headers.get("access-control-expose-headers"),
    ).toContain("set-auth-token");
  });

  it("answers an unauthenticated RPC call with 401 and CORS headers", async () => {
    const response = await app.request("/rpc/decks/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:1420",
      },
      body: JSON.stringify({ json: {} }),
    });

    expect(response.status).toBe(401);
    // Without the CORS header the browser blocks the 401 outright and the
    // client sees an indistinguishable network failure instead of "expired".
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:1420",
    );
  });

  it("answers an authenticated RPC call", async () => {
    const token = (await signUp()).headers.get("set-auth-token");

    const created = await app.request("/rpc/decks/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ json: { name: "German" } }),
    });
    expect(created.status).toBe(200);

    const listed = await app.request("/rpc/decks/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ json: {} }),
    });
    const body = await listed.json();
    expect(JSON.stringify(body)).toContain("German");
  });

  it("runs the full HTTP RPC dispatch through the supplied Effect runtime", async () => {
    const runtime = makeAppRuntime(Layer.succeed(Application, {
      database: { db },
      auth: {
        instance: {
          api: {
            getSession: async () => ({ user: { id: "effect-user" } }),
          },
        },
      },
      workflows: {},
      provider: {},
    } as never));
    const effectApp = createApp({ db, auth, runtime });
    const run = vi.spyOn(runtime, "runPromise");

    try {
      const response = await effectApp.request("/rpc/decks/list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer deliberately-not-a-better-auth-token",
        },
        body: JSON.stringify({ json: {} }),
      });

      expect(response.status).toBe(200);
      // Dispatch, authentication, and the Effect-native deck use case all
      // run on the one application runtime.
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      await runtime.dispose();
    }
  });

  it("accepts an originless native bearer session request", async () => {
    const token = (await signUp()).headers.get("set-auth-token");
    const response = await app.request("/api/auth/get-session", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(200);
  });

  it("gates debug.summary on explicit app startup enablement", async () => {
    const enabledApp = createApp({
      db,
      auth,
      corsOrigin: "http://localhost:1420",
      devtoolsEnabled: true,
    });
    const token = (await signUp()).headers.get("set-auth-token");

    const disabledResponse = await app.request("/rpc/debug/summary", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(disabledResponse.status).toBe(403);
    expect(JSON.stringify(await disabledResponse.json())).toContain(
      "Devtools are disabled",
    );

    const enabledResponse = await enabledApp.request("/rpc/debug/summary", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(enabledResponse.status).toBe(200);
    expect(JSON.stringify(await enabledResponse.json())).toContain(
      '"totalCards":0',
    );
  });

  it("rejects an out-of-bounds generate-image input with 400, not 500", async () => {
    const token = (await signUp()).headers.get("set-auth-token");

    // Input validation runs before the handler, so this never reaches a model.
    const response = await app.request("/rpc/ai/generateImage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        json: { noteId: "0195f0e0-0000-7000-8000-000000000000", prompt: "" },
      }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects HTTP signup when public registration is disabled", async () => {
    const closedAuth = createAuth(db, {
      secret: "test-secret-at-least-32-characters-long",
      baseURL: "http://localhost:3000",
      registrationEnabled: false,
    });
    const closedApp = createApp({
      db,
      auth: closedAuth,
      corsOrigin: "http://localhost:1420",
      registrationEnabled: false,
    });

    const response = await closedApp.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "blocked@example.com",
        password: "correct-horse",
        name: "blocked",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: "Email and password sign up is not enabled",
      code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    });
  });

  it.each([
    ["http://localhost:1420", "http://localhost:1420"],
    ["https://evil.example", null],
  ])(
    "preserves CORS preflight visibility for %s",
    async (origin, allowedOrigin) => {
      const response = await app.request("/rpc/decks/create", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin"))
        .toBe(allowedOrigin);
    },
  );
});
