# Effect Server Migration Design

## Status

Approved in chat on 2026-09-13. The first child project is specified and
planned in `docs/superpowers/plans/2026-09-13-effect-foundation.md`.

Tracked by Beads feature `mnimi-pi5`.

## Goal

Migrate Mnimi's complete server implementation to stable Effect 3 while
preserving the application's public behavior. Domain orchestration,
infrastructure, background work, and both creation pipelines become
Effect-native. Promise-returning code remains only at Hono/oRPC entry points
and at third-party or runtime interoperability boundaries.

The migration is compatibility-first. It changes how server work is modeled,
composed, supervised, and released; it does not redesign the HTTP API, client
contract, database, product behavior, or deployment topology.

## Success criteria

The migration is complete when:

- server use cases return `Effect` values with explicit requirements and
  typed expected failures;
- application-wide dependencies are constructed with Layers and owned by one
  scoped runtime;
- background jobs, schedulers, timers, subscriptions, and external processes
  have explicit Effect lifetime ownership;
- Hono and oRPC are thin compatibility adapters around the Effect runtime;
- Better Auth, Drizzle/libSQL, provider SDKs, filesystem calls, and Bun APIs
  are isolated behind Effect services or adapter functions;
- both the legacy `drafts.start` pipeline and durable `drafts.submit` pipeline
  preserve their existing behavior;
- existing routes, schemas, event streams, error responses, persistence
  semantics, and deployment behavior remain compatible;
- the focused, server, workspace, web, and production-shaped runtime gates
  pass.

## Selected approach

Pin `effect@3.22.2` and retain the current transport and storage libraries:

- Bun and `Bun.serve` remain the process and HTTP runtime.
- Hono remains responsible for middleware and route dispatch.
- oRPC remains the typed RPC and SSE transport.
- Better Auth remains the authentication implementation.
- Drizzle and libSQL remain the persistence implementation.
- Zod and the existing shared schemas remain public validation contracts.
- LogTape remains the logging sink.

Effect Platform HTTP is not part of this migration. Replacing Hono or the Bun
HTTP adapter would require a separate contract-tested spike.

Stable Effect 3 is intentional. Effect 4 is currently a release candidate,
and its service and platform APIs differ from stable v3. No Effect 4 package
may be mixed into this implementation.

## Compatibility contract

The migration preserves:

- `/api/registration`;
- `/api/auth/*`;
- `/images/*` and `/audio/*`;
- `/rpc/*` and the exported `AppRouter` type;
- native bearer authentication;
- browser HttpOnly cookie authentication and cookie-only auth responses;
- the current CORS allowlist and browser mutation-origin protection;
- current oRPC codes, HTTP statuses, safe messages, and error payloads;
- legacy draft event discriminants, ordering, coalescing, and terminal
  behavior;
- durable creation snapshots, revisions, leases, attempts, and recovery;
- AI provider selection, model roles, retry boundaries, and redaction;
- media path validation, atomic write/rename behavior, and cleanup ordering;
- SQLite schema, migrations, transaction behavior, and process-wide write
  serialization;
- current detached-job, cancellation, notification, and shutdown semantics;
- development watcher, readiness token, CLI, migration, container, and
  one-process deployment behavior.

No database migration is required. The work must not be combined with auth
cookie changes, provider-default changes, retry-policy changes, API cleanup,
schema changes, or multiple-replica support.

## Current architecture constraints

The server has durable and process-local state with different correctness
requirements.

Durable SQLite state includes notes, cards, decks, drafts, creation attempts,
save receipts, leases, revisions, and push installations. Database rows remain
authoritative for durable job ownership and recovery.

Process-local state includes:

- the legacy generation job registry and custom event channels;
- durable creation subscriber registries;
- creation and image scheduler state;
- TTS job and generation-fence registries;
- notification debounce sets and timers;
- OpenRouter capability-route caching;
- the Codex app-server process, connections, turns, and workspaces.

Effect services may own this state, but must not blur the durable and
process-local guarantees or replace durable leases with in-memory queues.

The process-wide SQLite write lock is a correctness boundary. It serializes
plain writes and transactions because the pinned libSQL integration can move
transactions across connections. Better Auth continues to write through its
own adapter outside that lock. This migration does not change that division.

## Runtime architecture

`apps/server/main.ts` constructs one scoped `ManagedRuntime` from the live
application Layer. Global runtime services are never rebuilt per request.

```text
AppConfig
├── Database ── Auth
├── MediaStore
├── AIProvider ── CodexRuntime
├── Logging / Clock
└── Database + MediaStore + AIProvider
    ├── LegacyDraftJobs
    ├── DurableCreation
    ├── AudioJobs
    └── Notifications

All services
└── AppRuntime
    └── Hono/oRPC adapters
```

