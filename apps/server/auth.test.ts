import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./db/testing.ts";
import { createAuth } from "./auth.ts";

let close: Awaited<ReturnType<typeof createTestDb>>["close"];
let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let auth: ReturnType<typeof createAuth>;

beforeEach(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  db = testDb.db;
  auth = createAuth(testDb.db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    registrationEnabled: true,
  });
});

afterEach(() => {
  close();
});

async function signUp(email = "ada@example.com") {
  return auth.api.signUpEmail({
    body: { email, password: "correct-horse", name: "ada" },
    returnHeaders: true,
  });
}

describe("auth", () => {
  it("uses port 8788 when BETTER_AUTH_URL is unset", () => {
    const configuredBaseURL = process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_URL;

    try {
      const defaultAuth = createAuth(db, {
        secret: "test-secret-at-least-32-characters-long",
      });

      expect(defaultAuth.options.baseURL).toBe("http://127.0.0.1:8788");
    } finally {
      if (configuredBaseURL === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = configuredBaseURL;
    }
  });

  it("mints uuidv7 user ids", async () => {
    const { response } = await signUp();
    expect(response.user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("defaults nativeLanguage to en and exposes it on the session user", async () => {
    const { headers } = await signUp();
    const token = headers.get("set-auth-token");
    expect(token).toBeTruthy();

    const result = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(result?.user.nativeLanguage).toBe("en");
  });

  it("defaults ttsAutoplay to true and exposes it on the session user", async () => {
    const { headers } = await signUp();
    const token = headers.get("set-auth-token");
    expect(token).toBeTruthy();

    const result = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(result?.user.ttsAutoplay).toBe(true);
  });

  it("defaults AI instructions to empty and exposes them on the session user", async () => {
    const { headers } = await signUp();
    const token = headers.get("set-auth-token");
    expect(token).toBeTruthy();

    const result = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(result?.user.aiInstructions).toBe("");
  });

  it("returns null rather than throwing when there is no session", async () => {
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    expect(
      await auth.api.getSession({
        headers: new Headers({ authorization: "Bearer garbage" }),
      }),
    ).toBeNull();
  });

  it("lets a signed-in user change their native language", async () => {
    const { headers } = await signUp();
    const authHeaders = new Headers({
      authorization: `Bearer ${headers.get("set-auth-token")}`,
    });

    await auth.api.updateUser({
      body: { nativeLanguage: "pl" },
      headers: authHeaders,
    });

    const result = await auth.api.getSession({ headers: authHeaders });
    expect(result?.user.nativeLanguage).toBe("pl");
  });

  it("lets a signed-in user change their tts autoplay preference", async () => {
    const { headers } = await signUp();
    const authHeaders = new Headers({
      authorization: `Bearer ${headers.get("set-auth-token")}`,
    });

    await auth.api.updateUser({
      body: { ttsAutoplay: false },
      headers: authHeaders,
    });

    const result = await auth.api.getSession({ headers: authHeaders });
    expect(result?.user.ttsAutoplay).toBe(false);
  });

  it("lets a signed-in user save AI instructions", async () => {
    const { headers } = await signUp();
    const authHeaders = new Headers({
      authorization: `Bearer ${headers.get("set-auth-token")}`,
    });

    await auth.api.updateUser({
      body: { aiInstructions: "Include a useful example sentence." },
      headers: authHeaders,
    });

    const result = await auth.api.getSession({ headers: authHeaders });
    expect(result?.user.aiInstructions).toBe(
      "Include a useful example sentence.",
    );
  });

  it("emits the bearer token on the set-auth-token header at sign-in", async () => {
    await signUp();
    const { headers } = await auth.api.signInEmail({
      body: { email: "ada@example.com", password: "correct-horse" },
      returnHeaders: true,
    });
    expect(headers.get("set-auth-token")).toBeTruthy();
    // The plugin must also expose it, or a browser client cannot read it.
    expect(headers.get("access-control-expose-headers")).toContain(
      "set-auth-token",
    );
  });

  it("returns a bearer session when a native request has no Origin header", async () => {
    const { headers } = await signUp();
    const token = headers.get("set-auth-token");
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(200);
  });

  it("rejects public email signup when registration is disabled", async () => {
    const testDb = await createTestDb();
    const closedAuth = createAuth(testDb.db, {
      secret: "test-secret-at-least-32-characters-long",
      baseURL: "http://localhost:3000",
      registrationEnabled: false,
    });

    try {
      const response = await closedAuth.handler(
        new Request("http://localhost:3000/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "blocked@example.com",
            password: "correct-horse",
            name: "blocked",
          }),
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
      });
    } finally {
      testDb.close();
    }
  });
});
