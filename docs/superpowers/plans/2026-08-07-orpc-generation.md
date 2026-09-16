# Incremental Generation over oRPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written server-sent-events transport for card generation with an oRPC event iterator, so `ai.generateNote` is a procedure like every other call in the app.

**Architecture:** The generation logic moves out of the Hono route into a pure async generator (`server/ai/generate-note.ts`) that takes its two model calls as an injected `ModelCalls` object. A thin oRPC procedure delegates to it with `yield*`. The client calls `client.ai.generateNote(...)` and reads events off the returned async iterable; its types are re-exported from the server rather than mirrored by hand. The old route survives until the client has switched, so every commit leaves the suite green.

**Tech Stack:** Deno, Hono, oRPC 1.14.14 (`@orpc/server`, `@orpc/client`), Zod 4, `@tanstack/ai` against OpenRouter, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-07-orpc-generation-design.md`

## Global Constraints

- Package management and script execution use `deno`. Never `npm`, `npx`, `yarn` or `pnpm` (`AGENTS.md`).
- Verification is the three CI commands: `deno task build` (frontend typecheck + build), `deno task check:api` (server typecheck), `deno task test` (Vitest, one shot). All three must pass before every commit.
- Baseline before this plan: **28 test files, 234 tests, all passing.** No task may reduce that count except where this plan says a file is deleted.
- Tests must never reach a real model or the network. The seam is `ModelCalls`, injected through `AppContext.modelCalls`, exactly as `AppContext.generateImageBytes` and `AppContext.writeImage` already work.
- Server modules use explicit `.ts` extensions in imports; client modules use the `@/` alias for `src/` and `~server/` for `server/`.
- The message the client receives for a failed generation stays exactly `"Generation failed"`. It renders verbatim in a destructive alert, so no internal detail may reach it.
- No procedure takes a `userId` from its input.

---

### Task 1: Extract the generation logic into a pure generator

The generation half of `server/routes/generate-note.ts` becomes a testable async generator. The route stays, still SSE, now delegating to it. `streamWithRetry` has to become a generator on the way, because a callback cannot `yield` and the awaits that would drain a buffer live inside `streamWithRetry` itself.

**Files:**
- Create: `server/ai/generate-note.ts`
- Create: `server/ai/model-calls.ts`
- Create: `server/ai/generate-note.test.ts`
- Modify: `server/ai/generate.ts` (`streamWithRetry`, lines 34–72)
- Modify: `server/ai/generate.test.ts` (the `streamWithRetry` describe block, lines 44–115)
- Modify: `server/routes/generate-note.ts` (replace the body of the `eventStreamResponse` callback)

**Interfaces:**
- Consumes: `parseWithRetry`, `projectCards` from `server/ai/generate.ts`; `buildSystemPrompt` from `server/ai/rule-packs.ts`; `classificationSchema`, `generatedNoteSchema`, and the types `Classification`, `GeneratedNote`, `PartialCard` from `server/ai/schemas.ts`.
- Produces:
  - `type GenerationInput = { text: string; nativeLanguage: string }`
  - `type ModelPrompts = { system: string; user: string }`
  - `type ModelCalls = { classify(prompts: ModelPrompts): Promise<unknown>; generate(prompts: ModelPrompts): AsyncGenerator<string, unknown> }`
  - `type GenerationEvent` — the four-member union below
  - `function generateNote(input: GenerationInput, models: ModelCalls): AsyncGenerator<GenerationEvent>`
  - `const openRouterCalls: ModelCalls` from `server/ai/model-calls.ts`
  - `type StreamProgress = { type: "partial"; raw: string } | { type: "retry" }` from `server/ai/generate.ts`
  - `function streamWithRetry<T>(schema: z.ZodType<T>, attempt: (feedback: string | null) => AsyncGenerator<string, unknown>): AsyncGenerator<StreamProgress, T>`

- [ ] **Step 1: Write the failing test for the generator**

Create `server/ai/generate-note.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateNote, type GenerationEvent, type ModelCalls } from "./generate-note.ts";

const INPUT = { text: "die Banane", nativeLanguage: "en" };

const CLASSIFICATION = { domain: "language", language: "de", partOfSpeech: "noun" };

const NOTE = {
  cards: [{ aspect: "meaning", front: "banana", back: "die Banane", hint: null }],
  imagePrompt: "a banana",
};

/** One generate pass: the deltas it streams, then the object it returns. */
type Pass = { deltas: string[]; object: unknown };

/**
 * A ModelCalls that replays canned passes. The last pass repeats if the
 * generator asks for more, so a test only lists the passes it cares about.
 */
function models(passes: Pass[], classification: unknown = CLASSIFICATION): ModelCalls {
  let index = 0;
  return {
    classify: () => Promise.resolve(classification),
    generate: async function* () {
      const pass = passes[Math.min(index++, passes.length - 1)];
      for (const delta of pass.deltas) yield delta;
      return pass.object;
    },
  };
}

async function collect(calls: ModelCalls, input = INPUT): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const event of generateNote(input, calls)) out.push(event);
  return out;
}