The runtime is acquired during startup and released during shutdown. Provider
selection and validation remain eager and finish before the HTTP port binds.
Recovery finishes before the associated scheduler is exposed to requests.

Hono and oRPC call the managed runtime through a small, shared adapter. They do
not construct Layers per call. Request-local values are provided only for that
invocation and cannot leak into application-wide services.

## Service boundaries

### AppConfig

`AppConfig` snapshots process configuration once for the application runtime
and exposes validated, redacted values grouped by concern.

It owns server options, browser origins, registration, runtime paths, media
roots, database URL, AI provider selection, OpenRouter roles, Codex settings,
and ElevenLabs settings. Existing defaults, exact validation messages, and
lazy optional-provider requirements remain unchanged.

Secrets are represented as redacted values and are never included in logs,
causes returned to clients, or diagnostic annotations.

### Database

`Database` owns the libSQL client, Drizzle handle, PRAGMA initialization, and
client disposal. Its live Layer uses scoped acquisition and release.

The service exposes operations for:

- ordinary reads;
- explicit read snapshots using the current libSQL read transaction;
- serialized writes;
- serialized write transactions.

The serialization primitive may be implemented with an Effect semaphore only
after tests prove the same ordering, rejection recovery, and non-leaking
release behavior as `withWriteLock`. A write operation must not reacquire the
same non-reentrant lock from within a locked operation.

Critical database sections preserve their current boundaries. Network calls
and filesystem work are not moved into or out of a transaction merely because
Effect makes composition convenient. Cancellation must never strand the lock
or an open transaction.

### Auth

`Auth` owns construction of the Better Auth instance over the Database
service. Better Auth remains a Promise-based adapter and keeps its existing
Drizzle configuration, UUIDv7 IDs, registration behavior, trusted origins,
bearer plugin, and cookie settings.

Authentication runs once per HTTP-backed RPC invocation. A procedure never
accepts a user ID from client input. Ownership misses remain indistinguishable
from absent resources.

### MediaStore

`MediaStore` owns image, draft-image, and audio filesystem operations. It
preserves secure path resolution, UUID validation, temporary-file writes,
atomic rename, missing-file classification, claim/remove behavior, and sweep
semantics.

Database and filesystem compensation remains explicit. Effect finalizers do
not turn non-transactional filesystem work into an implied distributed
transaction or introduce automatic retries for unsafe operations.

### AIProvider and CodexRuntime

`AIProvider` provides the current text-model capabilities and image generation
as Effect operations. OpenRouter and Codex remain atomic, selectable live
Layers with no fallback between them.

Promise SDK calls are wrapped with explicit error translation. Wrapping a
Promise does not imply cancellation. Abort propagation is added only where the
current implementation already supports it.

`CodexRuntime` separately owns the long-lived app-server process, JSONL
client, active turns, temporary workspaces, process-tree supervision, bounded
cleanup, and asynchronous disposal. Effect interruption maps to the existing
turn interruption and cleanup behavior; it must not add operation replay or
automatic reconnect semantics.

### LegacyDraftJobs

`LegacyDraftJobs` owns the behavior currently held in the module-global map in
`ai/jobs.ts` and the custom channel in `ai/channel.ts`.

The pipeline continues to outlive the request that starts it. It preserves the
snapshot-first subscription handshake, event ordering, card-snapshot
coalescing, queued-event drain behavior, image-attempt fences, late-result
cleanup, and current abort boundaries.

The custom channel is retained until an Effect Queue, PubSub, or Stream model
is proven equivalent by characterization tests. A generic sliding queue is not
an acceptable replacement because it can discard non-coalescible events.

### DurableCreation

`DurableCreation` owns creation events, text scheduling, image scheduling,
workers, lease heartbeats, stale recovery, and notification handoff.

Effect fibers replace detached Promise bookkeeping, while SQLite leases and
attempt IDs remain the source of truth. The service preserves:

- two concurrent text attempts per user;
- two concurrent image attempts globally;
- immediate polling and the current polling intervals;
- lease durations and heartbeat intervals;
- fencing, revision checks, and stale-work recovery;
- committed-state-before-publish ordering;
- no late work admission after shutdown begins.

Scheduler interruption must wait for its current cleanup without treating a
fiber interruption as successful durable completion.

### AudioJobs

`AudioJobs` owns card-job coalescing, generation counters, orphan resumption,
per-note concurrency, ElevenLabs transport, media cleanup, and detached error
reporting.

The migration gives this state an explicit application lifetime but does not
change whether shutdown drains, interrupts, or abandons work. The chosen
behavior must be pinned by characterization before the service implementation
changes.

### Notifications

`Notifications` owns debounce timers, per-user deduplication, actionable-row
checks, Expo delivery, and invalid-token removal.

