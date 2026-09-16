# Replacing Supabase with SQLite, Drizzle and better-auth

Drop Supabase entirely. A single self-hosted Hono server on Deno takes over
everything it did — Postgres becomes a SQLite file behind Drizzle, GoTrue
becomes better-auth, PostgREST becomes an oRPC router, and the two Edge
Functions become routes on that same server.

## Problem

Supabase costs this project a container runtime, a CLI, a seven-port block, a
Podman workaround written down in the README so nobody rediscovers it, and a
whole class of "which stack is `.env.local` pointing at" failures. What it buys
in return is a hosted Postgres with RLS, an auth server, object storage and a
function runtime — for a single-user-per-account flashcard app whose entire data
model is five tables and whose scheduling logic already runs on the client.

The trade is no longer worth it. A SQLite file and one process replace all of it.

## Approach

**One server, in-process everything.** `server/` holds a Hono app on Deno that
owns the SQLite file directly. No network hop between the API layer and the
database means the two multi-statement writes in the app — saving a note with
its cards, and grading a card with its review log — become real transactions
instead of the best-effort cleanup dances they are today.

Alternatives considered and rejected:

- **Local-first SQLite inside the Tauri app.** Removes the server, but also
  removes multi-device sync, leaves the OpenRouter key with nowhere safe to
  live, and gives better-auth nothing to do.
- **Hybrid: on-device SQLite plus a thin auth/AI server.** Buys offline review
  at the cost of two data stores and a sync problem this project does not have
  today.
- **A hand-written REST layer.** Fewer dependencies, but every endpoint is a
  route string and a pair of hand-maintained types on either side of the wire.
  oRPC gives end-to-end inference from the Drizzle schema for the same work.
- **A thin PostgREST-shaped query layer**, so `src/lib/api/*.ts` barely changes.
  Rejected outright: a generic query language reachable from the client is
  precisely what must not exist now that RLS is gone.

**Clean cut.** No data migration. The existing local stack holds throwaway dev
data, so `supabase/` is deleted, the SQLite file starts empty, and accounts are
created fresh. This keeps the change purely a code change — no ID mapping, no
timestamp format conversion, and no password-hash rehash shim (Supabase's
bcrypt hashes are not portable into better-auth without one).

## 1. Repository layout

```
server/
  deno.json              imports: hono, better-auth, drizzle-orm, @orpc/*,
                         @libsql/client, uuidv7, zod, @tanstack/ai
  main.ts                Hono app — CORS, route mounting, Deno.serve
  auth.ts                betterAuth(): drizzleAdapter, emailAndPassword, bearer()
  db/
    schema.ts            Drizzle schema — auth tables + app tables
    index.ts             drizzle() over @libsql/client, file: URL
  router/
    index.ts             oRPC root router
    base.ts              `pub` and `authed` procedures + auth middleware
    decks.ts notes.ts cards.ts ai.ts
  ai/                    moved from supabase/functions/_shared, logic unchanged
    generate.ts rule-packs.ts schemas.ts openrouter.ts sse.ts
  routes/
    generate-note.ts     plain Hono SSE route
  drizzle.config.ts
  drizzle/               generated migration SQL
  data/                  gitignored — mnimi.db, images/
src/
  lib/orpc.ts            oRPC client, bearer header, 401 detection
  lib/auth.ts            same public API, better-auth underneath
  lib/api/*.ts           same hook names, oRPC underneath
```

`supabase/` is deleted in full. `src-tauri/`, `src/components/` and every route
component's structure are untouched.

## 2. Database schema

### Auth tables

better-auth owns `user`, `session`, `account` and `verification`, generated into
`server/db/schema.ts` by its CLI. `user` is extended through
`user.additionalFields`:

| Field | Type | Default |
|---|---|---|
| `nativeLanguage` | text, not null | `'en'` |
| `uiLanguage` | text, not null | `'en'` |

