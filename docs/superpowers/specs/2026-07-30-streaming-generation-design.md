# Streaming card generation design

Turn card generation from an opaque ten-second wait into a screen that shows its
work: real phase descriptions, an elapsed timer, skeletons, and cards that
materialise field by field as the model writes them.

Closes [#1](https://github.com/unfixed3854/mnimi/issues/1).

## Problem

`/add` disables the Generate button, changes its label to "Generating…", and
then nothing happens until the whole note arrives. `generate-note` runs two
model passes — a classify pass and a generate pass — and retries the generate
pass once on a validation failure, so a slow run can sit silent for a long time
with no indication that anything is happening, let alone what.

Everything needed to narrate that is already known server-side. None of it
reaches the client.

## Approach

Stream. `generate-note` responds with `text/event-stream` and emits its own
small typed event vocabulary. Generation and review become **one screen**: cards
materialise from skeletons into the existing editable card list in place, with
no transition.

Two alternatives were considered and rejected:

- **Forward TanStack AI's AG-UI stream** via `toServerSentEventsResponse` and
  parse it in the browser. The SSE reader (`fetchServerSentEvents`) lives in the
  React binding package, paired with `useChat` — a multi-turn chat transcript
  hook — and this is a one-shot generation that must go through
  `supabase.functions.invoke` to carry the auth header. AG-UI also has no event
  for "classification finished" or "output failed validation, restarting", which
  are three of the five events below; they would be `CUSTOM` chunks, i.e. our own
  vocabulary inside someone else's envelope. It is the chosen approach plus a
  dependency, and it hands the component JSON fragments to reassemble instead of
  card objects.
- **A job record the client polls.** Survives a page reload, but costs a table,
  RLS policies, and cleanup, and is slower for a ten-second operation.

Adopting a hand-written protocol forecloses nothing: the client-side reader is a
small module, not a competing framework, and coexists with `@tanstack/ai-react`
if a real chat feature ever wants it.

## 1. Wire protocol

`generate-note` keeps its request body (`{ text, nativeLanguage }`).

`getUser(req)` and Zod body validation run **before** any bytes are written, so
auth and bad-request failures still return real 401/400 JSON responses. Once the
stream opens the headers are committed, so every later failure travels as an
`error` event instead.

Response headers: `...corsHeaders`, `Content-Type: text/event-stream`,
`Cache-Control: no-cache`.

One JSON object per `data:` line:

| Event | Payload | Meaning |
|---|---|---|
| `classified` | `{ classification }` | Pass 1 done; rule packs selected |
| `cards` | `{ cards: PartialCard[] }` | Snapshot of the partial parse so far |
| `retry` | `{}` | Attempt 1 failed validation; discard the cards shown |
| `done` | `{ classification, generation }` | Validated final result |
| `error` | `{ message }` | Terminal failure |

```ts
type PartialCard = {
  aspect: string | null
  front: string | null
  back: string | null
}
```

A field is `null` when the model has not emitted it yet, which is exactly what
renders as a skeleton.

`cards` carries a **full snapshot**, not a delta: idempotent, order-independent,
and trivial to render. A four-card note produces roughly forty snapshots of a few
hundred bytes each, so no throttling is needed and there are no timers to clean
up. A snapshot is emitted only when it differs from the last one sent.

## 2. Server changes

### `_shared/schemas.ts`

Reorder `generatedNoteSchema` to put `cards` before `imagePrompt`. Models emit
JSON keys in schema order, so cards start appearing immediately instead of
behind the image prompt. Behaviourally neutral for every existing consumer.

### `_shared/sse.ts` (new)

Formats an event as `data: ${JSON.stringify(payload)}\n\n`, encodes it, and
constructs the streaming `Response`. Separate from the route so the framing is
unit-testable.

### `_shared/generate.ts`

`parseWithRetry` stays, untouched, for the classify pass; its tests stay green.
The feedback-message construction is extracted into a shared
`validationFeedback(issues)` used by both functions. A sibling is added:

```ts
streamWithRetry<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null, onDelta: (delta: string) => void) => Promise<unknown>,
  handlers: { onPartial(raw: string): void; onRetry(): void },
): Promise<T>
```

Same contract as `parseWithRetry` — one retry with the validation error fed back,
two failures is a real failure. It owns the accumulator: deltas append,
`onPartial` receives the accumulated raw text, and a retry **resets the
accumulator** before calling `onRetry()`. That reset is what makes the honest
"trying once more" behaviour fall out of the state machine rather than needing to
be coordinated in the route. It imports nothing from `@tanstack/ai`, so it is
testable with plain fakes.

### `generate-note/index.ts`

The adapter-specific part stays here, because chunk shapes are a library detail:
iterate `chat({ outputSchema, stream: true })`, feed `TEXT_MESSAGE_CONTENT.delta`
to `onDelta`, and take the final object from the terminal
`structured-output.complete` chunk. `onPartial` runs `parsePartialJSON` over the
accumulated text and emits a `cards` snapshot.

On the streaming path `@tanstack/ai` **deliberately does not validate** against
`outputSchema` — partial payloads are partial by design, so validation is the
consumer's responsibility. It stays ours, in `streamWithRetry`, against
`generatedNoteSchema`. The existing guarantee that the client only ever sees
schema-valid cards is preserved, not weakened.

## 3. Client transport

### `src/lib/sse.ts` (new)

```ts
readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string>
```

Yields each event's `data` payload. Uses a streaming `TextDecoder` so a
multi-byte character split across chunks is not corrupted, splits the buffer on
the blank line, joins multiple `data:` lines with `\n`, and ignores `:` comment
lines and `event:` / `id:` fields. No dependency.

### `src/lib/api/ai.ts`

`generateNote` is replaced by:

```ts
generateNoteStream(
  text: string,
  nativeLanguage: string,
  signal?: AbortSignal,
): AsyncGenerator<GenerationEvent>
```

`GenerationEvent` is the discriminated union from §1. It calls
`supabase.functions.invoke("generate-note", { body, signal })`, which returns the
raw `Response` for a `text/event-stream` content type and accepts an
`AbortSignal`, then yields parsed events.

If the stream ends without a terminal `done` or `error` — a dropped connection —
it yields a synthetic `error` itself, so no consumer can silently hang on a
truncated stream.

`generateNoteImage` is untouched, as are the exported `Classification`,
`GeneratedCard` and `GeneratedNote` types — `src/lib/api/notes.ts` imports the
first two and must keep compiling unchanged.

## 4. State machine

The branching lives in a pure module, not the component.

### `src/lib/generation-state.ts` (new)

`generationReducer(state, action)`, where actions are `GenerationEvent` plus two
local ones: `{ type: "start", text, startedAt }` and `{ type: "cancel" }`.

```
idle → classifying → generating → review

any → review   (via error: hand-editable fallback)
any → idle     (via cancel)
```

Four states, not five: a retry is not a state of its own but `generating` with
its `cards` emptied and a `retried` flag set. The status line reads the retry
message while `retried && cards.length === 0`, so it appears the moment the
first attempt is discarded and clears itself as soon as the second attempt
produces something — no extra transition to manage.

- `retry` clears `cards` but keeps `classification` and the running clock.
- `error` lands on `review` with the existing hand-editable fallback card and
  `generationFailed: true`, so the flow is still never a dead end. One honest
  improvement over today: if `classified` already arrived, the **real**
  classification is kept instead of being overwritten with
  `{ domain: "concept", language: null, partOfSpeech: null }`. The current code
  cannot distinguish "classification failed" from "generation failed"; with the
  streamed protocol it can, so the saved note records what was actually detected.
- `startedAt` is supplied by the component, keeping the reducer pure and the
  whole machine unit-testable.

## 5. UI

### `src/lib/generation-status.ts` (new)

Pure `generationStatusText(state): string` and `formatElapsed(ms): string`.

```
0:01  Working out what this is…
0:03  Language · de · noun — writing cards…
0:06  Writing the gender card…
0:11  4 cards ready
```

Every line is derived from a server event; nothing is decorative. The
aspect-naming rule: name the current card's aspect **only once its `front` is
non-null**, which means the aspect string has finished streaming — otherwise fall
back to "writing cards…", so the UI never briefly announces "Writing the gen
card…". Underscores in open-vocabulary aspects become spaces (`roman_name` →
"roman name"). A retry reads "That came back malformed — trying once more…".

