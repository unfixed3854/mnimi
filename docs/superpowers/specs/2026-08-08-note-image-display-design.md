# Note images: display and pre-save generation

Make generated note images visible — serve them over authenticated HTTP and
render them in the deck list and on the review card — and move generation
ahead of the save, so an image can be seen, and rejected, before the note is
committed.

## Problem

The image pipeline is half-built. `ai.generateImage` calls the model, writes
the PNG under `IMAGES_DIR`, and records the path on the note
(`server/router/ai.ts:52-97`) — and there the chain stops.

- **No route serves the files.** `createApp` mounts exactly two things,
  `/api/auth/*` and `/rpc/*` (`server/app.ts:37-53`). `IMAGES_DIR` is written
  to and never read back.
- **No component renders `imagePath`.** The only `<img>` in `src/` is the
  favicon in `auth-brand-header.tsx:13`. The deck screen lists notes as text
  (`src/routes/_authed.decks.$deckId.tsx:96-108`).

Observed directly: the note `die Banane` has `image_path` set, and its PNG is
on disk — and the app shows nothing. The README's claim that "the note screen
offers a retry" describes UI that does not exist.

Two further gaps follow from the same half-built pipeline:

- **A failure is indistinguishable from a decision.** A note whose model
  decided no picture would help and a note whose generation failed both have a
  null `imagePath`, and the client's only reaction to a failure is a
  `console.error` (`src/lib/api/notes.ts:24`). The note `das Flugzeug` has a
  null `image_path` with no way to tell which case it is.
- **The image cannot be seen before the note exists.** `ai.generateImage`
  takes a `noteId`, checks ownership of that row, and writes
  `<userId>/<noteId>.png`. Before Save there is no id and nowhere to put
  bytes, so the confirm screen can never show what it is about to commit.

## Approach

Two parts, one branch.

**Part 1** gets bytes to the browser: an authenticated HTTP route keyed by id
rather than by path, one shared component, and rendering in the deck list and
on the review card. Entirely additive — no existing contract changes.

**Part 2** moves generation ahead of the save: a draft image written to a
staging directory under a server-issued `draftId`, displayed on the confirm
screen, and claimed by `notes.save`. This changes `notes.save`'s contract and
deletes the client's fire-and-forget attachment path.

The constraint that shapes Part 1: auth is a bearer token in `localStorage`
(`src/lib/orpc.ts:20-32`), not a cookie. A bare `<img src>` cannot set an
`Authorization` header, so a plain authenticated static route would never
render. The client instead fetches with the header and wraps the bytes in an
object URL.

Part 2 is built on Part 1's route, which is why they share a branch: Part 2
needs exactly Part 1's component pointed at a second path.

**A cost this accepts.** Generating before the save means paying for images on
notes that are never saved. Today an abandoned `/add` screen costs nothing.
This is inherent to seeing the image before committing to it, not an oversight
— `sweepDrafts` (§13) bounds the disk cost, but not the spend.

---

# Part 1 — Serving and display

## 1. Storage module (`server/images.ts`)

`IMAGES_DIR` and `writeImage` move out of `server/router/ai.ts:11-27` into a
new `server/images.ts`, which also holds the serving route, the draft write
and claim helpers (§8, §9) and the sweep (§13). `router/ai.ts` imports
`writeImage` back.

The move is not cosmetic: the HTTP layer needs `IMAGES_DIR`, and without this
it would have to import it from the RPC router — a layering inversion. Two
import sites update: `server/router/ai.ts` and
`server/router/write-image.test.ts`. The latter sets `IMAGES_DIR` before
importing, because the constant is read once at module load; that stays true
of the new module, so the test's existing comment and ordering still hold.

## 2. Serving route (`GET /images/:scope/:id`)

`server/images.ts` exports `createImagesRoute({ db, auth })`, returning a Hono
sub-app that `createApp` mounts with `app.route("/images", ...)` — the same
dependencies `createApp` already receives, passed explicitly rather than read
from module scope, so the route is testable against a temp database exactly
like every other handler.