describe("generateNote", () => {
  it("classifies, streams cards, then reports the validated note", async () => {
    const events = await collect(models([{ deltas: [JSON.stringify(NOTE)], object: NOTE }]));

    expect(events.map((event) => event.type)).toEqual(["classified", "cards", "done"]);
    expect(events[0]).toEqual({ type: "classified", classification: CLASSIFICATION });
    expect(events.at(-1)).toEqual({
      type: "done",
      classification: CLASSIFICATION,
      generation: NOTE,
    });
  });

  it("emits cards before the model has finished writing them", async () => {
    const events = await collect(
      models([
        {
          deltas: [
            '{"cards":[{"aspect":"meaning"',
            ',"front":"banana"',
            ',"back":"die Banane","hint":null}],"imagePrompt":"a banana"}',
          ],
          object: NOTE,
        },
      ]),
    );

    const cards = events.filter((event) => event.type === "cards");
    expect(cards.length).toBeGreaterThan(1);
    expect(cards[0]).toEqual({
      type: "cards",
      cards: [{ aspect: "meaning", front: null, back: null }],
    });
    expect(cards.at(-1)).toEqual({
      type: "cards",
      cards: [{ aspect: "meaning", front: "banana", back: "die Banane" }],
    });
  });

  it("does not re-emit cards when a delta changes nothing it renders", async () => {
    const events = await collect(
      models([
        {
          deltas: [
            '{"cards":[{"aspect":"meaning","front":"banana","back":"die Banane","hint":null}]',
            ',"imagePrompt":"a bana',
            'na"}',
          ],
          object: NOTE,
        },
      ]),
    );

    // The last two deltas only extend imagePrompt, which projectCards drops.
    expect(events.filter((event) => event.type === "cards")).toHaveLength(1);
  });

  it("announces a retry and discards the failed attempt's cards", async () => {
    const events = await collect(
      models([
        { deltas: ['{"cards":[{"aspect":"junk"}]}'], object: { cards: [] } },
        { deltas: [JSON.stringify(NOTE)], object: NOTE },
      ]),
    );

    expect(events.map((event) => event.type)).toEqual([
      "classified",
      "cards",
      "retry",
      "cards",
      "done",
    ]);
    expect(events.at(-2)).toEqual({
      type: "cards",
      cards: [{ aspect: "meaning", front: "banana", back: "die Banane" }],
    });
  });

  it("throws when the classify pass never validates", async () => {
    const calls = models([{ deltas: [], object: NOTE }], { domain: 42 });
    await expect(collect(calls)).rejects.toThrow();
  });

  it("propagates a provider failure rather than swallowing it", async () => {
    const calls: ModelCalls = {
      classify: () => Promise.resolve(CLASSIFICATION),
      generate: async function* () {
        throw new Error("provider exploded");
      },
    };

    await expect(collect(calls)).rejects.toThrow("provider exploded");
  });
});
```

Note on the second and third tests: they assert what `parsePartialJSON` produces from a half-written object. If the intermediate shape it returns differs from what is written above, assert what it actually produces — the properties under test are that a `cards` event lands before the object is complete, that the last one carries every field, and that an unchanged projection produces no event.

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno run -A npm:vitest run server/ai/generate-note.test.ts`
Expected: FAIL — cannot resolve `./generate-note.ts`.

- [ ] **Step 3: Create the generator**

Create `server/ai/generate-note.ts`. `CLASSIFY_PROMPT` and the generate pass's user message move verbatim from `server/routes/generate-note.ts` (lines 20–30 and 85–96 respectively):

```ts
import { parsePartialJSON } from "@tanstack/ai";
import { buildSystemPrompt } from "./rule-packs.ts";
import { classificationSchema, generatedNoteSchema } from "./schemas.ts";
import type { Classification, GeneratedNote, PartialCard } from "./schemas.ts";
import { parseWithRetry, projectCards, streamWithRetry } from "./generate.ts";

export type GenerationInput = { text: string; nativeLanguage: string };

/** One model call's two halves. Feedback from a failed validation is folded
 *  into `user`, so a retry needs no extra parameter. */
export type ModelPrompts = { system: string; user: string };

/**
 * The seam between generation and the provider. Everything about *what* to
 * generate lives in this module; `ModelCalls` is only *how* the request is
 * made, so a test drives the whole generator with canned output and never
 * reaches OpenRouter.
 */
export type ModelCalls = {
  classify(prompts: ModelPrompts): Promise<unknown>;
  /** Yields raw text deltas and returns the model's unvalidated object. */
  generate(prompts: ModelPrompts): AsyncGenerator<string, unknown>;
};

/** The four events generation emits. A failure is thrown, not yielded. */
export type GenerationEvent =
  | { type: "classified"; classification: Classification }
  | { type: "cards"; cards: PartialCard[] }
  | { type: "retry" }
  | { type: "done"; classification: Classification; generation: GeneratedNote };

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

function generateMessage(input: GenerationInput, feedback: string | null): string {
  return [
    `Create flashcards for: ${input.text}`,
    `The learner's native language is ${input.nativeLanguage}.`,
    `Write the learner-facing side in their native language where that makes sense.`,
    `If a picture would help anchor this in memory, supply an imagePrompt describing the thing itself, with no text in the image. If a picture would not help, set imagePrompt to null.`,
    feedback ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function* generateNote(
  input: GenerationInput,
  models: ModelCalls,
): AsyncGenerator<GenerationEvent> {
  // Pass 1 — classify, which selects the rule packs. Not streamed: it is
  // cheap, and pass 2's system prompt cannot be built until it lands.
  const classification = await parseWithRetry(
    classificationSchema,
    (feedback) =>
      models.classify({
        system: CLASSIFY_PROMPT,
        user: feedback ? `${input.text}\n\n${feedback}` : input.text,
      }),
  );
  yield { type: "classified", classification };

  // Pass 2 — generate under base + any domain packs, streamed.
  const system = buildSystemPrompt(classification);
  const stream = streamWithRetry(
    generatedNoteSchema,
    (feedback) => models.generate({ system, user: generateMessage(input, feedback) }),
  );

  // Driven by hand rather than `yield*` because each partial has to be
  // projected onto the card shape and compared: most deltas land inside a
  // string that is already on screen and change nothing structural.
  let lastSnapshot = "";
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
}
```

- [ ] **Step 4: Convert `streamWithRetry` to a generator**

In `server/ai/generate.ts`, replace the whole `streamWithRetry` function (lines 34–72) with:

```ts
/** What a streamed attempt reports as it runs. */
export type StreamProgress = { type: "partial"; raw: string } | { type: "retry" };

