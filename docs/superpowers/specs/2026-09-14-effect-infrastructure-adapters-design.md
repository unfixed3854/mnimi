# Effect Infrastructure Adapters Design

## Status

Approved in chat on 2026-09-14 as option a. This document specifies Beads
child `mnimi-pi5.3`, the third child of the Effect migration program tracked
by `mnimi-pi5`.

The selected approach is an adapter-first migration with four disjoint
families: media plus ElevenLabs, OpenRouter plus pure generation, Codex, and
push notifications. Each family gains an Effect-native service and changes
its existing production Promise entry point into an explicit compatibility
facade backed by that service. Jobs, routers, HTTP transport, `main.ts`, and
the process-bound core runtime lifetime remain unchanged in this child.

## Goal

Move infrastructure work behind typed Effect operations without changing any
current caller contract or observable behavior. At the end of this child:

- filesystem image/audio operations and ElevenLabs requests run as Effect
  operations before crossing the existing Promise API;
- OpenRouter text, streaming, route/adjustment, and image operations run as
  Effect operations before crossing `CreationModelCalls` and `AiProvider`;
- the selected Codex provider is acquired in its own Effect scope and that
  scope is released by the existing `AiProvider[Symbol.asyncDispose]` hook;
- Expo delivery and notification dispatcher state are Effect-owned while the
  existing `queue`/`flush`/`stop` facade remains exact;
- every compatibility facade has a named later removal slice.

The application continues to have two lifetime domains:

```text
process-bound core runtime
  AppConfig -> Logging -> Database -> Auth
  intentionally remains acquired after normal SIGINT/SIGTERM

adapter-owned resources
  selected AiProvider
    OpenRouter: no long-lived external resource
    Codex: one Effect Scope -> one long-lived app-server process
  existing shutdown -> AiProvider[Symbol.asyncDispose] -> close Codex Scope

stateless/stateful compatibility facades
  media and ElevenLabs Promise functions -> Effect.runPromise(operation)
  notification dispatcher -> Effect-owned state -> queue/flush/stop facade
```

Provider resources are deliberately not added to `CoreServices`. Doing so
would keep Codex alive when the existing shutdown contract expects provider
disposal, or would require closing the database while Promise-era work may
still be active. The later jobs/transport ownership child will unify those
lifetimes after it owns every admission and active-work path.

## Non-goals and hard boundaries

This child does not migrate jobs, schedulers, workers, routers, Hono/oRPC
transport, request context, SSE, `main.ts`, `lifecycle.ts`, database access,
authentication, signal listeners, or the core runtime graph. It does not
change schemas, migrations, routes, request or response shapes, cookies,
CORS, provider selection, deployment topology, or package versions.

It must not add retries, timeouts, fallbacks, reconnects, replay, implicit
cancellation, new shutdown calls, or new eager validation. Promise wrapping
does not claim to make a third-party operation interruptible. Existing late
result fences and compensating cleanup remain owned by their current jobs.

The public paths used by current callers remain stable. New Effect modules
must not import `main.ts`, `app.ts`, routers, jobs, schedulers, or the old
singleton database/auth values. Low-level third-party, filesystem, protocol,
and process modules remain valid runtime edges.

## Shared service and compatibility rules

Every family exposes:

1. a `Context.Tag` service whose operations return `Effect`;
2. a deterministic constructor accepting explicit captured configuration and
   replaceable low-level dependencies for tests;
3. a Layer constructor for later composition with `AppConfig` and `Logging`
   where applicable;
4. a named Promise facade used by the current production export;
5. focused tests for the Effect contract and separate compatibility tests for
   the unchanged Promise contract.

The deterministic constructor is the common implementation used by both the
Layer and the compatibility facade. A facade may construct a service from its
current captured inputs; it must not duplicate the underlying operation.
This lets production use the Effect implementation now without extending the
process-bound core runtime prematurely.

Typed failures use the existing `MediaFailure`, `ProviderFailure`,
`DependencyUnavailable`, and `InfrastructureFailure` types. Each failure
records an operation and retains the diagnostic cause. At a compatibility
boundary, the facade rethrows the original cause when callers depend on its
identity, `.code`, `cause.issues`, or exact message. Otherwise it converts the
tagged failure to a plain `Error` with the exact legacy message. Secrets,
prompts, account details, provider payloads, and raw stderr must not enter
logs or public errors.

