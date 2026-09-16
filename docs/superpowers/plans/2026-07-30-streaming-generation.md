# Streaming Card Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/add` card generation from a disabled button into a screen that streams cards in from skeletons, narrates the real model phase, and shows an elapsed timer.

**Architecture:** The `generate-note` edge function responds with `text/event-stream` and emits five typed events (`classified`, `cards`, `retry`, `done`, `error`). It partial-parses the model's JSON server-side, so the browser receives card objects rather than JSON fragments. On the client a hand-written SSE reader feeds a pure reducer; all branching lives in four pure modules under `src/lib/`, leaving the components as thin rendering.

**Tech Stack:** Deno + `@tanstack/ai` (OpenRouter) in Supabase Edge Functions; React 19 + TanStack Router + Tailwind v4 + shadcn/ui on the client; Zod for validation; vitest for tests.

**Spec:** `docs/superpowers/specs/2026-07-30-streaming-generation-design.md`

## Global Constraints

- Use `deno` for all package management and script execution. Never `npm`, `npx`, `yarn` or `pnpm` (`AGENTS.md`).
- Full test command: `deno task test`. Baseline before this plan: **8 files, 67 tests, all passing.**
- Deno files under `supabase/functions/` import siblings **with the `.ts` extension** (`import { corsHeaders } from "./cors.ts"`). Vite resolves this fine, so those modules stay vitest-testable.
- Client files under `src/` import siblings **without** an extension, using the `@/` alias for absolute paths.
- `vitest.config.ts` already covers `src/**/*.test.ts(x)` and `supabase/functions/**/*.test.ts`. No config change is needed.
- **Never import `@tanstack/ai` from a module that vitest loads.** It is a Deno-only dependency and is absent from `node_modules`. Anything imported by a `.test.ts` must be free of it.
- `parsePartialJSON` is exported from the `@tanstack/ai` **main** entry (verified in 0.42.0). Do not add a `@tanstack/ai/client` subpath — the import map in `supabase/functions/deno.json` has no prefix key for it and it would fail to resolve.
- On the streaming path `@tanstack/ai` deliberately does **not** validate against `outputSchema`. Validation stays ours.
- Existing code style: double quotes, semicolons, 2-space indent. Comments explain *why*, not *what*.
- Edge function changes require `supabase stop && supabase start` to take effect. `supabase functions serve` does not work on this setup — see README troubleshooting.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/functions/_shared/sse.ts` | **new** — SSE record framing and the streaming `Response` |
| `supabase/functions/_shared/sse.test.ts` | **new** — framing and header tests |
| `supabase/functions/_shared/generate.ts` | **modify** — add `streamWithRetry` and `projectCards`; extract `validationFeedback` |
| `supabase/functions/_shared/generate.test.ts` | **modify** — add `streamWithRetry` and `projectCards` suites |
| `supabase/functions/_shared/schemas.ts` | **modify** — reorder `generatedNoteSchema`; add the `PartialCard` type |
| `supabase/functions/generate-note/index.ts` | **modify** — stream instead of returning one JSON blob |
| `src/lib/sse.ts` | **new** — `readEventStream`, the browser-side SSE reader |
| `src/lib/sse.test.ts` | **new** |
| `src/lib/api/ai.ts` | **modify** — replace `generateNote` with `generateNoteStream` + `readGenerationEvents` |
| `src/lib/api/ai.test.ts` | **new** — `readGenerationEvents` only (no Supabase involved) |
| `src/lib/generation-state.ts` | **new** — the whole state machine, pure |
| `src/lib/generation-state.test.ts` | **new** |
| `src/lib/generation-status.ts` | **new** — status text and elapsed formatting, pure |
| `src/lib/generation-status.test.ts` | **new** |
| `src/components/card-editor.tsx` | **new** — one editable card, lifted out of the route |
| `src/components/streaming-cards.tsx` | **new** — read-only partial cards with skeletons |
| `src/components/generation-status.tsx` | **new** — status line and timer |
| `src/routes/_authed.add.tsx` | **modify** — orchestration only |

Task order follows the dependency chain: framing → retry helper → edge function → client transport → state → status text → components → route.

---

### Task 1: SSE framing, both ends

Server writer and browser reader. Paired because they define one wire format, but each is tested independently — the client test hand-writes the same framing rather than importing Deno code.

**Files:**
- Create: `supabase/functions/_shared/sse.ts`
- Create: `supabase/functions/_shared/sse.test.ts`
- Create: `src/lib/sse.ts`
- Create: `src/lib/sse.test.ts`

**Interfaces:**
- Consumes: `corsHeaders` from `supabase/functions/_shared/cors.ts`
- Produces:
  - `encodeEvent(payload: unknown): Uint8Array`
  - `eventStreamResponse(producer: (send: (payload: unknown) => void) => Promise<void>): Response`
  - `readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string>`

- [ ] **Step 1: Write the failing server test**

Create `supabase/functions/_shared/sse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { encodeEvent, eventStreamResponse } from "./sse";

const decoder = new TextDecoder();

describe("encodeEvent", () => {
  it("frames a payload as a data record terminated by a blank line", () => {
    expect(decoder.decode(encodeEvent({ type: "retry" }))).toBe(
      'data: {"type":"retry"}\n\n',
    );
  });

  it("escapes newlines in the payload so they cannot split the record", () => {
    const framed = decoder.decode(encodeEvent({ text: "a\nb" }));
    expect(framed).toBe('data: {"text":"a\\nb"}\n\n');
    expect(framed.indexOf("\n\n")).toBe(framed.length - 2);
  });
});