### `src/components/generation-status.tsx` (new)

Status line plus an `m:ss` timer on a one-second interval.

`aria-live="polite"` goes on the **text** element only; the timer is
`aria-hidden`. Otherwise a screen reader announces the clock once a second.

### `src/components/streaming-cards.tsx` (new)

Read-only partial cards in the same `<Card>` chrome as the review list. A `null`
field renders `<Skeleton className="h-8 w-full" />`, matching `Input`'s `h-8`, so
nothing shifts when the list becomes editable. The list is padded with
placeholder skeleton cards up to three while the first card streams, so it does
not lurch. `aria-busy="true"` on the list.

### `src/components/card-editor.tsx` (new)

The editable card — `Card`, remove button, front and back `Input`s — lifted
verbatim out of `_authed.add.tsx`.

### `src/routes/_authed.add.tsx`

Shrinks to orchestration: `useReducer(generationReducer, …)`, an
`AbortController` in a ref, and

```ts
for await (const event of generateNoteStream(text, nativeLanguage, signal)) {
  dispatch(event)
}
```

`AbortError` is swallowed — a cancel is not a failure.

Generation and review are the same screen. The heading stays "Review cards", the
status line sits under it, and the card list swaps from `StreamingCards` to
`CardEditor`s on `done`. Streamed cards are **read-only**: inputs, remove buttons
and Save activate only when the stream completes, so no local edit can be
clobbered by a later delta. Cancel replaces Save while generating.

