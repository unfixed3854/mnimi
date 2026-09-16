# Effect Infrastructure Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task by task.
> Use superpowers:test-driven-development for every production change and
> superpowers:verification-before-completion before every commit.

**Goal:** Make media/ElevenLabs, OpenRouter generation, Codex, and push
notifications Effect-native behind their unchanged production Promise
contracts, without changing jobs, routers, transport, main, or the
process-bound core-runtime lifetime.

**Architecture:** Each adapter family has a `Context.Tag`, deterministic
service constructor, Layer constructor, and named Promise compatibility
facade. The facade and Layer share one Effect implementation; current
production exports delegate through the facade so no dead parallel service is
introduced. Stateless services use one service value per facade. The Codex
provider owns a dedicated Effect Scope that its existing async-dispose hook
closes. A final integration task alone owns shared provider selection, the
Effect barrel, and import-boundary coverage.

**Tech Stack:** Bun 1.3.13, TypeScript 6.0.3, Vitest 4.1.10, Effect 3.22.2,
TanStack AI/OpenRouter, Codex app-server protocol, Hono, Drizzle/libSQL,
LogTape, Expo Push API.

**Spec:**
`docs/superpowers/specs/2026-09-14-effect-infrastructure-adapters-design.md`

Tasks 1-2 are Track A, Task 3 is Track B, Task 4 is Track C, and Task 5 is
Track D. Tracks A-D have disjoint file ownership and may run concurrently.
Task 6 begins only after their reviewed commits. Task 7 is the integrated
verification gate.

## Global constraints

- Use `bun` for package management and public scripts. Never use Deno, npm,
  npx, Yarn, pnpm, or raw `bun test`.
- Use conventional commits. The primary agent inspects and serializes commits.
- Follow red-green-refactor. Show the new test failing for the intended reason
  before editing production code.
- Do not edit jobs, schedulers, workers, routers, Hono/oRPC transport,
  `main.ts`, `lifecycle.ts`, database/auth ownership, schemas/migrations,
  deployment files, or the process-bound core Layer graph.
- Do not add retry, timeout, replay, reconnect, fallback, eager validation, or
  cancellation claims.
- Existing Promise export names, argument shapes, return values, exact errors,
  operation order, timer behavior, and disposal behavior remain compatible.
- New Effect modules do not import `main.ts`, `app.ts`, routers, jobs,
  schedulers, `auth.instance.ts`, the runtime `db/index.ts` value, or the old
  logging singleton. Type-only `Db` imports at the notification compatibility
  edge are allowed.
- At a Promise boundary, unwrap the original diagnostic cause when existing
  code depends on error identity, `.code`, `cause.issues`, or `.message`.
- No operation creates a Layer, Scope, or ManagedRuntime per call. Scoped
  resources are acquired once per owning provider/dispatcher instance.
- Each compatibility facade gets a code comment naming its removal child.
- Only Task 6 may edit `apps/server/ai/provider.ts`,
  `apps/server/effect/index.ts`, `apps/server/import-boundary.test.ts`, or a
  shared Effect testing helper.
- At every task boundary run the focused tests, `bun run server:check`, and
  `git diff --check`. Full repository validation belongs to Task 7.

## File ownership map

| Track | Owned production files | Owned tests |
| --- | --- | --- |
| A1 Media | create `effect/media.ts`; modify `images.ts`, `audio.ts` | create `effect/media.test.ts`; modify `images.test.ts`, `audio.test.ts`, `write-image.test.ts`, `write-audio.test.ts` only as needed |
| A2 ElevenLabs | create `effect/elevenlabs.ts`; modify `tts/elevenlabs.ts` | create `effect/elevenlabs.test.ts`; modify `tts/elevenlabs.test.ts` |
| B OpenRouter/generation | create `effect/ai-generation.ts`, `effect/openrouter.ts`; modify `ai/generate.ts`, `ai/generate-note.ts`, `ai/model-calls.ts`, `ai/openrouter.ts`, `ai/openrouter-image.ts`, `ai/openrouter-provider.ts` | matching new tests and existing `ai/generate*`, `model-calls`, `openrouter*` tests |
| C Codex | create `effect/codex-runtime.ts`; modify `ai/codex/provider.ts` | create `effect/codex-runtime.test.ts`; modify `ai/codex/provider.test.ts` |
| D Notifications | create `effect/expo-push.ts`, `effect/notifications.ts`; modify `notifications/expo-push.ts`, `notifications/dispatcher.ts` | create matching Effect tests; modify existing notification tests |
| Integration | `ai/provider.ts`, `effect/index.ts`, `import-boundary.test.ts`, docs/Beads evidence only | `ai/provider.test.ts` plus import-boundary tests |

