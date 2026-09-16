# Separate auth pages design

Split the single `/login` page's sign-in/sign-up toggle into two real routes,
`/login` and `/signup`, each with its own identity — while sharing the form
mechanics that must stay behaviorally identical between them.

## Problem

`src/routes/login.tsx` holds both flows behind local `mode` state
(`"signin" | "signup"`), switching copy, validators, and a text-link toggle
in place. This means:

- The two flows can never be linked to independently (no `/signup` URL to
  send a new user straight to).
- Both flows are forced to share identical layout/copy since they're
  literally the same JSX with a few strings swapped.
- There's no confirm-password step on sign-up.
- These are also the app's only unauthenticated screens and currently carry
  no brand identity (no logo/wordmark anywhere in the app).

## Approach

Extract the field-rendering, validation, and submit logic that must behave
identically into a shared internal `AuthForm` component, parameterized by
`mode: "signin" | "signup"`. `src/routes/login.tsx` and the new
`src/routes/signup.tsx` become thin route files: each owns its own headline,
description, and brand treatment, and renders `<AuthForm mode="..." />` for
the mechanics.

This was chosen over full duplication (two independent files repeating ~100
lines of field/validation/submit JSX — a maintenance hazard for the parts
most prone to inconsistency, like ARIA wiring) and over a shared-hook-only
split (still duplicates that same field markup across both files). Since the
layout direction (below) stays a single narrow column rather than a
structural fork, most of the two pages' DNA is genuinely shared, and `AuthForm`
is where that shared DNA belongs.

## 1. Routes

- `src/routes/signup.tsx` — new file, `createFileRoute("/signup")`, mirrors
  `login.tsx`'s `validateSearch` (`redirect` param) and `beforeLoad` (bounce
  an already-authenticated visitor via `safeRedirect`).
- `src/routes/login.tsx` — stays at `/login`, same `beforeLoad`/`validateSearch`
  shape.
- Both route components render:
  ```
  <Page className="...">
    <AuthBrandHeader /> {/* logo/wordmark lockup, see §3 */}
    <header>
      <Eyebrow>...</Eyebrow>
      <PageTitle>...</PageTitle>
      <PageDescription>...</PageDescription>
    </header>
    <AuthForm mode="signin" | "signup" redirect={search.redirect} />
    <FooterLink /> {/* "No account yet? <Link to="/signup">Create one</Link>" */}
  </Page>
  ```
- The footer toggle becomes a real `<Link>` between the two routes instead of
  `setMode`, and forwards the current `redirect` search param so a user
  bounced to `/login?redirect=/decks/5` who clicks through to sign up lands
  on `/signup?redirect=/decks/5` and still ends up in the right place after
  signing up.
- `routeTree.gen.ts` is regenerated (TanStack Router CLI), not hand-edited.

## 2. Shared `AuthForm` component

New file, e.g. `src/components/auth-form.tsx`. Props: `mode: "signin" |
"signup"`, `redirect: string | undefined`. Owns:

- The `useForm` instance (`email`, `password`, and — signup only —
  `confirmPassword` fields), the submit handler (`signIn`/`signUp` branch,
  `router.navigate({ href: safeRedirect(redirect) })`, error state), and the
  `useEffect` re-validation on mode (now static per mount, so this simplifies
  to a one-time validate rather than reacting to a mode change).
- Field rendering for email and password, copied verbatim from today's
  `login.tsx` (labels, ARIA wiring, error display) — unchanged behavior.
- A new `confirmPassword` field, rendered only when `mode === "signup"`:
  placed directly after the password field, validated on change against the
  live password value (`"Passwords do not match"` when they diverge), and
  wired into `canSubmit` the same way the other fields are — submission stays
  blocked until it matches. Client-side only; better-auth's `signUp` still
  takes the single password value, this field is purely UX friction reduction
  against typos.
- The submit button and destructive-error `Alert`, unchanged.

Route files do **not** import `validateEmail`/`validatePassword`/`MIN_PASSWORD`
directly anymore — those move into `AuthForm` alongside the fields they
validate.

## 3. Brand header and copy

- New small component (e.g. `src/components/auth-brand-header.tsx`): the
  flashcard-glyph icon (from `public/favicon.svg`) paired with the "mnimi"
  wordmark, in the app's existing heading font. No such icon+text lockup
  exists today; these are the app's only unauthenticated screens, so this is
  the first identity marker a new or returning user sees.
- Each route gets its own small muted "eyebrow" label above the headline
  (matching the pattern already used on `_authed.index.tsx`'s dashboard),
  plus page-specific headline and description copy — exact wording is
  polished during implementation, not locked down here.
- Layout stays the existing narrow, centered single column (`Page` with
  `max-w-sm`, vertically centered) — no split-screen. Same flat OKLCH
  amber-accent + grain-texture aesthetic as the rest of the app; no gradients
  or illustrations introduced.
- Implementation invokes the `design-taste-frontend` skill to work out the
  concrete spacing/typography/copy details within these constraints, rather
  than pinning exact values here.

## 4. Redirect safety

`src/lib/redirect.ts`'s `safeRedirect()` currently rejects `/login` as a
redirect target (case-insensitive, trailing-slash tolerant) so a caller can't
be bounced back to the sign-in form. Generalize this to also reject
`/signup`, same reasoning — landing someone back on an auth form as their
"destination" is never correct. The `_authed` guard's `beforeLoad` keeps
bouncing unauthenticated visitors to `/login` specifically (not `/signup`) —
sign-up stays an opt-in destination reached via the footer link, not the
default gate target.

## Data flow

- Signed-out visitor at a protected route → `_authed.beforeLoad` →
  `/login?redirect=<url>`.
- On `/login`, "No account yet? Create one" → `/signup?redirect=<url>` (param
  forwarded).
- Successful `signIn`/`signUp` on either page → `router.navigate({ href:
  safeRedirect(redirect) })` → guard passes.
- Already-authenticated visitor hits either `/login` or `/signup` →
  `beforeLoad` → `safeRedirect`.

## Testing

Mirrors the existing route-guard/redirect-utility test style (no
form-rendering tests exist today; this doesn't introduce that category):

- `src/routes/-routes.test.ts`: add `signup.tsx` to the route-directory
  invariant's `allowed` whitelist; add a `/signup beforeLoad guard` describe
  block mirroring the existing `/login` one (already-signed-in redirect
  behavior).
- `src/lib/redirect.test.ts`: add `/signup`, `/signup/`, `/signup?x=1`
  rejection cases and a `/signups` negative case, mirroring the existing
  `/login` cases.

## Out of scope

OAuth providers, password reset, and any change to better-auth server
config. This is a client-side routing/UI split plus one new client-only
validation field.