It sits under the `cors` middleware already applied to `*`
(`server/app.ts:22-35`), whose `allowMethods` includes `GET`.

Both scopes begin the same way:

1. `auth.api.getSession({ headers })` — the same call `requireAuth` makes
   (`server/router/base.ts:32-40`). No session → **401**.
2. `id` must parse as a UUIDv7; if not → **404** (not 400: a malformed id is
   indistinguishable from a nonexistent one, and reporting them differently is
   a needless signal).

**`GET /images/notes/:noteId`** then selects the note `WHERE id = :noteId AND
userId = session.user.id` and answers **404** if the row is missing, belongs
to someone else, has a null `imagePath`, or names a file that is not on disk.
All four answer identically, so an id's existence never leaks — the same
reasoning as `notFound` (`server/router/base.ts:59-70`). The missing-file case
is logged, since it means disk and database have diverged.

**`GET /images/drafts/:draftId`** reads `drafts/<userId>/<draftId>.png`
directly, with no database lookup: a draft belongs to whoever's directory it
sits in, so ownership *is* the path prefix. Missing file → **404**.

On success: the file, `Content-Type: image/png`, `Cache-Control: private,
no-cache`.

**The client never supplies a path.** It supplies an id, and the path is
composed from the session's user id and a validated UUIDv7. Path traversal is
not mitigated here, it is unreachable.

`Deno.readFile` rather than a stream: these are single ~1 MB PNGs served from
localhost, and buffering keeps the handler a straight line.

## 3. Recording a failed generation

`NoteMetadata` (`server/db/schema.ts:97-100`) gains `imageFailed?: boolean`
and `imagePrompt?: string | null`, next to the `generationFailed` flag it
already carries. `metadata` is a JSON column, so **no migration**.

`imageFailed` means *an attempt was made and did not produce an image*. It is
set in two places — `notes.save` when a claim fails or a draft never arrived
(§10), and `ai.generateImage` when a retry fails (§18) — and cleared whenever
an image successfully lands. A note whose model returned `imagePrompt: null`
is never flagged: nothing was attempted, so nothing failed. That asymmetry is
the point. It is what separates "no picture would help" from "the picture
didn't happen".

Every write to `metadata` goes through `withWriteLock`, like the current
update (`server/router/ai.ts:87-94`). A JSON column means read-modify-write,
so the lock is doing real work here, not just matching style.

## 4. `hasImage` on due cards

`cards.due` already joins `notes` and discards everything but the card row
(`server/router/cards.ts:38-56`). It starts selecting `notes.imagePath` and
returns `{ ...card, hasImage: imagePath !== null }`.

A boolean, not the path: the review screen only needs to know whether to
render, and the stored path is a server-side detail. `notes.listByDeck` is
left alone — it already returns `imagePath` on the full note row.

## 5. `useGeneratedImage` (`src/lib/api/images.ts`)

A plain `useQuery`, not the oRPC query utils — this is raw HTTP, not a
procedure.

```ts
useGeneratedImage(scope: "notes" | "drafts", id: string, enabled: boolean)
```

- Fetches `${apiUrl}/images/${scope}/${id}` with `authorization: Bearer
  ${getToken()}`, through `sessionAwareFetch` so a refused token trips the
  same "sign in again" path as every RPC call
  (`src/lib/session-rejection.ts:38-46`).
- **Returns the `Blob`, not an object URL.** React Query has no destructor
  that fires on cache eviction, so a URL cached there would leak for the
  lifetime of the tab. The cache holds bytes; the component owns the URL.
- `retry: false` — a missing image is a normal outcome, not something to
  retry three times.
- `staleTime: Infinity` — the bytes at an id do not change within a session.

## 6. `GeneratedImage` (`src/components/generated-image.tsx`)

```tsx
<GeneratedImage scope={...} id={...} present={...} alt={...} className={...} />
```

