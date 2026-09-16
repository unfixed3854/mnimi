# Env vars for AI effort — design

**Date:** 2026-08-07
**Status:** approved, pending implementation plan
**Issue:** [unfixed3854/mnimi#7](https://github.com/unfixed3854/mnimi/issues/7)

## 1. Purpose

`CLASSIFY_MODEL` and `GENERATE_MODEL` (`server/ai/openrouter.ts`) already let an operator
override which model handles each AI pass. Neither pass can currently ask a reasoning-capable
model to think harder or more cheaply — OpenRouter exposes this as a `reasoning.effort` field
on chat requests, and it goes unused. This spec adds two more optional env vars, in the same
override style, so effort is tunable per pass without a code change.

## 2. Scope

In scope: `CLASSIFY_EFFORT` and `GENERATE_EFFORT`, one for each `chat()` call in
`server/routes/generate-note.ts`. Both are optional; unset means "send no `reasoning` field,
let the model use its provider default" — the same posture `CLASSIFY_MODEL`/`GENERATE_MODEL`
take when unset, just with `undefined` instead of a hardcoded fallback string, since there is
no sensible universal default effort.

Out of scope: `IMAGE_MODEL` / image generation. OpenRouter's image-generation request type
(`ImageGenerationRequest` in `@openrouter/sdk`) has no `reasoning` field — confirmed by reading
the SDK's generated types — so there is nothing to wire up there.

## 3. Valid values

OpenRouter's `ReasoningEffort` enum: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`,
`none`. Both new env vars accept exactly these strings.

## 4. Behavior

| Env var state | Behavior |
|---|---|
| Unset | No `reasoning` field sent; provider default applies. |
| Valid value | `modelOptions.reasoning = { effort: <value> }` on that pass's `chat()` call. |
| Invalid value (typo, unknown string) | Treated as unset (no `reasoning` field sent), plus one `warning`-level log naming the env var and the bad value it held. Never throws — a typo in this var should degrade to "no override," not take down request handling. |

## 5. Logging: introducing `@logtape/logtape`

The codebase has no logging library today, only two bare `console.error` calls
(`server/app.ts`, `server/routes/generate-note.ts`). This change adds `@logtape/logtape` as a
new `server/deno.json` dependency, used for the invalid-effort warning above.

A new `server/logging.ts` configures logtape once, at module load (`configureSync`, `reset:
true` so re-evaluating the module — e.g. across isolated test module graphs — never throws
logtape's "already configured" error):

- Sink: a single console sink.
- `["mnimi"]` category → the console sink, `lowestLevel: "warning"`. Everything under
  `["mnimi", ...]` inherits this unless it configures its own sinks.
- `["logtape", "meta"]` category → the console sink, `lowestLevel: "error"`, per logtape's own
  documented convention for silencing its internal meta-logger below error level.

`server/logging.ts` re-exports `getLogger` from `@logtape/logtape` so callers have one import
path that is guaranteed to run after configuration. `server/ai/openrouter.ts` creates
`const logger = getLogger(["mnimi", "ai"]);` and calls `logger.warn` from the invalid-value
path described above.

This intentionally does not touch the two existing `console.error` call sites — migrating them
to logtape is a separate, broader change and not needed for this issue.

## 6. Call-site wiring

`server/ai/openrouter.ts` gains two functions alongside the existing `classifyModel` /
`generateModel` / `imageModel`:

```ts
export const classifyReasoning = () => reasoningEffort("CLASSIFY_EFFORT");
export const generateReasoning = () => reasoningEffort("GENERATE_EFFORT");
```

backed by a shared `reasoningEffort(envVar: string): { effort: ReasoningEffort } | undefined`
helper that implements the table in §4.

`server/routes/generate-note.ts` passes the result on each pass's `chat()` call:

```ts
chat({
  adapter: textAdapter(classifyModel()),
  // ...
  modelOptions: { reasoning: classifyReasoning() },
}),
```

and the equivalent for the generate pass with `generateModel()` / `generateReasoning()`.

## 7. Documentation

`.env.example` and the README's "Optional model overrides" section list `CLASSIFY_EFFORT` and
`GENERATE_EFFORT` next to the existing three AI env vars, commented out, with the valid-values
list and the "unset = provider default" behavior noted.

## 8. Testing

New `server/ai/openrouter.test.ts`:

- `classifyReasoning()` / `generateReasoning()` return `undefined` when their env var is unset.
- Return `{ effort: <value> }` for each valid value.
- Return `undefined` for an invalid value, and cause exactly one `logger.warn` call.

Tests set/delete `Deno.env` entries directly (the pattern already used in
`server/router/write-image.test.ts`), and spy on the logger obtained from `server/logging.ts`
rather than asserting on raw console output.
