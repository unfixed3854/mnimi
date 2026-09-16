# Sign-in guard design

Make sign-in the gate for the whole app: an unauthenticated visitor sees only
the sign-in screen, with no tab bar and no reachable application route.

## Problem

Today the gate is scattered and leaky:

- `__root.tsx` renders the tab bar unconditionally, so a signed-out visitor sees
  and can click every tab.
- Each route wraps its own body in `<RequireSession>`, which renders a "Sign in
  to continue" stub *inside* the app shell.
- `/` has its own separate signed-out branch, duplicating that stub.
- `/login` doubles as an account screen ("Signed in as … / Sign out"), which
  Settings already provides.
- `onSignedOut()` in `__root` navigates to `/login` via an effect, racing the
  route that is already rendering.

## Approach

Guard at the router, not in components. A pathless `_authed` layout route owns
both the tab bar and a `beforeLoad` guard; every application route lives under
it. `/login` sits outside it and renders without the shell.

## 1. Auth store (`src/lib/auth.ts`)

`beforeLoad` runs outside React and cannot read a hook's state, so the session
moves to a module-level store:

- A module variable holds the current `Session | null`.
- One `supabase.auth.onAuthStateChange` subscription keeps it current, created
  before the initial `getSession()` call so an early event cannot be clobbered
  by the in-flight lookup (the race the current `useSession` comments describe).
- Exports:
  - `getSession(): Session | null` — synchronous read, for `beforeLoad`.
  - `initAuth(): Promise<void>` — resolves once the initial session lookup (or
    a preceding auth event) has settled, and once that session has been
    validated (see "Boot validation" below). Idempotent.
  - `subscribeAuth(cb: () => void): () => void` — notifies on every change.
- `useSession()` is rewritten as a thin `useSyncExternalStore` over the store
  and returns just the session. Its `loading` flag is dropped: the router awaits
  `initAuth()` before the first render, so no component ever observes an
  unresolved session.
- `signIn`, `signUp`, `signOut`, `useProfile` keep their current signatures.
- `onSignedOut` is deleted — the router guard replaces it.

## 2. Boot order (`src/main.tsx`)

```
const router = createRouter({ routeTree, context: { auth } })
await initAuth()
subscribeAuth(() => router.invalidate())
ReactDOM.createRoot(...).render(...)
```

`router.invalidate()` re-runs `beforeLoad`, so a token that dies mid-session
kicks the user to `/login` from wherever they are, no effect-based navigation.

The router context type is declared so `context.auth` is typed in `beforeLoad`.

## 3. Route tree

- `__root.tsx` — shell only: background wrapper plus `<Outlet />`. No tab bar,
  no auth effect.
- `_authed.tsx` — new pathless layout route.
  - `beforeLoad: ({ context, location }) => { if (!context.auth.getSession())
    throw redirect({ to: "/login", search: { redirect: location.href } }) }`
  - Renders `<Outlet />` plus the tab bar moved verbatim from `__root`.
- `login.tsx` — stays at the root, outside `_authed`.
  - `validateSearch` accepts an optional `redirect` string.
  - `beforeLoad` sends an already-signed-in visitor to `safeRedirect(search)`,
    so `/login` is only ever the form.
  - The "Signed in as … / Sign out" branch and the `loading` branch are removed.
  - On successful submit, `navigate({ to: safeRedirect(search) })`.
- Renamed under the layout, each dropping its `<RequireSession>` wrapper:
  `index.tsx`, `decks.index.tsx`, `decks.$deckId.tsx`, `add.tsx`,
  `review.$deckId.tsx`, `settings.tsx` → `_authed.*`. `index.tsx` also loses its
  signed-out and loading branches; inside `_authed` a session is guaranteed.
- `src/components/require-session.tsx` is deleted.

`routeTree.gen.ts` is regenerated with `deno task routes:generate`.

## 4. Boot validation

`getSession()` only reads the locally stored session; it does not prove the
token is still good. A token signed by a rotated key, or belonging to a deleted
user, looks valid locally and only fails on the first query as an unexplained
401. So `initAuth()` validates once at startup:

- After the initial session resolves, if there is a session, call
  `supabase.auth.getUser()`.
- If it returns an auth error (invalid or expired token, missing user), clear
  the stored session — `supabase.auth.signOut({ scope: "local" })` — so the app
  boots to the login screen.
- If it fails for network reasons (offline, server unreachable), keep the stored
  session. This app is a Tauri desktop client and must still open offline; a
  genuinely dead token will be rejected by PostgREST on the first request
  anyway.
- Distinguish the two by the error's status: a response with an HTTP status is
  an auth verdict, a thrown fetch failure with no status is a network problem.

This is the only place `getUser()` is called. Route guarding stays on the
synchronous `getSession()` read: `beforeLoad` cannot await a network round trip
on every navigation, and the real authorization boundary is RLS, which verifies
the JWT server-side on every query regardless of what the client believes.

## 5. Redirect safety

`redirect` arrives from the address bar and is attacker-controllable. A single helper,
`safeRedirect` in `src/lib/redirect.ts`, is used by both `login`'s `beforeLoad`
and its submit handler:

```
safeRedirect(search) =>
  typeof search.redirect === "string" &&
  search.redirect.startsWith("/") &&
  !search.redirect.startsWith("//")
    ? search.redirect
    : "/"
```

The `//` check rejects protocol-relative URLs, which would otherwise leave the
app.

## Data flow

- Signed-out visitor at any URL → `_authed.beforeLoad` → `/login?redirect=<url>`
  → submit → store updates → `navigate(safeRedirect)` → guard passes.
- Token dies mid-session → `subscribeAuth` → `router.invalidate()` → same
  redirect, current URL preserved for return.
- Signed-in visitor hits `/login` → `beforeLoad` → `safeRedirect`.

## Error handling

Sign-in and sign-up errors stay inline in the login form. A failed `signOut()`
still surfaces in Settings' alert; the store clears only on the actual
`SIGNED_OUT` event, so a failure leaves the user signed in rather than stranded.

## Testing

`deno task test` (vitest) covers `lib/` only; there is no route test harness and
this change does not justify introducing one. Add unit tests for the auth store:

- `initAuth()` resolves with the session returned by `getSession()`.
- An auth event arriving before the initial `getSession()` resolves wins over
  the later, stale result.
- `subscribeAuth` fires on change and stops firing after unsubscribe.
- `getSession()` reflects the latest event synchronously.
- Boot validation: a `getUser()` auth error clears the session; a network-shaped
  failure (no status) leaves it intact; a success leaves it intact.

Also unit-test `safeRedirect`: relative paths pass through; `//evil.com`,
`https://evil.com`, and a missing param all fall back to `/`.

## Out of scope

Password reset, OAuth providers, and any change to Supabase RLS policies. RLS
remains the actual authorization boundary; this design only fixes navigation.