/**
 * The streaming twin of {@link parseWithRetry}: same one-retry contract, with
 * the text surfaced as it arrives so the caller can render partial output.
 *
 * A generator rather than a pair of callbacks because its caller is itself a
 * generator, and a callback cannot `yield`. The validated value comes back as
 * the return value, so `const value = yield* streamWithRetry(...)` works for
 * a caller that needs no mapping, and an explicit `.next()` loop works for
 * one that does.
 *
 * The accumulator is per-attempt, so a retry starts from an empty string
 * before `{ type: "retry" }` is yielded. That is what makes "discard what is
 * on screen and start again" fall out of the state machine instead of having
 * to be coordinated by the caller.
 */
export async function* streamWithRetry<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null) => AsyncGenerator<string, unknown>,
): AsyncGenerator<StreamProgress, T> {
  async function* run(feedback: string | null): AsyncGenerator<StreamProgress, unknown> {
    let raw = "";
    const deltas = attempt(feedback);
    let step = await deltas.next();
    while (!step.done) {
      raw += step.value;
      yield { type: "partial", raw };
      step = await deltas.next();
    }
    return step.value;
  }

  const first = schema.safeParse(yield* run(null));
  if (first.success) return first.data;

  yield { type: "retry" };

  const second = schema.safeParse(yield* run(validationFeedback(first.error.issues)));
  if (second.success) return second.data;

  throw new Error(
    `Model output failed validation twice: ${JSON.stringify(second.error.issues)}`,
  );
}
```

`parseWithRetry`, `validationFeedback` and `projectCards` are unchanged.

- [ ] **Step 5: Update `streamWithRetry`'s tests for the new signature**

In `server/ai/generate.test.ts`, change the import to
`import { parseWithRetry, projectCards, streamWithRetry, type StreamProgress } from "./generate.ts";`
and replace the entire `describe("streamWithRetry", ...)` block (lines 44–115) with:

```ts
describe("streamWithRetry", () => {
  type Pass = { deltas: string[]; object: unknown };

  /** Replays canned passes and records the feedback each one was given. */
  function attemptOf(...passes: Pass[]) {
    const feedback: Array<string | null> = [];
    let index = 0;
    const attempt = (given: string | null) => {
      feedback.push(given);
      const pass = passes[Math.min(index++, passes.length - 1)];
      return (async function* () {
        for (const delta of pass.deltas) yield delta;
        return pass.object;
      })();
    };
    return { attempt, feedback };
  }

  async function drive<T>(generator: AsyncGenerator<StreamProgress, T>) {
    const progress: StreamProgress[] = [];
    let step = await generator.next();
    while (!step.done) {
      progress.push(step.value);
      step = await generator.next();
    }
    return { progress, value: step.value };
  }

  it("returns the parsed value and never retries when the first attempt is valid", async () => {
    const { attempt, feedback } = attemptOf({ deltas: [], object: { name: "ok" } });

    const { progress, value } = await drive(streamWithRetry(schema, attempt));

    expect(value).toEqual({ name: "ok" });
    expect(progress).toEqual([]);
    expect(feedback).toEqual([null]);
  });

  it("reports accumulated text rather than individual deltas", async () => {
    const { attempt } = attemptOf({
      deltas: ['{"na', 'me":"ok"}'],
      object: { name: "ok" },
    });

    const { progress } = await drive(streamWithRetry(schema, attempt));

    expect(progress).toEqual([
      { type: "partial", raw: '{"na' },
      { type: "partial", raw: '{"name":"ok"}' },
    ]);
  });

  it("resets the accumulator before the retry so partial output is discarded", async () => {
    const { attempt } = attemptOf(
      { deltas: ["junk"], object: { nome: "typo" } },
      { deltas: ['{"name":"fixed"}'], object: { name: "fixed" } },
    );

    const { progress, value } = await drive(streamWithRetry(schema, attempt));

    expect(value).toEqual({ name: "fixed" });
    expect(progress).toEqual([
      { type: "partial", raw: "junk" },
      { type: "retry" },
      { type: "partial", raw: '{"name":"fixed"}' },
    ]);
  });

  it("retries with the validation error as feedback", async () => {
    const { attempt, feedback } = attemptOf(
      { deltas: [], object: { nome: "typo" } },
      { deltas: [], object: { name: "fixed" } },
    );

    await drive(streamWithRetry(schema, attempt));

    expect(feedback[0]).toBeNull();
    expect(feedback[1]).toContain("name");
  });

  it("throws after a second failure rather than retrying forever", async () => {
    const { attempt, feedback } = attemptOf({ deltas: [], object: { wrong: true } });

    await expect(drive(streamWithRetry(schema, attempt))).rejects.toThrow();
    expect(feedback).toHaveLength(2);
  });
});
```

`vi` may become unused in this file once the `handlers()` helper is gone — if so, drop it from the import to satisfy `noUnusedLocals`.

- [ ] **Step 6: Create the real model calls**

Create `server/ai/model-calls.ts`. The two `chat(...)` invocations move verbatim from `server/routes/generate-note.ts` (lines 56–71 and 74–121); only their surroundings change:

```ts
import { chat } from "@tanstack/ai";
import { classifyModel, generateModel, textAdapter } from "./openrouter.ts";
import { classificationSchema, generatedNoteSchema } from "./schemas.ts";
import type { ModelCalls } from "./generate-note.ts";

