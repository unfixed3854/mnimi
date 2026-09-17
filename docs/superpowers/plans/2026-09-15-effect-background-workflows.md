# Effect Background Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended when explicitly authorized) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Mnimi server background orchestration with Effect services and fibers while preserving all existing durable-work, event, TTS, notification, sweep, and shutdown contracts.

**Architecture:** A once-created Effect background graph owns selected AI access, creation events, legacy creation, durable text/image workers, audio jobs, and draft maintenance. The current Hono/oRPC callers retain explicitly named Promise or async-generator facades until `mnimi-pi5.5`; `main.ts` remains the imperative bootstrap but starts and stops the new graph through narrow Effect bridges.

**Tech Stack:** Bun 1.3.13, TypeScript 6.0.3, Vitest 4.1.10, Effect 3.22.2, Drizzle/libSQL, Hono, oRPC, OpenRouter, Codex app-server, ElevenLabs, Expo Push.

**Spec:** `docs/superpowers/specs/2026-09-15-effect-background-workflows-design.md`

## Global Constraints

- Use Bun for every public command. Run the full suite with `VITEST_MAX_WORKERS=2 bun run test`, never raw `bun test`.
- Follow red-green-refactor. Every new behavior starts with a focused test that fails for the missing service or changed contract before production code is written.
- Preserve the public Hono/oRPC procedures, SSE framing, schemas, database schema, provider selection, exact learner-safe failure states, current log text, and existing error identity where tests assert it.
- Preserve the 2-per-user text limit, 2-global image limit, oldest-first claim order, lease durations/heartbeats, attempt/owner fencing, provider retry policy, notification drop-on-stop behavior, and detached-request behavior.
- No production operation may construct a `Layer`, `Scope`, `ManagedRuntime`, or per-call service. Importing an Effect module must not touch the filesystem, database, network, process, or timers.
- Do not add request cancellation to detached work, force-interrupt active claims during scheduler stop, add retries/timeouts/fallbacks, alter notification shutdown to flush, or unify legacy and durable creation behavior.
- `mnimi-pi5.5` owns Hono/oRPC transport conversion, request-local runtime access, final app-runtime disposal, and deleting the remaining router-facing Promise/async-generator adapters.
- Keep commits conventional and scoped. Do not commit, push, merge, or deploy without the user’s explicit authorization.

## File Structure

| Path | Responsibility |
| --- | --- |
| `apps/server/effect/background-provider.ts` | Selected OpenRouter/Codex Effect capability seam for background workflows; owns the selected scope once. |
| `apps/server/effect/creation-events.ts` | Effect subscriber state, durable initial snapshots, ordered/coalesced publication, and async-generator compatibility facade. |
| `apps/server/effect/legacy-creation.ts` | Detached legacy `drafts.start` work as Effects using the selected provider, events, notifications, and database. |
| `apps/server/effect/durable-text.ts` | Effect-native text claim/recover/renew/attempt functions and scheduler fibers. |
| `apps/server/effect/durable-images.ts` | Effect-native image queue, attempt, transfer, cleanup, and scheduler fibers. |
| `apps/server/effect/audio-jobs.ts` | Per-card generation state, compensation, bounded note fan-out, and orphan restart fibers. |
| `apps/server/effect/draft-maintenance.ts` | Immediate and hourly reference-aware draft media sweep fiber. |
| `apps/server/effect/background-workflows.ts` | Composition root exposing once-created start, kick, public facades, and stop operations. |
| Existing `creations/*.ts`, `tts/jobs.ts` | Temporary legacy exports that delegate to the new services; routers continue importing their present paths. |
| `main.ts`, `lifecycle.ts` | Bootstrap/startup ordering and explicit background stop integration, not final runtime unification. |

## Task 1: Characterize background service boundaries

**Files:**
- Modify: `apps/server/creations/events.test.ts`
- Modify: `apps/server/creations/scheduler.test.ts`
- Modify: `apps/server/creations/image-scheduler.test.ts`
- Modify: `apps/server/tts/jobs.test.ts`