This deletes both the `profiles` table and the `handle_new_user` signup trigger:
the fields are populated by better-auth at signup and travel inside the session
the client already holds.

### Application tables

`decks`, `notes`, `cards` and `review_logs` port over one-for-one. Column names
stay snake_case; the TypeScript property names become camelCase
(`sourceText: text("source_text")`), because these types now flow through oRPC
straight into components that also read better-auth's camelCase `user` fields,
and one convention per file beats two.

Postgres → SQLite type mapping:

| Postgres | Drizzle SQLite |
|---|---|
| `uuid primary key default gen_random_uuid()` | `text().primaryKey().$defaultFn(uuidv7)` |
| `timestamptz` | `integer({ mode: "timestamp_ms" })` |
| `jsonb` | `text({ mode: "json" }).$type<NoteMetadata>()` |
| `double precision` | `real()` |
| `boolean` | `integer({ mode: "boolean" })` |
| `smallint` | `integer()` |
| `text` | `text()` |

Foreign keys keep `onDelete: "cascade"`. Both indexes carry over, including the
partial one that backs the app's hottest query:

```
cards_due_idx      on cards (user_id, due) where suspended = 0
cards_note_id_idx  on cards (note_id)
notes_deck_id_idx  on notes (deck_id)
review_logs_card_id_idx on review_logs (card_id)
```

### Ids are UUIDv7

Every primary key is a UUIDv7 in canonical text form, generated by the `uuidv7`
package (1.2.1 — zero dependencies, one export).

Postgres generated v4 ids, which are uniformly random. SQLite stores these as
TEXT in a B-tree keyed on the id, so random ids scatter every insert across the
tree and dirty a fresh set of pages each time. v7 leads with a 48-bit
millisecond timestamp, so canonical-form ids sort lexicographically in creation
order: inserts append to one end of the index instead of stippling it, and
`order by created_at` on `decks` and `notes` could later be served by the
primary key alone.

**better-auth must be pointed at the same generator**, via
`advanced.database.generateId`. Left alone it mints its own random string ids
that are not UUIDs at all, which would leave `user.id` in one format and every
foreign key referencing it in another.

`uuidv7()` is monotonic within a process — repeated calls inside the same
millisecond increment rather than collide — so a note and its cards inserted in
one transaction keep their insertion order.

One property worth stating rather than discovering: a v7 id encodes its creation
time, so anyone holding an id can read when the row was made. Here ids are only
ever visible to the user who owns the row, so this costs nothing. It would need
revisiting if an id ever appeared in a shared or public URL.

Request validation gains precision alongside it: `ai.generateImage`'s `noteId`
becomes `z.uuidv7()` instead of the version-agnostic `z.string().uuid()`.

### Timestamps become Dates end to end

`timestamp_ms` means Drizzle hands back `Date` objects, and oRPC's RPC codec
serialises `Date` natively, so a `Date` written on the server arrives as a
`Date` on the client. `src/lib/fsrs.ts` therefore stops converting in both
directions: `toFsrsCard` and `fromFsrsCard` pass `due` and `lastReview` through
unchanged rather than round-tripping them through ISO strings. Their tests
narrow accordingly — the mapping they cover is now the FSRS field names, not the
date format.

## 3. Authorization

Row Level Security was the real authorization boundary and it is gone. Its
replacement is one rule, enforced in one place:

> **No procedure ever accepts a `userId` from the client.**

A `authed` base procedure runs an oRPC middleware that reads the `Authorization`
header, resolves it through `auth.api.getSession({ headers })`, throws
`ORPCError("UNAUTHORIZED")` when there is no valid session, and puts `userId`
into procedure context. Every procedure builds on it.

- Inserts take `userId` from context, never from input. Input schemas do not
  have a `userId` field to supply.
- Selects, updates and deletes carry `eq(table.userId, ctx.userId)` in their
  where clause — including single-row-by-id lookups, so a wrong-owner id is
  indistinguishable from a missing one.