/** The production half of {@link ModelCalls}: the only module that talks to a
 *  provider. Everything it is asked to say is decided in `generate-note.ts`. */
export const openRouterCalls: ModelCalls = {
  async classify({ system, user }) {
    return await chat({
      adapter: textAdapter(classifyModel()),
      systemPrompts: [system],
      messages: [{ role: "user", content: user }],
      outputSchema: classificationSchema,
      stream: false,
    });
  },

  async *generate({ system, user }) {
    const stream = chat({
      adapter: textAdapter(generateModel()),
      systemPrompts: [system],
      messages: [{ role: "user", content: user }],
      outputSchema: generatedNoteSchema,
      stream: true,
    });

    let object: unknown;
    for await (const chunk of stream) {
      if (chunk.type === "TEXT_MESSAGE_CONTENT") yield chunk.delta;
      if (chunk.type === "CUSTOM" && chunk.name === "structured-output.complete") {
        // The streaming path does not validate against outputSchema —
        // partial payloads are partial by design — so this object is still
        // unvalidated. streamWithRetry validates it.
        object = (chunk.value as { object?: unknown }).object;
      }
      if (chunk.type === "RUN_ERROR") {
        // The adapter yields RUN_ERROR and returns normally for every
        // provider failure — it never throws. Left unhandled, `object` stays
        // undefined, streamWithRetry treats that as a validation failure and
        // burns a pointless retry against a provider that just failed.
        throw new Error(chunk.message);
      }
    }
    return object;
  },
};
```

- [ ] **Step 7: Rewire the existing route to the generator**

In `server/routes/generate-note.ts`, delete `CLASSIFY_PROMPT` and everything inside the `eventStreamResponse` callback, and delete the now-unused imports (`chat`, `parsePartialJSON`, `buildSystemPrompt`, `classificationSchema`, `generatedNoteSchema`, `parseWithRetry`, `projectCards`, `streamWithRetry`, the openrouter helpers). The file keeps its auth check, its `requestSchema` parse, and becomes:

```ts
import * as z from "zod";
import type { Context } from "hono";
import { eventStreamResponse } from "../ai/sse.ts";
import { generateNote } from "../ai/generate-note.ts";
import { openRouterCalls } from "../ai/model-calls.ts";
import type { Auth } from "../auth.ts";

const requestSchema = z.object({
  text: z.string().min(1).max(200),
  nativeLanguage: z.string().min(2).max(10),
});

export function generateNoteRoute(auth: Auth) {
  return async (c: Context) => {
    // Auth and request validation run before a single byte is written. Once
    // the event stream opens the status code is committed, so everything after
    // this point has to report failure as an `error` event instead.
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    let body: z.infer<typeof requestSchema>;
    try {
      body = requestSchema.parse(await c.req.json());
    } catch (error) {
      // Malformed JSON throws SyntaxError, well-formed but wrong-shaped throws
      // ZodError. Both are the caller's fault, so both are 400.
      return c.json(
        { error: error instanceof Error ? error.message : "Invalid request body" },
        400,
      );
    }

    return eventStreamResponse(async (send) => {
      try {
        for await (const event of generateNote(body, openRouterCalls)) send(event);
      } catch (error) {
        // The full detail stays server-side in the log. The client only ever
        // gets a short, generic message — it renders verbatim in a destructive
        // alert, so anything more specific would leak internals to the screen.
        console.error("generate-note failed", error);
        send({ type: "error", message: "Generation failed" });
      }
    });
  };
}
```

- [ ] **Step 8: Run the full verification**

Run: `deno task test`
Expected: PASS, 29 files (the new `generate-note.test.ts`), 234 + 6 = 240 tests.

Run: `deno task check:api`
Expected: PASS, no errors.

Run: `deno task build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/ai/generate-note.ts server/ai/generate-note.test.ts \
        server/ai/model-calls.ts server/ai/generate.ts \
        server/ai/generate.test.ts server/routes/generate-note.ts
git commit -m "refactor(server): extract card generation into a testable generator"
```

---

### Task 2: Add the `ai.generateNote` procedure

The generator gets an oRPC procedure in front of it. The old route still exists and still works; nothing consumes the procedure yet except its tests.

**Files:**
- Modify: `server/router/base.ts` (the `AppContext` type, lines 5–15)
- Modify: `server/router/ai.ts` (imports, and the `aiRouter` export at the end)
- Modify: `server/router/ai.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `generateNote`, `ModelCalls` from `server/ai/generate-note.ts`; `openRouterCalls` from `server/ai/model-calls.ts`; `authed` from `server/router/base.ts`.
- Produces: `aiRouter.generateNote` — an authed procedure taking `{ text: string; nativeLanguage: string }` and returning `AsyncGenerator<GenerationEvent>`; `AppContext.modelCalls?: ModelCalls`.

- [ ] **Step 1: Write the failing tests**

