# Image Generation Model Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change mnimi's default image-generation model to `black-forest-labs/flux.2-klein-4b` everywhere it is configured or documented, while preserving `IMAGE_MODEL` overrides.

**Architecture:** Keep the existing environment lookup in `server/ai/openrouter.ts`; only replace its fallback string. Update the checked-in example, README, and local `.env` to the same model identifier. Add focused tests around `imageModel()` for both unset fallback and explicit override behavior.

**Tech Stack:** Deno, TypeScript, Vitest, OpenRouter configuration, Markdown, dotenv-style environment files.

## Global Constraints

- Use `deno` for package management and script execution; do not use `npm`, `npx`, `yarn`, or `pnpm`.
- Preserve `Deno.env.get("IMAGE_MODEL")` precedence over the fallback.
- Use the exact model identifier `black-forest-labs/flux.2-klein-4b`.
- Do not expose or modify unrelated secrets in `.env`.

---

### Task 1: Update the default model and lock its behavior with tests

**Files:**
- Modify: `server/ai/openrouter.ts` — `imageModel()` fallback.
- Modify: `server/ai/openrouter.test.ts` — import and test `imageModel()`.
- Modify: `.env.example` — documented example image model.
- Modify: `.env` — local image model override.
- Modify: `README.md` — documented default image model.

**Interfaces:**
- Consumes: existing `imageModel(): string` function and `IMAGE_MODEL` environment variable.
- Produces: `imageModel()` returning `black-forest-labs/flux.2-klein-4b` when unset and returning any explicit `IMAGE_MODEL` value unchanged.

- [ ] **Step 1: Add the failing fallback and override tests**

In `server/ai/openrouter.test.ts`, change the import to include `imageModel`:

```ts
import {
  classifyReasoning,
  generateReasoning,
  imageModel,
} from "./openrouter.ts";
```

Add this test block before the existing `describe("classifyReasoning", ...)` block:

```ts
describe("imageModel", () => {
  beforeEach(() => {
    Deno.env.delete("IMAGE_MODEL");
  });

  afterEach(() => {
    Deno.env.delete("IMAGE_MODEL");
  });

  it("returns the Flux default when IMAGE_MODEL is unset", () => {
    expect(imageModel()).toBe("black-forest-labs/flux.2-klein-4b");
  });

  it("returns an explicit IMAGE_MODEL override unchanged", () => {
    Deno.env.set("IMAGE_MODEL", "some/provider-model");
    expect(imageModel()).toBe("some/provider-model");
  });
});
```

- [ ] **Step 2: Run the focused test to verify the fallback test fails**

Run:

```bash
deno task test server/ai/openrouter.test.ts
```

Expected: the new fallback test fails because the current fallback is `google/gemini-2.5-flash-image`; the explicit override test passes.

- [ ] **Step 3: Change the runtime fallback**

In `server/ai/openrouter.ts`, change only the image fallback:

```ts
export const imageModel = () =>
  Deno.env.get("IMAGE_MODEL") ?? "black-forest-labs/flux.2-klein-4b";
```

- [ ] **Step 4: Update all requested configuration and documentation references**

Make these exact replacements, leaving all other environment values and secrets untouched:

```text
.env.example: IMAGE_MODEL=qwen/qwen-image-3
→           IMAGE_MODEL=black-forest-labs/flux.2-klein-4b

.env:        IMAGE_MODEL=qwen/qwen-image-3
→           IMAGE_MODEL=black-forest-labs/flux.2-klein-4b

README.md:   IMAGE_MODEL=google/gemini-2.5-flash-image
→           IMAGE_MODEL=black-forest-labs/flux.2-klein-4b
```

- [ ] **Step 5: Run focused tests to verify behavior**

Run:

```bash
deno task test server/ai/openrouter.test.ts
```

Expected: PASS, including both `imageModel` cases and the existing reasoning tests.

- [ ] **Step 6: Verify references and run the complete suite**

Run:

```bash
rg -n "IMAGE_MODEL=|imageModel|google/gemini-2.5-flash-image|qwen/qwen-image-3|black-forest-labs/flux.2-klein-4b" server .env .env.example README.md

deno task test

git diff --check
git status --short
```

Expected: the new model appears in the runtime fallback, `.env`, `.env.example`, README, and tests; the old model identifiers no longer appear in active configuration/documentation; the full suite passes; `git diff --check` reports no whitespace errors.

- [ ] **Step 7: Review the diff and commit the implementation**

Run:

```bash
git diff -- server/ai/openrouter.ts server/ai/openrouter.test.ts .env.example .env README.md
git add server/ai/openrouter.ts server/ai/openrouter.test.ts .env.example .env README.md
git commit -m "feat: change default image generation model"
```

The commit must contain only the runtime fallback, focused tests, requested environment updates, and README update.
