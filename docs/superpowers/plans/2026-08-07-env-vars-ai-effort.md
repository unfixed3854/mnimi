# Env vars for AI effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `CLASSIFY_EFFORT` and `GENERATE_EFFORT` env vars override OpenRouter's reasoning-effort parameter for the classify and generate AI passes, mirroring the existing `CLASSIFY_MODEL`/`GENERATE_MODEL` override pattern.

**Architecture:** `server/ai/openrouter.ts` gains a validated env-var reader (`reasoningEffort`) behind two new exports, `classifyReasoning()`/`generateReasoning()`, each returning `{ effort } | undefined`. `server/routes/generate-note.ts` passes that straight into `modelOptions.reasoning` on its two `chat()` calls. An invalid value logs a warning via a newly introduced `@logtape/logtape` setup (`server/logging.ts`) instead of throwing.

**Tech Stack:** Deno 2, TypeScript, Vitest, `@tanstack/ai` / `@tanstack/ai-openrouter`, `@openrouter/sdk`, `@logtape/logtape@2.3.0` (new).

## Global Constraints

- New env vars: `CLASSIFY_EFFORT`, `GENERATE_EFFORT`. Server-only — never prefixed `VITE_`.
- Valid values (exact strings): `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `none`.
- Unset → no `reasoning` field is sent; the model uses its provider default.
- Invalid value → treated as unset, plus exactly one `warning`-level log naming the env var and the value. Never throws.
- `IMAGE_MODEL` / image generation is out of scope — `ImageGenerationRequest` has no `reasoning` field.
- New dependency `@logtape/logtape@2.3.0` goes in `server/deno.json` only (server-side logging, not shipped to the client bundle).
- Existing `console.error` call sites (`server/app.ts`, `server/routes/generate-note.ts`) are untouched — migrating them to logtape is out of scope for this change.

---

### Task 1: Logtape setup

**Files:**
- Modify: `server/deno.json`
- Create: `server/logging.ts`
- Test: `server/logging.test.ts`

**Interfaces:**
- Produces: `getLogger` (re-exported from `server/logging.ts`, same signature as `@logtape/logtape`'s `getLogger(category: string | readonly string[]): Logger`). Task 2 imports this as `import { getLogger } from "../logging.ts";` and calls `getLogger(["mnimi", "ai"])`.

- [ ] **Step 1: Write the failing test**

Create `server/logging.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getLogger } from "./logging.ts";

