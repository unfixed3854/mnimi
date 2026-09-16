import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./db/testing.ts";
import { createAuth } from "./auth.ts";
import { createApp } from "./app.ts";

const origin = "http://localhost:8081";
const account = { email: "cookies@example.com", password: "correct-horse", name: "Cookies" };
let database: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  database = await createTestDb();
  app = createApp({
    db: database.db,
    auth: createAuth(database.db, {
      secret: "test-secret-at-least-32-characters-long",
      baseURL: "https://api.example.com",
      trustedOrigins: [origin],
      registrationEnabled: true,
    }),
    corsOrigin: origin,
  });
});
afterEach(() => database.close());

async function signUp() {
  return app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(account),
  });
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

describe("browser cookie authentication", () => {
  it("issues a host-only HttpOnly Secure SameSite=Lax cookie without a readable bearer", async () => {
    const response = await signUp();
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((value) => value.includes("session_token="));
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).not.toMatch(/; Domain=/i);
    expect(response.headers.get("set-auth-token")).toBeNull();
    expect(response.headers.get("access-control-expose-headers") ?? "").not.toContain("set-auth-token");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.user.email).toBe(account.email);
    expect(body).not.toHaveProperty("token");
  });

  it("restores, updates, signs out and signs in using only the cookie", async () => {
    const cookie = cookieHeader(await signUp());
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
    const restored = await app.request("/api/auth/get-session", { headers });
    const session = await restored.json();
    expect(session.user.email).toBe(account.email);
    expect(session.session).not.toHaveProperty("token");
    const updated = await app.request("/api/auth/update-user", {
      method: "POST", headers, body: JSON.stringify({ nativeLanguage: "pl" }),
    });
    expect(updated.status).toBe(200);
    const decks = await app.request("/rpc/decks/create", {
      method: "POST", headers, body: JSON.stringify({ json: { name: "Cookie deck" } }),
    });
    expect(decks.status).toBe(200);
    const logout = await app.request("/api/auth/sign-out", { method: "POST", headers });
    expect(logout.status).toBe(200);
    expect(await (await app.request("/api/auth/get-session", { headers })).json()).toBeNull();
    const login = await app.request("/api/auth/sign-in/email", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(account),
    });
    expect(login.status).toBe(200);
    expect(cookieHeader(login)).toContain("session_token=");
    expect(await login.json()).not.toHaveProperty("token");
    expect(login.headers.get("set-auth-token")).toBeNull();
  });

  it("does not expose tokens on same-origin browser GETs or session lists", async () => {
    const cookie = cookieHeader(await signUp());
    for (const path of ["get-session", "list-sessions"]) {
      const response = await app.request(`/api/auth/${path}`, {
        headers: { Cookie: cookie, "Sec-Fetch-Mode": "cors" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(/"token"\s*:/);
      expect(response.headers.get("set-auth-token")).toBeNull();
    }
  });

  it.each([undefined, "https://evil.example", "null"])("rejects cookie RPC mutations with untrusted Origin %s", async (requestOrigin) => {
    const cookie = cookieHeader(await signUp());
    const response = await app.request("/rpc/decks/create", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", ...(requestOrigin ? { Origin: requestOrigin } : {}) },
      body: JSON.stringify({ json: { name: "Forged deck" } }),
    });
    expect(response.status).toBe(403);
    const listed = await app.request("/rpc/decks/list", {
      method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ json: {} }),
    });
    expect(await listed.text()).not.toContain("Forged deck");
  });
});
