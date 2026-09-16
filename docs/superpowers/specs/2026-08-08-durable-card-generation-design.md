# Durable card generation

Generation stops being a request and becomes a job the server owns. Leaving
`/add` no longer kills it; coming back picks the stream up where it is. What was
transient client state — the cards, the classification, the picture — becomes a
**draft** row you can save, discard, or leave alone for a week.

Closes [#21](https://github.com/unfixed3854/mnimi/issues/21).

## Problem

`ai.generateNote` is an oRPC procedure whose handler is an async generator, and
the client drives it. `_authed.add.tsx` holds every result in a `useReducer`,
and its unmount effect aborts the controller:

```ts
useEffect(() => {
  return () => abortRef.current?.abort();
}, []);
```

That was deliberate and, given the design, correct — a generation nobody is
watching is money being spent on output that has nowhere to land, and the oRPC
spec listed "cancel stops the work" as a property to verify by hand. But it
makes the capture screen a place you cannot leave. Switch to another route to
check a deck name, let the phone lock, get a call: the run dies and the ten
seconds start again.

The picture is worse than the cards. `ai.generateDraftImage` is fired by an
effect in the route once the prompt arrives, and its `draftId` exists only in
component state. Navigating away during image generation leaves the PNG written
to disk with nothing pointing at it, waiting for the 24-hour sweep.

Nothing is persisted until `notes.save`, so there is also no "later". A note is
either committed whole or lost whole.

## Approach

Three changes, each of which is the smallest one that makes the next possible.

1. **A `drafts` table**, one row per user, holding everything the reducer holds
   today. This is what "come back to later" means, and it is what makes the
   other two changes observable.
2. **A job registry in the server process.** The generation runs detached,
   keeping its latest snapshot in memory and publishing to whoever is watching.
   `drafts.watch` yields the snapshot immediately and then tails.
3. **The image becomes a concurrent stage of that job**, started from the
   prompt rather than after the cards, and settled against whatever the draft
   has become by the time the bytes arrive.

Two alternatives to (2) were considered.

**Persist every snapshot and poll.** Each `cards` snapshot written to the row,
`/add` on a `refetchInterval`. No registry, no pub/sub, and a reconnect is just
the next poll. Rejected on both ends: roughly forty writes per generation
queued behind the global write lock, in exchange for turning field-by-field
streaming — the whole point of the 2026-07-30 spec — into half-second steps.

**An append-only `generation_events` table** replayed from a cursor. It is the
only option that survives a server restart mid-generation with the run intact,
and it costs a second table, a cursor protocol on the wire, and a pruning
policy. The property it buys is worth less than it looks: the server restarting
mid-generation is a development event, and the model call does not survive it
either, so the log would replay a stream that stopped. A restart is handled
honestly instead — see §1.4.

The UI stays deliberately small. There is no `/drafts` route, no list, and no
draft browser, because there is never more than one draft.

## 1. The draft

### 1.1 Table

```ts
export const drafts = sqliteTable("drafts", {
  id: text("id").primaryKey().$defaultFn(uuidv7),
  userId: text("user_id").notNull().unique()
    .references(() => user.id, { onDelete: "cascade" }),
  deckId: text("deck_id").notNull()
    .references(() => decks.id, { onDelete: "cascade" }),
  sourceText: text("source_text").notNull(),
  status: text("status").$type<DraftStatus>().notNull(),
  classification: text("classification", { mode: "json" })
    .$type<Classification | null>(),
  cards: text("cards", { mode: "json" }).$type<DraftCard[]>().notNull()
    .$defaultFn(() => []),
  imagePrompt: text("image_prompt"),
  imageStatus: text("image_status").$type<DraftImageStatus>().notNull()
    .$defaultFn(() => "none"),
  draftImageId: text("draft_image_id"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
    .$defaultFn(() => new Date()),
});

type DraftStatus = "generating" | "ready" | "failed";
type DraftImageStatus = "none" | "generating" | "ready" | "failed";
```

`userId` is `unique`. The "one draft at a time" rule is a database constraint,
not a convention the UI is trusted to uphold — a second `drafts.start` fails
even if two tabs race it.

`cards` holds `PartialCard[]` while generating and `GeneratedCard[]` once
`status === "ready"`, which the client already distinguishes by status. It is
JSON rather than a `draft_cards` table because nothing queries into it: it is
read whole, written whole, and thrown away or promoted whole.

**Two independent status columns.** `status` describes the cards; `imageStatus`
describes the picture. They are separate precisely because §3 makes the two
stages concurrent, so they no longer finish together — and often finish in the
opposite order from today.

`onDelete: "cascade"` on `deckId` matters: deleting a deck with an unfinished
draft for it must not leave a row pointing at nothing.

### 1.2 Lifecycle

```
/add, no draft ──▶ capture form (deck + text) ──▶ drafts.start
                                                      │
  status=generating ──┤ classified · image-prompt · cards…
                      │        └─ image stage runs concurrently
                      │
  status=ready ───────┤ cards editable, autosaved
                      │
        ├─ Save ──────▶ note created, draft row deleted
        └─ Discard ───▶ job aborted, row + image file deleted

  status=failed ──────┤ hand-editable fallback card, same as today
```

`/add` never shows the capture form while a draft exists. Discard is the way
back to it.

### 1.3 Cancel is Discard

Today's Cancel returns you to an empty form. With a persisted draft that is the
same action as Discard — abort the job, drop the row, drop the file — so there
is one button, not two that differ only in which state they are reachable from.

### 1.4 A restart is a failure, and says so

Every in-flight job dies with the process. `main.ts` reconciles at boot:

```sql
UPDATE drafts
   SET status       = CASE WHEN status = 'generating' THEN 'failed'
                           ELSE status END,
       error        = CASE WHEN status = 'generating' THEN ? ELSE error END,
       image_status = CASE WHEN image_status = 'generating' THEN 'failed'
                           ELSE image_status END
 WHERE status = 'generating' OR image_status = 'generating'
```

with `error = "The server restarted while this was generating."`. The two
columns are reconciled independently, because §3 makes them independent: a
draft whose cards finished and whose picture was still rendering comes back
`ready` with a failed image and a working "Try again", not failed outright.

A failed `status` lands on the existing path — a hand-editable card seeded with
the text you typed, the same remedy a model failure has offered since the
streaming spec. Nothing is silently lost and nothing pretends to still be
running.

`drafts.watch` makes the same check defensively, for a row written between boot
and the request — a `generating` row with no live job is reconciled on read.

### 1.5 Retention, and one change to the sweep

With one draft per user there is no pile-up, so the row has no TTL. A draft
waits as long as you want.

That breaks the existing sweep. `sweepDrafts(maxAgeMs)` deletes any file under
`DRAFTS_DIR` older than 24 hours, which would eat the picture out from under a
day-old draft. It gains the ids that live rows reference:

```ts
sweepDrafts(maxAgeMs, referenced: Set<string>, now?: number): Promise<number>
```

and skips them. It stays a backstop for the orphan class it was written for —
files whose row is already gone — which now also covers a discard whose file
delete failed. `main.ts` reads the referenced ids from the table before each
sweep.

## 2. The job

### 2.1 `server/ai/channel.ts`

The one new primitive. The oRPC spec refused to build a queue when a ten-line
`.next()` loop would do, and that was right: `generateNote` had a synchronous
driver pulling it. A detached job does not. The producer runs on its own and
subscribers appear and vanish, so the callback-to-iterator bridge is real here.

```ts
export function channel<T>(): {
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
  [Symbol.asyncIterator](): AsyncGenerator<T>;
};
```

**It coalesces.** An unbounded queue grows behind a stalled mobile client, and
the natural fixes — dropping the oldest, or blocking the producer — are both
wrong for a job that must not be slowed by its audience. Instead: if the tail of
the queue is a `cards` event and another `cards` arrives, it *replaces* it. That
is legal precisely because `cards` carries a full snapshot rather than a delta,
a property the 2026-07-30 protocol chose for rendering simplicity and which pays
for itself again here. Terminal events are never coalesced.

Small enough to test alone, which is why it is its own module.

### 2.2 `server/ai/jobs.ts`

```ts
type Job = {
  draftId: string;
  userId: string;
  snapshot: DraftSnapshot;          // what a late subscriber gets first
  subscribers: Set<Channel<DraftEvent>>;
  abort: AbortController;
  imageAttempt: number;
  noteId: string | null;            // set by notes.save; see §3.2
};

const jobs = new Map<string, Job>();
```

`subscribe(draftId)` returns an async iterable that yields
`{ type: "snapshot", draft }` first, then tails. Its `finally` removes the
channel from the set, so a closed tab does not leak one.

The registry is process-local, which is fine: one Deno process, one SQLite file,
`Deno.serve` with no clustering. If that ever stops being true this module is
the seam that has to change, and nothing else is.

### 2.3 The event union

```ts
export type DraftEvent =
  | { type: "snapshot"; draft: Draft }
  | { type: "classified"; classification: Classification }
  | { type: "image-prompt"; prompt: string | null }
  | { type: "cards"; cards: PartialCard[] }
  | { type: "retry" }
  | { type: "done"; classification: Classification; generation: GeneratedNote }
  | { type: "image"; status: DraftImageStatus; draftImageId: string | null }
  | { type: "failed"; message: string };
```

**`failed` is an event, reversing the oRPC spec deliberately.** That spec
removed `{ type: "error" }` on the grounds that an iterator which *is* the
generation should throw when the generation fails, and it was right. `watch` is
not the generation. It observes a job that may have failed before this request
existed, so throwing would assert "watching failed", which is a different fact
and would send the client's `catch` down the reconnect path in §4.2 for a draft
that is never coming back. A thrown error from `watch` now means exactly one
thing: the connection broke.

## 3. Generating

### 3.1 The image starts from the prompt, not from the cards

`generatedNoteSchema` reorders to `{ imagePrompt, cards }`.

The 2026-07-30 spec put `cards` first so they would start appearing immediately
rather than behind the image prompt, and with a client-driven image fired after
`done` that was the only ordering that helped anyone. Now the prompt is the
input to a concurrent stage, so emitting it first buys the entire card-writing
duration as image head start:

```
t=0.0  classify
t=1.2  imagePrompt "a ripe banana, whole, on a plain surface"  ┐
t=1.4  card 1 streaming…                                       │ image
t=3.1  card 2 streaming…                                       │ stage
t=6.0  card 3 streaming…                                     ┌─┘
t=6.4  image ready ◀─────────────────────────────────────────┘
t=9.8  cards done — the picture is already there
```

The cost is the ~20 tokens of prompt the model writes before the first card,
which is well under a second and is paid once.

`generateNote` gains one event:

```ts
| { type: "image-prompt"; prompt: string | null }
```

**Knowing the string is complete** is not a guess. `parsePartialJSON` returns an
object that grows as text arrives; a string value can still be extended until
the next key appears, so `imagePrompt` is final exactly when the parsed object
has gained a `cards` key. The event fires at that delta, once per attempt. A
`null` prompt fires it too, carrying `null` — that is the model deciding no
picture helps, which is a decision and not a failure, and it is what leaves
`imageStatus` at `none`.

**A retry supersedes the prompt.** `streamWithRetry` discards a first attempt
that failed validation, and its image prompt goes with it. The second attempt's
`image-prompt` bumps `job.imageAttempt`; a result arriving from a superseded
attempt is discarded rather than written. It is not aborted, because the
OpenRouter image call takes no signal and the bytes are paid for the moment the
request is made — discarding on arrival is the honest description of what
happens, and retries are rare enough that the waste is not worth machinery.

### 3.2 Two stages, disjoint columns

The cards stage owns `status`, `classification`, `cards`, `error`. The image
stage owns `imageStatus`, `draftImageId`. Both write through `withWriteLock`, so
their concurrency is the same serialised write path every other write already
takes.

Writes per generation: the insert, `classified`, `image-prompt`, up to two image
transitions, and `done`. Roughly six, against the forty the polling alternative
would have cost.

### 3.3 The retarget, without a race

You can Save while the picture is still generating. The note commits without
it, and the running stage is redirected onto the note. The two halves of that
cannot interleave, because both run inside `withWriteLock`:

**Image stage, once the bytes are on disk** — read the draft row, then, in the
same locked section:

| state | action |
|---|---|
| row exists | `imageStatus = "ready"`, `draftImageId` |
| row gone, `job.noteId` set | rename onto the note path, set `notes.imagePath` |
| row gone, no `noteId` | the draft was discarded; delete the file |

**`notes.save`** — read the row, then, in the same locked section:

| state | action |
|---|---|
| `imageStatus === "ready"` | claim the file onto the note, exactly as today |
| image still generating | set `job.noteId` synchronously, then delete the row |

Whichever acquires the lock first, the other sees a settled world. There is no
third state, and no window in which the file is at the draft path with nothing
that will ever look for it.

The failure ordering the current `attachImage` establishes is preserved: bytes
land on disk before any row points at them, and a rename that succeeds while its
row update fails surfaces rather than being relabelled a claim failure.

## 4. Procedures

### 4.1 The `drafts` router

```
drafts.current()                       → Draft | null
drafts.start({ deckId, text })         → { draftId }
drafts.watch({ draftId })              → AsyncIterable<DraftEvent>
drafts.update({ draftId, deckId?, cards? })
drafts.discard({ draftId })
drafts.retryImage({ draftId })
```

`start` asserts deck ownership, inserts the row, and spawns the job. The unique
index turns a concurrent second call into a rejection rather than a second job.

`retryImage` restarts the image stage from the stored prompt, bumping
`imageAttempt`. It replaces the `generateDraftImage` call the route's "Try
again" button makes today.

`notes.save` narrows to `{ draftId, cards }`. `sourceText`, `classification`,
`imagePrompt` and the image all come from the row: a picture that landed one
tick before Save cannot be missed, and the client can no longer supply its own
classification. `cards` still comes from the client because it is the one field
the client is authoritative for — sending it explicitly means a debounce still
in flight can never lose an edit.

`ai.generateNote` and `ai.generateDraftImage` stop being procedures; their logic
is the job runner's. `ai.generateImage` — the note-screen retry, which operates
on a saved note — is untouched.

### 4.2 Ownership

Every procedure filters on `context.userId`, the repo's standing convention, and
`drafts.watch` checks it before subscribing: the registry is keyed by `draftId`
alone, so ownership is not implied by the key.

## 5. Client

### 5.1 `/add` becomes a viewer

Four states rather than three: `loading` while `drafts.current()` resolves, then
`idle` (capture form), `generating`, or `review`. The reducer is seeded by the
`snapshot` event instead of a local `start` action, and `DraftImageState` stops
being local state — it is two columns now, arriving as `image` events.

The route loses the StrictMode `firedForRunRef` dance along with the effect that
needed it: nothing client-side fires image generation any more.

### 5.2 `run-generation.ts` → `watch-draft.ts`, which reconnects

Today a dropped stream is fatal, and honestly so: the work died with it, so a
hand-editable fallback was the only remedy. The job now outlives the connection,
which changes what a drop means. A drop while the draft is still `generating` is
re-watched — three attempts, backing off — and only surfaces as a failure if the
draft itself is `failed`.

This is the change that makes the feature feel durable on a phone, where the
stream drops for reasons that have nothing to do with generation. It is also why
§2.3 insists a thrown error from `watch` means only "the connection broke": the
reconnect path needs that to be unambiguous.

The cancel branch is unchanged and still checks `signal.aborted` rather than the
error's shape, for the reason recorded in its comment.

### 5.3 Autosave

A 1s debounce on `drafts.update`, live only while `status === "ready"`.

The timer is deliberately **not** cleared on unmount. The mutation is a plain
oRPC call, not bound to the component, so navigating away flushes it instead of
discarding it — which is the entire point of the feature. The worst case is
losing under a second of typing to a killed app. Save cannot race it, because
Save sends `cards` explicitly (§4.1).

### 5.4 The indicator

The sidebar's `Add` item carries a dot and a status word from
`drafts.current()` — `generating…`, `ready`, `failed` — invalidated by `start`,
`discard` and `notes.save`. That is the whole of the "there is something waiting
for you" surface; no new layout region, no banner component.

### 5.5 Deleted

- `src/lib/run-draft-image.ts` and `src/lib/run-draft-image.test.ts`
- `generateDraftImage` from `src/lib/api/ai.ts`
- the draft-image effect and `firedForRunRef` in `_authed.add.tsx`
- the local `DraftImageState` machinery in `src/lib/generation-state.ts`

`src/lib/api/drafts.ts` is added beside `ai.ts`, which keeps `generateNoteImage`
for the note screen.

## 6. Error handling

| Failure | Behaviour |
|---|---|
| Model output fails validation once | `retry`; cards clear, image attempt superseded, timer keeps running |
| Model output fails validation twice | `status = failed`; hand-editable card, text preserved |
| Image generation fails | `imageStatus = failed`; cards unaffected, "Try again" calls `retryImage` |
| Connection drops mid-watch | Re-watch, three attempts; the job never noticed |
| Server restarts mid-generation | Reconciled to `failed` at boot, with an honest message |
| Second `drafts.start` while a draft exists | Rejected by the unique index |
| Deck deleted with a draft for it | Row cascades away; `/add` shows the capture form |
| Save while the image generates | Note commits; image lands on it afterwards (§3.3) |
| Draft discarded while the image generates | File deleted when the bytes settle (§3.3) |

## 7. Tests

Component tests exist in this repo — `auth-form`, `page`, `generated-image`,
`sidebar-resize`, `sidebar-shortcut`, all Testing Library with `vi.mock` over
the API module — so the earlier specs' note that there is no component harness
is stale, and the route is testable.

**New**

- **`server/ai/channel.test.ts`** — coalescing replaces a queued `cards` and
  never a terminal event; a late subscriber gets the snapshot first; `finally`
  unsubscribes; `fail` rejects the iteration.
- **`server/ai/jobs.test.ts`** — two subscribers see the same sequence;
  `discard` aborts the run; the boot reconcile flips an orphaned `generating`
  row to `failed`, and leaves a `ready` row with a `generating` image at
  `ready` with the image failed.
- **`server/router/drafts.test.ts`** — per-user ownership on all six
  procedures; a second `start` is rejected; and **both write-lock orderings of
  the retarget**, image-settles-first and save-settles-first. Those two are the
  cases that earn their keep.
- **`src/lib/watch-draft.test.ts`** — reconnects on a drop, gives up after
  three, ignores a cancel, does not reconnect on `failed`.
- **`src/routes/_authed.add.test.tsx`** — mounting with a `generating` draft
  shows the resumed text and streaming cards rather than the capture form.

**Extended**

- **`server/ai/generate-note.test.ts`** — `image-prompt` fires exactly once, at
  the delta where `cards` appears; a `null` prompt fires it too; a retry
  supersedes the first attempt's prompt.
- **`server/images.test.ts`** — the sweep skips ids a live draft references.
- **`server/router/notes.test.ts`** — save from a draft; save with the image in
  flight sets `imagePath` afterwards; the draft row is gone either way.
- **`src/lib/generation-state.test.ts`** — rewritten around snapshot seeding;
  the existing retry, error and edit cases survive as they are.

**Deleted** — `src/lib/run-draft-image.test.ts`.

## 8. Migration and docs

One drizzle migration creating `drafts` with its unique index. Nothing existing
changes shape, so it is additive.

`README.md`'s "AI endpoints" section is rewritten: generation is a job with a
draft, not a request, and `ai.generateNote` / `ai.generateDraftImage` are no
longer part of the client-facing surface. The layout tree gains
`server/ai/channel.ts`, `server/ai/jobs.ts`, `server/router/drafts.ts` and
`src/lib/api/drafts.ts`, and loses `src/lib/run-draft-image.ts`.

The 2026-07-30 and 2026-08-07 specs stand as written. This one supersedes the
first's "resuming a generation across a page reload" exclusion and its schema
ordering, and reverses the second's error-as-thrown decision for `watch` only —
both for reasons recorded above, at the point where each is reversed.

## 9. Out of scope

- **More than one draft.** The single-slot rule is what keeps the UI to a
  status word on a nav item. Lifting it means a list, a route, and a decision
  about what `/add` shows — a different feature.
- **Surviving a restart with the run intact.** Would need the event log in §
  Approach, and the model call does not survive either.
- **Editing while generating.** Cards stay read-only until `status === "ready"`,
  as they are today, so no local edit can be clobbered by a later delta.
- **Resuming a *failed* generation from where it stopped.** A failure produces
  the hand-editable card; regenerating means discarding and starting again.