Its finalizer preserves the current process-exit outcome: pending unref'd
debounce work is dropped rather than flushed during shutdown. The currently
unwired `stop()` behavior is characterized before runtime ownership changes.

### Logging and Clock

LogTape remains the canonical sink. Effect logging is bridged into it so a
failure is not logged once by a service and again by the oRPC interceptor.

Logs may be annotated with request, user, creation, attempt, and stage IDs.
They must not contain secrets, prompts, raw provider payloads, or private
filesystem paths.

Clock and scheduling requirements are injectable so timer behavior can use
deterministic Effect tests without weakening existing real-time integration
coverage.

## Request context and transport boundary

Application-wide dependencies live in `AppRuntime`. Request-local context
contains only:

- request headers;
- the authenticated user ID after auth middleware succeeds;
- a request identifier;
- the transport abort signal.

The abort signal is available to adapters, but the migration does not expand
its behavioral reach. In particular, starting a legacy or durable background
job must not bind that job to the initiating HTTP request's lifetime.

The final oRPC context no longer acts as a loose dependency bag. It carries the
runtime bridge and request values. Existing test overrides move to test Layers
or explicit adapter fixtures.

Async Effect streams are bridged back to the current async-generator/oRPC SSE
surface. The adapter must preserve synchronous subscriber registration before
the initial snapshot, event discriminants, order, coalescing, error delivery,
and disconnect cleanup.

## Error model

Expected internal failures use tagged domain or infrastructure errors. The
minimum categories are:

- `Unauthorized`;
- `NotFound`;
- `Conflict`;
- `Validation`;
- `DependencyUnavailable`;
- `DatabaseFailure`;
- `ProviderFailure`;
- `MediaFailure`;
- `Interrupted`;
- `InfrastructureFailure`.

Deep services do not throw `ORPCError`. A single transport mapping converts
expected tagged failures into the current oRPC codes, statuses, safe messages,
and payloads. Defects and unexpected causes are logged once and mapped to the
same safe internal-server response used today.

Provider payloads, prompts, paths, credentials, and low-level database errors
remain diagnostic-only. Persisted creation error categories and stages remain
unchanged.

## Startup and shutdown

Startup keeps the current externally meaningful sequence:

1. capture and validate the applicable configuration;
2. acquire Database and Auth;
3. acquire and validate the selected AI provider;
4. construct the Hono/oRPC application;
5. recover stale text work;
6. acquire notifications and the text scheduler;
7. recover stale image work;
8. acquire the image scheduler and draft sweep;
9. bind `Bun.serve`;
10. print the development readiness token only after binding succeeds.

Startup failure releases every resource acquired so far and preserves the
actionable original cause.

Shutdown remains idempotent. It first fences new work, then initiates the
current server, scheduler, timer, notification, and provider cleanup paths
without allowing one failure to skip the others. Their failures are collected
into one reported shutdown failure. The Database client closes only after
dependent resource finalizers settle.

Process signal handlers are installed once and removed with the application
scope. Development watch behavior and its SIGTERM-to-SIGKILL escalation remain
owned by `scripts/server-dev.mjs`.

## Program decomposition

This migration is too large for one safe implementation plan. It is a program
of child projects, each tracked by a child Beads issue and completed through
its own specification, plan, implementation, and verification cycle.

The child-project boundaries are:

1. characterization and the Effect foundation;
2. configuration, database, auth, and logging ownership;
3. independent media/TTS, OpenRouter, Codex, and notification adapters;
4. legacy and durable job, event, scheduler, and worker ownership;
5. domain router conversion;
6. transport-context consolidation, bootstrap, and Promise-era cleanup.

The first child project is limited to characterization and the Effect
foundation. It introduces no converted production domain behavior. Later
child projects are not planned in implementation-level detail until their
predecessor's verified interfaces are known. This prevents early plans from
encoding speculative service APIs and allows each completed boundary to be
reviewed before the next one expands it.

## Migration sequence

### 1. Characterization and harness hardening

Add missing contract coverage before changing production behavior:

- authenticated runtime smoke through one representative RPC;
- registration, browser-cookie, native-bearer, media, CORS, and error response
  matrices;
- SSE content type, event order, disconnect, and cleanup;
- scheduler immediate poll, coalesced kick, failed poll, heartbeat release,
  and stop behavior;
- notification timer replacement, stop, invalid-token cleanup, and shutdown;
- import tests proving modules do not open production resources unexpectedly.

### 2. Effect kernel

Add the pinned dependency, tagged error foundation, service definitions,
runtime bridge, Layer test helpers, and finalizer tests. Existing production
functions remain behind temporary adapters until their owning slice migrates.

### 3. Configuration, database, auth, and logging

Move configuration reads and resource construction behind Layers. Preserve
SQLite and Better Auth invariants. Introduce the scoped managed runtime without
yet rewriting all consumers.

