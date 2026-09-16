/** @jest-environment jsdom */

import { TextDecoder, TextEncoder } from "node:util";

Object.assign(globalThis, { TextDecoder, TextEncoder });
// jsdom omits Fetch response constructors that the default Node tests inherit.
Object.assign(globalThis, jest.requireActual("whatwg-fetch"));
jest.mock("@/auth/session-transport", () =>
  jest.requireActual("@/auth/session-transport.web")
);
const mockFetch = jest.fn();

it.each([
  ["signUp", true], ["signIn", true], ["signUp", false], ["signIn", false],
] as const)("%s rejects a missing cookie session (development: %s)", async (method, development) => {
  mockFetch
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response("null"));
  const auth = await import("@/auth/auth");
  const { getSession } = await import("@/auth/session-store");

  const previousDevelopment = __DEV__;
  let error: unknown;
  try {
    Object.assign(globalThis, { __DEV__: development });
    await auth[method]("ada@example.com", "password123");
  } catch (cause) {
    error = cause;
  } finally {
    Object.assign(globalThis, { __DEV__: previousDevelopment });
  }
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toMatch(/sign(?:ing)? in/i);
  expect(message).toMatch(/cookies/i);
  expect((error as { title: string }).title.includes("Account created")).toBe(method === "signUp");
  expect(message).not.toContain("same hostname");
  expect(message).not.toContain("https://api.example.com");
  const details = (error as { technicalDetails?: string }).technicalDetails;
  expect(details?.includes("same hostname") ?? false).toBe(development);
  expect(details?.includes("https://api.example.com") ?? false).toBe(development);
  expect(getSession()).toBeNull();
});

beforeEach(() => {
  jest.resetModules();
  window.localStorage.clear();
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  process.env.EXPO_PUBLIC_API_URL = "https://api.example.com";
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, operation: () => Promise<unknown>) => operation() },
  });
});

it("sends cookies instead of a readable bearer and discards legacy storage", async () => {
  window.localStorage.setItem("mnimi.bearer", "legacy-token");
  mockFetch.mockResolvedValue(new Response(null, { headers: { "set-auth-token": "must-not-persist" } }));
  const { sessionAwareFetch } = await import("@/api/session-rejection");
  await sessionAwareFetch("https://api.example.com/rpc/decks/list", {
    headers: { authorization: "Bearer stale-token" }, credentials: "omit",
  });
  const options = mockFetch.mock.calls[0][1] as RequestInit;
  expect(options.credentials).toBe("include");
  expect(new Headers(options.headers).has("authorization")).toBe(false);
  expect(window.localStorage.getItem("mnimi.bearer")).toBeNull();
  expect(JSON.stringify(window.localStorage)).not.toContain("must-not-persist");
});

it("rejects responses from before another tab changed the cookie session", async () => {
  let finish!: (response: Response) => void;
  mockFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const { sessionAwareFetch } = await import("@/api/session-rejection");
  const pending = sessionAwareFetch("https://api.example.com/rpc/decks/list");
  await Promise.resolve();
  window.localStorage.setItem("mnimi.session-version", "another-tab-change");
  finish(new Response("old-account-data"));
  await expect(pending).rejects.toThrow("Your session changed");
});

it("keeps a failed cookie sign-out signed in and retryable", async () => {
  const { signOut } = await import("@/auth/auth");
  const { getSession, setCurrentSession } = await import("@/auth/session-store");
  const session = { user: {
    id: "user-1", email: "ada@example.com", name: "Ada", nativeLanguage: "en",
    uiLanguage: "en", ttsAutoplay: true, aiInstructions: "",
  } };
  setCurrentSession(session);
  mockFetch.mockRejectedValueOnce(new Error("Network unavailable"));
  await expect(signOut()).rejects.toThrow("Network unavailable");
  expect(getSession()).toEqual(session);
  expect(window.localStorage.getItem("mnimi.session-version")).toBeNull();

  mockFetch.mockResolvedValueOnce(new Response(null));
  await signOut();
  expect(getSession()).toBeNull();
  expect(window.localStorage.getItem("mnimi.session-version")).toBeTruthy();
});