describe("logging", () => {
  it("configures a logger that can log without throwing", () => {
    const logger = getLogger(["mnimi", "test"]);
    expect(() => logger.warn("test message")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test -- server/logging.test.ts`
Expected: FAIL — `server/logging.ts` does not exist, so the import errors.

- [ ] **Step 3: Add the dependency**

Edit `server/deno.json`, adding `@logtape/logtape` to `imports` (keep the existing entries and alphabetical-ish ordering already used there):

```json
{
  "imports": {
    "@logtape/logtape": "npm:@logtape/logtape@2.3.0",
    "@openrouter/sdk": "npm:@openrouter/sdk@0.13.20",
    "@tanstack/ai": "npm:@tanstack/ai@0.42.0",
    "@tanstack/ai-openrouter": "npm:@tanstack/ai-openrouter@0.15.10",
    "hono": "npm:hono@4.13.0"
  }
}
```

Run: `deno install`
Expected: exits 0, `deno.lock` picks up the new dependency.

- [ ] **Step 4: Write the implementation**

Create `server/logging.ts`:

```ts
import { configureSync, getConsoleSink, getLogger } from "@logtape/logtape";

// `reset: true` so re-evaluating this module — e.g. across isolated Vitest
// module graphs, one per test file — never hits logtape's "already
// configured" error. Every re-run just replaces the config with the same one.
configureSync({
  reset: true,
  sinks: { console: getConsoleSink() },
  loggers: [
    { category: ["mnimi"], sinks: ["console"], lowestLevel: "warning" },
    // Silences logtape's own internal meta-logger below error level, per
    // logtape's documented convention.
    { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "error" },
  ],
});

export { getLogger };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno task test -- server/logging.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/deno.json server/logging.ts server/logging.test.ts deno.lock
git commit -m "feat: add logtape logging setup"
```

---

### Task 2: `classifyReasoning` / `generateReasoning` in `server/ai/openrouter.ts`

**Files:**
- Modify: `server/ai/openrouter.ts`
- Test: `server/ai/openrouter.test.ts` (new)

**Interfaces:**
- Consumes: `getLogger` from `../logging.ts` (Task 1).
- Produces:
  - `export const classifyReasoning: () => { effort: ReasoningEffort } | undefined`
  - `export const generateReasoning: () => { effort: ReasoningEffort } | undefined`
  - where `ReasoningEffort` is the local union `"minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "none"`.
  - Task 3 imports both and spreads the result into `chat({ modelOptions: { reasoning: ... } })`.

- [ ] **Step 1: Write the failing tests**

Create `server/ai/openrouter.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { getLogger } from "../logging.ts";
import { classifyReasoning, generateReasoning } from "./openrouter.ts";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "none"];

describe("classifyReasoning", () => {
  afterEach(() => {
    Deno.env.delete("CLASSIFY_EFFORT");
  });

  it("returns undefined when CLASSIFY_EFFORT is unset", () => {
    expect(classifyReasoning()).toBeUndefined();
  });

  it("returns the effort for each valid value", () => {
    for (const value of EFFORTS) {
      Deno.env.set("CLASSIFY_EFFORT", value);
      expect(classifyReasoning()).toEqual({ effort: value });
    }
  });

  it("returns undefined and warns once for an invalid value", () => {
    const logger = getLogger(["mnimi", "ai"]);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    Deno.env.set("CLASSIFY_EFFORT", "extreme");

    expect(classifyReasoning()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

describe("generateReasoning", () => {
  afterEach(() => {
    Deno.env.delete("GENERATE_EFFORT");
  });

  it("returns undefined when GENERATE_EFFORT is unset", () => {
    expect(generateReasoning()).toBeUndefined();
  });

  it("returns the effort for a valid value", () => {
    Deno.env.set("GENERATE_EFFORT", "high");
    expect(generateReasoning()).toEqual({ effort: "high" });
  });

  it("returns undefined and warns once for an invalid value", () => {
    const logger = getLogger(["mnimi", "ai"]);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    Deno.env.set("GENERATE_EFFORT", "extreme");

    expect(generateReasoning()).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test -- server/ai/openrouter.test.ts`
Expected: FAIL — `classifyReasoning`/`generateReasoning` are not exported from `server/ai/openrouter.ts` yet.

- [ ] **Step 3: Write the implementation**

Edit `server/ai/openrouter.ts`. Add the import and the new code after the existing `imageModel` export (after line 15):

```ts
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { OpenRouter } from "@openrouter/sdk";
import { getLogger } from "../logging.ts";

function apiKey(): string {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return key;
}

export const classifyModel = () =>
  Deno.env.get("CLASSIFY_MODEL") ?? "google/gemini-2.5-flash";
export const generateModel = () =>
  Deno.env.get("GENERATE_MODEL") ?? "anthropic/claude-sonnet-4.5";
export const imageModel = () =>
  Deno.env.get("IMAGE_MODEL") ?? "google/gemini-2.5-flash-image";

const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
] as const;

type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const logger = getLogger(["mnimi", "ai"]);

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

// Unset means "send no `reasoning` field, let the model use its own
// default" — there is no universally sensible fallback effort the way there
// is a fallback model. An invalid value degrades to the same "unset"
// behaviour rather than throwing: a typo in this var should never take down
// request handling.
function reasoningEffort(
  envVar: string,
): { effort: ReasoningEffort } | undefined {
  const value = Deno.env.get(envVar);
  if (value === undefined) return undefined;

  if (!isReasoningEffort(value)) {
    logger.warn(
      "{envVar} is set to {value}, which is not a valid reasoning effort. Valid values are: {valid}. Ignoring it.",
      { envVar, value, valid: REASONING_EFFORTS.join(", ") },
    );
    return undefined;
  }

  return { effort: value };
}

export const classifyReasoning = () => reasoningEffort("CLASSIFY_EFFORT");
export const generateReasoning = () => reasoningEffort("GENERATE_EFFORT");
```

(The rest of the file — the `TextModel` type, `textAdapter`, `imagesClient` — is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno task test -- server/ai/openrouter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/ai/openrouter.ts server/ai/openrouter.test.ts
git commit -m "feat: add CLASSIFY_EFFORT/GENERATE_EFFORT env var readers"
```

---

### Task 3: Wire reasoning effort into the generate-note route, document the env vars

**Files:**
- Modify: `server/routes/generate-note.ts:5`, `server/routes/generate-note.ts:58-69`, `server/routes/generate-note.ts:78-97`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `classifyReasoning`, `generateReasoning` from `../ai/openrouter.ts` (Task 2).

- [ ] **Step 1: Update the import**

In `server/routes/generate-note.ts`, replace line 5:

```ts
import { classifyModel, generateModel, textAdapter } from "../ai/openrouter.ts";
```

with:

```ts
import {
  classifyModel,
  classifyReasoning,
  generateModel,
  generateReasoning,
  textAdapter,
} from "../ai/openrouter.ts";
```

- [ ] **Step 2: Pass reasoning effort on the classify pass**

Replace the classify `chat()` call (originally lines 58-69):

```ts
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
```

with:

```ts
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
              modelOptions: { reasoning: classifyReasoning() },
            }),
```

- [ ] **Step 3: Pass reasoning effort on the generate pass**

Replace the generate `chat()` call (originally lines 78-97):

```ts
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
```

with:

```ts
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
              modelOptions: { reasoning: generateReasoning() },
            });
```

- [ ] **Step 4: Typecheck the server**

Run: `deno task check:api`
Expected: exits 0. This is how `server/routes/generate-note.ts` is verified today — it has no dedicated test file (it streams SSE and there's no existing harness for that), so a clean typecheck plus the full test suite in the next step is the correctness bar for this task.

- [ ] **Step 5: Document the env vars in `.env.example`**

In `.env.example`, replace:

```
# --- AI (server only — never prefixed VITE_) ---
OPENROUTER_API_KEY=sk-or-...
CLASSIFY_MODEL=~deepseek/deepseek-v4-flash-latest
GENERATE_MODEL=~deepseek/deepseek-v4-flash-latest
IMAGE_MODEL=qwen/qwen-image-3
```

with:

```
# --- AI (server only — never prefixed VITE_) ---
OPENROUTER_API_KEY=sk-or-...
CLASSIFY_MODEL=~deepseek/deepseek-v4-flash-latest
GENERATE_MODEL=~deepseek/deepseek-v4-flash-latest
IMAGE_MODEL=qwen/qwen-image-3
# Optional reasoning-effort override for models that support it: minimal, low,
# medium, high, xhigh, max, none. Unset lets each model use its provider
# default; an invalid value is logged as a warning and ignored rather than
# breaking generation.
# CLASSIFY_EFFORT=low
# GENERATE_EFFORT=medium
```

- [ ] **Step 6: Document the env vars in `README.md`**

In `README.md`, find this block (the "Optional model overrides" section, in the "The OpenRouter key" section):

```
Optional model overrides, with the defaults the code falls back to:

```
CLASSIFY_MODEL=google/gemini-2.5-flash
GENERATE_MODEL=anthropic/claude-sonnet-4.5
IMAGE_MODEL=google/gemini-2.5-flash-image
```

**The key never goes in client code and never gets a `VITE_` prefix.**
```

Insert a new paragraph and code block immediately after the `IMAGE_MODEL` line and before `**The key never goes in client code...**`, so the section reads:

```
Optional model overrides, with the defaults the code falls back to:

```
CLASSIFY_MODEL=google/gemini-2.5-flash
GENERATE_MODEL=anthropic/claude-sonnet-4.5
IMAGE_MODEL=google/gemini-2.5-flash-image
```

Optional reasoning-effort overrides for the two chat passes, for models that support it:

```
CLASSIFY_EFFORT=low
GENERATE_EFFORT=medium
```

Valid values are `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and `none` — OpenRouter's
`reasoning.effort` values. Leave unset to use each model's own default. `IMAGE_MODEL` has no
effort equivalent: OpenRouter's image-generation endpoint doesn't take a `reasoning` parameter.
An invalid value is logged as a warning and ignored rather than breaking generation.

**The key never goes in client code and never gets a `VITE_` prefix.**
```

- [ ] **Step 7: Run the full test suite**

Run: `deno task test`
Expected: PASS, including the tests from Task 1 and Task 2.

- [ ] **Step 8: Commit**

```bash
git add server/routes/generate-note.ts .env.example README.md
git commit -m "feat: wire CLASSIFY_EFFORT/GENERATE_EFFORT into generate-note, document env vars"
```