Append to `server/router/ai.test.ts`, and add `import { ORPCError } from "@orpc/server";` plus `import type { ModelCalls } from "../ai/generate-note.ts";` and `import type { AppContext } from "./base.ts";` to the imports at the top:

```ts
describe("ai.generateNote", () => {
  const CLASSIFICATION = { domain: "language", language: "de", partOfSpeech: "noun" };
  const NOTE = {
    cards: [{ aspect: "meaning", front: "banana", back: "die Banane", hint: null }],
    imagePrompt: null,
  };
  const INPUT = { text: "die Banane", nativeLanguage: "en" };

  function models(overrides: Partial<ModelCalls> = {}): ModelCalls {
    return {
      classify: vi.fn(async () => CLASSIFICATION),
      generate: async function* () {
        yield JSON.stringify(NOTE);
        return NOTE;
      },
      ...overrides,
    };
  }

  async function collect(context: AppContext, input = INPUT) {
    const events = await call(aiRouter.generateNote, input, { context });
    const out = [];
    for await (const event of events) out.push(event);
    return out;
  }

  it("streams the generated note to an authenticated caller", async () => {
    const ada = await server.signIn("ada@example.com");

    const events = await collect({ ...ada.context, modelCalls: models() });

    expect(events.map((event) => event.type)).toEqual(["classified", "cards", "done"]);
    expect(events.at(-1)).toEqual({
      type: "done",
      classification: CLASSIFICATION,
      generation: NOTE,
    });
  });

  it("refuses an unauthenticated caller before spending a generation", async () => {
    const calls = models();

    await expect(
      collect({ db: server.db, auth: server.auth, modelCalls: calls }),
    ).rejects.toThrow();
    expect(calls.classify).not.toHaveBeenCalled();
  });

  it("rejects an over-long capture before spending a generation", async () => {
    const ada = await server.signIn("ada@example.com");
    const calls = models();

    await expect(
      collect({ ...ada.context, modelCalls: calls }, {
        text: "x".repeat(201),
        nativeLanguage: "en",
      }),
    ).rejects.toThrow();
    expect(calls.classify).not.toHaveBeenCalled();
  });

  it("reports a failure without leaking why it failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ada = await server.signIn("ada@example.com");
    const calls = models({
      generate: async function* () {
        throw new Error("OPENROUTER_API_KEY is not set");
      },
    });

    const error = await collect({ ...ada.context, modelCalls: calls }).catch((e) => e);

    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).message).toBe("Generation failed");
    expect(JSON.stringify(error)).not.toContain("OPENROUTER_API_KEY");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno run -A npm:vitest run server/router/ai.test.ts`
Expected: FAIL — `aiRouter.generateNote` is undefined.

- [ ] **Step 3: Add `modelCalls` to the context**

In `server/router/base.ts`, add to the `AppContext` type, after `writeImage`:

```ts
  /** Overridden in tests so no request ever reaches a model. */
  modelCalls?: ModelCalls;
```

and add the import at the top:

```ts
import type { ModelCalls } from "../ai/generate-note.ts";
```

- [ ] **Step 4: Add the procedure**

In `server/router/ai.ts`, add to the imports:

```ts
import { ORPCError } from "@orpc/server";
import { generateNote } from "../ai/generate-note.ts";
import { openRouterCalls } from "../ai/model-calls.ts";
```

and add before the `aiRouter` export:

```ts
const generateNoteProcedure = authed
  .input(
    z.object({
      text: z.string().min(1).max(200),
      nativeLanguage: z.string().min(2).max(10),
    }),
  )
  .handler(async function* ({ input, context }) {
    try {
      yield* generateNote(input, context.modelCalls ?? openRouterCalls);
    } catch (error) {
      // The full detail stays server-side in the log. The client only ever
      // gets a short, generic message — it renders verbatim in a destructive
      // alert, so anything more specific would leak internals to the screen.
      //
      // The ORPCError wrapper is load-bearing: oRPC replaces the message of
      // anything else thrown here with "Internal server error".
      console.error("generateNote failed", error);
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Generation failed" });
    }
  });
```

There is deliberately no `.output()`: no other procedure validates its output, `PartialCard` is not a Zod schema, and revalidating every partial snapshot would cost work per delta for no guarantee the client acts on. The client's type comes from the handler's return type through `RouterClient<AppRouter>`.

Then replace the export:

```ts
export const aiRouter = {
  generateImage: generateImageProcedure,
  generateNote: generateNoteProcedure,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno run -A npm:vitest run server/router/ai.test.ts`
Expected: PASS, 8 tests (4 existing + 4 new).

If the unauthenticated case rejects from the `call(...)` promise rather than from the first iteration, the test still passes — `collect` awaits both.

- [ ] **Step 6: Run the full verification**

Run: `deno task test`
Expected: PASS, 29 files, 244 tests.

Run: `deno task check:api`
Expected: PASS.

Run: `deno task build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/router/base.ts server/router/ai.ts server/router/ai.test.ts
git commit -m "feat(server): serve card generation as an oRPC event iterator"
```

---

### Task 3: Switch the client to the procedure

The client stops building its own request. Its five mirrored type declarations become re-exports from the server, so `RouterClient<AppRouter>` is what keeps the two ends in agreement.

**Files:**
- Modify: `src/lib/api/ai.ts` (rewritten)
- Modify: `src/lib/api/ai.test.ts` (rewritten)
- Modify: `src/lib/generation-state.ts` (the `GenerationAction` union, lines 19–24)
- Modify: `src/lib/session-rejection.test.ts` (the `STREAM` constant, line 5)
- Modify: `src/routes/_authed.add.tsx` (the comment at lines 44–46)
- Delete: `src/lib/sse.ts`
- Delete: `src/lib/sse.test.ts`

