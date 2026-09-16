# Sign-in Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sign-in the gate for the whole app — a signed-out visitor sees only the sign-in screen, with no tab bar and no reachable application route.

**Architecture:** The session moves out of a React hook into a module-level store in `src/lib/auth.ts` that can be read synchronously from outside React. That store is handed to the router as context. A new pathless `_authed` layout route owns both the tab bar and a `beforeLoad` guard that redirects to `/login` when there is no session; every application route moves under it. `/login` lives outside the layout and renders bare.

**Tech Stack:** React 19, TanStack Router (file-based routes, `@tanstack/router-plugin` codegen), TanStack Query, supabase-js v2, Vitest + jsdom, Tauri v2.

## Global Constraints

- Use `deno` for all package management and script execution. Never `npm`, `npx`, `yarn`, or `pnpm`. Tests run with `deno task test`; route codegen is `deno task routes:generate`.
- `src/routeTree.gen.ts` is generated and not committed. Regenerate it after any change to files under `src/routes/`.
- Route guarding reads the session **synchronously** via `getSession()`. `supabase.auth.getUser()` is called in exactly one place: the boot validation inside `initAuth()`.
- RLS remains the real authorization boundary. This change fixes navigation only; do not touch Supabase policies.
- The `redirect` search param is attacker-controllable. It must pass through `safeRedirect()` before any navigation.
- Existing explanatory comments in touched files describe real bugs. Preserve them unless the code they describe is being deleted.
- Follow the existing code style: double quotes, semicolons, `@/` import alias, named exports.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/redirect.ts` (new) | `safeRedirect()` — sanitises the untrusted `redirect` search param. |
| `src/lib/redirect.test.ts` (new) | Unit tests for `safeRedirect()`. |
| `src/lib/auth.ts` (rewrite) | Module-level session store: `getSession`, `initAuth`, `subscribeAuth`, `useSession`, plus the existing `signIn`/`signUp`/`signOut`/`useProfile`. Owns boot validation. Exports the `AuthContext` type. |
| `src/lib/auth.test.ts` (new) | Unit tests for the store and boot validation. |
| `src/main.tsx` (modify) | Boot order: create router with auth context, `await initAuth()`, subscribe → `router.invalidate()`, then render. |
| `src/routes/__root.tsx` (modify) | Shell only — background wrapper + `<Outlet />`. Typed root route with auth context. |
| `src/routes/_authed.tsx` (new) | Pathless layout: `beforeLoad` guard + the tab bar. |
| `src/routes/login.tsx` (rewrite) | Sign-in / sign-up form only. Validates `redirect` search param, bounces already-signed-in visitors. |
| `src/routes/_authed.*.tsx` (renames) | The six application routes, each with its `RequireSession` wrapper removed. |
| `src/components/require-session.tsx` | Deleted. |

---

### Task 1: `safeRedirect` helper

**Files:**
- Create: `src/lib/redirect.ts`
- Test: `src/lib/redirect.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `safeRedirect(value: string | undefined): string` — returns `value` when it is an app-internal absolute path, otherwise `"/"`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/redirect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { safeRedirect } from "@/lib/redirect";

