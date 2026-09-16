# Effect Background Workflows Design

**Status:** approved approach a (2026-09-15)

## Goal and scope

Move Mnimi's background domain work to Effect-native services and fibers without changing the Hono/oRPC API, database schema, provider behavior, or Bun deployment contract. This child owns both the older detached `drafts.start` creation flow and the durable creation queue: events, text and image workers, schedulers, audio work, notification coordination, and draft-media sweeping.

The previous adapter child already owns media, ElevenLabs, OpenRouter, Codex, and Expo push operations as Effect implementations. This child consumes those implementations directly. A Promise or async-generator adapter remains only where a Hono/oRPC-facing router still needs it; `mnimi-pi5.5` owns replacing those transport-boundary adapters and unifying the application runtime.

The migration does not replace Hono or oRPC, change any public procedure, change SSE framing or payloads, add schema migrations, add retries/timeouts/fallbacks, unify the legacy and durable creation pipelines, or alter provider selection. It does not move final `main.ts`/runtime disposal ownership into a new unified runtime.

## Current contracts that remain invariant

### Durable text creation

Text work keeps its database-authoritative claim model. Claims are serialized through the existing SQLite write lock, select the oldest queued work, allow at most two active claims per user, and use the current attempt and lease-owner fence on every renewal and settlement. A 90-second lease is renewed at the current 30-second cadence. Startup requeues all earlier-process active work, including the legacy unleased rows, before the server accepts requests. Normal polling requeues only expired leases and purges removed drafts after their undo window.

The text scheduler still polls immediately, polls every five seconds, coalesces re-entrant kicks per user, logs poll and worker failures, and ignores kicks after stop. Stopping a scheduler prevents new claims and future polls; it does not retract an already claimed attempt. A claim that settles after shutdown is still fenced by its database fields and is recoverable on the next startup.

### Durable images

Image work keeps its separate global concurrency limit of two, its own attempt/lease fence, a 120-second lease, and a 40-second heartbeat. It remains independent of text slots. Retry and cancellation retain their current stale-attempt rejection, cleanup of superseded draft media, and transfer-to-note compensation. A late image write that has lost ownership deletes the media it wrote; a failed image attempt changes only the image state and leaves a ready creation usable.

### Legacy creation, events, and audio

The legacy detached creation operation remains detached from the request. Its existing persisted failures, progress snapshots, generated-card handling, and notification behavior remain unchanged.

Detail and inbox subscribers still register synchronously before their initial database snapshot. Snapshots remain full snapshots with the same discriminants, attempt IDs, revisions, ordering, and coalescing behavior. A disconnect still removes the subscriber; publishing occurs only after the guarded database write has committed.

Audio jobs retain one current generation per card, in-flight deduplication, invalidation of stale results, status transitions, durable failure recording, file compensation, and note-level concurrency of two. Orphan resumption stays fire-and-forget and logs per-card failures rather than rejecting the reading request.

### Notifications, maintenance, and shutdown

Notification coordination uses the existing Effect `Notifications` service directly. It still deduplicates per-user creation IDs, replaces and unreferences the two-second debounce timer, projects the same actionable rows and messages, removes only that user's invalid tokens, and swallows/logs delivery failures. Stopping it is idempotent and drops pending notifications rather than flushing them.

The maintenance worker still runs a sweep on startup and every hour. It gathers both draft and creation-image-attempt references before invoking the Effect media sweep with the existing 24-hour retention window. Sweep failures are logged and do not stop scheduling.

Shutdown first fences admission, then stops the scheduler and maintenance fibers and notification dispatcher. No active claim is force-interrupted by the scheduler stop. The existing server and provider cleanup order remains in the current lifecycle boundary, but its resource list gains the explicit background-workflow stop action so no timer or poll admits work after shutdown begins.

## Architecture

The implementation adds focused Effect services under `apps/server/effect/`:

| Service | Responsibility | Direct dependencies |
| --- | --- | --- |
| `CreationEvents` | subscriber registries, initial snapshots, and ordered post-commit publication | Database service |
| `LegacyCreationWorkflow` | detached legacy creation orchestration and progress publication | selected Effect AI provider, CreationEvents, Notifications, Database |
| `DurableTextWorkflow` | claim, recovery, renewal, text attempt execution, and per-user scheduler fibers | selected Effect AI provider, CreationEvents, Notifications, Database |
| `DurableImageWorkflow` | image attempts, recovery, heartbeat, cleanup, transfer, and scheduler fibers | selected Effect AI provider, MediaStore, CreationEvents, Database |
| `AudioJobs` | card-generation generations, fibers, note concurrency, and orphan recovery | ElevenLabs, MediaStore, Database |
| `DraftMaintenance` | initial and periodic reference-aware media sweeps | MediaStore, Database |