### 4. Independent infrastructure adapters

After the kernel stabilizes, migrate non-overlapping groups:

- images, audio, filesystem errors, and ElevenLabs;
- pure generation, schemas, retries, and OpenRouter;
- Codex protocol/process/workspace ownership;
- Expo transport and notification dispatch.

### 5. Jobs, events, and durable workers

Migrate channels, legacy jobs, durable event registries, text workers, image
workers, schedulers, heartbeat loops, and audio jobs. The legacy job/event
owner and durable creation owner coordinate all shared event-boundary changes.

### 6. Domain routers

Convert router use cases in dependency order:

1. decks, cards, and notifications;
2. debug and media-heavy operations;
3. drafts, notes, and `creation-save` as one coordinated unit.

Every converted use case returns an Effect program. The oRPC procedure remains
a thin `runPromise` and error-mapping adapter.

### 7. Transport-context consolidation

Reduce `AppContext` to the runtime bridge and request-local data. Remove old
function-injection and singleton seams after all consumers use test Layers.

### 8. Bootstrap and cleanup

Convert `main.ts` and lifecycle ownership fully, adapt server CLI scripts,
remove superseded Promise-era resource registries, and run production-shaped
validation.

`apps/server/scripts/create-user.ts`, `codex-login.ts`,
`validate-runtime-config.ts`, and `runtime-smoke.ts` become thin Effect runtime
entry points where they execute server use cases. `scripts/server-dev.mjs` and
Drizzle's tool configuration remain tool-specific adapters rather than being
rewritten for cosmetic consistency.

## Worker orchestration

Implementation uses non-overlapping Luna worker assignments in dependency
batches.

- `xhigh` workers own database/concurrency, creation pipelines, Codex process
  lifecycle, and cross-cutting integration review.
- `high` workers own characterization, contained adapters, low-coupling router
  domains, and focused test conversion.
- one owner controls `package.json`, `bun.lock`, `tsconfig.json`, `app.ts`,
  `main.ts`, `lifecycle.ts`, `router/base.ts`, `router/index.ts`, `db/index.ts`,
  and shared runtime foundations in each batch;
- workers do not edit overlapping files concurrently;
- each worker receives exact invariants, allowed paths, focused gates, and the
  required handoff format;
- the coordinating agent reviews every diff and runs integration gates rather
  than accepting worker success claims at face value.

Media, OpenRouter, Codex, and notification adapter groups may run in parallel
after the Effect kernel and database boundaries settle. Jobs and durable
creation work do not run concurrently when they share event or registry files.
Drafts, notes, and creation-save remain one ownership group.

Within each child project, worker tasks may be parallelized only after the
project's central interfaces have landed and only across non-overlapping file
sets. Completion of a child project is a checkpoint: its Beads issue, focused
gates, full server suite, diff review, and remaining compatibility shims are
reconciled before the next child project begins.

## Test strategy

Migration is test-driven. Each slice begins with a focused failing contract or
service test, implements the smallest behavior-preserving conversion, and runs
its local checks before integration.

Per-slice gates include:

- affected Vitest files;
- `bun run server:check`;
- `git diff --check`.

Each integrated batch additionally runs:

- `VITEST_MAX_WORKERS=2 bun run server:test`.

Milestone and final gates run the repository-declared commands:

- `bun run check`;
- `VITEST_MAX_WORKERS=2 bun run test`.

Final behavior validation also includes:

- `EXPO_PUBLIC_API_URL=https://api.example.com bun run web:build`;
- `bun run web:test` against the migrated local server;
- a production-shaped container build;
- database migration plus runtime smoke inside or against that container;
- startup and SIGTERM shutdown with both OpenRouter and Codex configurations
  when credentials and the environment make each provider available.

Provider-dependent validation is reported separately from deterministic local
tests. A skipped credentialed provider check is not represented as passing.

## Rollback and commit boundaries

Every slice preserves the database schema and public API so it can be reverted
without a data rollback. Central adapters may temporarily support both Promise
and Effect implementations, but each compatibility shim must have a named
removal slice; no permanent dual architecture is accepted.

Implementation commits follow conventional commits and stay scoped to one
migration slice. Committing, merging, pushing, or deploying remains subject to
the repository's active authorization policy.

## Explicitly deferred work

The following require separate Beads issues if desired:

- replacing Hono or oRPC with Effect Platform HTTP;
- changing client-visible error payloads;
- propagating request cancellation into currently detached generation;
- adding new provider retries, fallback, or operation replay;
- changing notification shutdown from drop to flush;
- changing TTS shutdown behavior beyond the characterized current outcome;
- unifying the legacy and durable creation pipelines;
- serializing Better Auth writes through the application write lock;
- supporting multiple API processes or replicas over one SQLite volume;
- schema or migration cleanup unrelated to Effect ownership.