Calls `useGeneratedImage(scope, id, present)` and owns the object-URL lifetime
the cache cannot: a `useEffect` on the blob creates the URL and its cleanup
revokes it.

Three render states:

- `present` false → **nothing at all**. A note the model decided needs no
  picture is a correct note, not a hole to be papered over with a placeholder.
- blob in flight → a `Skeleton` at the final dimensions, so nothing shifts
  when it lands.
- fetch failed → **nothing**, collapsing rather than leaving a broken frame.

`alt` is supplied by the caller rather than derived, because what the image
depicts differs by surface.

## 7. Placements

**Deck note list** (`src/routes/_authed.decks.$deckId.tsx:96-108`). The `<li>`
shifts from `items-baseline` to `items-center` and gains a leading `size-10`
rounded thumbnail with `present={note.imagePath !== null}` and
`alt={note.sourceText}`. When `note.metadata.imageFailed` is set, a muted
`image failed` marker sits beside the existing domain label — understated,
because it is information, not an error state. Each row links to the note
detail screen (§18), which is where that marker leads.

**Review card** (`src/routes/_authed.review.$deckId.tsx`). The image renders
inside the answer `Card` once `revealed` is true, capped at `max-h-64`, with
`present={card.hasImage}` from §4 and `alt={card.back}` — the answer is the
one string on this screen that names what the picture shows, and it is already
revealed by the time the image appears, so the alt text spoils nothing a
sighted user cannot see.

Only after reveal, never on the front. A picture of a banana *is* the answer
to "what does die Banane mean?", and showing it up front would let a card be
graded correct without recall, quietly corrupting FSRS scheduling. Gating on
`revealed` is correct for every aspect without the code needing to interpret
aspect labels — which are open-vocabulary model output that no code path
guarantees.

---

# Part 2 — Pre-save generation

## 8. `ai.generateDraftImage({ prompt })`

A new authed procedure — deliberately **not** a new event on the generation
stream. Keeping it separate leaves the stream contract, `runGeneration` and
the validation-retry logic untouched, and makes "retry" nothing more than
calling it again.

It generates bytes through the existing `context.generateImageBytes` seam,
writes them to `drafts/<userId>/<draftId>.png` with a server-generated UUIDv7
`draftId`, and returns `{ draftId }`. The write helper lives beside
`writeImage` in `server/images.ts`.

## 9. `notes.save` claims the draft

`saveNoteInput` gains `draftImageId: z.uuidv7().nullish()`.

Ordering, which is load-bearing:

1. Generate `noteId` explicitly rather than leaving it to the column default,
   so the destination path is known before anything is written.
2. Run the existing transaction — note plus cards — unchanged.
3. **After it commits**, rename `drafts/<userId>/<draftId>.png` to
   `<userId>/<noteId>.png` and set `imagePath` under `withWriteLock`.

Claiming after the commit rather than before is the whole point of the
ordering. A rename first would, on a failed transaction, leave a file at a
note path with no note row — an orphan class the draft sweep cannot see.
Claiming after means every failure degrades to "note without image", which the
app already treats as valid, and the unclaimed draft is swept by age.

`Deno.rename` is atomic here because both paths are under `IMAGES_DIR`, one
filesystem.

## 10. Inferring a failed attempt at save time

`notes.save` sets `metadata.imageFailed` when the rename fails, and also when
`imagePrompt` is non-null but no `draftImageId` arrived.

That second case needs no extra field, because the combination is already
unambiguous: a non-null prompt means an image was wanted, Save is disabled
while a draft is in flight (§16), and the fallback path into `review` carries
a null prompt (`src/lib/generation-state.ts:112-125`). So prompt-without-draft
can only mean the attempt was made and did not succeed.

## 11. Persisting `imagePrompt`

`saveNoteInput` already accepts `imagePrompt` (`server/router/notes.ts:36`)
and the handler silently drops it — it exists only so the *client* can decide
whether to fire generation. The handler now writes it into `metadata`.