If a worker discovers that a required change falls outside its owned paths, it
must report the seam to the primary agent rather than editing the shared file.

## Interfaces between tracks

Track A produces `MediaStore`, `MediaStoreService`, `makeMediaStore`,
`makeMediaStoreLayer`, `makeMediaPromiseFacade`, `ElevenLabs`,
`ElevenLabsService`, `makeElevenLabs`, `makeElevenLabsLayer`, and
`makeElevenLabsPromiseFacade`.

Track B produces `AiGeneration`, `OpenRouter`, deterministic constructors,
Layers, `makeGenerationPromiseFacade`, `makeOpenRouterModelCalls`, and
`makeOpenRouterProvider`. The existing `createOpenRouterProvider` may accept
an optional captured environment but must remain callable with no arguments.

Track C produces `CodexRuntime`, a scoped layer or acquire function, and a
Promise `AiProvider` facade. The existing `createCodexProvider({ env })`
remains the public factory and owns closing its acquired Scope.

Track D produces `ExpoPush`, `Notifications`, deterministic constructors and
Layers, `makeExpoPushPromiseFacade`, and
`makeNotificationDispatcherPromiseFacade`. Existing public notification types
and factories remain at their current paths.

Task 6 makes `createAiProvider({ env })` pass the authoritative captured
environment to both provider factories without importing the unselected
provider and exports all new Effect modules from the barrel.

## Task 1: MediaStore Effect operations and production facade

**Bead:** `mnimi-pi5.3.1`

**Files:**

- Create: `apps/server/effect/media.ts`
- Create: `apps/server/effect/media.test.ts`
- Modify: `apps/server/images.ts`
- Modify: `apps/server/audio.ts`
- Modify focused legacy tests only when needed to prove delegation

- [ ] **Step 1: Record the current contract**

Run the unchanged characterization set:

```bash
bun run --cwd apps/server vitest run images.test.ts audio.test.ts write-image.test.ts write-audio.test.ts fs-errors.test.ts
```

Read every media caller before choosing the facade shape. Do not move route
auth, DB ownership checks, status mapping, headers, `setNoteImageFailed`, or
job compensation.

- [ ] **Step 2: Write failing Effect service tests**

Cover configured/default roots, strict UUIDv7 segments, extensions and root
containment, traversal rejection before I/O, image/audio atomic replacement,
sibling temporary cleanup when write or rename fails, original primary error
preservation, meaningful draft-claim `ENOENT`, idempotent remove only for
not-found errors, audio existence, read hit/miss classification, sweep absent
directory, cutoff, referenced IDs, sequential deletes, and no implicit retry.

Inject filesystem functions and roots. Verify constructing/importing the
service performs no filesystem operation.

- [ ] **Step 3: Run the new test and confirm RED**

```bash
bun run --cwd apps/server vitest run effect/media.test.ts
```

Expected: module/export missing or service contract not implemented.

- [ ] **Step 4: Implement the minimal MediaStore**

Use `MediaFailure` with operation, exact compatibility message, and cause.
Make write/rename/cleanup an uninterruptible Effect region after work begins.
Do not add a finalizer or retry. Provide an explicit constructor from roots and
injected filesystem operations plus a Layer constructor from `AppConfig` and
`Logging`.

- [ ] **Step 5: Make legacy exports delegate**