**Interfaces:**
- Consumes: current public scheduler, worker, event, audio, main, and lifecycle exports.
- Produces: a stable characterization suite for the services introduced by Tasks 2-9.

- [ ] **Step 1: Add passing characterization coverage**

Extend `events.test.ts` and `sse-contract.test.ts` coverage for the current contract: subscriber registration before snapshot read, one initial snapshot, snapshot-tail replacement for a stalled client, publication after commit only, and iterator cancellation cleanup. Extend scheduler/image/TTS tests only where an existing behavior lacks a direct assertion. These tests must pass against the current Promise implementation; they are compatibility oracles, not future-module imports.

- [ ] **Step 2: Run the characterization tests and verify the baseline**

Run:

```bash
bun run --cwd apps/server vitest run creations/events.test.ts creations/scheduler.test.ts creations/image-scheduler.test.ts tts/jobs.test.ts main.test.ts lifecycle.test.ts sse-contract.test.ts
```

Expected: all current contract tests pass before any production conversion.

- [ ] **Step 3: Record the exact baseline**

Run:

```bash
VITEST_MAX_WORKERS=2 bun run server:test
bun run server:check
git diff --check
```

Record the output count and any existing environment warnings in Pimp comments. Do not change production behavior in this task.

## Task 2: Add the selected Effect background-provider seam

**Files:**
- Create: `apps/server/effect/background-provider.ts`
- Create: `apps/server/effect/background-provider.test.ts`
- Modify: `apps/server/ai/provider.ts`
- Modify: `apps/server/ai/provider.test.ts`
- Modify: `apps/server/effect/index.ts`

**Interfaces:**
- Consumes: `OpenRouterService`, `CodexRuntimeService`, `AppConfigValue`, and existing provider-selection configuration.
- Produces: `BackgroundProvider` and `acquireBackgroundProvider` for Tasks 4-6.

- [ ] **Step 1: Write the failing service contract**

Define the direct Effect contract without Promise model-call facades:

```ts
export type BackgroundProviderService = Readonly<{
  readonly classify: (prompts: Prompts) => Effect.Effect<unknown, ProviderFailure>;
  readonly route: (prompts: Prompts) => Effect.Effect<unknown, ProviderFailure>;
  readonly adjust: (prompts: Prompts) => Effect.Effect<unknown, ProviderFailure>;
  readonly generate: (prompts: Prompts) => Effect.Effect<EffectPull<string, unknown, ProviderFailure>, ProviderFailure>;
  readonly generateImageBytes: (prompt: string) => Effect.Effect<Uint8Array, ProviderFailure>;
}>;

export const BackgroundProvider = Context.GenericTag<BackgroundProviderService>(
  "@mnimi/server/BackgroundProvider",
);
```

Test that an injected environment is authoritative, provider registration gating occurs before Codex acquisition, only the selected factory is evaluated, missing configuration stays lazy at operation invocation, and release closes the selected Codex scope exactly once.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun run --cwd apps/server vitest run effect/background-provider.test.ts ai/provider.test.ts
```

Expected: missing module/tag/factory exports.

- [ ] **Step 3: Implement the scoped selected-provider constructor**

Build `acquireBackgroundProvider({ env, config, logger, factories })` with `Effect.acquireRelease`. Reuse `makeOpenRouter`/its Effect operations for OpenRouter and `CodexRuntime` for Codex. Convert the existing stream iterator into the current `EffectPull` shape; do not replay `.next()`, eagerly create clients, or construct an unselected provider.

Keep `createAiProvider({ env })` as its exact Promise compatibility result for `createApp`. Make both it and the background acquisition delegate to the same selected-provider construction rules, preserving dynamic-import/validation order.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun run --cwd apps/server vitest run effect/background-provider.test.ts effect/openrouter.test.ts effect/codex-runtime.test.ts ai/provider.test.ts ai/openrouter-provider.test.ts ai/codex/provider.test.ts
bun run server:check
git diff --check
```

## Task 3: Migrate creation events to an Effect service