- Nested resources need no trust chain: `notes`, `cards` and `review_logs` each
  carry `user_id` directly, exactly as they do under RLS today.

An unauthenticated request gets 401, which is the same signal the client's
existing session-rejection machinery already acts on.

## 4. Endpoint surface

### oRPC procedures

| Procedure | Input | Returns |
|---|---|---|
| `decks.list` | — | `Deck[]`, oldest first |
| `decks.create` | `{ name, description? }` | `Deck` |
| `notes.listByDeck` | `{ deckId }` | `Note[]`, newest first |
| `notes.save` | `{ deckId, sourceText, classification, cards, imagePrompt, generationFailed? }` | `Note` |
| `cards.due` | `{ deckId? }` | `Card[]`, due first, limit 100 |
| `cards.dueCount` | `{ deckId? }` | `number`, uncapped |
| `cards.grade` | `{ cardId, card: FsrsColumns, log: ReviewLogInsert }` | `void` |
| `ai.generateImage` | `{ noteId, prompt }` | `{ imagePath }` |

`cards.due` and `cards.dueCount` stay separate for the reason recorded in the
current code: the queue is capped at 100 because that is a sensible session
size, and a "Today" counter built on that capped query would tell a user with
120 cards due that 100 are.

Two procedures gain transactional integrity by being in-process:

- **`notes.save`** inserts the note and all its cards in one SQLite
  transaction. This deletes the manual orphan-cleanup block in
  `src/lib/api/notes.ts`, which today deletes a committed note by hand when the
  cards insert fails.
- **`cards.grade`** updates the card and inserts the review log in one
  transaction, closing the "FSRS state saved but the log wasn't" gap the review
  screen currently apologises for in a comment.

FSRS stays client-computed. The README states this as a deliberate design
choice — the database stores scheduling state, it does not compute it — and
PostgREST under RLS already let the owner write any state they liked, so this is
parity, not a new trust assumption. The payload is zod-validated on arrival so
malformed state is a 400 rather than a corrupt row.

Language settings need no procedure: `authClient.updateUser({ nativeLanguage })`
covers it, since the field lives on `user`.

### Plain HTTP routes

- **`POST /api/generate-note`** — `text/event-stream`, **not** an oRPC event
  iterator. Keeping it a raw SSE route preserves the wire protocol the streaming
  spec documents along with `src/lib/sse.ts`, `readGenerationEvents`,
  `run-generation.ts` and every one of their tests. Behaviour is unchanged: auth
  and zod body validation run before a single byte is written, so 401 and 400
  are still real status codes, and every later failure travels as an `error`
  event.
- **`/api/auth/*`** — better-auth's handler, mounted on Hono.

### Images

`ai.generateImage` writes to `server/data/images/<userId>/<noteId>.png` and
records the relative path in `notes.image_path`, mirroring the current bucket
layout where the first path segment is the owner. The pre-generation ownership
check that exists today to stop a caller billing image generations against
random UUIDs stays, now as a scoped `select` rather than an RLS-filtered one.

There is **no read endpoint**. Nothing in the UI renders a note image today,
under Supabase or after this change, so adding one would be new functionality
rather than migration. This is recorded in `docs/OUT-OF-SCOPE.md`.

## 5. Client changes

### `src/lib/auth.ts` keeps its public API

`getSession`, `subscribeAuth`, `initAuth`, `useSession`, `signIn`, `signUp`,
`signOut` and `clearRejectedSession` all keep their signatures and semantics;
only the implementation swaps to better-auth's `createAuthClient`. Consequently
`main.tsx`, `src/routes/_authed.tsx` and `src/routes/login.tsx` are essentially
untouched, and two behaviours survive intact:

- The boot-time session validation — resolve the stored session, verify it
  against the server once, fail open on network trouble so the app still opens
  offline.