Keep the current module-captured root behavior in `images.ts`/`audio.ts`, but
build one facade service from those captured values and implement the Promise
exports by running its Effects. Preserve raw error identity/code where current
tests or routes inspect them. Keep the route definitions and DB helper in
place.

Add a removal comment: job/router media callbacks disappear during their
Effect migrations; read facades disappear in the transport child.

- [ ] **Step 6: Verify GREEN and compatibility**

```bash
bun run --cwd apps/server vitest run effect/media.test.ts images.test.ts audio.test.ts write-image.test.ts write-audio.test.ts fs-errors.test.ts
bun run server:check
git diff --check
```

- [ ] **Step 7: Review and commit**

Have a fresh worker review only Track A1 against the spec. Resolve findings,
rerun the gate, then commit:

```bash
git add apps/server/effect/media.ts apps/server/effect/media.test.ts apps/server/images.ts apps/server/audio.ts apps/server/images.test.ts apps/server/audio.test.ts apps/server/write-image.test.ts apps/server/write-audio.test.ts
git commit -m "feat(server): own media storage with Effect"
```

Stage only paths actually changed.

## Task 2: ElevenLabs Effect operation and production facade

**Bead:** `mnimi-pi5.3.1`

**Files:**

- Create: `apps/server/effect/elevenlabs.ts`
- Create: `apps/server/effect/elevenlabs.test.ts`
- Modify: `apps/server/tts/elevenlabs.ts`
- Modify: `apps/server/tts/elevenlabs.test.ts`

- [ ] **Step 1: Characterize then write failing tests**

First run the existing test. Add service tests for the exact percent-encoded
voice URL, headers, output format and JSON body; model/voice defaults and
overrides; lazy missing key; non-success status; empty bytes; fetch rejection;
one fetch/no retry; redacted configuration; and no work during construction.

```bash
bun run --cwd apps/server vitest run tts/elevenlabs.test.ts
bun run --cwd apps/server vitest run effect/elevenlabs.test.ts
```

The second command must fail for the intended missing service/export.

- [ ] **Step 2: Implement the Effect service**

Expose `synthesizeSpeech(text)` as an Effect failing with
`DependencyUnavailable` for a missing key and `ProviderFailure` for provider
or response failures. Retain the original cause. The deterministic constructor
accepts captured values and fetch; the Layer consumes AppConfig. Do not retry,
time out, fall back, or claim interruption.

- [ ] **Step 3: Delegate the public Promise export**

Keep the existing optional fetch injection and lazy invocation-time environment
behavior through one injected configuration thunk. The Layer path instead uses
the immutable AppConfig snapshot. The current export runs the shared service
implementation and rethrows the exact legacy errors. Add the AudioJobs removal
comment. Do not edit `tts/jobs.ts`.

- [ ] **Step 4: Verify, review, and commit**

```bash
bun run --cwd apps/server vitest run effect/elevenlabs.test.ts tts/elevenlabs.test.ts tts/jobs.test.ts
bun run server:check
git diff --check
git add apps/server/effect/elevenlabs.ts apps/server/effect/elevenlabs.test.ts apps/server/tts/elevenlabs.ts apps/server/tts/elevenlabs.test.ts
git commit -m "feat(server): own ElevenLabs requests with Effect"
```

A fresh reviewer checks exact errors, lazy secret access, and no retry before
the primary agent commits.

## Task 3: OpenRouter and generation Effect services

**Bead:** `mnimi-pi5.3.2`

**Files:** Track B paths from the ownership map. Do not edit the provider
selector, Effect barrel, import-boundary test, Codex files, jobs, or routers.

- [ ] **Step 1: Establish the compatibility baseline**

```bash
bun run --cwd apps/server vitest run ai/schemas.test.ts ai/generate.test.ts ai/generate-note.test.ts ai/creation-generation.test.ts ai/creation-routing.test.ts ai/creation-adjustment.test.ts ai/model-calls.test.ts ai/openrouter.test.ts ai/openrouter-image.test.ts ai/openrouter-provider.test.ts
```

- [ ] **Step 2: Write failing generation-service tests**