**Files:**
- Create: `apps/server/effect/creation-events.ts`
- Create: `apps/server/effect/creation-events.test.ts`
- Modify: `apps/server/creations/events.ts`
- Modify: `apps/server/creations/events.test.ts`
- Modify: `apps/server/sse-contract.test.ts`
- Modify: `apps/server/effect/index.ts`

**Interfaces:**
- Consumes: `DatabaseService`, `Draft`, and existing creation snapshot types.
- Produces: `CreationEventsService` with Effect publish/subscribe operations and the unchanged async-generator facade used by `router/drafts.ts`.

- [ ] **Step 1: Write the failing events-service tests**

Specify the service as:

```ts
export type CreationEventsService = Readonly<{
  readonly subscribeDetail: (
    userId: string,
    creationId: string,
  ) => Effect.Effect<AsyncGenerator<CreationDetailSnapshot>, DatabaseFailure>;
  readonly subscribeInbox: (
    userId: string,
  ) => Effect.Effect<AsyncGenerator<CreationInboxSnapshot>, DatabaseFailure>;
  readonly publish: (
    creation: Draft,
    attemptId: string | null,
  ) => Effect.Effect<void, DatabaseFailure>;
  readonly publishInbox: (
    userId: string,
    changedCreationId: string | null,
    attemptId: string | null,
  ) => Effect.Effect<void, DatabaseFailure>;
}>;
```

Use injected snapshot readers and an explicit replacement-capable channel factory. Test synchronous registration, initial snapshot ordering, full snapshot replacement while a consumer stalls, user/detail isolation, no publication before the caller commits, and cleanup after `return()`.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun run --cwd apps/server vitest run effect/creation-events.test.ts creations/events.test.ts sse-contract.test.ts
```

Expected: missing service module.

- [ ] **Step 3: Implement and delegate**

Implement event state once per service instance. Wrap database reads in `Effect.tryPromise` mapped to `DatabaseFailure`; retain the current channel rule that replaces only the queued tail of full snapshots. Adapt `subscribeCreation`, `subscribeCreationInbox`, `publishCreationSnapshots`, and `publishCreationInboxSnapshot` to run the one installed service without changing their exports or the router's async-generator consumption.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun run --cwd apps/server vitest run effect/creation-events.test.ts creations/events.test.ts sse-contract.test.ts router/drafts.test.ts
bun run server:check
git diff --check
```

## Task 4: Move legacy detached creation to Effect

**Files:**
- Create: `apps/server/effect/legacy-creation.ts`
- Create: `apps/server/effect/legacy-creation.test.ts`
- Modify: `apps/server/router/drafts.ts`
- Modify: `apps/server/router/drafts.test.ts`
- Modify: `apps/server/effect/index.ts`

**Interfaces:**
- Consumes: `BackgroundProvider`, `CreationEvents`, `Notifications`, `Database`, and the existing creation rule/schema helpers.
- Produces: a detached `LegacyCreationWorkflow.start(input)` Effect and a router-compatible fire-and-forget facade.

- [ ] **Step 1: Add failing legacy workflow tests**

Move the legacy `startGenerationJob` contract into direct service tests. Cover the current detached request return, progress snapshot sequence, complete-card publication, validation retry behavior, final ready/needs-choice/failed persistence, and notification queueing. Assert that the request-facing facade starts one fiber and returns before the provider gate resolves.

```ts
const fiber = await Effect.runPromise(
  workflow.start({ userId: "ada", creationId: "draft-1" }),
);
expect(Fiber.isFiber(fiber)).toBe(true);
expect(provider.generate).not.toHaveBeenCalled();
```

- [ ] **Step 2: Verify RED**

Run:

```bash
bun run --cwd apps/server vitest run effect/legacy-creation.test.ts router/drafts.test.ts
```

Expected: missing workflow export.

- [ ] **Step 3: Implement the detached workflow**