Without this, retry after saving has nothing to regenerate from: the prompt
would be discarded at exactly the moment it becomes the only record of what
the picture was meant to show.

## 12. `notes.get({ noteId })`

Returns the note with its cards, scoped to the session user, `notFound`
otherwise. Feeds the detail screen (§18).

## 13. `sweepDrafts(maxAgeMs)`

Deletes draft files older than 24 hours. Called from `server/main.ts` on start
and on an interval, but exported from `server/images.ts` as a plain function
so it is tested against a temp directory rather than against a clock.

Drafts are the only orphan class this design creates, and §9's ordering is
what keeps it the only one.

## 14. Reducer: `draftImage`

The `review` state in `src/lib/generation-state.ts` gains a discriminated
union:

```ts
draftImage:
  | { status: "none" }
  | { status: "generating"; startedAt: number }
  | { status: "ready"; draftId: string }
  | { status: "failed" }
```

Three new actions — `draft-image-started`, `draft-image-ready`,
`draft-image-failed` — each guarded on `status === "review"`, exactly like the
existing `edit-card`. Both paths into `review` that carry a null `imagePrompt`
(including the hand-editable fallback) land on `none`.

## 15. `src/lib/run-draft-image.ts`

Drives the draft call and dispatches `ready` or `failed`, swallowing
`SessionExpiredError`. Unlike `run-generation.ts`'s call, this one is never
given an `AbortSignal` — `generateDraftImage` (`src/lib/api/ai.ts:68-74`)
takes none — so there is no abort case to swallow; see the "`/add` abandoned
mid-draft" edge case below for what that means in practice. It mirrors
`run-generation.ts` in structure and exists for the reason that module
states: the subtle branches belong in a pure testable module rather than in
the one route component the design otherwise leaves untested.

It owns a **timeout** that settles a hung call as `failed`. Because Save is
gated on this state (§16), a request that never returns would otherwise block
saving forever, and "disabled" would stop being a wait and start being a trap.

## 16. Save gating on the confirm screen

Save is disabled while `draftImage.status === "generating"`. `none`, `ready`
and `failed` all save.

The button carries a "Generating image…" label with elapsed seconds through
the existing `formatElapsed` (`src/lib/generation-status.ts`), so the wait
reads as progress rather than as a broken button. A `failed` draft offers
Retry beside the now-enabled Save.

The staged image renders above the cards via
`<GeneratedImage scope="drafts" id={draftId} present alt={text} />`.

## 17. `useSaveNote` sheds its tail

`useSaveNote` sends `draftImageId` when the draft is `ready`, and the
fire-and-forget block at `src/lib/api/notes.ts:17-28` is **deleted**.
Attachment now happens server-side inside `save`.

That block is where the original failure went silent — a `console.error` in a
`.catch` on a promise nobody awaited. Removing it is the point, not a side
effect.

## 18. Note detail screen (`/notes/$noteId`)

Source text, the image, its cards, and a Retry button shown when `imagePath`
is null and `metadata.imagePrompt` is non-null. Retry calls the surviving
`ai.generateImage` with the persisted prompt; that procedure keeps its
existing behaviour and additionally clears `imageFailed` on success and sets
it on failure (§3).

Keying Retry on the persisted prompt rather than on `imageFailed` means it is
offered in both cases that deserve it — a failed attempt, and a note saved
while its draft was failing — without either needing to be distinguished.

---

## Edge cases

- **Database and disk diverge** (row has `imagePath`, file is gone): 404 and a
  server-side log. The UI collapses the image, as with any other failure.
- **Signed out mid-session**: the route 401s, `sessionAwareFetch` fires the
  session-rejected handler, and the app takes its existing path — the image
  query is not a special case.
- **A note is deleted while its image is on screen**: the next fetch 404s and
  the component collapses. No dangling object URL, because the effect cleanup
  runs on unmount regardless of query state.
- **Same note rendered twice** (deck list and review): one React Query cache
  entry, one fetch, two object URLs with independent lifetimes. Correct, and
  the duplicate URL costs nothing.
