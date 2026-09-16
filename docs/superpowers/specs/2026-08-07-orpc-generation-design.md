# Incremental generation over oRPC

Move card generation off its hand-written server-sent-events protocol and onto an
oRPC event iterator — closing issue
[#3](https://github.com/unfixed3854/mnimi/issues/3).

Nothing changes on screen. This is a transport migration: the same five phases
of the same two-pass generation, delivered by the same client that already
carries every other call.

## Problem

`generate-note` is the one thing in the app that is not an oRPC procedure. When
it was written, streaming was the reason: oRPC's event iterators were not part
of the design, so the feature got a Hono route, a wire protocol, and a reader at
each end.

That bought four costs.

**A protocol maintained by hand.** `server/ai/sse.ts` frames events;
`src/lib/sse.ts` parses records back out, including the buffering, the
multi-byte-character straddle, and the `data:` field handling. Both are correct
and both are tested, and neither carries a single line of application meaning.

**Types mirrored across the wire.** `Classification`, `GeneratedCard`,
`GeneratedNote`, `PartialCard` and the `GenerationEvent` union are declared once
in `server/ai/schemas.ts` and again in `src/lib/api/ai.ts`, with a comment on
each explaining that the two must agree. Nothing checks that they do. Every
other call in the app gets that check for free from `RouterClient<AppRouter>`.

**Auth and validation reimplemented.** The route calls
`auth.api.getSession(...)` itself, parses its own body with Zod, and returns its
own 401 and 400 — work the `authed` middleware and `.input()` already do for the
eleven other procedures.

**An error path shaped by a constraint.** Once an SSE response's headers are
written the status code is committed, so a failure after that point cannot be an
HTTP error. Hence `{ type: "error" }`: a failure smuggled through as a
successful stream. The client then has to synthesise the same event when a
stream simply stops, because a dropped connection and a corrupt frame are
indistinguishable to a reader.

The client pays for all of it at the call site. `generateNoteStream` builds its
own `fetch`, attaches the bearer token by hand, and inspects
`response.status === 401` — the one place in `src/lib/api/` that touches HTTP at
all.

## Approach

`ai.generateNote` becomes an oRPC procedure whose handler is an async generator.
oRPC 1.14.14 — already a dependency — serialises an async iterator natively over
the RPC link, so the client receives an async iterable and `for await` reads
events off it.

Two alternatives were considered.

**Keep the route, keep the protocol, share the types.** The cheapest fix for the
mirroring problem alone: import the server's types into the client with the
`~server` alias that `src/lib/orpc.ts` already uses. It leaves the framing code,
the duplicated auth, and the error-as-event workaround in place, and it makes
the client depend on server modules without gaining the call site that would
justify it.

**Adopt oRPC's event iterator but keep all five events verbatim.** The smallest
possible diff. Rejected because `{ type: "error" }` exists only to work around a
constraint this migration removes: an iterator that throws mid-stream reaches
the client as a rejected iteration, which is what the client's error handling
already expects from every other call.

The chosen shape yields four events and throws on failure.

## 1. The generator

`server/routes/generate-note.ts` today mixes three concerns: HTTP (auth, body
parsing), generation (prompts, two passes, retry), and framing. It has no test
file — the generation logic is only reachable through a request.

The generation half moves to `server/ai/generate-note.ts` as a pure async
generator. No auth, no HTTP, no framing:

```ts
export type GenerationEvent =
  | { type: "classified"; classification: Classification }
  | { type: "cards"; cards: PartialCard[] }
  | { type: "retry" }
  | { type: "done"; classification: Classification; generation: GeneratedNote };

export async function* generateNote(
  input: { text: string; nativeLanguage: string },
  models: ModelCalls,
): AsyncGenerator<GenerationEvent>;
```

The prompts (`CLASSIFY_PROMPT`, the generate pass's user message) move with it —
they are generation, not transport.

### The callback-to-yield bridge

`streamWithRetry` reports progress through `onPartial` and `onRetry` callbacks,
and a callback cannot `yield`. The awaits that would have to drain a buffer are
inside `streamWithRetry` itself, so no amount of buffering at the call site
helps.

`streamWithRetry` becomes an async generator that yields its progress and
*returns* its validated value:

```ts
export async function* streamWithRetry<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null) => AsyncGenerator<string, unknown>,
): AsyncGenerator<{ type: "partial"; raw: string } | { type: "retry" }, T>;
```

`attempt` yields raw deltas and returns the model's unvalidated object;
`streamWithRetry` accumulates the deltas, so the per-attempt accumulator that
makes "discard what is on screen and start again" fall out of the state machine
stays exactly where it is. `yield*` carries `attempt`'s return value through.

`generateNote` drives it with an explicit `.next()` loop rather than `yield*`,
because it has to map each partial through `parsePartialJSON` and `projectCards`
and drop snapshots that did not change:

```ts
const stream = streamWithRetry(generatedNoteSchema, attempt);
let step = await stream.next();
while (!step.done) {
  if (step.value.type === "retry") {
    lastSnapshot = "";
    yield { type: "retry" };
  } else {
    const cards = projectCards(parsePartialJSON(step.value.raw));
    const snapshot = JSON.stringify(cards);
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      yield { type: "cards", cards };
    }
  }
  step = await stream.next();
}
yield { type: "done", classification, generation: step.value };
```

`parseWithRetry` is unchanged — the classify pass is not streamed.

A queue that the callbacks push to and the generator drains was the alternative.
Rejected: a new concurrency primitive, with its own ordering and close-on-error
failure modes, bought to avoid a ten-line loop.

### `ModelCalls`

```ts
export type ModelCalls = {
  classify(prompts: { system: string; user: string }): Promise<unknown>;
  generate(
    prompts: { system: string; user: string },
  ): AsyncGenerator<string, unknown>;
};
```

The two `chat()` invocations, injected. Everything else about generation stays
in `generate-note.ts`; only the network call is swappable, so a test drives the
whole generator with canned deltas and never reaches OpenRouter. This is the
pattern `AppContext.generateImageBytes` and `AppContext.writeImage` already use.

`generate` returns the model's unvalidated structured object, exactly as the
current `attempt` does, and throws on `RUN_ERROR` for the reason recorded in
today's comment: the adapter yields `RUN_ERROR` and returns normally rather than
throwing, so leaving it unhandled burns a retry against a provider that just
failed.

The real implementations move to `server/ai/model-calls.ts`, which is the only
new module importing `@tanstack/ai` and `server/ai/openrouter.ts`.

## 2. The procedure

`server/router/ai.ts` gains roughly twenty lines beside `generateImage`:

```ts
const generateNoteProcedure = authed
  .input(z.object({
    text: z.string().min(1).max(200),
    nativeLanguage: z.string().min(2).max(10),
  }))
  .handler(async function* ({ input, context }) {
    try {
      yield* generateNote(input, context.modelCalls ?? openRouterCalls);
    } catch (error) {
      console.error("generateNote failed", error);
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Generation failed",
      });
    }
  });

export const aiRouter = {
  generateImage: generateImageProcedure,
  generateNote: generateNoteProcedure,
};
```

`AppContext` gains `modelCalls?: ModelCalls`, documented like its neighbours as
overridden in tests so no request ever reaches a model.

No `.output()`. No other procedure in the router validates its output,
`PartialCard` is deliberately not a Zod schema, and validating every partial
snapshot would cost work per delta for no guarantee the client acts on. The
client's type is inferred from the handler's return type through
`RouterClient<AppRouter>`, which is what closes the mirroring problem.

The explicit `ORPCError` is load-bearing: oRPC replaces the message of any other
thrown error with "Internal server error". Wrapping preserves the exact string
the UI renders in its destructive alert today, while the detail stays in the
server log — the same split the current `catch` makes.

Auth and input validation now run *before* the iterator opens, so the constraint
that shaped the old error path is gone along with the comment describing it.

`server/app.ts` drops the `/api/generate-note` registration and its import;
`server/routes/` is deleted.

## 3. The client

`src/lib/api/ai.ts` keeps the two functions its callers use — `generateNoteStream`
and `generateNoteImage` — and loses its HTTP:

```ts
export async function* generateNoteStream(
  text: string,
  nativeLanguage: string,
  signal?: AbortSignal,
): AsyncGenerator<GenerationEvent> {
  let terminated = false;
  try {
    const events = await client.ai.generateNote(
      { text, nativeLanguage },
      { signal },
    );
    for await (const event of events) {
      if (event.type === "done") terminated = true;
      yield event;
    }
  } catch (error) {
    throw await asSessionError(error);
  }
  if (!terminated) throw new Error(CONNECTION_DROPPED_MESSAGE);
}
```

The five mirrored type declarations become type-only re-exports from
`~server/ai/generate-note` and `~server/ai/schemas`, so the components importing
`PartialCard` and `GeneratedCard` from `@/lib/api/ai` do not change. The alias is
already in `tsconfig.json` and `vitest.config.ts`, and `src/lib/orpc.ts` already
type-imports the router through it.

`asSessionError` is the 401 handling that `generateNoteImage` performs inline
today — an `ORPCError` with status 401 becomes `clearRejectedSession()` plus a
`SessionExpiredError`, anything else passes through — extracted so both AI calls
share one copy. Generation reaching this path through `ORPCError` rather than a
raw status code is the point: it converges on what every other call already did.

The dropped-connection guard stays, because it protects the UI's worst failure
mode — skeletons forever — and oRPC makes no promise about how a truncated
stream surfaces. It now throws rather than yielding an event.
`runGeneration`'s existing `catch` turns that into the same
`{ type: "error", message }` dispatch it produced before, so the reducer sees no
difference. Its abort and `SessionExpiredError` branches are unchanged and still
correct: an aborted iteration rejects, and the signal is still the one thing
both abort paths flip.

`GenerationAction` in `src/lib/generation-state.ts` declares
`{ type: "error"; message: string }` explicitly, now that it no longer arrives
as part of `GenerationEvent`. The reducer body is untouched.

`readGenerationEvents` is inlined into `generateNoteStream` — with no framing
left to parse, splitting the two only hides the loop.

## 4. Deleted

- `server/ai/sse.ts` and `server/ai/sse.test.ts`
- `server/routes/generate-note.ts`, and `server/routes/` with it
- `src/lib/sse.ts` and `src/lib/sse.test.ts`
- `readGenerationEvents`, the hand-built `fetch`, and the five mirrored type
  declarations in `src/lib/api/ai.ts`
- the `{ type: "error" }` member of `GenerationEvent`
- the two `/api/generate-note` cases in `server/app.test.ts`

## 5. Tests

The suite is 234 tests across 28 files before this change and must be green
after it.

**New — `server/ai/generate-note.test.ts`.** The generation logic's first direct
test, driven by a fake `ModelCalls`:

- the happy path yields `classified`, one or more `cards`, then `done`, in that
  order, with `done` carrying the validated generation
- a first generate pass that fails validation yields `retry` before the second
  pass's `cards`, and the cards yielded after `retry` do not include the
  discarded attempt's
- two identical partial snapshots yield one `cards` event, not two
- a classify pass that fails validation twice throws
- a `generate` that throws propagates rather than yielding

**New cases — `server/router/ai.test.ts`.** Against the same real-SQLite harness
the other procedure tests use:

- an unauthenticated call rejects with `UNAUTHORIZED` and the fake `ModelCalls`
  is never invoked
- input outside the schema's bounds rejects before any model call
- a generator that throws surfaces `message === "Generation failed"`, and the
  underlying error's text appears nowhere in what the client receives

**Adapted — `server/ai/generate.test.ts`.** `streamWithRetry`'s existing cases
(one-retry contract, per-attempt accumulator, two failures throw) re-expressed
against the generator signature: collect yields, assert the returned value.
`parseWithRetry` and `projectCards` cases are unchanged.

**Rewritten — `src/lib/api/ai.test.ts`.** Against a stubbed `client.ai`:

- events pass through in order
- an `ORPCError` with status 401 clears the session and throws
  `SessionExpiredError`
- a stream that ends without `done` throws the dropped-connection error
- `signal` is forwarded to the client call

**Amended — `src/lib/session-rejection.test.ts`.** Its `/api/generate-note`
constant becomes an `/rpc` URL; the assertions are unchanged, since `/rpc` is
now the only non-auth path that 401s.

**Unchanged.** `run-generation`, `generation-state`, `generation-status`,
`streaming-cards`, and every other existing file. That they need no edits is the
evidence that this is a transport change.

## 6. Verification beyond the suite

Two properties the suite cannot show, checked by running the app before the
issue is closed:

- **It streams.** Cards materialise field by field on `/add` as they do today.
  A regression here is silent — a buffered iterator produces a correct note
  after one long pause, and every test still passes.
- **Cancel stops the work.** Cancelling mid-generation aborts the server
  generator rather than leaving a model call running to completion, so a
  cancelled generation stops costing money.

Desktop is enough for both; neither is platform-specific.

## 7. Docs

`README.md`'s "AI endpoints" section loses the paragraph explaining that
`generate-note` is "Not an oRPC procedure … because it streams" and describes
`ai.generateNote` alongside `ai.generateImage`. The "Layout" tree drops
`server/routes/` and `src/lib/sse.ts` and gains `server/ai/generate-note.ts` and
`server/ai/model-calls.ts`.

`docs/superpowers/specs/2026-07-30-streaming-generation-design.md` stays as
written. It records why the protocol was hand-rolled, which was correct at the
time; this spec supersedes its transport sections and leaves its event
vocabulary and UI design intact.