Translate the current legacy job one awaited operation at a time to `Effect.gen`. Run the selected provider and event publication Effects directly. Fork only at the router compatibility boundary; catch and persist the same failure categories inside the detached fiber, then log exactly as the current job does. Do not pass an HTTP abort signal, alter provider stream consumption, or share this state machine with durable attempts.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun run --cwd apps/server vitest run effect/legacy-creation.test.ts router/drafts.test.ts creations/contracts.test.ts ai/generate-note.test.ts
bun run server:check
git diff --check
```

## Task 5: Move durable text scheduling and attempts to Effect fibers

**Files:**
- Create: `apps/server/effect/durable-text.ts`
- Create: `apps/server/effect/durable-text.test.ts`
- Modify: `apps/server/creations/scheduler.ts`
- Modify: `apps/server/creations/worker.ts`
- Modify: `apps/server/creations/scheduler.test.ts`
- Modify: `apps/server/creations/worker.test.ts`
- Modify: `apps/server/effect/index.ts`

**Interfaces:**
- Consumes: `BackgroundProvider`, `CreationEvents`, `Notifications`, `Database`, existing contracts/rules, and UUID/clock/timer test seams.
- Produces: `DurableTextWorkflowService` with `recover`, `start`, `kick(userId)`, `runAttempt(work)`, and `stop` Effects.

- [ ] **Step 1: Write the failing durable-text service tests**

Add focused tests that port every existing scheduler/worker invariant to direct Effect calls: atomic oldest claim selection; per-user active limit; exact owner/attempt renewal; boot versus expiry recovery; undo purge; immediate poll; pending-kick coalescing; poll failure logging; heartbeat single-flight and finalizer removal; all five creation operations; complete-prefix publication; reviewed-card preservation; replacement-image cancellation; reroute after deck deletion; stale-fence no-op; and terminal lease release.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun run --cwd apps/server vitest run effect/durable-text.test.ts creations/scheduler.test.ts creations/worker.test.ts
```

Expected: missing service module and direct Effect operations.

- [ ] **Step 3: Implement database operations and attempt execution**

Define the direct contract:

```ts
export type DurableTextWorkflowService = Readonly<{
  readonly recover: (
    now: Date,
    options: { readonly allLeases?: boolean; readonly includeUnleased?: boolean },
  ) => Effect.Effect<number, DatabaseFailure>;
  readonly start: () => Effect.Effect<void>;
  readonly kick: (userId: string) => Effect.Effect<void>;
  readonly runAttempt: (
    work: ClaimedCreationWork,
  ) => Effect.Effect<void, DatabaseFailure | ProviderFailure | MediaFailure>;
  readonly stop: () => Effect.Effect<void>;
}>;
```

Use the existing `Database.withWriteLock` service around every current serialized write. Use a tracked heartbeat fiber per attempt; its finalizer clears only that attempt's interval/fiber state. The scheduler uses per-user draining/pending state and forks each claimed attempt. Its stop action marks admission closed and cancels only poll scheduling; it does not interrupt in-flight attempt fibers.

Keep `claimCreationWork`, `renewCreationLease`, `recoverStaleCreationWork`, `purgeExpiredRemovedCreations`, `runCreationAttempt`, `startCreationScheduler`, and `kickCreationScheduler` as named Promise/void facades until their router callers migrate.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun run --cwd apps/server vitest run effect/durable-text.test.ts creations/scheduler.test.ts creations/worker.test.ts creations/events.test.ts router/drafts.test.ts main.test.ts
bun run server:check
git diff --check
```

## Task 6: Move durable image workflow and scheduler fibers to Effect

**Files:**
- Create: `apps/server/effect/durable-images.ts`
- Create: `apps/server/effect/durable-images.test.ts`
- Modify: `apps/server/creations/image-scheduler.ts`
- Modify: `apps/server/creations/image-scheduler.test.ts`
- Modify: `apps/server/effect/index.ts`

**Interfaces:**
- Consumes: `BackgroundProvider`, `MediaStore`, `CreationEvents`, `Database`, image schemas, and clock/timer/ID seams.
- Produces: `DurableImageWorkflowService` with enqueue/cancel/retry/transfer/recover/start/kick/stop Effect operations.

- [ ] **Step 1: Write failing image-service tests**

Port the existing image test matrix to direct Effects: global two-slot claim; text/image isolation; ready and failed settlement; retry/cancel stale fencing; superseded-media deletion; boot recovery; owner disappearance during write; late write cleanup; transfer when pending/ready/failed; immediate poll; completion coalescing; failed-poll continuation; and heartbeat finalization.

Add a new test that stops the scheduler after a claim and proves the active image fiber still runs its guarded cleanup path while no new claim is admitted.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun run --cwd apps/server vitest run effect/durable-images.test.ts creations/image-scheduler.test.ts
```