- The 401 → clear session → `router.invalidate()` → `_authed` guard evicts to
  `/login?redirect=…` path.

Session transport is better-auth's **bearer plugin**: the server returns a
token, the client stores it and sends `Authorization: Bearer …`. Cookies were
rejected because the Tauri webview origin differs from the API origin on every
platform, which forces `SameSite=None; Secure` plus credentialed CORS — and
Android's webview over plain http is where that reliably breaks.

Three mechanics this rests on, all confirmed against the real package:

- The token arrives as a `set-auth-token` response header, which the plugin
  adds to `Access-Control-Expose-Headers`. Hono's `cors()` must therefore list
  `set-auth-token` in `exposeHeaders`, or the browser hides it and sign-in
  appears to succeed while leaving the client with no token.
- There is no official bearer *client* plugin. The client side is
  `createAuthClient`'s `fetchOptions`: an `onSuccess` that captures the header,
  and `auth: { type: "Bearer", token: () => … }` that replays it.
- The session lives in a nanostores atom at `authClient.$store.atoms.session`,
  read with `.get()` and subscribed with `.listen()` — which is what backs the
  `useSyncExternalStore` store. Two traps: `$store.listen()` discards the
  unsubscribe function and leaks, so subscription goes through the atom
  directly; and the atom only starts fetching once it has its first listener,
  so `initAuth()` must subscribe rather than poll `.get()`.

**Sign-up must supply a name.** better-auth's `user.name` is `notNull`, but the
login form collects only an email and a password. `signUp` therefore derives
one from the local part of the email address. Adding a name field to the form is
a product change, not a migration, and is out of scope here.

`useProfile()` is deleted. Callers read `useSession()?.user.nativeLanguage`,
which also removes a round trip the Add screen currently waits on before it can
generate.

### Everything else

| File | Change |
|---|---|
| `src/lib/supabase.ts` | → `src/lib/orpc.ts`: `RPCLink` with a bearer header and a fetch that flags 401 |
| `src/types/database.ts` | deleted — types come from `$inferSelect` on the Drizzle schema |
| `src/lib/api/decks.ts`, `notes.ts`, `review.ts` | same hook names and signatures, oRPC calls inside |
| `src/lib/api/ai.ts` | `generateNoteStream` uses plain `fetch` with the bearer header; `generateNoteImage` becomes an oRPC call; the `FunctionsHttpError` 401 check becomes a status check |
| `src/lib/session-rejection.ts` | the `/auth/v1/` exclusion becomes `/api/auth/` |
| `src/routes/_authed.review.$deckId.tsx` | `isConnectionError` currently sniffs an empty PostgREST error code; it becomes `!(error instanceof ORPCError)` |
| `src/routes/_authed.settings.tsx` | reads and writes the language through better-auth instead of a `profiles` update |
| `src/lib/fsrs.ts` | `Date` in, `Date` out — no ISO conversion |
| snake_case → camelCase | `note.source_text` → `note.sourceText`, `card.elapsed_days` → `card.elapsedDays`, and so on across the routes and components that read rows |

## 6. Configuration and tooling

`mise.toml` drops the `supabase` tool and `DOCKER_HOST`. Node, Deno, Java 17 and
the Android SDK stay.

Client `.env.local`:

```
VITE_API_URL=http://127.0.0.1:8787
```

Server `server/.env` (gitignored):

```
DATABASE_URL=file:./data/mnimi.db
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=http://127.0.0.1:8787
CORS_ORIGIN=http://localhost:1420
OPENROUTER_API_KEY=sk-or-...
CLASSIFY_MODEL=google/gemini-2.5-flash
GENERATE_MODEL=anthropic/claude-sonnet-4.5
IMAGE_MODEL=google/gemini-2.5-flash-image
```

The OpenRouter key rule is unchanged and still load-bearing: it is read only by
the server, never prefixed `VITE_`, and never reaches the bundle.