**Interfaces:**
- Consumes: `client.ai.generateNote` from Task 2; `GenerationEvent` from `server/ai/generate-note.ts`; `Classification`, `GeneratedCard`, `GeneratedNote`, `PartialCard` from `server/ai/schemas.ts`.
- Produces: `generateNoteStream(text: string, nativeLanguage: string, signal?: AbortSignal): AsyncGenerator<GenerationEvent>` and `generateNoteImage(noteId: string, prompt: string)` — the same two names `src/routes/_authed.add.tsx` and `src/lib/api/notes.ts` already import. `GenerationEvent` no longer has an `error` member.

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/api/ai.test.ts` entirely:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ORPCError } from "@orpc/client";

const { generateImageMock, generateNoteMock } = vi.hoisted(() => ({
  generateImageMock: vi.fn(),
  generateNoteMock: vi.fn(),
}));

vi.mock("@/lib/orpc", () => ({
  apiUrl: "http://127.0.0.1:8787",
  getToken: vi.fn().mockReturnValue("a-token"),
  client: { ai: { generateImage: generateImageMock, generateNote: generateNoteMock } },
}));
vi.mock("@/lib/auth", () => ({ clearRejectedSession: vi.fn() }));

import { clearRejectedSession } from "@/lib/auth";
import { SessionExpiredError } from "@/lib/session-expired";
import { generateNoteImage, generateNoteStream, type GenerationEvent } from "./ai";

const CLASSIFIED = {
  type: "classified",
  classification: { domain: "concept", language: null, partOfSpeech: null },
} as const;

const DONE = {
  type: "done",
  classification: { domain: "concept", language: null, partOfSpeech: null },
  generation: {
    cards: [{ aspect: "meaning", front: "a", back: "b", hint: null }],
    imagePrompt: null,
  },
} as const;

/** What the oRPC client hands back: a promise of an async iterator. */
function iteratorOf(...events: GenerationEvent[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

async function collect(events: AsyncGenerator<GenerationEvent>) {
  const out: GenerationEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("generateNoteStream", () => {
  beforeEach(() => {
    generateNoteMock.mockReset();
    vi.mocked(clearRejectedSession).mockReset();
  });

  it("yields the events the procedure produces", async () => {
    generateNoteMock.mockResolvedValueOnce(iteratorOf(CLASSIFIED, DONE));

    await expect(collect(generateNoteStream("word", "en"))).resolves.toEqual([
      CLASSIFIED,
      DONE,
    ]);
  });

  it("forwards the capture and the AbortSignal to the procedure", async () => {
    const controller = new AbortController();
    generateNoteMock.mockResolvedValueOnce(iteratorOf(DONE));

    await collect(generateNoteStream("word", "en", controller.signal));

    expect(generateNoteMock).toHaveBeenCalledWith(
      { text: "word", nativeLanguage: "en" },
      { signal: controller.signal },
    );
  });

  it("treats a 401 as a dead session rather than a generation failure", async () => {
    generateNoteMock.mockRejectedValueOnce(new ORPCError("UNAUTHORIZED"));

    await expect(
      collect(generateNoteStream("word", "en")),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(clearRejectedSession).toHaveBeenCalledTimes(1);
  });

  it("passes a non-401 failure through untouched", async () => {
    const error = new ORPCError("INTERNAL_SERVER_ERROR", { message: "Generation failed" });
    generateNoteMock.mockRejectedValueOnce(error);

    await expect(collect(generateNoteStream("word", "en"))).rejects.toBe(error);
    expect(clearRejectedSession).not.toHaveBeenCalled();
  });

  it("reports a stream that ends without a verdict", async () => {
    // Unreported this would leave the UI on skeletons forever.
    generateNoteMock.mockResolvedValueOnce(iteratorOf(CLASSIFIED));

    await expect(collect(generateNoteStream("word", "en"))).rejects.toThrow(
      "The connection dropped mid-generation",
    );
  });

  it("reports a failure that lands mid-stream", async () => {
    generateNoteMock.mockResolvedValueOnce(
      (async function* () {
        yield CLASSIFIED;
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Generation failed" });
      })(),
    );

    await expect(collect(generateNoteStream("word", "en"))).rejects.toThrow(
      "Generation failed",
    );
  });
});

describe("generateNoteImage", () => {
  beforeEach(() => {
    generateImageMock.mockReset();
    vi.mocked(clearRejectedSession).mockReset();
  });

  it("treats a 401 as a dead session too", async () => {
    generateImageMock.mockRejectedValueOnce(new ORPCError("UNAUTHORIZED"));

    await expect(generateNoteImage("note-1", "a banana")).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
    expect(clearRejectedSession).toHaveBeenCalledTimes(1);
  });

  it("passes a non-401 ORPCError through untouched", async () => {
    const error = new ORPCError("INTERNAL_SERVER_ERROR");
    generateImageMock.mockRejectedValueOnce(error);

    await expect(generateNoteImage("note-1", "a banana")).rejects.toBe(error);
    expect(clearRejectedSession).not.toHaveBeenCalled();
  });

  it("returns the image path on success", async () => {
    generateImageMock.mockResolvedValueOnce({ imagePath: "u1/n1.png" });

    await expect(generateNoteImage("note-1", "a banana")).resolves.toEqual({
      imagePath: "u1/n1.png",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno run -A npm:vitest run src/lib/api/ai.test.ts`