No facade may create a new Layer or ManagedRuntime per operation. Stateless
facades create one service value and run individual operations. Scoped
facades acquire one scope per owning provider/dispatcher instance and close
it idempotently through the existing lifecycle method.

`apps/server/effect/index.ts` and `apps/server/import-boundary.test.ts` have a
single integration owner after all family commits. Parallel workers do not
edit those shared files.

## MediaStore and ElevenLabs

### MediaStore contract

`MediaStore` owns only filesystem operations. Its service includes image,
draft-image, and audio writes; draft claiming; image/draft/audio removal;
audio existence; draft sweeping; and image/draft/audio reads. Database status
updates, authentication, ownership checks, HTTP status/headers, scheduling,
and compensation order remain outside the service.

Writes preserve the current sibling-temporary-file then atomic-rename
algorithm. Once the write sequence begins, interruption cannot strand a
temporary file or race cleanup with an in-flight filesystem Promise. Cleanup
failure never replaces the primary write failure. Removal remains idempotent
only for the current not-found error classes and rethrows every other failure.

Stored media paths continue to require two UUIDv7 path segments, the correct
extension, and containment below the configured root. Traversal, a wrong
root, wrong extension, or malformed ID is rejected before reading. Draft
claiming remains a same-filesystem rename and preserves meaningful `ENOENT`.
Draft sweeping returns zero for an absent drafts directory, skips referenced
IDs, honors the exact cutoff, and keeps the current sequential deletion
semantics.

The existing exports in `images.ts` and `audio.ts` delegate to a single
service value built from the same module-captured media roots. Existing Hono
routes in those files remain transport-owned and use the Promise exports.
`setNoteImageFailed` remains database/domain code and is not moved.

### ElevenLabs contract

`ElevenLabs` exposes
`synthesizeSpeech(text): Effect<Uint8Array, ProviderFailure |
DependencyUnavailable>`. It preserves the current endpoint, percent-encoded
voice ID, headers, JSON body, model/voice defaults, output format, and exact
missing-key, non-success-status, and empty-audio messages.

The API key remains lazy and redacted until the request boundary. The Layer
uses the immutable AppConfig snapshot; the default legacy facade keeps its
current invocation-time `process.env` reads through one injected configuration
thunk because `tts/jobs.ts` does not receive AppConfig yet. An explicitly
injected fetcher remains authoritative for that call. Each call makes at most
one fetch. There is no retry, timeout, fallback, or abort claim. Fetch rejection
remains available as the diagnostic cause. The existing `tts/elevenlabs.ts`
export delegates through the Promise facade; `tts/jobs.ts` does not change.

### Removal slices

- Remove media Promise callbacks as each legacy/durable image job and router
  migrates.
- Replace route read facades in the transport child.
- Delete the legacy media module surfaces only after the last job/router and
  transport consumer moves.
- Remove the ElevenLabs Promise facade when `AudioJobs` consumes the service.

## OpenRouter and pure generation

### Service boundary

`OpenRouter` owns selected model construction, reasoning option parsing,
non-streaming structured calls, streaming structured calls, image route
discovery, image generation, and the per-service image-route cache. It uses a
captured AppConfig value and logger dependency, performs no eager SDK/network
work during construction, and unwraps the redacted API key only when an
operation first needs a client.

The current Promise shapes remain stable:

- `CreationModelCalls.classify`, `route`, and `adjust` return Promises;
- `CreationModelCalls.generate` returns the same async iterable and terminal
  structured value behavior;
- `AiProvider.generateImageBytes` returns a Promise;
- `AiProvider[Symbol.asyncDispose]` remains present and idempotent.

The Promise objects delegate to one OpenRouter service instance. The provider
selector continues to choose exactly one provider and must pass its explicit
environment to the OpenRouter factory just as it already does for Codex. That
factory path captures the authoritative values once. Direct legacy exports
and a no-argument factory remain compatible with their current invocation-time
environment behavior and identity where tests depend on it. No OpenRouter code
is loaded for a selected Codex provider beyond the existing dynamic-import
boundary.

### Exact behavior