Test exactly one validation retry, retry only for
`structured-output-validation-failed`, `cause.issues` preservation, no retry
for unrelated/stream failures, twice-failed text, accumulated deltas, retry
event order, accumulator reset, image-prompt timing, card snapshot
deduplication, stable-key reset, and terminal validation.

The Effect service may reuse current pure schemas/rules. Its Promise facade
must retain the current async iterable and event shapes.

- [ ] **Step 3: Write failing OpenRouter-service tests**

Test no SDK/network work at construction, lazy exact missing-key error, model
defaults/overrides, accepted reasoning values, empty/unset omission, invalid
warning, exact structured role calls, stream chunk filtering and RUN_ERROR,
route `proposed` normalization/warning, per-model cache success/concurrent
coalescing/failure eviction, Images-vs-chat routing, prompt suffix, request
shape, data URL decoding, exact image errors, and no generation retry.

```bash
bun run --cwd apps/server vitest run effect/ai-generation.test.ts effect/openrouter.test.ts
```

Confirm RED for missing modules/exports.

- [ ] **Step 4: Implement deterministic services and Layers**

Use `ProviderFailure({ provider: "openrouter", operation, message, cause })`.
Construct from captured OpenRouter config, logger, SDK/client/fetch factories,
and cache. Add Layers from AppConfig/Logging without eager client creation.
Do not move Zod/rule modules simply for ownership aesthetics.

- [ ] **Step 5: Convert existing exports into facades**

Make `generate.ts`, `generate-note.ts`, `model-calls.ts`, `openrouter.ts`, and
`openrouter-image.ts` delegate to the shared Effect implementations while
retaining their exact types. `createOpenRouterProvider` builds one service
instance and returns the current `AiProvider`; accept an optional environment
for Task 6, but keep no-argument behavior and the legacy exported-object
identity where existing tests require it. The explicit-environment factory
captures its authoritative values once, while direct legacy exports retain
their current invocation-time reads. Async disposal stays idempotent and
resource-free.

Add removal comments for generation jobs, creation workers, image scheduler,
and final provider selection.

- [ ] **Step 6: Verify, review, and commit**

```bash
bun run --cwd apps/server vitest run effect/ai-generation.test.ts effect/openrouter.test.ts ai/schemas.test.ts ai/generate.test.ts ai/generate-note.test.ts ai/creation-generation.test.ts ai/creation-routing.test.ts ai/creation-adjustment.test.ts ai/model-calls.test.ts ai/openrouter.test.ts ai/openrouter-image.test.ts ai/openrouter-provider.test.ts ai/codex/provider.test.ts
bun run server:check
git diff --check
```

A fresh reviewer checks retry/event/cache behavior, lazy credentials, typed
failure mapping, and Codex compatibility. The primary agent stages only Track
B paths and commits:

```bash
git commit -m "feat(server): own OpenRouter generation with Effect"
```

## Task 4: Scoped CodexRuntime and AiProvider facade

**Bead:** `mnimi-pi5.3.3`

**Files:**

- Create: `apps/server/effect/codex-runtime.ts`
- Create: `apps/server/effect/codex-runtime.test.ts`
- Modify: `apps/server/ai/codex/provider.ts`
- Modify: `apps/server/ai/codex/provider.test.ts`

- [ ] **Step 1: Run the full offline Codex oracle**

Run all `apps/server/ai/codex/*.test.ts` files plus process-tree and supervisor
tests. Record the count and duration before changing production code.

- [ ] **Step 2: Write failing scoped-service tests**

Cover one client acquisition per Scope, exact eager validation order, no
acquisition for an unselected provider, failed-connect cleanup, primary error
preservation when cleanup fails, typed sanitized categories, one operation
invocation/no replay, dead-connection behavior delegated unchanged, release
idempotence, and awaiting bounded client disposal. Test AppConfig defaults,
explicit blank role values, authoritative injected env, and no direct env read
inside the service.

- [ ] **Step 3: Implement CodexRuntime over the existing edge**