describe("safeRedirect", () => {
  it("passes through an internal absolute path", () => {
    expect(safeRedirect("/decks/abc")).toBe("/decks/abc");
  });

  it("keeps the query string and hash", () => {
    expect(safeRedirect("/decks?sort=name#top")).toBe("/decks?sort=name#top");
  });

  it("falls back to / when the param is missing", () => {
    expect(safeRedirect(undefined)).toBe("/");
  });

  it("rejects an absolute URL", () => {
    expect(safeRedirect("https://evil.example/steal")).toBe("/");
  });

  it("rejects a protocol-relative URL", () => {
    expect(safeRedirect("//evil.example/steal")).toBe("/");
  });

  it("rejects a relative path that could escape", () => {
    expect(safeRedirect("../../evil")).toBe("/");
  });

  it("rejects an empty string", () => {
    expect(safeRedirect("")).toBe("/");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test src/lib/redirect.test.ts`
Expected: FAIL — cannot resolve `@/lib/redirect`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/redirect.ts`:

```ts
/**
 * The `redirect` search param comes off the address bar, so it is
 * attacker-controllable: a link to
 * `/login?redirect=https://evil.example` would otherwise walk the user
 * out of the app right after they hand over their password. Only an
 * app-internal absolute path is allowed through. The `//` check matters
 * on its own — `//evil.example` is a protocol-relative URL that starts
 * with `/` but leaves the origin.
 */
export function safeRedirect(value: string | undefined): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  return value;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test src/lib/redirect.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/redirect.ts src/lib/redirect.test.ts
git commit -m "feat: add safeRedirect helper for the login redirect param"
```

---

### Task 2: Auth session store

Replaces the per-component `useSession` state with a module-level store that `beforeLoad` can read synchronously, and validates the stored session once at boot.

**Files:**
- Rewrite: `src/lib/auth.ts`
- Test: `src/lib/auth.test.ts`
- Modify: `src/routes/index.tsx`, `src/routes/login.tsx` (adapt to the new `useSession` return type so the app still compiles)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `getSession(): Session | null`
  - `initAuth(): Promise<void>` — idempotent
  - `subscribeAuth(onChange: () => void): () => void`
  - `useSession(): Session | null` — **note the changed shape**, it used to return `{ session, loading }`
  - `type AuthContext = { getSession: () => Session | null }`
  - `signIn`, `signUp`, `signOut`, `useProfile` — unchanged signatures
  - `onSignedOut` is still exported at the end of this task; Task 3 deletes it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth.test.ts`. The store is a module-level singleton, so every test re-imports it through `vi.resetModules()` to get a fresh one.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "@supabase/supabase-js";

const authMock = {
  getSession: vi.fn(),
  getUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  signOut: vi.fn(),
};

vi.mock("@/lib/supabase", () => ({ supabase: { auth: authMock } }));

const SESSION = { user: { id: "u1", email: "a@b.c" } } as unknown as Session;

/** Fresh module instance per test — the store is module-level state. */
async function loadAuth() {
  vi.resetModules();
  return await import("@/lib/auth");
}

/** A promise plus the handle to settle it later. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  authMock.getSession.mockResolvedValue({ data: { session: null } });
  authMock.getUser.mockResolvedValue({ data: { user: null }, error: null });
  authMock.signOut.mockResolvedValue({ error: null });
});

describe("initAuth", () => {
  it("adopts the session returned by getSession", async () => {
    authMock.getSession.mockResolvedValue({ data: { session: SESSION } });
    const auth = await loadAuth();

    await auth.initAuth();

    expect(auth.getSession()).toBe(SESSION);
  });

  it("only runs once even when called repeatedly", async () => {
    const auth = await loadAuth();

    await Promise.all([auth.initAuth(), auth.initAuth()]);
    await auth.initAuth();

    expect(authMock.getSession).toHaveBeenCalledTimes(1);
  });

  it("lets an auth event win over a getSession result that lands later", async () => {
    // A dead refresh token fires SIGNED_OUT while the initial getSession()
    // call is still in flight. That call resolves from the pre-expiry
    // cached session, so honouring it would put the app back into a
    // live-looking signed-in state.
    const pending = deferred<{ data: { session: Session | null } }>();
    authMock.getSession.mockReturnValue(pending.promise);
    const auth = await loadAuth();

    const init = auth.initAuth();
    const handler = authMock.onAuthStateChange.mock.calls[0][0];
    handler("SIGNED_OUT", null);
    pending.resolve({ data: { session: SESSION } });
    await init;

    expect(auth.getSession()).toBeNull();
  });

  it("tracks later auth events", async () => {
    const auth = await loadAuth();
    await auth.initAuth();

    const handler = authMock.onAuthStateChange.mock.calls[0][0];
    handler("SIGNED_IN", SESSION);

    expect(auth.getSession()).toBe(SESSION);
  });
});

describe("subscribeAuth", () => {
  it("notifies subscribers on change and stops after unsubscribe", async () => {
    const auth = await loadAuth();
    await auth.initAuth();
    const onChange = vi.fn();
    const unsubscribe = auth.subscribeAuth(onChange);
    const handler = authMock.onAuthStateChange.mock.calls[0][0];

    handler("SIGNED_IN", SESSION);
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    handler("SIGNED_OUT", null);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("boot validation", () => {
  it("clears the session when getUser reports an auth error", async () => {
    authMock.getSession.mockResolvedValue({ data: { session: SESSION } });
    authMock.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid claim", status: 401 },
    });
    const auth = await loadAuth();

    await auth.initAuth();

    expect(auth.getSession()).toBeNull();
    expect(authMock.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("keeps the session when getUser fails without a status", async () => {
    // Offline. This is a desktop app; it must still open.
    authMock.getSession.mockResolvedValue({ data: { session: SESSION } });
    authMock.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Failed to fetch" },
    });
    const auth = await loadAuth();

    await auth.initAuth();

    expect(auth.getSession()).toBe(SESSION);
    expect(authMock.signOut).not.toHaveBeenCalled();
  });

  it("keeps the session when getUser throws", async () => {
    authMock.getSession.mockResolvedValue({ data: { session: SESSION } });
    authMock.getUser.mockRejectedValue(new TypeError("Failed to fetch"));
    const auth = await loadAuth();

    await auth.initAuth();

    expect(auth.getSession()).toBe(SESSION);
  });

  it("keeps the session when getUser succeeds", async () => {
    authMock.getSession.mockResolvedValue({ data: { session: SESSION } });
    const auth = await loadAuth();

    await auth.initAuth();

    expect(auth.getSession()).toBe(SESSION);
    expect(authMock.getUser).toHaveBeenCalledTimes(1);
  });

  it("skips getUser entirely when there is no stored session", async () => {
    const auth = await loadAuth();

    await auth.initAuth();

    expect(authMock.getUser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test src/lib/auth.test.ts`
Expected: FAIL — `initAuth`/`getSession`/`subscribeAuth` are not exported.

- [ ] **Step 3: Rewrite `src/lib/auth.ts`**

Replace the whole file with:

```ts
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

/** What the router receives as context so `beforeLoad` can guard routes. */
export type AuthContext = { getSession: () => Session | null };

let currentSession: Session | null = null;
let initPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setSession(next: Session | null) {
  if (next === currentSession) return;
  currentSession = next;
  for (const listener of listeners) listener();
}

/**
 * Synchronous read of the current session. This is what route guards use:
 * `beforeLoad` runs outside React and cannot await a network round trip on
 * every navigation. It reflects local state only — the server re-verifies
 * the JWT on every request, and RLS is the real authorization boundary.
 */
export function getSession(): Session | null {
  return currentSession;
}

export function subscribeAuth(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Resolves once the session is known and validated. The router awaits this
 * before the first render, which is why nothing in the app needs a
 * "loading" state for auth any more.
 */
export function initAuth(): Promise<void> {
  initPromise ??= resolveInitialSession();
  return initPromise;
}

async function resolveInitialSession(): Promise<void> {
  // Set once any onAuthStateChange event has been observed, so the initial
  // getSession() resolution below can no longer clobber it.
  let sawAuthEvent = false;

  // Subscribe FIRST: if a SIGNED_OUT (or any other) event arrives before
  // the in-flight getSession() call below resolves, we must not let that
  // stale getSession() result overwrite what the event just set. Without
  // this ordering + guard, a dead refresh token could fire SIGNED_OUT and
  // then the original getSession() promise — resolved from the pre-expiry
  // cached session — would land afterward and set the session back to a
  // live-looking value.
  supabase.auth.onAuthStateChange((_event, next) => {
    sawAuthEvent = true;
    setSession(next);
  });

  const { data } = await supabase.auth.getSession();
  if (!sawAuthEvent) setSession(data.session);

  await validateStoredSession();
}

/**
 * getSession() only reads local storage; it does not prove the token is
 * still good. A token signed by a rotated key, or belonging to a deleted
 * user, looks fine locally and only fails on the first query as an
 * unexplained 401. One getUser() call at boot turns that into a clean
 * "not signed in".
 *
 * Fails open on network trouble: this is a Tauri desktop app and must
 * still open offline. A genuinely dead token gets rejected by PostgREST on
 * the first request anyway.
 */
async function validateStoredSession(): Promise<void> {
  if (!currentSession) return;

  try {
    const { error } = await supabase.auth.getUser();
    if (!error) return;
    // An HTTP status means the auth server answered and rejected us. An
    // error without one is a fetch failure — offline, DNS, server down.
    if (typeof error.status !== "number") return;
    await supabase.auth.signOut({ scope: "local" });
    setSession(null);
  } catch {
    // Thrown fetch failure. Same call as above: keep what we have.
  }
}

export function useSession(): Session | null {
  return useSyncExternalStore(subscribeAuth, getSession, getSession);
}

export function useProfile() {
  const session = useSession();

  return useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!session,
  });
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email: string, password: string) {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("signOut failed:", error);
    throw error;
  }
}

/**
 * supabase-js refreshes access tokens on its own. When the refresh token is
 * also dead it emits SIGNED_OUT, and the app must stop pretending it has a
 * session — otherwise queries fail with an unexplained 401.
 */
export function onSignedOut(handler: () => void) {
  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") handler();
  });
  return () => data.subscription.unsubscribe();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test src/lib/auth.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Fix the two `useSession()` call sites so the app still compiles**

`useSession()` no longer returns `{ session, loading }`. Both call sites are temporary — Tasks 4 and 5 delete these branches outright — so make the smallest change that type-checks.

In `src/routes/index.tsx`, replace:

```tsx
  const { session, loading } = useSession();
  const { data: dueCount } = useDueCount();

  if (loading) return <p className="p-4 text-muted-foreground">Loading…</p>;

  if (!session) {
```

with:

```tsx
  const session = useSession();
  const { data: dueCount } = useDueCount();

  if (!session) {
```

In `src/routes/login.tsx`, replace:

```tsx
  const { session, loading } = useSession();
```

with:

```tsx
  const session = useSession();
```

and delete the now-dead loading branch, i.e. these lines:

```tsx
  // While the initial session lookup is in flight, session is still null —
  // rendering the sign-in form here would flash it at an already-signed-in
  // user before flipping to the "Signed in as" view a moment later.
  if (loading) {
    return <div className="p-4" />;
  }

```

- [ ] **Step 6: Verify the whole suite and the type check**

Run: `deno task test`
Expected: PASS — all suites.

Run: `deno run -A npm:typescript/tsc --noEmit`
Expected: no errors. (`src/routeTree.gen.ts` must exist; if `tsc` complains it is missing, run `deno task routes:generate` first.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth.ts src/lib/auth.test.ts src/routes/index.tsx src/routes/login.tsx
git commit -m "refactor: move the session into a module-level store"
```

---

### Task 3: Router context and boot order

Wires the store into the router so `beforeLoad` can read it, and replaces the effect-based sign-out navigation with `router.invalidate()`.

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/routes/__root.tsx`
- Modify: `src/lib/auth.ts` (delete `onSignedOut`)

**Interfaces:**
- Consumes: `getSession`, `initAuth`, `subscribeAuth`, `AuthContext` from Task 2.
- Produces: a router whose context is `{ auth: AuthContext }`, so later tasks can write `beforeLoad: ({ context }) => context.auth.getSession()`.

- [ ] **Step 1: Make the root route context-aware**

In `src/routes/__root.tsx`, replace the import block and route definition. The tab bar and the `onSignedOut` effect move out — the tab bar reappears verbatim in Task 4's `_authed.tsx`, so cut it, don't retype it.

The whole file becomes:

```tsx
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { AuthContext } from "@/lib/auth";

export const Route = createRootRouteWithContext<{ auth: AuthContext }>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Outlet />
    </div>
  );
}
```

Note the `pb-20` `<main>` wrapper is gone from here — it belongs with the tab bar and moves to `_authed.tsx` in Task 4.

- [ ] **Step 2: Wire the boot order in `src/main.tsx`**

Replace the whole file with:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getSession, initAuth, subscribeAuth } from "@/lib/auth";
import { routeTree } from "./routeTree.gen";
import "@/index.css";

const queryClient = new QueryClient();
const router = createRouter({ routeTree, context: { auth: { getSession } } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Resolve and validate the session before the first render, so route guards
// never see an unresolved session and no screen needs an auth loading state.
await initAuth();

// A token dying mid-session emits SIGNED_OUT; re-running beforeLoad is what
// kicks the user back to /login, from whatever route they were on. This
// replaces the effect-based navigation that used to live in __root.
subscribeAuth(() => {
  router.invalidate();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

Top-level `await` is fine here: this is an ES module bundled by Vite, targeting a modern browser engine.

- [ ] **Step 3: Delete `onSignedOut`**

It has no callers left. Remove this block from the end of `src/lib/auth.ts`:

```ts
/**
 * supabase-js refreshes access tokens on its own. When the refresh token is
 * also dead it emits SIGNED_OUT, and the app must stop pretending it has a
 * session — otherwise queries fail with an unexplained 401.
 */
export function onSignedOut(handler: () => void) {
  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") handler();
  });
  return () => data.subscription.unsubscribe();
}
```

- [ ] **Step 4: Verify**

Run: `deno task routes:generate && deno task test && deno run -A npm:typescript/tsc --noEmit`
Expected: tests PASS, no type errors, and no reference to `onSignedOut` remains:

```bash
grep -rn "onSignedOut" src/
```
Expected: no output.

The tab bar is intentionally gone from the app at this point — Task 4 restores it inside the guarded layout.

- [ ] **Step 5: Commit**

```bash
git add src/main.tsx src/routes/__root.tsx src/lib/auth.ts
git commit -m "refactor: give the router auth context and validate at boot"
```

---

### Task 4: Login route

Turns `/login` into a form-only screen that honours (and sanitises) a `redirect` search param.

**Files:**
- Rewrite: `src/routes/login.tsx`

**Interfaces:**
- Consumes: `safeRedirect` (Task 1); `getSession`, `useSession`, `signIn`, `signUp` (Task 2).
- Produces: a `/login` route accepting `?redirect=<path>`, which Task 5's guard links to.

- [ ] **Step 1: Rewrite `src/routes/login.tsx`**

Changes from the current file: adds `validateSearch` and `beforeLoad`; drops the "Signed in as … / Sign out" branch (Settings owns sign-out); navigates to the sanitised redirect target instead of always `/`.

```tsx
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { getSession, signIn, signUp } from "@/lib/auth";
import { safeRedirect } from "@/lib/redirect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: ({ search }) => {
    // Nothing to sign in to. Send them where they were headed — /login is
    // only ever the form.
    if (getSession()) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        if (mode === "signin") await signIn(value.email, value.password);
        else await signUp(value.email, value.password);
        // The auth event has already updated the store by now, so the
        // _authed guard will pass. `href` rather than `to` because the
        // target is an arbitrary runtime string, not a known route id.
        await router.navigate({ href: safeRedirect(search.redirect) });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sign in failed");
      }
    },
  });

  return (
    <form
      className="p-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
    >
      <h1 className="text-2xl font-bold">
        {mode === "signin" ? "Sign in" : "Create an account"}
      </h1>

      <form.Field name="email">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>Email</Label>
            <Input
              id={field.name}
              name={field.name}
              type="email"
              placeholder="you@example.com"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="password">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>Password</Label>
            <Input
              id={field.name}
              name={field.name}
              type="password"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </div>
        )}
      </form.Field>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" size="lg" className="w-full">
        {mode === "signin" ? "Sign in" : "Sign up"}
      </Button>

      <Button
        type="button"
        variant="ghost"
        className="w-full text-muted-foreground"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
      >
        {mode === "signin" ? "Need an account?" : "Already have an account?"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Verify**

Run: `deno task routes:generate && deno task test && deno run -A npm:typescript/tsc --noEmit`
Expected: tests PASS, no type errors.

Sign-up note: if the Supabase project has email confirmation on, `signUp` returns without a session and `beforeLoad` will bounce the user straight back to the form. That behaviour is unchanged from today and out of scope here.

- [ ] **Step 3: Commit**

```bash
git add src/routes/login.tsx
git commit -m "feat: make /login a form-only route with a redirect param"
```

---

### Task 5: Guarded `_authed` layout

The actual gate: a pathless layout that redirects signed-out visitors and owns the tab bar. All six application routes move under it.

**Files:**
- Create: `src/routes/_authed.tsx`
- Rename + modify: `src/routes/index.tsx` → `src/routes/_authed.index.tsx`
- Rename + modify: `src/routes/decks.index.tsx` → `src/routes/_authed.decks.index.tsx`
- Rename + modify: `src/routes/decks.$deckId.tsx` → `src/routes/_authed.decks.$deckId.tsx`
- Rename + modify: `src/routes/add.tsx` → `src/routes/_authed.add.tsx`
- Rename + modify: `src/routes/review.$deckId.tsx` → `src/routes/_authed.review.$deckId.tsx`
- Rename: `src/routes/settings.tsx` → `src/routes/_authed.settings.tsx`
- Delete: `src/components/require-session.tsx`

**Interfaces:**
- Consumes: the router's `{ auth: AuthContext }` context (Task 3); the `/login` route's `redirect` search param (Task 4).
- Produces: nothing later tasks depend on — this is the last task.

- [ ] **Step 1: Create the layout route**

Create `src/routes/_authed.tsx`. The tab bar is the block cut from `__root.tsx` in Task 3, including its `activeOptions` comment.

```tsx
import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { CalendarCheck, Layers, Plus, User } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context, location }) => {
    // The session is resolved before the first render and this subtree
    // covers every application route, so a signed-out visitor never reaches
    // one — whatever URL they typed. router.invalidate() re-runs this on
    // SIGNED_OUT, which is what evicts a user whose token dies mid-session.
    if (!context.auth.getSession()) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: AuthedLayout,
});

const NAV_ITEMS = [
  { to: "/", label: "Today", icon: CalendarCheck },
  { to: "/decks", label: "Decks", icon: Layers },
  { to: "/add", label: "Add", icon: Plus },
  { to: "/settings", label: "Account", icon: User },
] as const;

function AuthedLayout() {
  return (
    <>
      <main className="pb-20">
        <Outlet />
      </main>
      <nav className="fixed bottom-0 inset-x-0 flex border-t border-border bg-background p-1">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <Button
            key={to}
            // activeOptions keeps the home tab from staying lit on every
            // child route.
            render={
              <Link
                to={to}
                activeOptions={{ exact: to === "/" }}
                activeProps={{ className: "text-foreground" }}
              />
            }
            variant="ghost"
            size="lg"
            className="h-14 flex-1 flex-col gap-1 text-xs font-normal text-muted-foreground"
          >
            <Icon />
            {label}
          </Button>
        ))}
      </nav>
    </>
  );
}
```

- [ ] **Step 2: Move the routes**

```bash
git mv src/routes/index.tsx src/routes/_authed.index.tsx
git mv src/routes/decks.index.tsx src/routes/_authed.decks.index.tsx
git mv 'src/routes/decks.$deckId.tsx' 'src/routes/_authed.decks.$deckId.tsx'
git mv src/routes/add.tsx src/routes/_authed.add.tsx
git mv 'src/routes/review.$deckId.tsx' 'src/routes/_authed.review.$deckId.tsx'
git mv src/routes/settings.tsx src/routes/_authed.settings.tsx
```

- [ ] **Step 3: Update each moved route's id and drop its `RequireSession` wrapper**

`_authed` is pathless, so URLs are unchanged and every `<Link to="/decks">` in the app keeps working. Only the `createFileRoute` id gains the segment.

In `src/routes/_authed.settings.tsx` — id only:

```tsx
export const Route = createFileRoute("/_authed/settings")({ component: SettingsPage });
```

In `src/routes/_authed.index.tsx`, replace the route definition and the signed-out branch. Delete the `useSession` import and the `Button`/`Link` sign-in block; inside `_authed` a session is guaranteed. The route definition becomes:

```tsx
export const Route = createFileRoute("/_authed/")({ component: TodayPage });
```

and `TodayPage` becomes:

```tsx
function TodayPage() {
  const { data: dueCount } = useDueCount();

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-bold">Today</h1>
      <p className="text-5xl font-bold">{dueCount ?? 0}</p>
      <p className="text-muted-foreground">cards due</p>
      <Button
        render={<Link to="/decks" />}
        variant="link"
        size="sm"
        className="px-0"
      >
        Choose a deck to review
      </Button>
    </div>
  );
}
```

Its import line `import { useSession } from "@/lib/auth";` is now unused — delete it. `Link` and `Button` are still used by the remaining "Choose a deck to review" button, so keep those imports.

In `src/routes/_authed.decks.index.tsx`:

```tsx
export const Route = createFileRoute("/_authed/decks/")({ component: DecksPage });
```

In `src/routes/_authed.decks.$deckId.tsx`:

```tsx
export const Route = createFileRoute("/_authed/decks/$deckId")({ component: DeckPage });
```

In `src/routes/_authed.add.tsx`:

```tsx
export const Route = createFileRoute("/_authed/add")({ component: AddPage });
```

In `src/routes/_authed.review.$deckId.tsx`:

```tsx
export const Route = createFileRoute("/_authed/review/$deckId")({ component: ReviewPage });
```

In each of those four files, also delete the import line:

```tsx
import { RequireSession } from "@/components/require-session";
```

- [ ] **Step 4: Delete the component the wrappers used**

```bash
git rm src/components/require-session.tsx
```

- [ ] **Step 5: Verify there are no stragglers**

```bash
grep -rn "RequireSession" src/
```
Expected: no output.

Run: `deno task routes:generate && deno task test && deno run -A npm:typescript/tsc --noEmit`
Expected: tests PASS, no type errors.

- [ ] **Step 6: Verify the behaviour in the running app**

Run: `deno task dev`, open http://localhost:1420, and confirm:

1. Signed out, visiting `/` → lands on `/login?redirect=%2F`, no tab bar visible.
2. Signed out, visiting `/decks` directly → `/login?redirect=%2Fdecks`, no tab bar.
3. Signing in from case 2 → lands on `/decks`, tab bar present.
4. Visiting `/login` while signed in → bounced to `/`.
5. Settings → Sign out → immediately back at `/login`, no tab bar.
6. Manually visiting `/login?redirect=https://example.com`, then signing in → lands on `/`, not example.com.

- [ ] **Step 7: Commit**

```bash
git add -A src/routes src/components
git commit -m "feat: gate every app route behind an _authed layout"
```

---

## Done

Run the full check once more from a clean tree:

```bash
deno task routes:generate && deno task test && deno run -A npm:typescript/tsc --noEmit
```

Then use `superpowers:finishing-a-development-branch` to decide how `feat/sign-in-guard` gets integrated.