Expected: FAIL — `generateNoteStream` still calls `fetch`, so `generateNoteMock` is never invoked.

- [ ] **Step 3: Rewrite the client module**

Replace `src/lib/api/ai.ts` entirely:

```ts
import { ORPCError } from "@orpc/client";
import { client } from "@/lib/orpc";
import { clearRejectedSession } from "@/lib/auth";
import { SessionExpiredError } from "@/lib/session-expired";

// Re-exported rather than restated: the wire shape is the router's type, and
// `RouterClient<AppRouter>` is what keeps the two ends in agreement. These are
// type-only, so no server module reaches the browser bundle.
export type {
  Classification,
  GeneratedCard,
  GeneratedNote,
  PartialCard,
} from "~server/ai/schemas";
export type { GenerationEvent } from "~server/ai/generate-note";

import type { GenerationEvent } from "~server/ai/generate-note";

/** Synthesised whenever the stream ends without a terminal event — a dropped
 * connection would otherwise leave the UI on skeletons forever. */
const CONNECTION_DROPPED_MESSAGE = "The connection dropped mid-generation";

/**
 * A 401 from any procedure means the stored bearer token was refused, and
 * this session is dead. Reporting that as a generation failure would drop the
 * user onto the hand-editable fallback card, quietly nudging them into
 * writing the card themselves when signing in again is the actual fix.
 */
async function asSessionError(error: unknown): Promise<unknown> {
  if (error instanceof ORPCError && error.status === 401) {
    await clearRejectedSession();
    return new SessionExpiredError();
  }
  return error;
}

export async function* generateNoteStream(
  text: string,
  nativeLanguage: string,
  signal?: AbortSignal,
): AsyncGenerator<GenerationEvent> {
  let terminated = false;

  try {
    const events = await client.ai.generateNote({ text, nativeLanguage }, { signal });
    for await (const event of events) {
      if (event.type === "done") terminated = true;
      yield event;
    }
  } catch (error) {
    throw await asSessionError(error);
  }

  // A stream that stops without a verdict means the connection dropped
  // mid-generation. oRPC makes no promise about how a truncated stream
  // surfaces, so synthesise the failure the server never got to report.
  if (!terminated) throw new Error(CONNECTION_DROPPED_MESSAGE);
}

export async function generateNoteImage(noteId: string, prompt: string) {
  try {
    return await client.ai.generateImage({ noteId, prompt });
  } catch (error) {
    throw await asSessionError(error);
  }
}
```

If the duplicate `GenerationEvent` line (one `export type … from`, one `import type … from`) trips a lint or reads badly, collapse it to `import type { GenerationEvent } from "~server/ai/generate-note";` followed by `export type { GenerationEvent };`.

- [ ] **Step 4: Give the reducer its own error action**

In `src/lib/generation-state.ts`, the wire no longer carries an `error` event, but `runGeneration` still dispatches one. Change the `GenerationAction` union to:

```ts
export type GenerationAction =
  | GenerationEvent
  | { type: "error"; message: string }
  | { type: "start"; text: string; startedAt: number }
  | { type: "cancel" }
  | { type: "edit-card"; index: number; patch: Partial<GeneratedCard> }
  | { type: "remove-card"; index: number };
```

The reducer body is untouched.

- [ ] **Step 5: Delete the SSE reader and point the session test at `/rpc`**

```bash
git rm src/lib/sse.ts src/lib/sse.test.ts
```

In `src/lib/session-rejection.test.ts`, change line 5 to:

```ts
const STREAM = "http://127.0.0.1:8787/rpc/ai/generateNote";
```

and rename the test that uses it so it still says what it means:

```ts
  it("reports a 401 from the generation call, however the request is built", async () => {
```

The assertions are unchanged — the point of that test is `urlOf` handling both a string and a `Request`, which still matters.

- [ ] **Step 6: Update the stale comment on the call site**

In `src/routes/_authed.add.tsx`, the comment above the cleanup effect names the old route. Change:

```ts
  // Navigating away mid-generation would otherwise leave the fetch — and the
  // server's /api/generate-note stream behind it — running with nothing left
  // to consume it. Hooks stay unconditional and above the early return below.
```

to:

```ts
  // Navigating away mid-generation would otherwise leave the request — and the
  // server's generation running behind it — with nothing left to consume it.
  // Hooks stay unconditional and above the early return below.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `deno run -A npm:vitest run src/lib`
Expected: PASS. `sse.test.ts` is gone (−7 tests) and `api/ai.test.ts` goes from 14 tests to 9 — the seven that exercised SSE framing had nothing left to test.

- [ ] **Step 8: Run the full verification**

Run: `deno task test`
Expected: PASS, 28 files, 232 tests.

Run: `deno task build`
Expected: PASS — this is what proves the `~server/` type-only re-exports do not drag a server module into the browser bundle.

Run: `deno task check:api`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A src/lib src/routes/_authed.add.tsx
git commit -m "feat(web): read generation events from the oRPC client"
```

---

### Task 4: Delete the SSE transport

Nothing calls the route any more. Both framing modules and the route go, and the two app-level cases they justified are re-pointed at `/rpc` rather than dropped.

**Files:**
- Delete: `server/routes/generate-note.ts` (and the now-empty `server/routes/`)
- Delete: `server/ai/sse.ts`
- Delete: `server/ai/sse.test.ts`
- Modify: `server/app.ts` (remove the import at line 7 and the registration at line 40)
- Modify: `server/app.test.ts` (lines 50–57 and 84–113)