describe("eventStreamResponse", () => {
  it("declares the SSE content type and keeps the CORS headers", () => {
    const response = eventStreamResponse(async () => {});
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("streams everything the producer sends, in order", async () => {
    const response = eventStreamResponse(async (send) => {
      send({ type: "retry" });
      send({ type: "done" });
    });
    expect(await response.text()).toBe(
      'data: {"type":"retry"}\n\ndata: {"type":"done"}\n\n',
    );
  });

  it("closes the stream even when the producer throws", async () => {
    const response = eventStreamResponse(async (send) => {
      send({ type: "retry" });
      throw new Error("boom");
    });
    await expect(response.text()).resolves.toBe('data: {"type":"retry"}\n\n');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `deno task test sse`
Expected: FAIL — `Failed to resolve import "./sse"`. (Test files import siblings
without the extension, matching `generate.test.ts`; the modules themselves keep
the `.ts` extension Deno requires.)

- [ ] **Step 3: Implement the server writer**

Create `supabase/functions/_shared/sse.ts`:

```ts
import { corsHeaders } from "./cors.ts";

const encoder = new TextEncoder();

/**
 * Frames one payload as a server-sent event. JSON.stringify escapes any
 * newline inside the payload, so a card's text can never accidentally
 * terminate the record.
 */
export function encodeEvent(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Streams whatever `producer` sends. Note that the status code is committed
 * the moment this returns: a failure inside `producer` can no longer become an
 * HTTP error, so the producer is responsible for reporting its own failures as
 * events. The `finally` here only guarantees the stream closes rather than
 * hanging the client.
 */
export function eventStreamResponse(
  producer: (send: (payload: unknown) => void) => Promise<void>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await producer((payload) => controller.enqueue(encodeEvent(payload)));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `deno task test sse`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing client test**

Create `src/lib/sse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readEventStream } from "./sse";

function streamOf(
  ...chunks: Array<string | Uint8Array>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of readEventStream(stream)) out.push(data);
  return out;
}

describe("readEventStream", () => {
  it("yields each event's data payload", async () => {
    await expect(
      collect(streamOf('data: {"a":1}\n\ndata: {"b":2}\n\n')),
    ).resolves.toEqual(['{"a":1}', '{"b":2}']);
  });

  it("reassembles an event split across chunk boundaries", async () => {
    await expect(collect(streamOf('data: {"a', '":1}\n', "\n"))).resolves.toEqual(
      ['{"a":1}'],
    );
  });

  it("keeps a multi-byte character split across chunks intact", async () => {
    const bytes = new TextEncoder().encode('data: {"v":"ä"}\n\n');
    // "ä" is two bytes at offsets 12 and 13; cut between them.
    await expect(
      collect(streamOf(bytes.slice(0, 13), bytes.slice(13))),
    ).resolves.toEqual(['{"v":"ä"}']);
  });

  it("joins multiple data lines in one event with a newline", async () => {
    await expect(collect(streamOf("data: one\ndata: two\n\n"))).resolves.toEqual(
      ["one\ntwo"],
    );
  });

  it("ignores comment heartbeats and records carrying no data field", async () => {
    await expect(
      collect(streamOf(": ping\n\nevent: tick\n\ndata: real\n\n")),
    ).resolves.toEqual(["real"]);
  });

  it("yields a final event that arrives without its terminating blank line", async () => {
    await expect(collect(streamOf("data: last"))).resolves.toEqual(["last"]);
  });

  it("yields nothing for an empty stream", async () => {
    await expect(collect(streamOf())).resolves.toEqual([]);
  });
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `deno task test sse`
Expected: the server suite passes; the client suite FAILS with `Failed to resolve import "./sse"`.

- [ ] **Step 7: Implement the client reader**

Create `src/lib/sse.ts`:

```ts
/**
 * Reads a `text/event-stream` body and yields each event's `data` payload.
 *
 * Hand-written rather than taken from a library: this app needs exactly this
 * and nothing more, and the obvious alternative (`fetchServerSentEvents`)
 * ships inside a chat-transcript hook that has no use here.
 *
 * Records are separated by "\n\n" only. Both ends of this stream are ours, so
 * CRLF framing is not handled.
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` holds back a multi-byte character that straddles two
      // chunks instead of decoding half of it as a replacement character.
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const data = dataOf(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        if (data !== null) yield data;
        separator = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    // SSE only requires the blank line *between* records, so a stream that
    // ends right after its last event still carries a complete one.
    const data = dataOf(buffer);
    if (data !== null) yield data;
  } finally {
    reader.releaseLock();
  }
}

/**
 * The `data` payload of one record, or null if it carries none — `:` comment
 * heartbeats and lone `event:` / `id:` fields do not.
 */
function dataOf(record: string): string | null {
  const lines = record
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    // A single space after the colon is framing, not payload.
    .map((line) => line.slice(5).replace(/^ /, ""));

  return lines.length > 0 ? lines.join("\n") : null;
}
```

- [ ] **Step 8: Run the full suite**

Run: `deno task test`
Expected: PASS — 10 files, 79 tests (67 baseline + 5 server + 7 client).

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/sse.ts supabase/functions/_shared/sse.test.ts src/lib/sse.ts src/lib/sse.test.ts
git commit -m "feat: add server-sent event framing and reader"
```

---

### Task 2: `streamWithRetry`

The streaming twin of `parseWithRetry`, with the accumulator that makes the honest retry reset fall out of the state machine.

**Files:**
- Modify: `supabase/functions/_shared/generate.ts`
- Modify: `supabase/functions/_shared/generate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  streamWithRetry<T>(
    schema: z.ZodType<T>,
    attempt: (feedback: string | null, onDelta: (delta: string) => void) => Promise<unknown>,
    handlers: { onPartial: (raw: string) => void; onRetry: () => void },
  ): Promise<T>
  ```
  `parseWithRetry` keeps its existing signature and behaviour unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/_shared/generate.test.ts`, and change line 3's import to
`import { parseWithRetry, streamWithRetry } from "./generate";`:

```ts
describe("streamWithRetry", () => {
  const handlers = () => ({ onPartial: vi.fn(), onRetry: vi.fn() });

  it("returns the parsed value and never retries when the first attempt is valid", async () => {
    const spies = handlers();
    const attempt = vi.fn().mockResolvedValue({ name: "ok" });

    await expect(streamWithRetry(schema, attempt, spies)).resolves.toEqual({
      name: "ok",
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(spies.onRetry).not.toHaveBeenCalled();
  });

  it("reports accumulated text rather than individual deltas", async () => {
    const spies = handlers();
    const attempt = vi.fn(
      async (_feedback: string | null, onDelta: (delta: string) => void) => {
        onDelta('{"na');
        onDelta('me":"ok"}');
        return { name: "ok" };
      },
    );

    await streamWithRetry(schema, attempt, spies);
    expect(spies.onPartial.mock.calls.map((call) => call[0])).toEqual([
      '{"na',
      '{"name":"ok"}',
    ]);
  });

  it("resets the accumulator before the retry so partial output is discarded", async () => {
    const spies = handlers();
    const attempt = vi
      .fn()
      .mockImplementationOnce(
        async (_feedback: string | null, onDelta: (delta: string) => void) => {
          onDelta("junk");
          return { nome: "typo" };
        },
      )
      .mockImplementationOnce(
        async (_feedback: string | null, onDelta: (delta: string) => void) => {
          onDelta('{"name":"fixed"}');
          return { name: "fixed" };
        },
      );

    await expect(streamWithRetry(schema, attempt, spies)).resolves.toEqual({
      name: "fixed",
    });
    expect(spies.onRetry).toHaveBeenCalledTimes(1);
    expect(spies.onPartial.mock.calls.map((call) => call[0])).toEqual([
      "junk",
      '{"name":"fixed"}',
    ]);
  });

  it("retries with the validation error as feedback", async () => {
    const spies = handlers();
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ nome: "typo" })
      .mockResolvedValueOnce({ name: "fixed" });

    await streamWithRetry(schema, attempt, spies);
    expect(attempt.mock.calls[0][0]).toBeNull();
    expect(attempt.mock.calls[1][0]).toContain("name");
  });

  it("throws after a second failure rather than retrying forever", async () => {
    const spies = handlers();
    const attempt = vi.fn().mockResolvedValue({ wrong: true });

    await expect(streamWithRetry(schema, attempt, spies)).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `deno task test generate`
Expected: FAIL — `streamWithRetry is not a function` (or an import error). The four existing `parseWithRetry` tests still pass.

- [ ] **Step 3: Implement**

Replace the body of `supabase/functions/_shared/generate.ts` with:

```ts
import type { z } from "zod";

/** The correction prompt fed back to the model after a failed validation. */
function validationFeedback(issues: unknown): string {
  return (
    `Your previous response failed validation with these errors:\n` +
    JSON.stringify(issues, null, 2) +
    `\nReturn corrected JSON matching the schema exactly.`
  );
}

/**
 * Runs an attempt, validates it, and on failure retries exactly once with the
 * validation error fed back so the model can correct itself. Two failures is
 * a real failure — the caller falls back to a hand-editable empty draft
 * rather than looping and burning tokens.
 */
export async function parseWithRetry<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null) => Promise<unknown>,
): Promise<T> {
  const first = schema.safeParse(await attempt(null));
  if (first.success) return first.data;

  const second = schema.safeParse(
    await attempt(validationFeedback(first.error.issues)),
  );
  if (second.success) return second.data;

  throw new Error(
    `Model output failed validation twice: ${JSON.stringify(second.error.issues)}`,
  );
}

/**
 * The streaming twin of {@link parseWithRetry}: same one-retry contract, with
 * the text surfaced as it arrives so the caller can render partial output.
 *
 * The accumulator is per-attempt, so a retry starts from an empty string
 * before `onRetry` fires. That is what makes "discard what is on screen and
 * start again" fall out of the state machine instead of having to be
 * coordinated by the caller.
 */
export async function streamWithRetry<T>(
  schema: z.ZodType<T>,
  attempt: (
    feedback: string | null,
    onDelta: (delta: string) => void,
  ) => Promise<unknown>,
  handlers: { onPartial: (raw: string) => void; onRetry: () => void },
): Promise<T> {
  const run = (feedback: string | null) => {
    let raw = "";
    return attempt(feedback, (delta) => {
      raw += delta;
      handlers.onPartial(raw);
    });
  };

  const first = schema.safeParse(await run(null));
  if (first.success) return first.data;

  handlers.onRetry();

  const second = schema.safeParse(
    await run(validationFeedback(first.error.issues)),
  );
  if (second.success) return second.data;

  throw new Error(
    `Model output failed validation twice: ${JSON.stringify(second.error.issues)}`,
  );
}
```

- [ ] **Step 4: Run the full suite**

Run: `deno task test`
Expected: PASS — 84 tests (79 + 5).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/generate.ts supabase/functions/_shared/generate.test.ts
git commit -m "feat: add streamWithRetry alongside parseWithRetry"
```

---

### Task 3: Stream from `generate-note`

Schema reorder, the partial-card projection, and the edge function rewritten to emit events.

**Files:**
- Modify: `supabase/functions/_shared/schemas.ts`
- Modify: `supabase/functions/_shared/generate.ts` (add `projectCards`)
- Modify: `supabase/functions/_shared/generate.test.ts`
- Modify: `supabase/functions/generate-note/index.ts` (full rewrite)

**Interfaces:**
- Consumes: `eventStreamResponse` (Task 1), `streamWithRetry` (Task 2).
- Produces:
  - `type PartialCard = { aspect: string | null; front: string | null; back: string | null }` from `_shared/schemas.ts`
  - `projectCards(parsed: unknown): PartialCard[]` from `_shared/generate.ts`
  - The five-event wire protocol consumed by Task 4.

- [ ] **Step 1: Write the failing `projectCards` tests**

Append to `supabase/functions/_shared/generate.test.ts` and extend line 3's import to
`import { parseWithRetry, projectCards, streamWithRetry } from "./generate";`:

```ts
describe("projectCards", () => {
  it("returns nothing until the cards array exists", () => {
    expect(projectCards(undefined)).toEqual([]);
    expect(projectCards({})).toEqual([]);
    expect(projectCards({ cards: "not an array" })).toEqual([]);
  });

  it("nulls every field the model has not reached yet", () => {
    expect(projectCards({ cards: [{ aspect: "gender" }] })).toEqual([
      { aspect: "gender", front: null, back: null },
    ]);
  });

  it("passes a half-written string through so it renders as it arrives", () => {
    expect(
      projectCards({ cards: [{ aspect: "meaning", front: "die Ba" }] }),
    ).toEqual([{ aspect: "meaning", front: "die Ba", back: null }]);
  });

  it("drops non-string values rather than leaking them to the client", () => {
    expect(projectCards({ cards: [{ aspect: 7, front: null, back: {} }] })).toEqual(
      [{ aspect: null, front: null, back: null }],
    );
  });

  it("keeps only the three fields the streaming UI renders", () => {
    expect(
      projectCards({
        cards: [{ aspect: "meaning", front: "a", back: "b", hint: "h" }],
      }),
    ).toEqual([{ aspect: "meaning", front: "a", back: "b" }]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `deno task test generate`
Expected: FAIL — `projectCards is not a function`.

- [ ] **Step 3: Add the `PartialCard` type**

In `supabase/functions/_shared/schemas.ts`, append:

```ts
/**
 * A card mid-stream. Deliberately not a Zod schema: it describes what the
 * model has emitted so far, so every field is null until it arrives and there
 * is nothing to validate. `src/lib/api/ai.ts` mirrors this type — the two meet
 * over the wire, not through an import, because the client cannot load Deno
 * modules.
 */
export type PartialCard = {
  aspect: string | null;
  front: string | null;
  back: string | null;
};
```

Also reorder `generatedNoteSchema` in the same file:

```ts
export const generatedNoteSchema = z.object({
  // `cards` first so the model emits them first: JSON keys arrive in schema
  // order, and the UI streams cards, not the image prompt.
  cards: z.array(generatedCardSchema).min(1),
  imagePrompt: z.string().nullish().transform((v) => v ?? null),
});
```

- [ ] **Step 4: Implement `projectCards`**

Append to `supabase/functions/_shared/generate.ts`, and add
`import type { PartialCard } from "./schemas.ts";` at the top:

```ts
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Projects a partially-parsed generation onto the card shape the client
 * renders. Takes the already-parsed value rather than the raw string so this
 * stays free of `@tanstack/ai`, which vitest cannot resolve.
 */
export function projectCards(parsed: unknown): PartialCard[] {
  const cards = (parsed as { cards?: unknown } | undefined)?.cards;
  if (!Array.isArray(cards)) return [];

  return cards.map((card) => ({
    aspect: stringOrNull(card?.aspect),
    front: stringOrNull(card?.front),
    back: stringOrNull(card?.back),
  }));
}
```

- [ ] **Step 5: Run to confirm the unit tests pass**

Run: `deno task test`
Expected: PASS — 89 tests (84 + 5). `schemas.test.ts` must still pass; the reorder is behaviourally neutral.

- [ ] **Step 6: Rewrite the edge function**

Replace `supabase/functions/generate-note/index.ts` entirely:

```ts
import { chat, parsePartialJSON } from "@tanstack/ai";
import { z } from "zod";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { eventStreamResponse } from "../_shared/sse.ts";
import { getUser } from "../_shared/auth.ts";
import { classifyModel, generateModel, textAdapter } from "../_shared/openrouter.ts";
import { buildSystemPrompt } from "../_shared/rule-packs.ts";
import { classificationSchema, generatedNoteSchema } from "../_shared/schemas.ts";
import { parseWithRetry, projectCards, streamWithRetry } from "../_shared/generate.ts";

const requestSchema = z.object({
  text: z.string().min(1).max(200),
  nativeLanguage: z.string().min(2).max(10),
});

const CLASSIFY_PROMPT = `
You classify a single thing a learner wants to remember.

Decide whether it is a language-learning item — a word, phrase or grammatical
form in a language the learner is studying — or something else entirely, such
as a person, a scientific concept, a historical event or a quotation.

Set domain to "language" only for language-learning items. Otherwise use a
short lowercase label describing what it is: concept, person, place, event,
phrase, formula.

For language items set language to the target language code and partOfSpeech
to the word class. For everything else leave both null.
`.trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth and request validation run before a single byte is written. Once the
  // event stream opens the status code is committed, so everything after this
  // point has to report failure as an `error` event instead.
  let body: z.infer<typeof requestSchema>;
  try {
    await getUser(req);
    body = requestSchema.parse(await req.json());
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      400,
    );
  }

  return eventStreamResponse(async (send) => {
    try {
      // Pass 1 — classify, which selects the rule packs. Not streamed: it is
      // cheap, and pass 2's system prompt cannot be built until it lands.
      const classification = await parseWithRetry(classificationSchema, (feedback) =>
        chat({
          adapter: textAdapter(classifyModel()),
          systemPrompts: [CLASSIFY_PROMPT],
          messages: [
            {
              role: "user",
              content: feedback ? `${body.text}\n\n${feedback}` : body.text,
            },
          ],
          outputSchema: classificationSchema,
          stream: false,
        }),
      );
      send({ type: "classified", classification });

      // Pass 2 — generate under base + any domain packs, streamed.
      let lastSnapshot = "";
      const generation = await streamWithRetry(
        generatedNoteSchema,
        async (feedback, onDelta) => {
          const stream = chat({
            adapter: textAdapter(generateModel()),
            systemPrompts: [buildSystemPrompt(classification)],
            messages: [
              {
                role: "user",
                content: [
                  `Create flashcards for: ${body.text}`,
                  `The learner's native language is ${body.nativeLanguage}.`,
                  `Write the learner-facing side in their native language where that makes sense.`,
                  `If a picture would help anchor this in memory, supply an imagePrompt describing the thing itself, with no text in the image. If a picture would not help, set imagePrompt to null.`,
                  feedback ?? "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
            ],
            outputSchema: generatedNoteSchema,
            stream: true,
          });

          let object: unknown;
          for await (const chunk of stream) {
            if (chunk.type === "TEXT_MESSAGE_CONTENT") onDelta(chunk.delta);
            if (chunk.type === "CUSTOM" && chunk.name === "structured-output.complete") {
              // The streaming path does not validate against outputSchema —
              // partial payloads are partial by design — so this object is
              // still unvalidated. streamWithRetry validates it.
              object = (chunk.value as { object?: unknown }).object;
            }
          }
          return object;
        },
        {
          onPartial: (raw) => {
            const cards = projectCards(parsePartialJSON(raw));
            // Most deltas land inside a string that is already on screen and
            // change nothing structural, so only ship real changes.
            const snapshot = JSON.stringify(cards);
            if (snapshot === lastSnapshot) return;
            lastSnapshot = snapshot;
            send({ type: "cards", cards });
          },
          onRetry: () => {
            lastSnapshot = "";
            send({ type: "retry" });
          },
        },
      );

      send({ type: "done", classification, generation });
    } catch (error) {
      console.error("generate-note failed", error);
      send({
        type: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
});
```

- [ ] **Step 7: Type-check**

Run: `deno check supabase/functions/generate-note/index.ts`
Expected: no errors. The `chunk.value` cast is deliberate: `object` stays
`unknown` and is validated by `streamWithRetry`, so nothing downstream trusts it.

- [ ] **Step 8: Run the full suite**

Run: `deno task test`
Expected: PASS — 89 tests. (`index.ts` has no test; the edge function is verified end-to-end in Task 8.)

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/
git commit -m "feat: stream generate-note over server-sent events"
```

---

### Task 4: Client transport

**Files:**
- Modify: `src/lib/api/ai.ts`
- Create: `src/lib/api/ai.test.ts`

**Interfaces:**
- Consumes: `readEventStream` (Task 1); the wire protocol (Task 3).
- Produces:
  ```ts
  type PartialCard = { aspect: string | null; front: string | null; back: string | null }
  type GenerationEvent =
    | { type: "classified"; classification: Classification }
    | { type: "cards"; cards: PartialCard[] }
    | { type: "retry" }
    | { type: "done"; classification: Classification; generation: GeneratedNote }
    | { type: "error"; message: string }

  readGenerationEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<GenerationEvent>
  generateNoteStream(text: string, nativeLanguage: string, signal?: AbortSignal): AsyncGenerator<GenerationEvent>
  ```
  `Classification`, `GeneratedCard`, `GeneratedNote` and `generateNoteImage` keep their current exported shapes — `src/lib/api/notes.ts` imports the first two.

- [ ] **Step 1: Write the failing test**

Create `src/lib/api/ai.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// `ai.ts` imports supabase at module scope and `supabase.ts` throws when its
// env vars are missing, which they are under vitest. Same pattern as
// `src/lib/auth.test.ts`.
vi.mock("@/lib/supabase", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

import { readGenerationEvents, type GenerationEvent } from "./ai";

function streamOf(...payloads: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      controller.close();
    },
  });
}

/** `streamOf` JSON-encodes, so it cannot produce a malformed frame. */
function streamOfRaw(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const event of readGenerationEvents(stream)) out.push(event);
  return out;
}

const DONE = {
  type: "done",
  classification: { domain: "concept", language: null, partOfSpeech: null },
  generation: { cards: [{ aspect: "meaning", front: "a", back: "b", hint: null }], imagePrompt: null },
} as const;

describe("readGenerationEvents", () => {
  it("yields the server's events unchanged", async () => {
    await expect(collect(streamOf({ type: "retry" }, DONE))).resolves.toEqual([
      { type: "retry" },
      DONE,
    ]);
  });

  it("synthesises an error when the stream ends with no verdict", async () => {
    const events = await collect(streamOf({ type: "cards", cards: [] }));
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "error",
      message: "The connection dropped mid-generation",
    });
  });

  it("synthesises an error for a stream that carried nothing at all", async () => {
    await expect(collect(streamOf())).resolves.toEqual([
      { type: "error", message: "The connection dropped mid-generation" },
    ]);
  });

  it("adds nothing after the server's own error", async () => {
    await expect(
      collect(streamOf({ type: "error", message: "model exploded" })),
    ).resolves.toEqual([{ type: "error", message: "model exploded" }]);
  });

  // `resolves` is load-bearing: it fails if the generator rejects, which is
  // what an unguarded JSON.parse would do.
  it("yields an error for a malformed frame and completes", async () => {
    await expect(
      collect(streamOfRaw("data: {invalid json}\n\n")),
    ).resolves.toEqual([
      { type: "error", message: "The connection dropped mid-generation" },
    ]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `deno task test api/ai`
Expected: FAIL — `readGenerationEvents is not exported`.

- [ ] **Step 3: Implement**

Replace `src/lib/api/ai.ts` with:

```ts
import { supabase } from "@/lib/supabase";
import { readEventStream } from "@/lib/sse";

export type Classification = {
  domain: string;
  language: string | null;
  partOfSpeech: string | null;
};

export type GeneratedCard = {
  aspect: string;
  front: string;
  back: string;
  hint: string | null;
};

export type GeneratedNote = {
  imagePrompt: string | null;
  cards: GeneratedCard[];
};

/**
 * A card mid-stream: a field is null until the model reaches it, which is what
 * the UI draws as a skeleton. Mirrors `PartialCard` in
 * `supabase/functions/_shared/schemas.ts` — the two meet over the wire, since
 * the browser cannot import Deno modules.
 */
export type PartialCard = {
  aspect: string | null;
  front: string | null;
  back: string | null;
};

/** The five events `generate-note` emits. See the design doc for the protocol. */
export type GenerationEvent =
  | { type: "classified"; classification: Classification }
  | { type: "cards"; cards: PartialCard[] }
  | { type: "retry" }
  | { type: "done"; classification: Classification; generation: GeneratedNote }
  | { type: "error"; message: string };

export async function* readGenerationEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GenerationEvent> {
  let terminated = false;

  for await (const data of readEventStream(body)) {
    let event: GenerationEvent;
    try {
      event = JSON.parse(data) as GenerationEvent;
    } catch {
      // A corrupt frame would leave the UI on skeletons forever if we throw,
      // so synthesise an error and stop reading instead.
      yield { type: "error", message: "The connection dropped mid-generation" };
      return;
    }
    if (event.type === "done" || event.type === "error") terminated = true;
    yield event;
  }

  // A stream that stops without a verdict means the connection dropped
  // mid-generation. Unreported it would leave the UI on skeletons forever, so
  // synthesise the failure the server never got to send.
  if (!terminated) {
    yield { type: "error", message: "The connection dropped mid-generation" };
  }
}

export async function* generateNoteStream(
  text: string,
  nativeLanguage: string,
  signal?: AbortSignal,
): AsyncGenerator<GenerationEvent> {
  const { data, error } = await supabase.functions.invoke("generate-note", {
    body: { text, nativeLanguage },
    signal,
  });
  if (error) throw error;

  // A `text/event-stream` content type makes functions-js hand back the raw
  // Response instead of a parsed body.
  const body = (data as Response).body;
  if (!body) throw new Error("generate-note returned no stream");

  yield* readGenerationEvents(body);
}

export async function generateNoteImage(noteId: string, prompt: string) {
  const { data, error } = await supabase.functions.invoke("generate-image", {
    body: { noteId, prompt },
  });
  if (error) throw error;
  return data as { imagePath: string };
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `deno task test`
Expected: PASS — 94 tests (89 + 5).

- [ ] **Step 5: Commit**

`src/routes/_authed.add.tsx` still imports the now-deleted `generateNote` and will not type-check until Task 8. That is expected; the tests do not compile the route.

```bash
git add src/lib/api/ai.ts src/lib/api/ai.test.ts
git commit -m "feat: consume the generate-note event stream"
```

---

### Task 5: Generation state machine

**Files:**
- Create: `src/lib/generation-state.ts`
- Create: `src/lib/generation-state.test.ts`

**Interfaces:**
- Consumes: `Classification`, `GeneratedCard`, `GenerationEvent`, `PartialCard` (Task 4).
- Produces:
  ```ts
  type GenerationAction =
    | GenerationEvent
    | { type: "start"; text: string; startedAt: number }
    | { type: "cancel" }
    | { type: "edit-card"; index: number; patch: Partial<GeneratedCard> }
    | { type: "remove-card"; index: number }

  type GenerationState =
    | { status: "idle" }
    | { status: "classifying"; startedAt: number; text: string }
    | { status: "generating"; startedAt: number; text: string; classification: Classification; cards: PartialCard[]; retried: boolean }
    | { status: "review"; startedAt: number; text: string; classification: Classification; imagePrompt: string | null; cards: GeneratedCard[]; generationFailed: boolean; error: string | null }

  initialGenerationState: GenerationState
  generationReducer(state: GenerationState, action: GenerationAction): GenerationState
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/generation-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  generationReducer,
  initialGenerationState,
  type GenerationAction,
  type GenerationState,
} from "./generation-state";
import type { Classification, GeneratedCard } from "@/lib/api/ai";

const LANGUAGE: Classification = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};

const CARDS: GeneratedCard[] = [
  { aspect: "meaning", front: "die Banane", back: "the banana", hint: null },
  { aspect: "gender", front: "Banane", back: "die", hint: null },
];

const START: GenerationAction = {
  type: "start",
  text: "die Banane",
  startedAt: 1000,
};

function reduce(...actions: GenerationAction[]): GenerationState {
  return actions.reduce(generationReducer, initialGenerationState);
}

describe("generationReducer", () => {
  it("starts the clock and remembers the text that was submitted", () => {
    expect(reduce(START)).toEqual({
      status: "classifying",
      startedAt: 1000,
      text: "die Banane",
    });
  });

  it("moves to generating once the classification lands", () => {
    expect(reduce(START, { type: "classified", classification: LANGUAGE })).toEqual({
      status: "generating",
      startedAt: 1000,
      text: "die Banane",
      classification: LANGUAGE,
      cards: [],
      retried: false,
    });
  });

  it("replaces the card list with each snapshot", () => {
    const partial = [{ aspect: "meaning", front: "die Ba", back: null }];
    const state = reduce(
      START,
      { type: "classified", classification: LANGUAGE },
      { type: "cards", cards: [{ aspect: "meaning", front: null, back: null }] },
      { type: "cards", cards: partial },
    );
    expect(state).toMatchObject({ status: "generating", cards: partial });
  });

  it("lands on review with the finished note", () => {
    const state = reduce(
      START,
      { type: "classified", classification: LANGUAGE },
      {
        type: "done",
        classification: LANGUAGE,
        generation: { cards: CARDS, imagePrompt: "a banana" },
      },
    );
    expect(state).toEqual({
      status: "review",
      startedAt: 1000,
      text: "die Banane",
      classification: LANGUAGE,
      imagePrompt: "a banana",
      cards: CARDS,
      generationFailed: false,
      error: null,
    });
  });

  it("clears the cards on retry but keeps the classification and the clock", () => {
    const state = reduce(
      START,
      { type: "classified", classification: LANGUAGE },
      { type: "cards", cards: [{ aspect: "meaning", front: "x", back: null }] },
      { type: "retry" },
    );
    expect(state).toEqual({
      status: "generating",
      startedAt: 1000,
      text: "die Banane",
      classification: LANGUAGE,
      cards: [],
      retried: true,
    });
  });

  it("repopulates from the second attempt's snapshots", () => {
    const state = reduce(
      START,
      { type: "classified", classification: LANGUAGE },
      { type: "retry" },
      { type: "cards", cards: [{ aspect: "meaning", front: null, back: null }] },
    );
    expect(state).toMatchObject({ retried: true, cards: [{ aspect: "meaning" }] });
  });

  it("keeps the real classification when generation is what failed", () => {
    const state = reduce(
      START,
      { type: "classified", classification: LANGUAGE },
      { type: "error", message: "Model output failed validation twice" },
    );
    expect(state).toEqual({
      status: "review",
      startedAt: 1000,
      text: "die Banane",
      classification: LANGUAGE,
      imagePrompt: null,
      cards: [{ aspect: "meaning", front: "die Banane", back: "", hint: null }],
      generationFailed: true,
      error:
        "Model output failed validation twice — you can still write the card yourself.",
    });
  });

  it("falls back to concept when classification never arrived", () => {
    const state = reduce(START, { type: "error", message: "offline" });
    expect(state).toMatchObject({
      status: "review",
      classification: { domain: "concept", language: null, partOfSpeech: null },
      generationFailed: true,
    });
  });

  it("returns to idle on cancel", () => {
    expect(
      reduce(START, { type: "classified", classification: LANGUAGE }, { type: "cancel" }),
    ).toEqual({ status: "idle" });
  });

  it("patches only the edited card", () => {
    const state = reduce(
      START,
      { type: "classified", classification: LANGUAGE },
      { type: "done", classification: LANGUAGE, generation: { cards: CARDS, imagePrompt: null } },
      { type: "edit-card", index: 1, patch: { back: "der" } },
    );
    expect(state).toMatchObject({
      cards: [CARDS[0], { ...CARDS[1], back: "der" }],
    });
  });

  it("removes a card by index", () => {
    const state = reduce(
      START,
      { type: "classified", classification: LANGUAGE },
      { type: "done", classification: LANGUAGE, generation: { cards: CARDS, imagePrompt: null } },
      { type: "remove-card", index: 0 },
    );
    expect(state).toMatchObject({ cards: [CARDS[1]] });
  });

  it("ignores server events that arrive before a run has started", () => {
    expect(reduce({ type: "classified", classification: LANGUAGE })).toEqual({
      status: "idle",
    });
    expect(reduce({ type: "done", classification: LANGUAGE, generation: { cards: CARDS, imagePrompt: null } })).toEqual({
      status: "idle",
    });
  });

  it("ignores a late snapshot arriving after review", () => {
    const review = reduce(
      START,
      { type: "classified", classification: LANGUAGE },
      { type: "done", classification: LANGUAGE, generation: { cards: CARDS, imagePrompt: null } },
    );
    expect(generationReducer(review, { type: "cards", cards: [] })).toBe(review);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `deno task test generation-state`
Expected: FAIL — `Failed to resolve import "./generation-state"`.

- [ ] **Step 3: Implement**

Create `src/lib/generation-state.ts`:

```ts
import type {
  Classification,
  GeneratedCard,
  GenerationEvent,
  PartialCard,
} from "@/lib/api/ai";

/**
 * The classification recorded when the classify pass itself never completed.
 * Indistinguishable from a real one — "entropy" classifies the same way — so
 * `generationFailed` is what actually records the card was hand-written.
 */
const UNCLASSIFIED: Classification = {
  domain: "concept",
  language: null,
  partOfSpeech: null,
};

export type GenerationAction =
  | GenerationEvent
  | { type: "start"; text: string; startedAt: number }
  | { type: "cancel" }
  | { type: "edit-card"; index: number; patch: Partial<GeneratedCard> }
  | { type: "remove-card"; index: number };

export type GenerationState =
  | { status: "idle" }
  | { status: "classifying"; startedAt: number; text: string }
  | {
      status: "generating";
      startedAt: number;
      text: string;
      classification: Classification;
      cards: PartialCard[];
      /** True once a validation failure discarded a first attempt. */
      retried: boolean;
    }
  | {
      status: "review";
      startedAt: number;
      text: string;
      classification: Classification;
      imagePrompt: string | null;
      cards: GeneratedCard[];
      generationFailed: boolean;
      error: string | null;
    };

export const initialGenerationState: GenerationState = { status: "idle" };

/** True while a run is in flight and server events are worth applying. */
function isRunning(
  state: GenerationState,
): state is Extract<GenerationState, { status: "classifying" | "generating" }> {
  return state.status === "classifying" || state.status === "generating";
}

export function generationReducer(
  state: GenerationState,
  action: GenerationAction,
): GenerationState {
  switch (action.type) {
    case "start":
      return {
        status: "classifying",
        startedAt: action.startedAt,
        text: action.text,
      };

    case "cancel":
      return initialGenerationState;

    case "classified":
      // Strictly `classifying`, unlike done/error below: a replayed frame
      // arriving during generation would otherwise wipe the streamed cards
      // and un-set `retried`.
      if (state.status !== "classifying") return state;
      return {
        status: "generating",
        startedAt: state.startedAt,
        text: state.text,
        classification: action.classification,
        cards: [],
        retried: false,
      };

    case "cards":
      if (state.status !== "generating") return state;
      return { ...state, cards: action.cards };

    case "retry":
      if (state.status !== "generating") return state;
      // Everything on screen came from an attempt that failed validation, so
      // it is discarded. The clock keeps running: the wait is the real wait.
      return { ...state, cards: [], retried: true };

    case "done":
      if (!isRunning(state)) return state;
      return {
        status: "review",
        startedAt: state.startedAt,
        text: state.text,
        classification: action.classification,
        imagePrompt: action.generation.imagePrompt,
        cards: action.generation.cards,
        generationFailed: false,
        error: null,
      };

    case "error":
      if (!isRunning(state)) return state;
      // Never a dead end: fall through to a hand-editable card. Keep the real
      // classification when the classify pass had already succeeded — only
      // the streamed protocol makes those two failures distinguishable.
      return {
        status: "review",
        startedAt: state.startedAt,
        text: state.text,
        classification:
          state.status === "generating" ? state.classification : UNCLASSIFIED,
        imagePrompt: null,
        cards: [{ aspect: "meaning", front: state.text, back: "", hint: null }],
        generationFailed: true,
        error: `${action.message} — you can still write the card yourself.`,
      };

    case "edit-card":
      if (state.status !== "review") return state;
      return {
        ...state,
        cards: state.cards.map((card, index) =>
          index === action.index ? { ...card, ...action.patch } : card,
        ),
      };

    case "remove-card":
      if (state.status !== "review") return state;
      return {
        ...state,
        cards: state.cards.filter((_, index) => index !== action.index),
      };
  }
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `deno task test`
Expected: PASS — 108 tests (94 + 14).

- [ ] **Step 5: Commit**

```bash
git add src/lib/generation-state.ts src/lib/generation-state.test.ts
git commit -m "feat: add the generation state machine"
```

---

### Task 6: Status text

**Files:**
- Create: `src/lib/generation-status.ts`
- Create: `src/lib/generation-status.test.ts`

**Interfaces:**
- Consumes: `GenerationState` (Task 5).
- Produces: `generationStatusText(state: GenerationState): string`, `formatElapsed(ms: number): string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/generation-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatElapsed, generationStatusText } from "./generation-status";
import type { GenerationState } from "./generation-state";
import type { Classification, GeneratedCard, PartialCard } from "@/lib/api/ai";

const LANGUAGE: Classification = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};
const CONCEPT: Classification = {
  domain: "concept",
  language: null,
  partOfSpeech: null,
};

function generating(
  cards: PartialCard[],
  options: { retried?: boolean; classification?: Classification } = {},
): GenerationState {
  return {
    status: "generating",
    startedAt: 0,
    text: "die Banane",
    classification: options.classification ?? LANGUAGE,
    cards,
    retried: options.retried ?? false,
  };
}

function review(cards: GeneratedCard[], generationFailed = false): GenerationState {
  return {
    status: "review",
    startedAt: 0,
    text: "die Banane",
    classification: LANGUAGE,
    imagePrompt: null,
    cards,
    generationFailed,
    error: null,
  };
}

const card = (aspect: string, front: string | null): PartialCard => ({
  aspect,
  front,
  back: null,
});

describe("generationStatusText", () => {
  it("says nothing when idle", () => {
    expect(generationStatusText({ status: "idle" })).toBe("");
  });

  it("names the classify pass", () => {
    expect(
      generationStatusText({ status: "classifying", startedAt: 0, text: "x" }),
    ).toBe("Working out what this is…");
  });

  it("reports the detected classification before any card arrives", () => {
    expect(generationStatusText(generating([]))).toBe(
      "Language · de · noun — writing cards…",
    );
  });

  it("drops the null parts of a non-language classification", () => {
    expect(generationStatusText(generating([], { classification: CONCEPT }))).toBe(
      "Concept — writing cards…",
    );
  });

  it("names the card being written once its aspect has finished streaming", () => {
    expect(generationStatusText(generating([card("meaning", "x"), card("gender", "")]))).toBe(
      "Writing the gender card…",
    );
  });

  it("does not name a half-written aspect", () => {
    expect(generationStatusText(generating([card("meaning", "x"), card("gen", null)]))).toBe(
      "Language · de · noun — writing cards…",
    );
  });

  it("reads open-vocabulary aspects as words", () => {
    expect(generationStatusText(generating([card("roman_name", "Neptune")]))).toBe(
      "Writing the roman name card…",
    );
  });

  it("explains the retry while the screen is empty", () => {
    expect(generationStatusText(generating([], { retried: true }))).toBe(
      "That came back malformed — trying once more…",
    );
  });

  it("returns to normal narration once the retry produces cards", () => {
    expect(
      generationStatusText(generating([card("meaning", "die")], { retried: true })),
    ).toBe("Writing the meaning card…");
  });

  it("counts the finished cards", () => {
    const made = (aspect: string): GeneratedCard => ({
      aspect,
      front: "f",
      back: "b",
      hint: null,
    });
    expect(generationStatusText(review([made("a"), made("b")]))).toBe("2 cards ready");
    expect(generationStatusText(review([made("a")]))).toBe("1 card ready");
  });

  it("does not claim success when the fallback card is what is on screen", () => {
    expect(
      generationStatusText(
        review([{ aspect: "meaning", front: "die Banane", back: "", hint: null }], true),
      ),
    ).toBe("Generation failed");
  });
});

describe("formatElapsed", () => {
  it("formats as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_400)).toBe("0:07");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(600_000)).toBe("10:00");
  });

  it("never shows a negative clock", () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `deno task test generation-status`
Expected: FAIL — `Failed to resolve import "./generation-status"`.

- [ ] **Step 3: Implement**

Create `src/lib/generation-status.ts`:

```ts
import type { Classification } from "@/lib/api/ai";
import type { GenerationState } from "@/lib/generation-state";

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** "language" + "de" + "noun" reads as "Language · de · noun". */
function describeClassification(classification: Classification): string {
  const label = [
    classification.domain,
    classification.language,
    classification.partOfSpeech,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Aspects are open-vocabulary model output: `roman_name` reads as "roman name". */
function humanizeAspect(aspect: string): string {
  return aspect.replace(/_/g, " ");
}

/**
 * Every line here is derived from something the server actually reported.
 * Nothing is filler, so the screen never claims progress that did not happen.
 */
export function generationStatusText(state: GenerationState): string {
  switch (state.status) {
    case "idle":
      return "";

    case "classifying":
      return "Working out what this is…";

    case "generating": {
      if (state.retried && state.cards.length === 0) {
        return "That came back malformed — trying once more…";
      }

      const current = state.cards[state.cards.length - 1];
      // Name the aspect only once `front` has started arriving, which proves
      // the aspect string itself finished streaming. Otherwise a half-written
      // label leaks out as "Writing the gen card…".
      if (current?.aspect && current.front !== null) {
        return `Writing the ${humanizeAspect(current.aspect)} card…`;
      }

      return `${describeClassification(state.classification)} — writing cards…`;
    }

    case "review":
      if (state.generationFailed) return "Generation failed";
      return `${state.cards.length} ${
        state.cards.length === 1 ? "card" : "cards"
      } ready`;
  }
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `deno task test`
Expected: PASS — 121 tests (108 + 13).

- [ ] **Step 5: Commit**

```bash
git add src/lib/generation-status.ts src/lib/generation-status.test.ts
git commit -m "feat: derive generation status text from server events"
```

---

### Task 7: Presentation components

Three thin rendering components, no tests — matching the repo convention (no `.test.tsx` exists; the sign-in-guard spec records there is no component harness). All the branching worth testing already lives in Tasks 5 and 6.

**Files:**
- Create: `src/components/card-editor.tsx`
- Create: `src/components/streaming-cards.tsx`
- Create: `src/components/generation-status.tsx`

**Interfaces:**
- Consumes: `GeneratedCard`, `PartialCard` (Task 4); `GenerationState` (Task 5); `generationStatusText`, `formatElapsed` (Task 6); `Button`, `Input`, `Card*`, `Skeleton` from `src/components/ui/`.
- Produces:
  - `<CardEditor card={GeneratedCard} onChange={(patch: Partial<GeneratedCard>) => void} onRemove={() => void} />`
  - `<StreamingCards cards={PartialCard[]} />`
  - `<GenerationStatus state={GenerationState} />`

- [ ] **Step 1: Create the editable card**

Lifted verbatim from the current `src/routes/_authed.add.tsx:104-134`. Create `src/components/card-editor.tsx`:

```tsx
import { X } from "lucide-react";
import type { GeneratedCard } from "@/lib/api/ai";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function CardEditor({
  card,
  onChange,
  onRemove,
}: {
  card: GeneratedCard;
  onChange: (patch: Partial<GeneratedCard>) => void;
  onRemove: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {card.aspect}
        </CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove card"
            onClick={onRemove}
          >
            <X />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        <Input
          aria-label="Front"
          value={card.front}
          onChange={(e) => onChange({ front: e.target.value })}
        />
        <Input
          aria-label="Back"
          value={card.back}
          onChange={(e) => onChange({ back: e.target.value })}
        />
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Create the streaming card list**

Create `src/components/streaming-cards.tsx`:

```tsx
import type { PartialCard } from "@/lib/api/ai";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * The model's card count is unknown until it finishes, and three is the low
 * end of a typical note. Padding to it stops the list lurching upward while
 * the first card streams.
 */
const MIN_ROWS = 3;

export function StreamingCards({ cards }: { cards: PartialCard[] }) {
  const placeholders = Math.max(0, MIN_ROWS - cards.length);

  return (
    <div className="space-y-4" aria-busy="true">
      {cards.map((card, index) => (
        <Card key={index}>
          <CardHeader>
            <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {card.aspect ?? <Skeleton className="h-3 w-20" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <StreamingField value={card.front} />
            <StreamingField value={card.back} />
          </CardContent>
        </Card>
      ))}

      {Array.from({ length: placeholders }, (_, index) => (
        <Card key={`placeholder-${index}`}>
          <CardHeader>
            <CardTitle>
              <Skeleton className="h-3 w-20" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <StreamingField value={null} />
            <StreamingField value={null} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * Matches Input's h-8 and horizontal padding, so nothing shifts when the list
 * is replaced by the editable one on completion.
 */
function StreamingField({ value }: { value: string | null }) {
  if (value === null) return <Skeleton className="h-8 w-full" />;

  return (
    <p className="flex h-8 items-center px-2.5 py-1 text-base md:text-sm">
      {value}
    </p>
  );
}
```

- [ ] **Step 3: Create the status line and timer**

Create `src/components/generation-status.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { GenerationState } from "@/lib/generation-state";
import { formatElapsed, generationStatusText } from "@/lib/generation-status";

export function GenerationStatus({ state }: { state: GenerationState }) {
  const running =
    state.status === "classifying" || state.status === "generating";
  const elapsed = useElapsed(
    state.status === "idle" ? null : state.startedAt,
    running,
  );

  if (state.status === "idle") return null;

  return (
    <div className="flex items-baseline justify-between gap-4">
      <p
        className="text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {generationStatusText(state)}
      </p>
      {/* aria-hidden: inside the live region a clock ticking once a second
          would be read out over the status text it is meant to accompany. */}
      <span
        className="text-sm tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}

function useElapsed(startedAt: number | null, running: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0);
      return;
    }

    // Settle on the true value the moment the run stops, rather than freezing
    // on whatever the last tick happened to catch up to a second earlier.
    setElapsed(Date.now() - startedAt);
    if (!running) return;

    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt, running]);

  return elapsed;
}
```

- [ ] **Step 4: Run the suite (nothing should break)**

Run: `deno task test`
Expected: PASS — 121 tests, unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/components/card-editor.tsx src/components/streaming-cards.tsx src/components/generation-status.tsx
git commit -m "feat: add streaming card, editor and status components"
```

---

### Task 8: Wire up the add route

The integration task. This is where the build type-checks again.

**Files:**
- Modify: `src/routes/_authed.add.tsx` (full rewrite)

**Interfaces:**
- Consumes: everything from Tasks 4–7.
- Produces: nothing further.

- [ ] **Step 1: Rewrite the route**

Replace `src/routes/_authed.add.tsx` entirely:

```tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useReducer, useRef, useState } from "react";
import { useDecks } from "@/lib/api/decks";
import { useSaveNote } from "@/lib/api/notes";
import { useProfile } from "@/lib/auth";
import { generateNoteStream } from "@/lib/api/ai";
import {
  generationReducer,
  initialGenerationState,
} from "@/lib/generation-state";
import { CardEditor } from "@/components/card-editor";
import { GenerationStatus } from "@/components/generation-status";
import { StreamingCards } from "@/components/streaming-cards";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authed/add")({ component: AddPage });

function AddPage() {
  const navigate = useNavigate();
  const { data: decks } = useDecks();
  const { data: profile } = useProfile();
  const saveNote = useSaveNote();

  const [text, setText] = useState("");
  const [deckId, setDeckId] = useState("");
  const [generation, dispatch] = useReducer(
    generationReducer,
    initialGenerationState,
  );
  const abortRef = useRef<AbortController | null>(null);

  async function handleGenerate() {
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "start", text, startedAt: Date.now() });

    try {
      for await (const event of generateNoteStream(
        text,
        profile?.native_language ?? "en",
        controller.signal,
      )) {
        dispatch(event);
      }
    } catch (e) {
      // Cancelling aborts the fetch, which lands here. That is not a failure,
      // and the reducer is already back at idle, so there is nothing to say.
      if (controller.signal.aborted) return;
      dispatch({
        type: "error",
        message: e instanceof Error ? e.message : "Generation failed",
      });
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
    dispatch({ type: "cancel" });
  }

  if (generation.status === "idle") {
    return (
      <div className="p-4 space-y-4">
        <h1 className="text-2xl font-bold">Add</h1>

        <div className="space-y-2">
          <Label htmlFor="deck">Deck</Label>
          {/* Base UI represents "nothing selected yet" as null, which is what
              renders the placeholder — deckId stays "" in state so the
              disabled checks below are unchanged. `items` maps the deck id
              onto its name for the trigger label. */}
          <Select
            items={decks?.map((deck) => ({
              value: deck.id,
              label: deck.name,
            }))}
            value={deckId || null}
            onValueChange={(value) => setDeckId(value ?? "")}
          >
            <SelectTrigger id="deck" className="w-full">
              <SelectValue placeholder="Choose a deck…" />
            </SelectTrigger>
            <SelectContent>
              {decks?.map((deck) => (
                <SelectItem key={deck.id} value={deck.id}>
                  {deck.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="source-text">Word or concept</Label>
          <Input
            id="source-text"
            placeholder="die Banane, Poseidon, entropy…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <Button
          size="lg"
          className="w-full"
          disabled={!text.trim() || !deckId}
          onClick={handleGenerate}
        >
          Generate cards
        </Button>
      </div>
    );
  }

  // Generation and review are one screen: the list fills with skeletons, then
  // becomes editable in place. `review` is the narrowed state, non-null only
  // once the stream has finished one way or the other.
  const review = generation.status === "review" ? generation : null;
  const hasBlankCard =
    review?.cards.some((card) => !card.front.trim() || !card.back.trim()) ??
    false;

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-bold">Review cards</h1>
      <GenerationStatus state={generation} />

      {review?.error && (
        <Alert variant="destructive">
          <AlertDescription>{review.error}</AlertDescription>
        </Alert>
      )}

      {review && (
        <p className="text-sm text-muted-foreground">
          Detected: {review.classification.domain}
          {review.classification.language
            ? ` · ${review.classification.language}`
            : ""}
        </p>
      )}

      {review ? (
        review.cards.map((card, index) => (
          <CardEditor
            key={index}
            card={card}
            onChange={(patch) => dispatch({ type: "edit-card", index, patch })}
            onRemove={() => dispatch({ type: "remove-card", index })}
          />
        ))
      ) : (
        <StreamingCards
          cards={generation.status === "generating" ? generation.cards : []}
        />
      )}

      {hasBlankCard && (
        <Alert variant="destructive">
          <AlertDescription>
            Every card needs both a front and a back before you can save — fill
            in or remove the blank ones.
          </AlertDescription>
        </Alert>
      )}

      {review && saveNote.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {saveNote.error instanceof Error
              ? saveNote.error.message
              : "Failed to save"}
          </AlertDescription>
        </Alert>
      )}

      {review ? (
        <Button
          size="lg"
          className="w-full"
          disabled={
            review.cards.length === 0 || hasBlankCard || saveNote.isPending
          }
          onClick={async () => {
            try {
              await saveNote.mutateAsync({
                deckId,
                sourceText: review.text,
                classification: review.classification,
                cards: review.cards.map((card) => ({
                  ...card,
                  front: card.front.trim(),
                  back: card.back.trim(),
                })),
                imagePrompt: review.imagePrompt,
                generationFailed: review.generationFailed,
              });
            } catch {
              // Error is already captured in saveNote.error and rendered
              // above; swallow here so this doesn't surface as an
              // unhandled rejection, and don't navigate away on failure.
              return;
            }
            navigate({ to: "/decks/$deckId", params: { deckId } });
          }}
        >
          {saveNote.isPending ? "Saving…" : `Save ${review.cards.length} cards`}
        </Button>
      ) : (
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          onClick={handleCancel}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check and test**

Run: `deno task build`
Expected: `tsc` passes with no errors, then Vite builds.

Run: `deno task test`
Expected: PASS — 121 tests.

- [ ] **Step 3: Verify against the real stack**

The edge function changed, so the stack must be restarted to pick it up
(`supabase functions serve` does not work here — see README troubleshooting):

```bash
supabase stop && supabase start
deno task dev
```

Open `http://localhost:1420/add`, sign in, choose a deck, enter `die Banane`, and
press Generate. Confirm all six:

1. The status line reads "Working out what this is…" with a timer counting from `0:00`.
2. It changes to "Language · de · noun — writing cards…" when the classification lands.
3. Skeleton cards appear, then fill in field by field — the text arrives progressively, not all at once.
4. The status names the card currently being written.
5. On completion the list becomes editable in place, the timer stops, and the line reads "N cards ready".
6. Pressing Cancel mid-generation returns to the form with no error.

Then check the failure path — stop the stack mid-generation (`supabase stop` in
another terminal) and confirm the screen lands on the hand-editable fallback
card with an explanatory alert rather than hanging on skeletons.

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authed.add.tsx
git commit -m "feat: stream generated cards into the review screen

Closes #1"
```

---

## Verification checklist

- [ ] `deno task test` — 121 tests passing
- [ ] `deno task build` — clean `tsc`, successful Vite build
- [ ] Manual run through Task 8 Step 3, all six behaviours confirmed
- [ ] `git log` shows eight focused commits plus the spec commit