Expected: missing image workflow module.

- [ ] **Step 3: Implement the Effect image workflow**

Keep the present database ordering and compensation exact. Use `MediaStore` for draft write/claim/remove and `BackgroundProvider.generateImageBytes` for generation; remove these dependencies from the production Promise worker path. Around written-media settlement, use a finalizer that removes a claimed path or draft image whenever the matching attempt fence disappears or a guarded write fails. The image scheduler owns one periodic poll fiber, a boolean drain/pending state, and active attempt fibers; stop clears future polling/admission only.

Make `enqueueCreationImage`, `cancelCreationImage`, `retryCreationImage`, `transferCreationImageToNote`, `recoverStaleCreationImageWork`, `runCreationImageAttempt`, `startImageScheduler`, and `kickImageScheduler` delegate to the installed service until router conversion.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun run --cwd apps/server vitest run effect/durable-images.test.ts creations/image-scheduler.test.ts creations/worker.test.ts router/drafts.test.ts router/notes.test.ts main.test.ts
bun run server:check
git diff --check
```

## Task 7: Move audio jobs and bounded fan-out to Effect

**Files:**
- Create: `apps/server/effect/audio-jobs.ts`
- Create: `apps/server/effect/audio-jobs.test.ts`
- Modify: `apps/server/tts/jobs.ts`
- Modify: `apps/server/tts/jobs.test.ts`
- Modify: `apps/server/effect/index.ts`

**Interfaces:**
- Consumes: `ElevenLabs`, `MediaStore`, `Database`, card eligibility rules, and UUID generation.
- Produces: `AudioJobsService` with Effect card/note/orphan/invalidation operations and existing exported errors/facades.

- [ ] **Step 1: Write failing audio service tests**

Define:

```ts
export type AudioJobsService = Readonly<{
  readonly generateCard: (
    userId: string,
    cardId: string,
  ) => Effect.Effect<void, AudioCardNotFoundError | AudioCardIneligibleError | DatabaseFailure | ProviderFailure | MediaFailure>;
  readonly generateNote: (
    userId: string,
    cardIds: readonly string[],
    concurrency?: number,
  ) => Effect.Effect<void>;
  readonly resumeOrphaned: (
    userId: string,
    cards: readonly AudioCardRow[],
  ) => Effect.Effect<void>;
  readonly invalidate: (cardId: string) => Effect.Effect<void>;
  readonly hasLiveJob: (cardId: string) => Effect.Effect<boolean>;
}>;
```

Port the entire existing audio suite, adding direct assertions that generation state is instance-local, invalidation increments the card generation before the old fiber can attach bytes, and note fan-out never exceeds the supplied concurrency.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun run --cwd apps/server vitest run effect/audio-jobs.test.ts tts/jobs.test.ts
```

Expected: missing audio service module.

- [ ] **Step 3: Implement state and compensation**

Use Effect-managed synchronized state keyed by card ID for generation numbers and active fibers. Preserve the authorization query before joining an existing job. Use `ElevenLabs.synthesizeSpeech` and `MediaStore` directly, perform each status mutation through the database write lock, and remove stale or unattachable media in a finalizer. `generateNote` uses a bounded worker/fiber pool and logs individual card failures. `resumeOrphaned` forks eligible work and logs failures without rejecting the calling read.