Tasks: `server/deno.json` gets `dev`, `db:generate` and `db:migrate`. On
Android the device must reach the server, so `VITE_API_URL` points at the dev
machine's LAN address — the same adjustment `VITE_SUPABASE_URL` needs today, and
the README note about it survives with a new variable name.

`vitest.config.ts` swaps `supabase/functions/**` for `server/**` in its include
list. Server code keeps importing bare specifiers, which Deno resolves from
`server/deno.json` and Vitest resolves from `node_modules` — the arrangement
already in use today.

That arrangement holds today only because every currently tested server module
happens to import nothing beyond `zod`, which is in the root `package.json`. The
new router tests break that: they import `drizzle-orm`, `@orpc/server`,
`better-auth`, `@libsql/client` and `uuidv7`. So those packages go in the root
`package.json` as well as `server/deno.json`, with matching versions. Anything
the server imports but never tests — `hono`, `@tanstack/ai` — may stay in
`server/deno.json` alone.

`README.md` loses the Podman prerequisite, the socket setup, the port table, the
`functions serve` troubleshooting section and the Supabase 401 entry, and gains
a short "run the server" section.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| No or invalid bearer token on any request | 401 → session cleared → `/login?redirect=…` (path unchanged) |
| Malformed request body | 400 from oRPC's zod validation |
| Wrong-owner id | Treated as not found, never as forbidden — an id's existence is not leaked |
| Cards insert fails during `notes.save` | Transaction rolls back; no orphaned note to clean up |
| Review log insert fails during `cards.grade` | Transaction rolls back; the card keeps its pre-grade state and retrying re-grades cleanly |
| Model or network failure mid-generation | SSE `error` event, exactly as today |
| Malformed model output | Zod parse, one retry with the validation error fed back, then a hand-editable empty card — unchanged |
| Image generation fails | Non-fatal; a note without an image is valid — unchanged |
| Server unreachable | Fetch throws; the review screen shows its "lost connection, grading disabled" state |

## 8. Testing

**Unchanged:** `fsrs` (narrowed for `Date`), `generation-state`,
`generation-status`, `run-generation`, `sse`, `redirect`, `utils`, `-routes`,
and the ported `rule-packs`, `schemas`, `generate`, server-side `sse`.

**Rewritten:** `auth.test.ts` against a better-auth client mock;
`session-rejection.test.ts` for the new URL rules.

**New — the RLS replacement gets real coverage.** Router tests run against a
unique temp-file SQLite database per test — not an in-memory one, for the
reasons §9 records — with two seeded users:

- A request with no bearer token gets 401 from every `authed` procedure.
- Reading another user's deck, note or card by id returns not-found.
- Updating or deleting another user's row affects zero rows and reports
  not-found rather than succeeding silently.
- A `userId` smuggled into an input payload is ignored — the row lands under the
  session's user.
- `cards.due` and `cards.dueCount` scope to the session's user, and the
  `deckId` filter does not widen that scope.

Transaction behaviour gets two tests: a failing cards insert leaves no note, and
a failing review-log insert leaves the card's FSRS state untouched.

Write serialisation gets its own: a `cards.grade` issued while a `notes.save`
holds its transaction open must succeed rather than fail `SQLITE_BUSY`, plus
direct tests of `withWriteLock` — including a control that measures the
unserialised collision, so the passing test cannot be satisfied by a no-op.

There are still no device E2E tests.

## 9. Runtime constraints

The two risks originally recorded here — `drizzle-kit` under Deno, and
better-auth under Deno — were both resolved by executing the real packages on
Deno 2.9.3 before this spec was finalised. Both work. What the exercise
produced instead is a set of non-obvious requirements, each of which is a silent
failure if missed.

