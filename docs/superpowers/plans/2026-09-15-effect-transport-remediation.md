# Effect Transport Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve media HTTP responses, detached-work admission, and application-scope resource ownership in the Effect transport migration.

**Architecture:** Keep Hono media handlers as Promise boundaries, but unwrap `MediaFailure` to the original filesystem cause before existing 404 handling. Split request-bound Effect execution from application-owned detached execution so a client abort never cancels admitted work. Fence workflow admission on shutdown, then settle tracked worker fibers before Effect releases provider and database resources.

**Tech Stack:** Bun, TypeScript, Vitest, Effect 3.22.2, Hono, oRPC, Drizzle/libSQL.

**Spec:** `docs/superpowers/specs/2026-09-15-effect-transport-runtime-design.md`

## Global Constraints

- Retain existing media 404 behavior, request authentication, cancellation boundaries, and shutdown ordering.
- Hono/oRPC remain Promise boundaries; server-domain work uses the one application runtime.
- Do not release provider or database resources while an admitted workflow can still settle state.
- Run the workspace check and full suite with Bun; do not push or merge.

---

### Task 1: Restore owned-media miss compatibility

**Files:**
- Modify: `apps/server/effect/media.ts`, `apps/server/images.ts`, `apps/server/audio.ts`
- Test: `apps/server/images.test.ts`, `apps/server/audio.test.ts`

- [ ] Add failing route tests using injected `MediaStore` reads that fail with `MediaFailure` whose cause is `ENOENT`; assert 404.
- [ ] Export the existing `MediaFailure`-to-cause bridge from `media.ts` and use it for owned image and audio reads.
- [ ] Run the media route tests and confirm owned and legacy reads have the same 404 result.

### Task 2: Keep admitted work independent of a client abort

**Files:**
- Modify: `apps/server/router/base.ts`, `apps/server/router/drafts.ts`, `apps/server/router/notes.ts`, `apps/server/router/creation-save.ts`
- Test: `apps/server/router/base.test.ts`

- [ ] Add a failing test with an already-aborted request signal and an application-runtime program that must still run through a detached runner.
- [ ] Add `runDetachedWorkflow`, which uses the owned runtime without an HTTP abort signal, and use it only for post-commit audio, text-scheduler, legacy generation, and image-start admissions.
- [ ] Run router boundary tests and confirm ordinary request work remains request-scoped.

### Task 3: Settle admitted worker fibers before releasing the application graph

**Files:**
- Modify: `apps/server/effect/legacy-jobs.ts`, `apps/server/effect/durable-text.ts`, `apps/server/effect/durable-images.ts`, `apps/server/effect/audio-jobs.ts`, `apps/server/effect/background-workflows.ts`, `apps/server/effect/application.ts`
- Test: `apps/server/effect/application.test.ts` and workflow unit tests

- [ ] Add a failing application disposal test that requires workflow settlement before provider release.
- [ ] Track daemon fibers in each workflow, fence new admission on `stop`, and expose a settlement effect that observes already admitted work without interrupting guarded settlement.
- [ ] Have the application layer run `stop` then settlement before releasing provider and core services; aggregate cleanup failures through the existing Effect scope.
- [ ] Run the focused workflow/application tests, then `bun run check`, `VITEST_MAX_WORKERS=2 bun run test`, and `git diff --check`.