Retain `AudioCardNotFoundError`, `AudioCardIneligibleError`, `generateCardAudio`, `generateNoteAudio`, `resumeOrphanedAudio`, `invalidateCardAudioJob`, and `hasAudioJob` as router-facing compatibility exports.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun run --cwd apps/server vitest run effect/audio-jobs.test.ts tts/jobs.test.ts router/cards.test.ts router/notes.test.ts router/creation-save.test.ts
bun run server:check
git diff --check
```

## Task 8: Add draft maintenance and compose once-created workflows

**Files:**
- Create: `apps/server/effect/draft-maintenance.ts`
- Create: `apps/server/effect/draft-maintenance.test.ts`
- Create: `apps/server/effect/background-workflows.ts`
- Create: `apps/server/effect/background-workflows.test.ts`
- Modify: `apps/server/effect/index.ts`
- Modify: `apps/server/images.ts`
- Modify: `apps/server/images.test.ts`

**Interfaces:**
- Consumes: `MediaStore`, `Database`, and all Task 2-7 services.
- Produces: `BackgroundWorkflowsService` with `recoverAndStart`, text/image kicks, router facades, and one idempotent `stop` Effect.

- [ ] **Step 1: Write failing maintenance and composition tests**

Test an initial sweep plus an hourly sweep, reference collection from both `drafts.draftImageId` and `creationImageAttempts.draftImageId`, the unchanged 24-hour maximum age, logged sweep failure followed by a later sweep, timer/fiber cleanup on stop, and no sweep after stop.

Test that `makeBackgroundWorkflows` creates exactly one of every child service and that calling `recoverAndStart` runs text recovery before text admission, then image recovery before image admission, without constructing a second provider or notification dispatcher. Add the Task 1 lifecycle contract here:

```ts
it("stops new scheduler admission and notification timers without interrupting an already claimed attempt", async () => {
  const running = deferred<void>();
  const workflows = makeBackgroundWorkflowsForTest({
    runText: () => Effect.promise(() => running.promise),
  });

  await Effect.runPromise(workflows.recoverAndStart());
  await Effect.runPromise(workflows.kickText("ada"));
  await waitForClaim("ada");
  await Effect.runPromise(workflows.stop());

  expect(await claimAfterStop("ada")).toEqual([]);
  running.resolve();
  await expect(observeSettledFence("ada")).resolves.toBe(true);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
bun run --cwd apps/server vitest run effect/draft-maintenance.test.ts effect/background-workflows.test.ts images.test.ts
```

Expected: missing maintenance/composition services.

- [ ] **Step 3: Implement maintenance and composition**

Expose:

```ts
export type BackgroundWorkflowsService = Readonly<{
  readonly recoverAndStart: () => Effect.Effect<void, DatabaseFailure>;
  readonly kickText: (userId: string) => Effect.Effect<void>;
  readonly kickImages: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;
}>;
```

`recoverAndStart` performs the exact current startup order: text boot recovery, notification/text start, image boot recovery, image start, then immediate maintenance sweep and its hourly schedule. Its stop action is idempotent and invokes maintenance, text, image, and notification stop actions without allowing one failure to skip another. Use `Effect.all`/cause aggregation to preserve the existing all-cleanup-attempts behavior.

Keep `images.sweepDrafts` as the media Promise facade for non-workflow callers, but make maintenance use `MediaStore.sweepDrafts` directly.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun run --cwd apps/server vitest run effect/draft-maintenance.test.ts effect/background-workflows.test.ts images.test.ts creations/scheduler.test.ts creations/image-scheduler.test.ts notifications/dispatcher.test.ts
bun run server:check
git diff --check
```

## Task 9: Wire production bootstrap and compatibility facades

**Files:**
- Modify: `apps/server/main.ts`
- Modify: `apps/server/main.test.ts`
- Modify: `apps/server/lifecycle.ts`
- Modify: `apps/server/lifecycle.test.ts`
- Modify: `apps/server/notifications/dispatcher.ts`
- Modify: `apps/server/notifications/dispatcher.test.ts`
- Modify: `apps/server/creations/scheduler.ts`
- Modify: `apps/server/creations/image-scheduler.ts`
- Modify: `apps/server/creations/events.ts`
- Modify: `apps/server/tts/jobs.ts`

**Interfaces:**
- Consumes: `BackgroundWorkflowsService`, current `ServerResources`, current `AiProvider` adapter, and existing public exports.
- Produces: real production callers that use the Effect graph while preserving all present router import paths and signatures.

- [ ] **Step 1: Write the failing bootstrap tests**

Update `main.test.ts` so it proves: provider selection precedes app creation; text recovery then workflow admission precedes image recovery/image admission; background stop is called on both signals exactly once; late claims are rejected after admission is fenced; startup failure invokes every acquired cleanup; and readiness still prints only after a successful `Bun.serve` bind.

Update `lifecycle.test.ts` to prove the new background cleanup participates in aggregation without changing server/provider ordering.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun run --cwd apps/server vitest run main.test.ts lifecycle.test.ts notifications/dispatcher.test.ts
```

Expected: existing resource graph does not yet own the background service.

- [ ] **Step 3: Wire once-created production services**

In `main.ts`, construct the selected background provider and `BackgroundWorkflowsService` once after the current core setup. Pass the existing Promise `AiProvider` adapter to `createApp`, but invoke `recoverAndStart` directly through the Effect bridge before binding Bun. Store `workflows.stop` in `ServerResources`; remove direct construction of Promise schedulers, workers, notification dispatcher, and sweep interval from main.

In `lifecycle.ts`, run the background stop action with the existing all-settled cleanup group after `markShuttingDown`. Preserve current idempotence and aggregate-error behavior. Each legacy module facade resolves the one installed production service and keeps the current test injection seams; it must fail clearly in isolated tests that forgot to install a service rather than silently creating a parallel instance.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun run --cwd apps/server vitest run main.test.ts lifecycle.test.ts effect/*.test.ts creations/*.test.ts tts/jobs.test.ts notifications/*.test.ts sse-contract.test.ts router/drafts.test.ts router/notes.test.ts router/cards.test.ts router/creation-save.test.ts
bun run server:check
git diff --check
```

## Task 10: Audit, review, validate, and hand off

**Files:**
- Modify only if evidence requires it: `docs/superpowers/specs/2026-09-15-effect-background-workflows-design.md`
- Modify only if evidence requires it: `docs/superpowers/plans/2026-09-15-effect-background-workflows.md`
- Modify: Pimp task with source ID `mnimi-pi5.4`

**Interfaces:**
- Consumes: completed Tasks 1-9 and the approved design.
- Produces: review evidence, validation evidence, and a clean handoff.

- [ ] **Step 1: Request an independent code review**

Give an independent reviewer the Task 2-9 diff and the approved spec. Require file-and-line findings for: dead parallel services, provider laziness, per-call runtime/scope creation, event loss/reordering, lease/heartbeat regression, active-fiber interruption, compensation holes, notification flush/retry drift, import side effects, transport scope creep, and missing compatibility-facade removal ownership.

For each confirmed finding, add a regression test first, fix the owning service, and rerun its focused gate. Record rejected findings with technical evidence.

- [ ] **Step 2: Run integrated deterministic validation**

Run:

```bash
bun run server:check
VITEST_MAX_WORKERS=2 bun run server:test
bun run --cwd apps/server scripts/runtime-smoke.ts
bun run check
VITEST_MAX_WORKERS=2 bun run test
git diff --check
```

Record exact test counts and exit status. Report mobile Expo Go/VM test-environment warnings separately from failures.

- [ ] **Step 3: Audit service ownership and scope**

Run:

```bash
rg -n "ManagedRuntime.make|Layer\.launch|Effect\.runPromise" apps/server/effect apps/server/creations apps/server/tts apps/server/notifications apps/server/main.ts
rg -n "createNotificationDispatcher|startCreationScheduler|startImageScheduler|setInterval" apps/server/main.ts apps/server/effect
git diff --stat
git status --short --branch
```

Confirm no old workflow instance remains in production main, all background production calls enter the new Effect graph, router exports remain compatible, no per-operation runtime/scope exists, and no unexpected file is modified.

- [ ] **Step 4: Update durable task state and hand off**

Update `mnimi-pi5.4` with the commit range, focused gates, full validation, independent-review outcome, and any intentionally retained transport facades. Close it only after every acceptance criterion is met. Do not push, merge, deploy, or commit without user authorization.