Everything below the list is unchanged: the blank-card guard, the save-error
alert, and navigating to the deck on success.

## Error handling

| Failure | Behaviour |
|---|---|
| Not signed in, or invalid body | Real 401/400 JSON, before the stream opens |
| Model output fails validation once | `retry` event; cards clear, timer keeps running, status explains why |
| Model output fails validation twice | `error` event; fallback to a hand-editable card |
| Model or network failure mid-stream | `error` event; same fallback |
| Connection drops with no terminal event | Synthetic `error` from `generateNoteStream`; same fallback |
| User cancels | Abort the signal, return to `idle`, no error surfaced |

## Testing

`deno task test` (vitest, already configured to cover both `src/**` and
`supabase/functions/**`):

- **`src/lib/sse.test.ts`** — an event split across chunk boundaries; a multi-byte
  character split across chunks; multi-line `data:`; `:` heartbeats ignored; a
  trailing event with no terminator; an empty stream.
- **`src/lib/generation-state.test.ts`** — happy path; retry clears cards but keeps
  classification and `startedAt`; an error after `classified` keeps the real
  classification; an error before `classified` falls back to `concept`; both error
  paths set `generationFailed`; cancel returns to `idle`.
- **`src/lib/generation-status.test.ts`** — text per phase; the `front !== null`
  aspect rule; underscore humanisation; `formatElapsed` at `0:07`, `1:05`,
  `10:00`.
- **`supabase/functions/_shared/generate.test.ts`** — extended for
  `streamWithRetry`: a clean first attempt fires neither retry path; `onPartial`
  receives accumulated rather than per-delta text; a retry resets the accumulator
  and fires `onRetry`; two failures throw. Existing `parseWithRetry` tests stay
  untouched.
- **`supabase/functions/_shared/sse.test.ts`** — event framing.

No component tests, matching the existing convention — the repo has no `.test.tsx`
and the sign-in-guard spec records that there is no route or component harness.
That is tolerable here specifically because every branch worth testing was pushed
into the four pure modules above; the components are left as thin rendering.

## Out of scope

Streaming the image generation (it runs after save), resuming a generation across
a page reload, a retry-from-the-UI button, and per-card regeneration.