**`nodeModulesDir: "auto"` is mandatory in `server/deno.json`.** `drizzle-kit`'s
`bin.cjs` `require()`s `drizzle-orm` from its own CJS context and needs a
physical `node_modules` tree; without it the CLI fails with the misleading
"Please install latest version of drizzle-orm". The import map also needs a
trailing-slash entry (`"drizzle-orm/": "npm:/drizzle-orm@…/"`) for subpath
imports to resolve.

**`dialect: "sqlite"`, not `"turso"`.** Both accept a `file:` URL, but `turso`
emits libSQL-server-specific `ALTER TABLE` statements. A local file wants the
plain-SQLite table-recreation strategy.

**Each test gets its own temp-file database — no in-memory form works here.**
`@libsql/client`'s `transaction()` hands its only connection to the transaction
and nulls its own; the next query lazily opens a *new* connection. Against a
private-cache `:memory:` database that new connection is a brand-new empty
database, so the first transaction silently destroys the schema and every later
query fails "no such table" — and two procedures here are transactional by
design, so it hits immediately. The obvious fix, `file::memory:?cache=shared`,
overshoots: shared-cache databases are keyed by name, so every call would hand
back the *same* database and tests collide on unique constraints like
`user.email`. Naming them apart via `mode=memory` is not available either —
@libsql/client rejects the `mode` query parameter. A unique temp file per test,
removed on close, has none of these problems.

**The same mechanism constrains the running server.** Inside a transaction
callback only the `tx` handle may be used — the root `db` handle is a different
connection, so it cannot see uncommitted rows and its writes fail against the
held lock. The same is true across requests: a write that arrives while another
request's transaction is open runs on the driver's lazily-opened second
connection and contends with it.

`PRAGMA busy_timeout` does not cover that case, despite appearances. A pragma
is per-connection state and startup can only configure the *initial*
connection, so the connection the driver opens later has `busy_timeout = 0` and
the contended writer fails with `SQLITE_BUSY` immediately — measured at 0 ms,
not 5000. Nor is `createClient({ timeout })` the fix: it does reach the
lazily-opened connection, but the driver's busy-wait blocks the event loop, so
the transaction holding the lock can never reach its `commit()` and the waiter
burns the whole timeout before failing anyway.

What startup's pragmas actually buy is WAL — readers proceed while a write
transaction is open instead of blocking on it. Overlapping *writers* are
prevented by serialising them in-process: `withWriteLock` in
`server/db/write-lock.ts` is a promise chain that `notes.save` and
`cards.grade` route their transactions through, plus `ai.generateImage`'s
`imagePath` update — which is a single statement, but loses to an open
transaction just as fast (measured ~1 ms), and is fired by
`useSaveNote.onSuccess` right when another write is likely. This is a
single-process self-hosted server, so an in-process mutex is sufficient. Both
transactions still stay short, and `drizzleAdapter`'s own `transaction` option
stays at its default `false`.

The mutex is not a global guarantee, and should not be read as one. Writes that
do not go through it — `decks.*`, and better-auth's own writes through
`drizzleAdapter`, which is not reachable from application code — can still
collide with an open transaction. Those are all single statements, so their
exposure is the microseconds they hold the lock rather than a transaction's
several round trips, which is where essentially all of the contention was. A
real fix for the remainder means a driver that honours `busy_timeout` on
lazily-opened connections, not more mutex.

**Deno's minimum-dependency-age policy blocks very fresh releases.**
better-auth publishes often; a version less than a day old is refused with "a
newer matching version was found, but it was not used". Pin deliberately rather
than chasing `latest`.

**better-auth specifics.** The schema generator is the `auth` package
(`deno run -A npm:auth@latest generate`) — `@better-auth/cli` is frozen at
1.4.x and predates this API. `additionalFields` must **not** set `input: false`:
that flag blocks `updateUser` as well as signup, so the settings screen would
get `FIELD_NOT_ALLOWED` when saving a language. And `user.name` is `notNull`,
which the sign-up form must satisfy — see §5.

None of these touch the schema, the authorization rule or the client contract.