- **`/add` abandoned mid-draft**: the unmount abort in `_authed.add.tsx:47-49`
  is wired to `generateNoteStream` only — `generateDraftImage`
  (`src/lib/api/ai.ts:68-74`) takes no `AbortSignal` at all. Navigating away
  mid-draft does **not** cancel it: the request keeps generating server-side
  and the charge is incurred regardless of whether anyone is still looking.
  If the server finishes writing the file, it sits unclaimed in the drafts
  directory until the 24-hour sweep removes it. This is accepted, not fixed —
  see "Rate limiting and spend caps" under Out of scope, which already
  accepts that abandoned drafts cost money.
- **The same draft claimed twice**: not reachable — `notes.save` renames, so a
  second claim finds no source file and lands on `imageFailed`, leaving the
  first note's image intact.

## Out of scope

- **Why `das Flugzeug` produced no image.** This spec makes such a failure
  *visible* rather than diagnosing that instance — once `imageFailed` exists,
  a repeat distinguishes itself from a deliberate no-image note without
  guesswork.
- **HTTP-level caching** (ETag, `max-age`). React Query holds the blob for the
  session. Retry overwrites a path within a session, which `private, no-cache`
  already handles correctly.
- **Rate limiting and spend caps on image generation.** Moving generation
  ahead of the save means abandoned drafts cost money, which sharpens the case
  for the `usage_events` work already recorded in `docs/OUT-OF-SCOPE.md` §2.4.
  It does not create it, and this spec does not address it.
- **Editing or replacing an image with your own upload.**

## Testing

Vitest runs `server/**/*.test.ts` and `src/**/*.test.{ts,tsx}` from one config
(`vitest.config.ts`), so both halves land in the same suite.

**`server/images.test.ts`** — HTTP level via `app.request`, following
`server/app.test.ts:22-33`, against a temp `IMAGES_DIR` set before import the
way `server/router/write-image.test.ts:11-16` does:

- The owner gets 200 with `image/png` and the written bytes, for both scopes.
- Another user's note, an unknown id, a malformed id, a note with a null
  `imagePath`, and a row naming a file that is not on disk all get 404 with
  identical bodies.
- A draft id belonging to another user gets 404 — the path prefix is the
  authorization, so this is the test that proves it.
- No bearer token gets 401.
- `sweepDrafts` deletes a file older than the cutoff and keeps a newer one.

**`server/router/ai.test.ts`** — `generateDraftImage` writes under the calling
user's draft directory and returns its id; a throwing `generateImageBytes`
sets `metadata.imageFailed` on retry; a success clears a previously-set flag.

**`server/router/notes.test.ts`** — save with a `draftImageId` moves the file
and sets `imagePath`; save with a non-null `imagePrompt` and no draft sets
`imageFailed`; save with a `draftImageId` naming a missing file sets
`imageFailed` and still commits the note and its cards; `imagePrompt` is
persisted into `metadata`; `notes.get` returns the note with cards and 404s
for another user's id.

**`server/router/cards.test.ts`** — `due` reports `hasImage` true for a note
with an `imagePath` and false without.

**`src/lib/generation-state.test.ts`** — the three draft actions move `review`
through `generating` → `ready` / `failed`, are ignored outside `review`, and a
null `imagePrompt` (both the `done` and the fallback path) lands on `none`.

**`src/lib/run-draft-image.test.ts`** — dispatches `ready` on success and
`failed` on rejection, stays silent on `SessionExpiredError` (mirroring
`run-generation.test.ts`), and settles as `failed` on timeout. There is no
abort case to test: the call it drives is never given a signal (§15).

**`src/components/generated-image.test.tsx`** — renders nothing when `present`
is false, renders an `img` once the blob resolves, and revokes the object URL
on unmount. jsdom does not implement `URL.createObjectURL`, so this needs a
stub.

**`src/lib/api/images.test.ts`** — sends the bearer header, hits the right
path per scope, and does not retry a 404.