Use `Effect.acquireRelease` or an equivalent scoped constructor. Register the
release as soon as the client/provider is acquired. Keep app-server client,
JSONL, operation workspace, process group, and supervisor modules as low-level
Promise/process edges. Map failures to `ProviderFailure` while retaining the
sanitized original error for the facade.

- [ ] **Step 4: Make createCodexProvider own the Scope**

The existing factory acquires one service scope after selected-provider
registration gating. Its `modelCalls` and image function run service Effects;
its async-dispose closes the scope once. Failed construction closes the scope
and preserves the current aggregation behavior. Do not edit provider selection
or main.

Add removal comments for jobs/image scheduler and later unified runtime
ownership.

- [ ] **Step 5: Verify, review, and commit**

```bash
bun run --cwd apps/server vitest run effect/codex-runtime.test.ts ai/codex/*.test.ts ai/provider.test.ts ai/generate.test.ts ai/generate-note.test.ts
bun run server:check
git diff --check
```

A fresh reviewer checks one-process-per-scope, cleanup bounds, no replay, error
sanitization, workspace/process invariants, and Promise compatibility. Then:

```bash
git add apps/server/effect/codex-runtime.ts apps/server/effect/codex-runtime.test.ts apps/server/ai/codex/provider.ts apps/server/ai/codex/provider.test.ts
git commit -m "feat(server): own Codex runtime with Effect"
```

## Task 5: ExpoPush and Notifications Effect services

**Bead:** `mnimi-pi5.3.4`

**Files:** Track D paths only.

- [ ] **Step 1: Expand characterization before production code**

Add legacy tests for empty send/no fetch, exact headers/body/order, non-OK
message, missing/malformed ticket arrays, positional invalid-token mapping,
both token formats, non-registration ticket errors, empty pending/actionable/
installation short circuits, mixed grouped body, duplicate ID deduplication,
per-user isolation, timer replacement/unref, DB/send/delete failures, flush
clearing state before work, idempotent stop, and stop dropping pending work.

Run the tests and confirm current behavior before adding Effect tests.

- [ ] **Step 2: Write failing Effect tests**

Define `ExpoPush.send(messages)` and Notifications `queue`, `flush`, and
`stop` Effect operations or equivalent state-safe methods. `queue` and `stop`
must be non-failing synchronous Effects so their void facades can use
`Effect.runSync` without scheduling races. Test typed
`ProviderFailure`/`InfrastructureFailure`, injected clock/timers/fetch/DB,
construction without timer/network work, and the exact facade conversion.

```bash
bun run --cwd apps/server vitest run effect/expo-push.test.ts effect/notifications.test.ts
```

Confirm RED for missing modules/exports.

- [ ] **Step 3: Implement the services**

Keep Expo send single-attempt. Notification state belongs to one dispatcher
instance. Queue replaces/unrefs a per-user timer; flush removes timer/pending
before querying; actionable filters and message projection remain exact;
invalid installation deletion remains user-scoped. The service records typed
failures, while the public dispatcher logs
`creation notification delivery failed` and resolves exactly as today.

- [ ] **Step 4: Delegate production facades**

Keep `sendExpoPush` and `createNotificationDispatcher` types and defaults.
`queue` remains synchronous/void, `flush` Promise<void>, and `stop`
synchronous/void, idempotent, and drop-not-flush. Do not add stop to main.
Add removal comments for jobs/scheduler and lifecycle children.

- [ ] **Step 5: Verify, review, and commit**

```bash
bun run --cwd apps/server vitest run effect/expo-push.test.ts effect/notifications.test.ts notifications/expo-push.test.ts notifications/dispatcher.test.ts creations/worker.test.ts main.test.ts lifecycle.test.ts
bun run server:check
git diff --check
```

A fresh reviewer checks exact payloads, failure swallowing, DB scoping,
timer/drop semantics, and no main lifecycle drift. Then:

```bash
git add apps/server/effect/expo-push.ts apps/server/effect/expo-push.test.ts apps/server/effect/notifications.ts apps/server/effect/notifications.test.ts apps/server/notifications/expo-push.ts apps/server/notifications/expo-push.test.ts apps/server/notifications/dispatcher.ts apps/server/notifications/dispatcher.test.ts
git commit -m "feat(server): own notifications with Effect"
```