**Interfaces:**
- Consumes: `aiRouter.generateNote` from Task 2 — reached over `/rpc/ai/generateNote`.
- Produces: nothing new.

- [ ] **Step 1: Move the CORS assertion onto the RPC 401 test**

The generate-note 401 test is the only one asserting that a 401 carries CORS headers, and that assertion has to survive. In `server/app.test.ts`, replace the existing `"answers an unauthenticated RPC call with 401"` test (lines 50–57) with:

```ts
  it("answers an unauthenticated RPC call with 401 and CORS headers", async () => {
    const response = await app.request("/rpc/decks/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:1420",
      },
      body: JSON.stringify({ json: {} }),
    });

    expect(response.status).toBe(401);
    // Without the CORS header the browser blocks the 401 outright and the
    // client sees an indistinguishable network failure instead of "expired".
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:1420",
    );
  });
```

- [ ] **Step 2: Replace the malformed-body test with its RPC equivalent**

Replace both generate-note tests (lines 84–113) with one:

```ts
  it("rejects an out-of-bounds generate-note input with 400, not 500", async () => {
    const token = (await signUp()).headers.get("set-auth-token");

    // Input validation runs before the handler, so this never reaches a model.
    const response = await app.request("/rpc/ai/generateNote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ json: { text: "", nativeLanguage: "en" } }),
    });

    expect(response.status).toBe(400);
  });
```

- [ ] **Step 3: Run the app tests to verify they pass against the procedure**

Run: `deno run -A npm:vitest run server/app.test.ts`
Expected: PASS, 5 tests — two generate-note cases replaced by one.

- [ ] **Step 4: Delete the route and the framing modules**

```bash
git rm server/routes/generate-note.ts server/ai/sse.ts server/ai/sse.test.ts
```

In `server/app.ts`, delete the import:

```ts
import { generateNoteRoute } from "./routes/generate-note.ts";
```

and the registration:

```ts
  app.post("/api/generate-note", generateNoteRoute(auth));
```

- [ ] **Step 5: Run the full verification**

Run: `deno task test`
Expected: PASS, 27 files, 226 tests. `server/ai/sse.test.ts` is gone (−5 tests) and `app.test.ts` is down one.

Run: `deno task check:api`
Expected: PASS — nothing imports the deleted modules.

Run: `deno task build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A server
git commit -m "refactor(server): drop the hand-written SSE transport"
```

---

### Task 5: Update the docs and verify against a running app

Two properties the suite cannot show: that the iterator streams incrementally rather than buffering, and that cancelling aborts the server's work. A buffered iterator produces a correct note after one long pause and every test still passes, so this has to be seen.

**Files:**
- Modify: `README.md` (the "AI endpoints" section and the "Layout" tree)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing.

- [ ] **Step 1: Rewrite the AI endpoints section**

In `README.md`, replace the intro line and the `POST /api/generate-note` bullet with:

```markdown
Generation lives in the server, under `server/ai/` and `server/router/ai.ts`:

- **`ai.generateNote`** — `{ text, nativeLanguage }`. An oRPC procedure whose handler is
  an async generator, so the client reads its events off an async iterable. Two passes: a
  cheap classify pass returning `{ domain, language, partOfSpeech }`, which selects the
  rule packs, then a structured-output generate pass returning aspect-tagged cards and an
  image prompt. Cards stream as the model writes them and nothing is persisted; output
  goes back to the client for review and editing. The generation logic itself is a pure
  generator in `server/ai/generate-note.ts` that takes its two model calls as an argument,
  so it is tested without reaching a provider; `server/ai/model-calls.ts` supplies the
  real ones.
```

The `ai.generateImage` bullet below it is unchanged.

- [ ] **Step 2: Update the Layout tree**

In the `server/` block of the Layout tree, delete the `routes/` line and expand the `ai/` line:

```
  router/          oRPC procedures: base, decks, notes, cards, ai (+ tests)
  ai/              rule-packs, schemas, generate, generate-note, model-calls,
                   openrouter (+ tests)
```

`src/lib/sse.ts` was never listed in the tree, so nothing changes on the client side of it.

- [ ] **Step 3: Check the rest of the README for stale references**

Run: `grep -n "generate-note\|SSE\|event-stream\|server/routes" README.md`
Expected: no hits outside the section just rewritten. Fix any that remain — the Troubleshooting entries talk about generation failing and about 401s generally, and both stay correct as written.

- [ ] **Step 4: Verify it streams**

Run: `deno task dev`

In the browser at `http://localhost:1420`: sign in, go to `/add`, capture `die Banane`, and watch the review screen. Cards must appear as skeletons and fill in field by field while the model writes, exactly as before this change — not all at once after a pause.

If everything appears at once, the iterator is being buffered somewhere between the handler and the client. Stop and diagnose before continuing; do not close the issue on a passing suite alone.

- [ ] **Step 5: Verify cancelling stops the work**

With `deno task dev` still running, start another generation and press Cancel while the cards are still filling in. The app must return to the idle capture screen, and the API process must not log a completed generation or a `generateNote failed` afterwards — the server generator should stop where it was rather than running the model call to completion.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: describe generation as an oRPC procedure"
```

---

## Done

`server/routes/` no longer exists, neither SSE module survives, `src/lib/api/ai.ts` declares no types of its own, and generation is one of twelve oRPC procedures rather than the one exception. Closes [#3](https://github.com/unfixed3854/mnimi/issues/3).