Missing `OPENROUTER_API_KEY` remains lazy and throws exactly
`OPENROUTER_API_KEY is not set`. Model defaults remain unchanged. Reasoning
accepts only `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `none`;
unset/empty omits reasoning, while invalid input warns and is ignored.

`parseWithRetry` validates the first result, retries exactly once only for
schema validation or a structured-output error whose code is
`structured-output-validation-failed`, preserves `cause.issues`, and throws
the existing twice-failed message. Unrelated provider errors do not retry.

Streaming continues to emit accumulated raw text after each delta, emit one
retry event, reset accumulated text and generated-note state before the
second attempt, and return the validated terminal object. Stream/provider
exceptions never retry. Image prompt emission, completed-card snapshots,
stable keys, deduplication, and final event order remain unchanged.

Image route discovery caches successful Promise results per model, coalesces
concurrent discovery, and evicts a failed discovery. Image generation itself
does not retry. Catalog membership continues to choose the dedicated Images
API even if endpoint visibility is empty; otherwise chat image modalities are
used. The prompt suffix, 1024x1024 request, first-image selection, base64 data
URL constraint, and exact no-image/unsupported-format errors remain unchanged.

Pure schemas and rules may remain in their current modules. Effect orchestration
may call them; this child does not relocate types merely to change ownership.

### Removal slices

- Remove the generation Promise facade when legacy and durable generation
  jobs become Effect-native.
- Remove `CreationModelCalls` adapters when the creation workers migrate.
- Remove the image Promise facade when the image scheduler migrates.
- Provider selection remains until the final runtime composition owns the
  selected service directly.

## Codex

### Scoped runtime contract

`CodexRuntime` is a scoped Effect service over the existing app-server client,
protocol, operation, workspace, and process-tree edge. Acquiring the selected
Codex provider connects and validates eagerly in the same order as today:
account read, paginated model discovery, then image capability. Failed
acquisition immediately disposes partial resources while preserving the
original startup failure if cleanup also fails.

One provider scope owns one long-lived app-server child. Text and image
operations create their current fresh temporary workspaces. Subscription
cleanup precedes workspace removal, and inode/device plus canonical-path
checks continue to reject substitution. A dead connection rejects every
pending request, turn, and subscription; current work is never replayed.
Replacement is allowed only for a later operation under the existing policy.

Release is idempotent: interrupt tracked turns, wait at most the current five
seconds, then force shutdown and await bounded connection cleanup. POSIX
process-group setup, Linux subreaper supervision, 250 ms supervisor fallback,
1.25 second killed-process wait, 250 ms reader cleanup, stream destruction,
and direct SIGKILL fallback remain exact.

The production `createCodexProvider` acquires one Effect scope and returns the
current `AiProvider`. Its operations run CodexRuntime Effects through the
Promise facade. `AiProvider[Symbol.asyncDispose]` closes that scope exactly
once, so current `createShutdown` retains ownership without any `main.ts` or
core-runtime change. Registration gating, atomic provider selection, role
defaults, trimming, explicit-blank errors, private `CODEX_HOME`, `auth.json`
permissions, and sanitized child environment remain unchanged.

The low-level protocol/client modules may remain Promise-based third-party and
process interoperability edges in this child. Moving JSONL transport itself
to Effect is not required to establish resource and operation ownership.

### Removal slices

- Remove the `AiProvider` Promise operation facade as generation and image
  jobs consume CodexRuntime directly.
- Move the selected provider scope into the unified production runtime only
  after jobs/transport own all active work and normal runtime disposal.
- Keep the separate device-login script outside the application runtime.

## Notifications

### ExpoPush contract

`ExpoPush` validates the existing Expo token forms and exposes an Effect send
operation. An empty message list performs no fetch. Non-empty sends use the
same endpoint, headers, JSON body, `sound: "default"`, and message ordering.
A non-success response retains the exact status message. Ticket position maps
only `DeviceNotRegistered` failures to invalid tokens; other ticket failures
do not invalidate installations.

`sendExpoPush` remains the Promise facade and delegates to the Effect
operation. There is no retry, batching change, receipt polling, timeout, or
fallback.

### NotificationDispatcher contract

The dispatcher service owns per-user pending creation-ID sets and debounce
timers. Queueing deduplicates IDs, replaces the user's timer, uses the current
two-second default, and preserves timer `unref`. `flush(userId)` clears the
timer and pending IDs before database work, selects only owned
`needs_choice`/`ready` rows, and preserves the exact singular/grouped bodies
and deep links.

It loads all installations for the user, sends in their current order, and
deletes only invalid tokens belonging to that user. Delivery or cleanup
failure continues to log `creation notification delivery failed` and resolves
the public flush rather than rejecting. Empty pending/actionable/installation
sets perform no later work.

The compatibility result remains:

```ts
type NotificationDispatcher = {
  queue(userId: string, creationId: string): void;
  flush(userId: string): Promise<void>;
  stop(): void;
};
```

`queue` synchronously runs the service's non-failing state Effect without
exposing a Promise. `flush` awaits the service Effect. `stop` synchronously
clears every timer and pending set;
it drops rather than flushes queued work and remains idempotent. This child
does not add dispatcher stop to `main.ts`, because the currently unwired stop
and process-exit pending-drop outcome are characterized legacy behavior.

### Removal slices

- Remove the dispatcher Promise facade when durable jobs and schedulers
  become Effect-native.
- Move dispatcher release into unified shutdown only in the lifecycle child.
- Move notification database operations to the Database service with the job
  migration, not in this adapter child.

## File ownership and parallel execution

Four family owners work on non-overlapping paths:

| Family | New Effect paths | Existing facade paths |
| --- | --- | --- |
| Media/ElevenLabs | `effect/media*`, `effect/elevenlabs*` | `images.ts`, `audio.ts`, `tts/elevenlabs.ts` and their focused tests |
| OpenRouter/generation | `effect/openrouter*`, `effect/ai-generation*` | OpenRouter/generation/provider implementation paths and focused tests |
| Codex | `effect/codex-runtime*`, optional `effect/codex-provider*` | `ai/codex/provider.ts` and focused tests |
| Notifications | `effect/expo-push*`, `effect/notifications*` | `notifications/expo-push.ts`, `notifications/dispatcher.ts` and focused tests |

The OpenRouter and Codex owners must not both edit `ai/provider.ts`. The
integration owner alone forwards the captured environment and reconciles the
two provider factories after both family commits. The integration owner also
owns `effect/index.ts`, `import-boundary.test.ts`, any shared test utility,
Beads closure, and full validation.

Each family starts from a clean committed base, follows test-first changes,
runs its focused characterization suite plus `bun run server:check` and
`git diff --check`, receives an independent review, and commits conventionally.
Because all workers share one worktree, only workers with disjoint ownership
run concurrently and commits are serialized by the primary agent.

## Verification

Deterministic tests cover service construction, typed failures, Promise
compatibility, exact request shapes and error messages, no eager validation,
no implicit retry, resource identity, and release behavior. Existing adapter,
provider, protocol, media, notification, job, scheduler, router, main, and
lifecycle tests remain compatibility oracles and are not weakened.

Import-boundary coverage must prove importing every new Effect module performs
no filesystem access, network request, client/process creation, timer setup,
or global logging configuration.

Each family runs focused Vitest files, `bun run server:check`, and
`git diff --check`. The integrated milestone runs:

```text
VITEST_MAX_WORKERS=2 bun run server:test
bun run check
VITEST_MAX_WORKERS=2 bun run test
bun run --cwd apps/server scripts/runtime-smoke.ts
git diff --check
```

Credentialed OpenRouter and Codex startup/text/image checks are reported
separately from deterministic offline validation. A skipped credentialed
check is never reported as passing.

## Acceptance criteria

- All four adapter families expose Effect-returning service operations with
  explicit dependencies and typed failures.
- Existing production Promise entry points delegate to those operations and
  preserve their exact public contracts and behavior.
- Media atomicity/security, generation retry/stream order, OpenRouter cache
  semantics, Codex process/workspace cleanup, and notification debounce/drop
  behavior retain executable regression coverage.
- No jobs, routers, transport, main bootstrap, signal lifecycle, or core
  runtime lifetime is migrated.
- Compatibility facades name their later removal slices and no parallel dead
  implementation is introduced.
- Focused and complete Bun validation passes, import-time side effects remain
  absent, independent reviews are clean, and the four child Beads close.