An Effect-native selected-provider seam exposes the provider operations that the legacy/text/image services need. It selects OpenRouter or Codex with the same validation order and laziness as the current provider factory, owns the selected provider scope once, and never constructs the unselected provider. The existing `AiProvider` remains an adapter for application/transport callers until the next child can remove it.

Each service has a deterministic constructor for tests and an Effect Layer for production composition. Constructors accept clocks, timers, generated IDs, and provider/media functions explicitly. Imports and construction perform no database operation, timer creation, network call, provider process start, or filesystem operation. Production creates each service once; no operation creates a `Layer`, `Scope`, `ManagedRuntime`, or independent runtime.

Fiber state is owned by the corresponding service instance, not by a process module global. Schedulers use Effect state to coalesce pending kicks and scoped poll fibers to drive recovery. An in-flight attempt is a tracked fiber whose completion triggers the next drain, but scheduler stop only halts admission and polling. The current global `kickCreationScheduler` and `kickImageScheduler` exports become thin named compatibility adapters to the one production instance for router callers. They are removed with router and transport conversion in `mnimi-pi5.5`.

`CreationEvents` uses an Effect stream/pub-sub implementation internally and offers the current async-generator contract at the SSE boundary. The adapter registers the subscriber before running the snapshot effect, forwards values in publication order, and removes it on iterator cancellation or completion. It must not introduce a lossy buffer, a second initial event, or a subscription race.

`main.ts` remains the imperative Bun bootstrap. After its existing core and selected-provider setup, it constructs the background services once, runs their Effect start/recovery operations, and stores their one shutdown action in the existing resource lifecycle. It continues to create the Hono/oRPC app and bind the port in the current observable order. The later runtime child may replace these narrow bridges with a single scoped application runtime.

## Error and cleanup model

Expected internal failures use the existing tagged Effect error types. Database access maps to `DatabaseFailure`; provider operations retain the current `ProviderFailure` categories and causes; media operations retain `MediaFailure`; and unavailable dependencies retain `DependencyUnavailable`. Durable workflow code maps only the same failures that it maps today to persisted creation status, category, stage, and learner-safe message. It does not expose Effect errors to public routes.

At a retained Promise boundary, the adapter unwraps the original cause when the current contract checks error identity, `.code`, `.message`, or validation issues. Unanticipated defects remain logged once and follow the current safe failure route. Worker failures that are intentionally swallowed stay swallowed: notification delivery, orphan audio resumption, scheduler poll failures, and background image failures retain their current log text and continuation behavior.

Database mutations and media compensation preserve their current interruption boundaries. Once a durable operation has written bytes or begun a guarded settlement, Effect cleanup ensures the existing compensation runs before the operation completes. This does not introduce request cancellation into detached generation, force cancellation at shutdown, or replay a provider call.

## Implementation sequence

1. Characterize missing contracts before behavior changes: service construction side effects, scheduler stop/admission fencing, active-worker survival, notification shutdown, event registration/order/disconnect, and media/audio compensation.
2. Add the selected Effect-AI seam and `CreationEvents` service with legacy async-generator facades. Prove the SSE contract remains exact.
3. Move legacy detached creation and durable text claims, attempts, heartbeats, recovery, and scheduler fibers to Effect services; retain router kick and Promise bridges only at their named boundary.
4. Move durable image queue operations, image attempt fibers, transfer, cleanup, and scheduler fibers to the image service using the Effect media/provider adapters directly.
5. Move audio job state and bounded note fan-out to `AudioJobs`, retaining router-facing Promise methods until router conversion.
6. Move draft sweep and notification coordination into the constructed background workflow lifetime, add their stop action to the existing shutdown resources, and delete only facades no longer used by production.
7. Audit imports and production call paths, request independent review, and run the complete validation matrix.

Each implementation slice follows red-green-refactor: add a focused failing contract test, observe its expected failure, make the smallest conversion, then run the affected legacy and new tests before moving to the next slice.

## Verification

Focused tests cover each service's constructor purity, injected clocks/timers, fiber start/stop behavior, and all invariants above. Existing creation worker, scheduler, image-scheduler, event, SSE, TTS job, notification, lifecycle, main, router, media, and provider tests remain compatibility oracles and are not weakened.

Each slice runs its focused Vitest files, `bun run server:check`, and `git diff --check`. Integrated server validation uses:

```bash
VITEST_MAX_WORKERS=2 bun run server:test
```

The child milestone runs:

```bash
bun run check
VITEST_MAX_WORKERS=2 bun run test
git diff --check
```

Credentialed OpenRouter and Codex checks, if their credentials are available, are reported separately from deterministic local tests. A skipped provider check is never reported as passing.

## Follow-on ownership

`mnimi-pi5.5` owns router/transport conversion, the final application runtime and disposal graph, request-local runtime access, and deleting the remaining Promise/async-generator compatibility adapters. A separate issue is required for any semantic change to client-visible errors, cancellation, provider retry policy, notification flushing, database schema, or multi-process deployment.