## Task 6: Shared provider and Effect-module integration

**Files:**

- Modify: `apps/server/ai/provider.ts`
- Modify: `apps/server/ai/provider.test.ts`
- Modify: `apps/server/effect/index.ts`
- Modify: `apps/server/import-boundary.test.ts`

- [ ] **Step 1: Write failing integration tests**

Provider tests must prove an injected environment is authoritative for both
factories, only the selected dynamic loader runs, registration gating remains
before Codex loading, and unknown providers remain exact. Import tests must
prove each new Effect module performs no filesystem/network/client/process/
timer/logging work on import and imports no forbidden higher layer.

- [ ] **Step 2: Integrate the two provider factories**

Adjust the loader type and OpenRouter call to accept `{ env }`, retaining
default/no-argument compatibility. Do not add fallback. Reconcile only the
factory signature; provider implementation remains owned by Tracks B/C.

- [ ] **Step 3: Export the new Effect modules**

Add explicit barrel exports after checking for duplicate symbol names. Keep
the existing core exports and error union unchanged unless a test proves a
new existing tagged type is required.

- [ ] **Step 4: Verify and commit**

```bash
bun run --cwd apps/server vitest run ai/provider.test.ts import-boundary.test.ts effect/*.test.ts
bun run server:check
git diff --check
git add apps/server/ai/provider.ts apps/server/ai/provider.test.ts apps/server/effect/index.ts apps/server/import-boundary.test.ts
git commit -m "feat(server): integrate Effect infrastructure adapters"
```

## Task 7: Independent integrated review and verification

- [ ] **Step 1: Review the complete child range**

Give a fresh Luna xhigh reviewer the range from the parent of the first Track
A-D commit through Task 6. Require findings with file/line evidence against
the approved spec, especially dead parallel implementations, per-call runtimes,
error identity loss, lifecycle drift, implicit retry/cancellation, import side
effects, forbidden scope expansion, and missing removal comments.

Fix every confirmed finding in its owning track, rerun that track gate, and
commit conventionally. A rejected finding gets written technical evidence.

- [ ] **Step 2: Run server validation**

```bash
bun run server:check
VITEST_MAX_WORKERS=2 bun run server:test
bun run --cwd apps/server scripts/runtime-smoke.ts
git diff --check
```

Record exact file/test counts and smoke exit status.

- [ ] **Step 3: Run repository validation**

```bash
bun run check
VITEST_MAX_WORKERS=2 bun run test
EXPO_PUBLIC_API_URL=https://api.example.com bun run web:build
git diff --check
```

Treat credentialed OpenRouter/Codex checks separately. If credentials are not
available, report them as not run, never as passed.

- [ ] **Step 4: Audit scope and repository state**

```bash
git status --short --branch
git diff --stat 39e491d..HEAD
git log --oneline 39e491d..HEAD
rg -n "ManagedRuntime.make|Layer\.launch|Effect\.runPromise" apps/server/effect apps/server/ai apps/server/images.ts apps/server/audio.ts apps/server/tts apps/server/notifications
```

Confirm no Layer/Scope/ManagedRuntime is created per operation, current
production exports reach the Effect implementation, no forbidden file changed,
and no generated artifact is staged.

- [ ] **Step 5: Close Beads and record evidence**

Update each family child with commits, focused tests, reviewer outcome, and
compatibility/removal seams, then close completed children. Update umbrella
`mnimi-pi5.3` with integrated commands and results; close it only if every
acceptance criterion is met. Keep parent `mnimi-pi5` in progress for the jobs,
routers, and final transport/runtime children.

- [ ] **Step 6: Final local commit/status handoff**

Commit any reviewed integration evidence that belongs in tracked docs. Do not
push, merge, open a PR, or deploy. Report commits, changed surfaces, exact
validation evidence, Beads status, credentialed checks, and clean/dirty git
status.
