# Effect Core Ownership Design

## Status

Approved in chat on 2026-09-13. This document specifies Beads child
`mnimi-pi5.2`, the second child of the Effect migration program tracked by
`mnimi-pi5`.

This revision records the explicit process-bound lifetime choice: production
keeps the acquired runtime and Database client process-bound through normal
SIGINT/SIGTERM cleanup, with disposal deferred to the later jobs/transport
ownership child.

The selected approach is transitional scoped ownership with a process-bound
production lifetime. This child gives configuration, the database,
authentication, logging, and the application runtime one explicit acquisition
graph while the existing Hono, oRPC, routers, provider adapters, media
adapters, and job implementations continue to use their current
Promise-oriented interfaces through named compatibility seams. Production
acquires the managed runtime once and intentionally keeps it acquired through
normal SIGINT/SIGTERM cleanup; runtime disposal and Database client close are
not part of normal shutdown until the later jobs/transport ownership child.

The implementation must be one implementation plan. It must not write an
implementation plan document as part of this design task.

## Goal

Create one immutable `AppConfig` snapshot, one managed-scope `Database`, one
managed-scope `Auth`, one managed-scope `LogTape` service, and one
process-wide `ManagedRuntime` in `apps/server/main.ts`. Preserve the current
HTTP, authentication, database, provider, media, startup, recovery, and
normal-shutdown behavior while making the acquisition boundary explicit
enough for later Effect slices to consume. The runtime is process-bound in
the production bootstrap: normal SIGINT/SIGTERM cleanup stops the current
workload resources but does not call `runtime.dispose()` and therefore does
not close the libSQL client.

The runtime owns the resource graph below:

```text
AppConfig
  |
  +--> LogTape ----> Database ----> Auth
                                      |
                                      +--> legacy bindings { db, auth }
                                                 |
                                                 +--> unchanged Hono/oRPC app and routers

one ManagedRuntime
  +--> AppConfig, LogTape, Database, Auth
  +--> remains acquired for the production process lifetime

normal SIGINT/SIGTERM
  +--> existing server/provider/scheduler/sweep cleanup
  +--> no runtime.dispose(), no Database client close

startup/provider failure before workload admission, tests, one-shot scopes
  +--> disposeCoreRuntime() with reverse release Auth -> Database -> LogTape
```

The legacy bindings are temporary and deliberately explicit. They do not
make the old global database and auth modules part of the live process
bootstrap. The process-bound production lifetime is the compatibility
boundary: later jobs/transport ownership must own every admission and active
work path before normal shutdown can safely add runtime disposal.

## Non-goals and hard boundaries

This child does not convert domain routers, Hono middleware, oRPC context,
media or TTS operations, OpenRouter, Codex, notifications, creation jobs,
events, workers, schedulers, transport error mapping, or Promise-era public
APIs. It does not change the SQLite schema, migrations, HTTP routes, request
schemas, cookies, CORS policy, provider policy, retry policy, or deployment
topology.

Normal shutdown disposal is also outside this child. The existing lifecycle
continues to stop the server, schedulers, sweep interval, and provider with
its current idempotent aggregate behavior, but it does not dispose the
managed runtime or close the Database client. That disposal remains deferred
until a later jobs/transport ownership child owns active HTTP handlers,
durable text and image workers, detached legacy jobs, TTS, notifications,
the sweep, and every admission path. Signal listener ownership and removal
remain unchanged here and are deferred to that final bootstrap/transport
cleanup.

The following files remain direct tool or compatibility entry points:

- `apps/server/drizzle.config.ts` and the `db:*` scripts continue to use the
  direct Drizzle/libSQL path;
- `apps/server/db/index.ts` remains available to existing tests and direct
  scripts until those consumers have their own migration slices;
- `apps/server/auth.instance.ts` remains a compatibility singleton for code
  that still imports it, but `main.ts` must not import it;
- `apps/server/logging.ts` continues to expose `getLogger` for unconverted
  owners;
- `apps/server/ai/jobs.ts` remains untouched; this child adds no active-job
  tracking, drain API, cancellation, or shutdown ownership;
- existing raw `console.error` sites outside this child are not migrated.

The new owned modules must not import `main.ts`, `app.ts`, any router,
`auth.instance.ts`, the runtime `db/index.ts` value, provider
implementations, media implementations, or the old logging module. Type-only
imports of the `Db` and `Auth` types are allowed where they do not evaluate
those modules.

## Evidence from the current implementation

The design follows the live checkout at `5ec09cf` and the parent design
`docs/superpowers/specs/2026-09-13-effect-server-migration-design.md`.

The relevant current behavior is:

- `apps/server/app.ts` parses `PORT` with a digit-only check, safe-integer
  check, and range check, throwing exactly
  `PORT must be an integer between 1 and 65535`; it defaults `PORT` to
  `8787` and `HOST` to `0.0.0.0`.
- `apps/server/registration.ts` returns true only for the exact string
  `"true"`; missing, empty, and malformed values are false.
- `apps/server/browser-origins.ts` defaults to
  `http://localhost:8081,http://127.0.0.1:8081`, splits on commas, trims each
  value, and filters empty entries. An explicitly empty `CORS_ORIGIN` yields
  an empty list; an unset value yields the two defaults.
- `apps/server/db/url.ts` defaults to `file:./data/mnimi.db`, resolves
  relative file URLs against the repository root, leaves
  `file::memory:` unchanged, leaves non-file URLs unchanged, and creates a
  file URL's parent directory only when it has a directory component.
- `apps/server/db/index.ts` creates one libSQL client, executes
  `PRAGMA journal_mode = WAL`, then `PRAGMA busy_timeout = 5000`, then
  `PRAGMA foreign_keys = ON`, and builds one Drizzle handle over that client.
- `apps/server/db/read-transaction.ts` explicitly opens
  `db.$client.transaction("read")`, builds a Drizzle read handle over the
  transaction, commits after the callback, and closes in a `finally` block so
  callback or commit failure rolls back/cleans up.
- `apps/server/db/write-lock.ts` is a process-wide FIFO Promise chain. It
  keeps the chain alive after rejection so later work runs. The current
  implementation has no re-entrancy detection; nested acquisition would
  wait forever.
- `apps/server/auth.ts` defaults the Better Auth URL to
  `http://127.0.0.1:8787`, defaults its secret to the empty string, uses the
  browser-origin list as trusted origins, uses
  `drizzleAdapter(..., { provider: "sqlite", transaction: false })`, uses
  UUIDv7 IDs, preserves three custom user fields, and enables the bearer
  plugin. Secure cookies are enabled when `NODE_ENV === "production"` or the
  base URL starts with `https://`.
- `apps/server/logging.ts` configures LogTape synchronously with a console
  sink, `reset: true`, warning-level `mnimi` routing, and error-level
  LogTape meta logging, then exports `getLogger`.
- `apps/server/main.ts` currently creates the provider before creating the
  app, recovers text and image work before exposing their schedulers, starts
  the draft sweep, binds `Bun.serve`, and prints the readiness token only
  after binding succeeds.
- `apps/server/lifecycle.ts` fences shutdown, attempts server, both
  schedulers, sweep interval, and provider cleanup with `Promise.allSettled`,
  aggregates failures, and returns one idempotent Promise. It does not close
  the process-wide database singleton; preserving that behavior is why the
  transitional production runtime remains acquired through normal shutdown.
- `apps/server/main.test.ts`, `lifecycle.test.ts`, `auth.test.ts`,
  `browser-auth.test.ts`, `app.test.ts`, `db/write-lock.test.ts`, and the
  Effect foundation tests pin the current behavior. The implementation must
  extend those tests rather than weaken them.

## AppConfig

### Interface and construction

Create `apps/server/effect/config.ts` with these exports:

```ts
import { Context, Layer } from "effect";
import * as Redacted from "effect/Redacted";
import { InfrastructureFailure } from "./errors.ts";

export type AppConfigValue = Readonly<{
  server: Readonly<{
    hostname: string;
    port: number;
  }>;
  browser: Readonly<{
    corsOrigin: string;
    origins: readonly string[];
  }>;
  registration: Readonly<{
    enabled: boolean;
  }>;
  database: Readonly<{
    url: string;
  }>;
  media: Readonly<{
    imagesDir: string;
    audioDir: string;
  }>;
  auth: Readonly<{
    baseURL: string;
    secret: Redacted.Redacted<string>;
    useSecureCookies: boolean;
  }>;
  ai: Readonly<{
    selected: string;
    openRouter: Readonly<{
      apiKey: Redacted.Redacted<string>;
      classifyModel: string;
      generateModel: string;
      imageModel: string;
      classifyEffort: string | undefined;
      generateEffort: string | undefined;
    }>;
    codex: Readonly<{
      classifyModel: string | undefined;
      classifyEffort: string | undefined;
      generateModel: string | undefined;
      generateEffort: string | undefined;
      codexHome: string;
    }>;
  }>;
  elevenLabs: Readonly<{
    apiKey: Redacted.Redacted<string>;
    model: string;
    voiceId: string;
  }>;
  runtime: Readonly<{
    nodeEnv: string | undefined;
    devtoolsEnabled: boolean;
    readyToken: Redacted.Redacted<string>;
  }>;
  /**
   * Compatibility-only copy for Promise adapters that still accept a full
   * ProcessEnv. Every value is redacted until the one adapter call that needs
   * to materialize it.
   */
  legacyEnvironment: Readonly<
    Record<string, Redacted.Redacted<string> | undefined>
  >;
}>;

export class AppConfig extends Context.Tag("@mnimi/server/AppConfig")<
  AppConfig,
  AppConfigValue
>() {}

export function captureAppConfig(input?: {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
}): AppConfigValue;

export function makeAppConfigLayer(input?: {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
}): Layer.Layer<AppConfig, InfrastructureFailure, never>;

export const AppConfigLive: Layer.Layer<AppConfig, InfrastructureFailure, never>;

export function materializeLegacyEnvironment(
  config: AppConfigValue,
): NodeJS.ProcessEnv;
```

`captureAppConfig` first copies the supplied environment object once. All
subsequent parsing reads that copy. The default input is `process.env` and
`process.argv.slice(2)`, so production makes one environment snapshot and
one argument snapshot. It recursively freezes the object and arrays before
returning it. The `Redacted` values are Effect `Redacted.Redacted<string>`
values; they are never serialized as configuration records.

`captureAppConfig` remains the direct characterization function and may throw
the existing plain `Error("PORT must be an integer between 1 and 65535")`.
`makeAppConfigLayer` catches capture failures and maps them to
`InfrastructureFailure` with `operation: "config.capture"`, `message` equal
to the original `Error.message` (or `String(cause)` for a non-Error cause),
and `cause` equal to the original value. Thus the Layer error type is
`InfrastructureFailure` while direct parser callers retain the plain error.
The shared core acquisition helper, rather than a config-specific catch in
`main.ts`, unwraps this failure. When its cause is an Error it rethrows that
original Error, so the actionable startup output for an invalid port remains
exactly `PORT must be an integer between 1 and 65535`, without exposing an
Effect wrapper to the CLI. The same helper handles Database and every other
`CoreLayerError` as specified below.

`AppConfigLive` is `makeAppConfigLayer()` with default inputs. Tests use
`makeAppConfigLayer({ env, argv })` so a layer never needs to mutate the
process environment. It acquires the value once in the managed scope and
returns the same object for every runtime invocation. It does not re-read
`process.env` when a request or shutdown callback runs.

`legacyEnvironment` is a compatibility-only snapshot of all environment
keys, with every value represented as an Effect Redacted value. The
`materializeLegacyEnvironment` function creates a short-lived
`NodeJS.ProcessEnv` copy for the existing provider factory; it is never logged,
stored in a service, or returned to a request. This keeps provider selection
and Codex child-process inheritance on the captured environment without
putting plain secrets in `AppConfigValue`. Deferred OpenRouter and media
functions that still read their own module-level environment remain the
explicit compatibility exception described below.

### Exact values and parsing rules

The capture table is normative. A rule that says “raw” means no trimming,
case folding, or validation is allowed at capture time.

| Config field | Source and default | Capture behavior and validation boundary |
| --- | --- | --- |
| `server.port` | `PORT ?? "8787"` | Apply the current digit-only, safe-integer, and `1..65535` checks. Preserve the exact error text `PORT must be an integer between 1 and 65535`. |
| `server.hostname` | `HOST ?? "0.0.0.0"` | Preserve raw string, including empty string. |
| `browser.corsOrigin` | `CORS_ORIGIN ?? "http://localhost:8081,http://127.0.0.1:8081"` | Preserve the resolved raw string so `createApp` can be passed it without another environment read. |
| `browser.origins` | `corsOrigin` | Split on `,`, trim each item, filter empty items, in the existing order. |
| `registration.enabled` | `REGISTRATION_ENABLED` | `value === "true"`, with missing and malformed values false. |
| `database.url` | `DATABASE_URL ?? "file:./data/mnimi.db"` | Apply the existing `resolveDatabaseUrl` rules, including the `file::memory:` exception and unchanged non-file URLs. |
| `media.imagesDir` | `IMAGES_DIR ?? "./data/images"` | Apply `resolveRuntimePath` exactly. An explicitly empty value remains the resolved repository root as it does today. |
| `media.audioDir` | `AUDIO_DIR ?? "./data/audio"` | Apply `resolveRuntimePath` exactly, including the explicit-empty behavior. |
| `auth.baseURL` | `BETTER_AUTH_URL ?? "http://127.0.0.1:8787"` | Preserve raw string, including empty string. |
| `auth.secret` | `BETTER_AUTH_SECRET ?? ""` | Wrap the exact value in `Redacted.make`; do not validate or log it here. |
| `auth.useSecureCookies` | `NODE_ENV`, `auth.baseURL` | `nodeEnv === "production" || baseURL.startsWith("https://")`, exactly as current auth construction does. |
| `ai.selected` | `AI_PROVIDER ?? "openrouter"` | Preserve raw string and do not trim or validate. The existing provider factory remains the owner of unknown-provider errors. |
| `ai.openRouter.apiKey` | `OPENROUTER_API_KEY ?? ""` | Wrap the exact value in `Redacted.make`; missing key remains a lazy provider failure, not a config failure. |
| `ai.openRouter.classifyModel` | `CLASSIFY_MODEL ?? "google/gemini-2.5-flash"` | Preserve raw value, including empty string. |
| `ai.openRouter.generateModel` | `GENERATE_MODEL ?? "anthropic/claude-sonnet-4.5"` | Preserve raw value, including empty string. |
| `ai.openRouter.imageModel` | `IMAGE_MODEL ?? "black-forest-labs/flux.2-klein-4b"` | Preserve raw value, including empty string. |
| `ai.openRouter.classifyEffort` | `CLASSIFY_EFFORT` | Preserve raw optional value. Invalid values remain the current lazy warning-and-ignore behavior. |
| `ai.openRouter.generateEffort` | `GENERATE_EFFORT` | Preserve raw optional value and the same lazy warning-and-ignore behavior. |
| `ai.codex.*` role fields | `CLASSIFY_MODEL`, `CLASSIFY_EFFORT`, `GENERATE_MODEL`, `GENERATE_EFFORT` | Preserve raw optional values. Do not call `readCodexRoleConfig` while capturing config: its undefined defaults, trimming, and empty-value `CodexProviderError` remain lazy and selected-provider-specific. |
| `ai.codex.codexHome` | `CODEX_HOME` | Apply the existing `resolveCodexHome` path rules, including an explicit empty value. Credential and catalog validation remains lazy. |
| `elevenLabs.apiKey` | `ELEVENLABS_API_KEY ?? ""` | Wrap the exact value in `Redacted.make`; the current `ELEVENLABS_API_KEY is not set` error remains at synthesis time. |
| `elevenLabs.model` | `ELEVENLABS_MODEL ?? "eleven_multilingual_v2"` | Preserve raw value, including empty string. |
| `elevenLabs.voiceId` | `ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb"` | Preserve raw value, including empty string. |
| `runtime.nodeEnv` | `NODE_ENV` | Preserve optional raw value. |
| `runtime.devtoolsEnabled` | `argv` | True when `argv` contains the exact `--devtools` argument, matching the current `process.argv.slice(2).includes` check. |
| `runtime.readyToken` | `MNIMI_DEV_READY_TOKEN ?? ""` | Wrap the exact value in `Redacted.make`; print its unwrapped value only after a successful bind and only when non-empty. |

The provider and media fields are captured so future adapter slices have one
defined input, but this child does not make the old adapters consume them.
The current OpenRouter, Codex, ElevenLabs, image, and audio modules retain
their existing lazy/function-local environment reads until their owning
children. This is the named transitional exception to the new owned-service
snapshot, and it is tested explicitly so it cannot be mistaken for a new
validation policy.

The deferred provider error boundary is also normative. The existing factory
continues to throw `AI_PROVIDER must be openrouter or codex` for an unknown
selection and `Codex provider requires REGISTRATION_ENABLED=false` when the
selected Codex provider sees registration enabled. When the Codex adapter is
selected, its existing role reader still defaults classify to
`gpt-5.6-luna`/`low` and generate to `gpt-5.6-sol`/`high`, trims only defined
values, and throws one of the exact messages `CLASSIFY_MODEL must not be
empty`, `CLASSIFY_EFFORT must not be empty`, `GENERATE_MODEL must not be
empty`, or `GENERATE_EFFORT must not be empty` through
`CodexProviderError("model-unavailable", ...)` for an explicitly empty role
field. Its startup validator retains the current messages for unavailable
credentials, wrong account type, unavailable models/efforts, and unavailable
image capability: `Codex credentials are unavailable; run bun run
codex:login`, `Codex subscription authentication failed; run bun run
codex:login`, `Codex requires ChatGPT authentication; run bun run
codex:login`, `Could not read the Codex model catalog`,
and the existing interpolated messages beginning `Configured Codex model` or
`Configured Codex effort`, followed by the configured role values,
`Could not verify Codex image generation capability`, and `Codex image
generation is unavailable for this account`. These are the existing
formatter messages, not new validation text. The OpenRouter adapter retains
`OPENROUTER_API_KEY is not set`, its three model defaults, invalid-effort
warning-and-ignore behavior, and image route/model errors. The ElevenLabs
adapter retains `ELEVENLABS_API_KEY is not set`, the existing
`ElevenLabs TTS failed: ` message followed by the HTTP response status, and
`ElevenLabs returned empty audio`.
Capturing config never moves any of these failures earlier or changes their
message.

`apps/server/app.ts` keeps exporting `serverOptions` for direct callers and
the CLI validation script. Its parser must share the same exact server parser
as `captureAppConfig`, so direct tests and the runtime cannot drift. The
runtime passes `config.browser.corsOrigin` to `createApp` and passes the
parsed origins directly to the Auth layer; `createApp` therefore does not
consult live environment state in the production bootstrap.

## Database

### Interface

Create `apps/server/effect/database.ts` with these exports:

```ts
import { Context, Effect, Layer } from "effect";
import type { Client } from "@libsql/client";
import type { Db } from "../db/index.ts";
import type { ReadDb } from "../db/read-transaction.ts";
import { AppConfig } from "./config.ts";
import { DatabaseFailure } from "./errors.ts";
import { Logging } from "./logging.ts";

export type DatabaseService = Readonly<{
  /** Compatibility-only escape hatches for unchanged Promise adapters. */
  client: Client;
  db: Db;
  withWriteLock<A, E, R>(
    operation: string,
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DatabaseFailure, R>;
  transaction<A, E, R>(
    operation: string,
    work: (tx: Db) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DatabaseFailure, R>;
  readSnapshot<A, E, R>(
    operation: string,
    read: (tx: ReadDb) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DatabaseFailure, R>;
}>;

export class Database extends Context.Tag("@mnimi/server/Database")<
  Database,
  DatabaseService
>() {}

export type DatabaseLayerDependencies = Readonly<{
  createClient: (options: { url: string }) => Client;
  ensureDatabaseDir: (url: string) => void;
}>;

export function makeDatabaseLayer(
  dependencies?: Partial<DatabaseLayerDependencies>,
): Layer.Layer<Database, DatabaseFailure, AppConfig | Logging>;

export const DatabaseLive: Layer.Layer<
  Database,
  DatabaseFailure,
  AppConfig | Logging
>;
```

`Db` is the existing Drizzle handle type and `ReadDb` is the existing narrow
read-transaction type. New owned code imports those types only; evaluating
the module `apps/server/db/index.ts` is forbidden from `effect/database.ts`.
Both `client` and `db` are compatibility-only fields: unchanged Promise
adapters may close over them through `LegacyBindings`, while new Effect
callers use the three named operations so database failures have an operation
label. `DatabaseLive` requires `Logging` even where a particular operation
does not log, which makes the ownership graph and finalizer order explicit
and keeps LogTape available while Database finalizers report failures.

### Acquisition and release

`DatabaseLive` acquires exactly one client for one managed runtime scope:

1. resolve the already captured `config.database.url`;
2. call `ensureDatabaseDir(url)` with the current file/non-file behavior;
3. call `createClient({ url })` exactly once;
4. immediately register an `Effect.acquireRelease` finalizer for that client
   before issuing any PRAGMA, so a failure in any subsequent step closes the
   partially acquired client exactly once;
5. execute `PRAGMA journal_mode = WAL`;
6. execute `PRAGMA busy_timeout = 5000`;
7. execute `PRAGMA foreign_keys = ON`;
8. construct `drizzle({ client, schema })` exactly once;
9. create the scoped write queue and register its installation finalizer;
10. return the Database service with its compatibility-only `client` and `db`
    fields.

The queue installation is one `Effect.acquireRelease` release owned by
`DatabaseLive`: it awaits `lock.close()`, then invokes the uninstall callback.
There is no second finalizer that also removes the installation. The earlier
client finalizer consequently runs after this queue release.

The PRAGMAs execute sequentially in the listed order. A PRAGMA, Drizzle
construction, or queue-installation failure therefore runs the client close
finalizer registered before step 5 and preserves the original failure as its
diagnostic cause. The queue finalizer runs before the client finalizer. It
fences and settles the queue, invokes the queue-installation token's removal
callback, and only then permits `client.close()` exactly once. This ordering is
used for startup-failure and test/one-shot scopes; production normal shutdown
does not dispose this scope.

Acquisition failures are mapped to
`DatabaseFailure({ operation: "database.acquire", cause })`; read, write, and
transaction wrappers use their supplied operation label. Close-fence,
delegate-reset, and client-close failures are not ordinary typed finalizer
failures: `acquireRelease` releases have error type `never`, so the Database
release catches each rejection and calls `Effect.die(new DatabaseFailure({
operation: "database.close", cause }))`. The tagged payload remains available
in the disposal `Cause` for diagnostics, but is never serialized into an HTTP
response. `disposeCoreRuntime` below is the only boundary that turns such a
finalizer defect into an actionable cleanup error for startup/test callers.
Interruption is deferred until the uninterruptible libSQL operation settles and
then surfaces as the Effect interruption rather than being rewritten as a
database failure.

`apps/server/db/index.ts` is not deleted or routed through the Layer in this
child. It remains the direct path used by Drizzle CLI/migration tooling and
old tests. `drizzle.config.ts` continues importing `db/url.ts` directly and
never acquires `DatabaseLive`.

### Write serialization and nested acquisition

Refactor `apps/server/db/write-lock.ts` only enough to expose a pure
`createWriteLock()` queue and a compatibility `withWriteLock` delegate. The
queue interface is:

```ts
export type WriteLock = Readonly<{
  withWriteLock<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

export function createWriteLock(): WriteLock;
export function installWriteLock(lock: WriteLock): () => Promise<void>;
export function withWriteLock<T>(work: () => Promise<T>): Promise<T>;
```

The default delegate retains the current process-local queue for direct tests
and direct legacy imports. `DatabaseLive` installs exactly one scoped queue in
the one production runtime and restores the prior delegate on scope release.
Installation records have identity and active state. Removing a record
removes exactly that record; it restores the nearest still-active predecessor
only when the removed record is the current delegate, so an out-of-order stale
finalizer cannot overwrite a newer installation. Nested test/runtime
installations are safe: an inner LIFO release restores the outer queue, and an
outer release while an inner record is active marks only the outer record
inactive; the inner release then restores the default fallback rather than a
closed outer queue. Production has no nested installation.

The `close()` fence is part of every scoped queue, even though production
normal shutdown does not call it. `WriteLock.close()` owns only admission
fencing and settlement; it never removes an installation. The callback returned
by `installWriteLock(lock)` is the sole owner of identity removal and delegate
restoration. Both operations are idempotent, and the two responsibilities are
never performed by both sides. The close fence performs these atomic steps:

1. mark the queue `closing` and capture the current tail in one synchronous
   state transition;
2. reject every later admission immediately with the exact compatibility
   rejection `Error("database write lock is closing")`; the Effect wrapper
   maps that rejection to `DatabaseFailure` with the supplied operation and
   original cause;
3. await the captured tail so every work item admitted before the transition,
   including queued items, settles while preserving FIFO and rejection
   recovery;
4. resolve the shared close Promise after the captured tail has settled.

The close Promise is shared and idempotent. No delegate restoration or client
close may occur before the captured tail settles. `DatabaseLive` calls
`await lock.close()`, then invokes the identity-protected uninstall callback,
then calls `client.close()` exactly once. A queue work item's `finally`
bookkeeping runs even when its operation rejects. The uninstall callback is
idempotent even when called after `close()` or after an out-of-order stale
finalizer; it removes only its own installation record and never removes a
newer record.

The scoped queue must preserve all current guarantees:

- calls begin in invocation order;
- only one write transaction or plain write runs at a time;
- a rejected operation does not poison later operations;
- a libSQL Promise is not cancelable, so queued admission and in-flight
  database work run uninterruptibly through settlement; an Effect interrupt
  requested while waiting or writing is observed only after that work settles,
  its queue slot is released, and the compatibility client remains valid;
- Better Auth writes do not enter this queue;
- filesystem and network operations remain at their current transaction
  boundaries.

The Effect implementation uses `Effect.uninterruptible` around queue
admission, the underlying libSQL Promise, and the release bookkeeping. It
does not race the Promise against an interruption timeout. When the calling
fiber was interrupted during that region, the completed operation's result is
discarded and the fiber returns the normal Effect interruption after the queue
slot has been released. A waiter interrupted before its turn therefore still
occupies its FIFO slot until its admitted work settles; an in-flight write
cannot abandon a libSQL transaction or leave the queue held by a detached
continuation. Tests cover both interrupted waiters and interrupted in-flight
writes.

The Effect operations carry a non-reentrant fiber-local acquisition marker.
If `withWriteLock` or `transaction` is requested from an Effect program that
already owns the same scoped queue, the operation fails immediately with
`DatabaseFailure` whose operation is the supplied operation and whose cause is
an internal `Error("nested database write lock acquisition")`. It must not
enqueue and hang. The callback supplied to a locked operation does not receive
the `Database` service, so normal code has no reason to reacquire it. Existing
legacy code that intentionally performs an un-locked write inside a locked
section, such as `setNoteImageFailed`, remains unchanged.

### Reads and snapshots

Unconverted ordinary reads use the compatibility-only `db` handle. New Effect
code uses `readSnapshot`, which duplicates the current explicit read path:
call `client.transaction("read")`, build a Drizzle handle over that
transaction and the existing schema, run the read, commit on success, and
always close in `finally`. Callback failure and commit failure close the
transaction and preserve the failure. The operation does not acquire the
write queue. Its transaction open/use/commit/close sequence is also
uninterruptible through settlement when called from Effect, because the
libSQL Promises cannot be canceled; a requested interrupt is surfaced only
after the transaction has closed. The interrupted-read case is included in
the Database tests.

No database operation moves filesystem or network work across a transaction
boundary. The service only changes ownership and error wrapping, not the
critical sections characterized by the existing router, job, scheduler, and
TTS tests.

## Auth

### Interface and layer

Create `apps/server/effect/auth.ts` with these exports:

```ts
import { Context, Layer } from "effect";
import * as Redacted from "effect/Redacted";
import type { Auth as LegacyAuth } from "../auth.ts";
import { AppConfig } from "./config.ts";
import { Database } from "./database.ts";
import { InfrastructureFailure } from "./errors.ts";

export type AuthService = Readonly<{
  instance: LegacyAuth;
}>;

export class Auth extends Context.Tag("@mnimi/server/Auth")<
  Auth,
  AuthService
>() {}

export const AuthLive: Layer.Layer<
  Auth,
  InfrastructureFailure,
  AppConfig | Database
>;
```

`AuthLive` constructs one Better Auth instance after `DatabaseLive` has
constructed its Drizzle handle. It calls the existing `createAuth` factory
with explicit values from `AppConfig` and `Database.db`:

- `secret: Redacted.value(config.auth.secret)`;
- `baseURL: config.auth.baseURL`;
- `trustedOrigins: [...config.browser.origins]`;
- `registrationEnabled: config.registration.enabled`;
- `useSecureCookies: config.auth.useSecureCookies`.

If `createAuth` throws, `AuthLive` fails with
`InfrastructureFailure({ operation: "auth.construct", message, cause })`,
preserving the original message and cause for startup diagnostics. It does
not turn the failure into a defect or expose the secret in the message.

Add the optional `useSecureCookies` input to `createAuth` while retaining its
current fallback expression when that option is omitted. This keeps direct
tests and direct scripts compatible while preventing the production Layer
from reading `process.env.NODE_ENV` after the snapshot.

The Better Auth configuration is otherwise byte-for-byte equivalent in
behavior: the Drizzle adapter remains SQLite with `transaction: false`,
UUIDv7 remains the generated ID function, the `nativeLanguage`, `uiLanguage`,
and `ttsAutoplay` fields remain writable with their current defaults, the
registration flag remains opt-in, trusted origins remain the parsed browser
allowlist, the bearer plugin remains installed, and secure cookie attributes
remain `httpOnly`, `sameSite: "lax"`, and `path: "/"`.

Better Auth writes remain outside the application write queue. The Auth layer
must not call `Database.withWriteLock` around adapter operations. Native
originless bearer responses, browser HttpOnly cookie responses, cookie-only
JSON bodies, registration reporting, and browser mutation-origin protection
remain owned by the existing app/auth adapters.

The temporary compatibility binding is `auth: AuthService.instance`. The
main process no longer imports `auth.instance.ts`; that module remains only
for unconverted direct consumers.

## LogTape

### Interface and ownership

Create `apps/server/effect/logging.ts` with these exports:

```ts
import { Context, Layer } from "effect";
import type { Logger, Sink } from "@logtape/logtape";
import { AppConfig } from "./config.ts";
import { InfrastructureFailure } from "./errors.ts";

export type LoggingService = Readonly<{
  getLogger(category: readonly string[]): Logger;
}>;

export class Logging extends Context.Tag("@mnimi/server/Logging")<
  Logging,
  LoggingService
>() {}

export function makeSanitizingSink(delegate: Sink): Sink;

export const LoggingLive: Layer.Layer<Logging, InfrastructureFailure, AppConfig>;
```

`LoggingLive` owns the one production LogTape configuration and its release.
It uses the current synchronous configuration exactly: `reset: true`, the
console sink named `console`, warning-level `mnimi` routing, and error-level
`["logtape", "meta"]` routing. Its finalizer calls LogTape's exported
`resetSync()` after all dependent services have been released. `resetSync()`
disposes the synchronous console sink and clears the global configuration; the
finalizer is idempotent through the managed runtime scope.

If `configureSync` throws, `LoggingLive` fails with
`InfrastructureFailure({ operation: "logging.configure", message, cause })`.
The finalizer is registered only after successful configuration. Because an
Effect 3 `acquireRelease` release has error type `never`, the finalizer catches
a `resetSync()` rejection/throw and calls
`Effect.die(new InfrastructureFailure({ operation: "logging.reset", message,
cause }))`. `disposeCoreRuntime` extracts that defect for startup/test cleanup;
it is not presented as an ordinary Layer error and does not replace a primary
startup failure.

`apps/server/logging.ts` becomes a compatibility shim that still exports
`getLogger` with its current call shape. Its module initialization calls
LogTape `getConfig()`: only when the result is `null` does it call
`configureSync({ reset: true, ...current compatibility configuration })`.
When a configuration already exists, including the configuration installed by
`LoggingLive`, the shim reuses it and never calls `configureSync` or
`resetSync`; it cannot replace an active runtime-owned configuration. Direct
imports with no active configuration therefore get the fixed compatibility
configuration once, while provider imports after `LoggingLive` use the one
canonical runtime-owned configuration. The shim imports the shared
`makeSanitizingSink` factory for its no-runtime fallback, but it does not
instantiate `LoggingLive` or a second runtime. It has no teardown authority
over the live runtime.

Structured logging accepts category, level, message, and structured fields.
The new adapter recursively traverses arrays and plain object fields and
renders every Effect `Redacted` value as the literal `"<redacted>"`, without
unwrapping it. The redaction is enforced at the LogTape record boundary, not
only by the service's direct logger: `LoggingLive` installs a sanitizing sink
wrapper around the canonical console sink. The implementation imports the
LogTape `Sink` and `LogRecord` types; its internal
`makeSanitizingSink(delegate: Sink): Sink` takes the `getConsoleSink()` result
and forwards only a recursively sanitized `LogRecord`. For every
`LogRecord` emitted by a logger, its category, level, message template
substitutions (`record.message`), and contextual/structured fields
(`record.properties`) are recursively sanitized before the wrapped sink
receives it; immutable category, level, raw-template, and timestamp metadata
are preserved. `getChild(...)` and `with(...)` loggers still route through
that same sink, so derived/context logger paths receive identical treatment.
The compatibility configuration uses the same sink wrapper.

The service returns the normal general LogTape `Logger` type, so it cannot
statically prevent a caller from passing a sensitive plain string in a message
or field. Callers must therefore use `Redacted` for secrets, omit prompts/raw
provider payloads/authorization headers/private paths, and treat logger
arguments as an explicit policy boundary. Broad raw console/logger cleanup
remains deferred to later owner children. Existing raw console sites in
unconverted owners remain unchanged in this child, including their current
error messages and log-and-continue behavior.

The adapter's recursive operation is concrete: `Redacted.isRedacted(value)`
maps to `"<redacted>"`; arrays are mapped element-by-element; and plain
objects are copied by enumerable key with the same recursion. Primitive
non-Redacted values are passed through. The sanitizing sink applies this
operation to every value the sink can receive, including derived logger
context, and never calls `Redacted.value` while formatting a log record. This
protects wrapped values without claiming that the general Logger can reject
an arbitrary sensitive plain string.

## Legacy bindings and runtime

### Explicit binding interface

Create `apps/server/effect/legacy-bindings.ts` with these exports:

```ts
import type { Auth as LegacyAuth } from "../auth.ts";
import type { Db } from "../db/index.ts";
import type { DatabaseService } from "./database.ts";
import type { AuthService } from "./auth.ts";

export type LegacyBindings = Readonly<{
  /** Compatibility-only fields for unchanged Hono/oRPC/router adapters. */
  db: Db;
  auth: LegacyAuth;
}>;

export function makeLegacyBindings(
  database: DatabaseService,
  auth: AuthService,
): LegacyBindings;
```

`makeLegacyBindings` returns the exact `database.db` and `auth.instance`
objects. No proxy changes method identity, transaction behavior, or auth
handler behavior. This is the sole production bridge that creates the old
`{ db, auth }` dependency bag.

Create `apps/server/effect/live.ts` with:

```ts
import * as Layer from "effect/Layer";
import { AppConfig } from "./config.ts";
import { Auth } from "./auth.ts";
import { Database } from "./database.ts";
import { InfrastructureFailure, DatabaseFailure } from "./errors.ts";
import { Logging } from "./logging.ts";

export type CoreServices = AppConfig | Logging | Database | Auth;
export type CoreLayerError = InfrastructureFailure | DatabaseFailure;

export function makeAppLayer(input?: {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
}): Layer.Layer<CoreServices, CoreLayerError, never>;
```

`makeAppLayer` is the testable constructor; production calls it without an
input so the default snapshot is taken exactly once. It composes the concrete
Layers with Effect 3's sequential dependency primitive `Layer.provideMerge`,
never with `Layer.mergeAll` or `Layer.zipWith`:

```ts
const config = makeAppConfigLayer(input);
const configAndLogging = Layer.provideMerge(LoggingLive, config);
const configLoggingDatabase = Layer.provideMerge(
  DatabaseLive,
  configAndLogging,
);
const core: Layer.Layer<CoreServices, CoreLayerError, never> =
  Layer.provideMerge(AuthLive, configLoggingDatabase);
return core;
```

Here `config` is `makeAppConfigLayer(input)`. In Effect 3.22.2's direct
two-argument form, the first (`that`) argument is the target layer and the
second (`self`) argument is the provider whose services feed that target.
Thus `config` feeds `LoggingLive`; the resulting context feeds
`DatabaseLive`; and that combined context feeds `AuthLive`.
`LoggingLive` requires
`AppConfig`; `DatabaseLive` requires `AppConfig | Logging`; and `AuthLive`
requires `AppConfig | Database`. This dependency chain forces acquisition in
the order AppConfig → LogTape → Database → Auth. Managed scope finalizers
therefore release in reverse order Auth → Database → LogTape → AppConfig;
AppConfig has no external resource, and LogTape remains configured while the
Database finalizer fences its queue and closes the client. `provideMerge`
memoizes the already-built dependency services, so this does not create a
second client or a per-request Layer. The composition's error type is the
actual union `InfrastructureFailure | DatabaseFailure`, with no cast or
defect conversion. The implementation keeps an explicit return annotation
`Layer.Layer<CoreServices, CoreLayerError, never>` on this expression; the
server check and live-layer test typecheck it against Effect 3.22.2. Ordered
resource composition must remain sequential and must not be replaced with a
concurrent `mergeAll`.

### Shared core acquisition and disposal helper

Create `apps/server/effect/core-runtime.ts` with the following concrete
interfaces:

```ts
import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect";
import type { AppConfigValue } from "./config.ts";
import type { AuthService } from "./auth.ts";
import type { DatabaseService } from "./database.ts";
import type { LoggingService } from "./logging.ts";
import type { CoreLayerError, CoreServices } from "./live.ts";

export type CoreServicesValue = Readonly<{
  config: AppConfigValue;
  logging: LoggingService;
  database: DatabaseService;
  auth: AuthService;
}>;

export function acquireCoreServices(
  runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>,
): Promise<CoreServicesValue>;

export function disposeCoreRuntime(
  runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>,
): Promise<void>;
```

The helper's acquisition program is one sequential `Effect.gen` that yields
`AppConfig`, `Logging`, `Database`, and `Auth` in that order. It runs with
`runtime.runPromiseExit(...)`, inspects `Exit.isSuccess`/`Exit.isFailure`, and
uses `Cause.failureOption` plus an exhaustive tagged-error check; it never
narrows failures by assuming they are configuration errors. The
implementation exhaustively handles both members of `CoreLayerError`:

- an `InfrastructureFailure` or `DatabaseFailure` whose `cause` is an `Error`
  returns that original Error, preserving its actionable message;
- a cause-less `DatabaseFailure` returns the stable safe message
  `Database startup failed during database acquisition`; no driver detail or
  dynamically supplied operation text is included;
- a cause-less `InfrastructureFailure` returns `new Error(failure.message)`;
- a non-Error cause on either tagged failure uses that failure's same safe
  fallback message, while the full Cause remains in diagnostics; an
  unexpected defect with no tagged `CoreLayerError` is converted to an Error
  from the `Cause` without an unsafe cast.

On an acquisition failure, `acquireCoreServices` first records that primary
Error, then runs `Effect.runPromiseExit(runtime.disposeEffect)` so every
partially acquired finalizer runs. This is the outer Effect runner, not
`runtime.runPromiseExit`: after an uncached Layer acquisition fails,
`ManagedRuntime.runPromiseExit` re-enters the failed `runtimeEffect` and cannot
reach the disposal effect. If disposal succeeds it rejects with the primary
Error. If disposal fails, it converts the disposal Cause to an actionable
cleanup Error and rejects with
`new AggregateError([primary, cleanup], "Core startup failed")`, keeping the
primary startup cause first and therefore never masking it. The same Cause
conversion is used by `disposeCoreRuntime` for an explicitly disposed test or
one-shot scope. Since Database and LogTape finalizers encode close/reset
failures as defects, their tagged payloads are visible in this Cause and are
reported by this helper rather than pretending that an `acquireRelease`
release has a typed error.

`main.ts` uses `acquireCoreServices` for its single production acquisition.
The exact invalid-port output remains
`PORT must be an integer between 1 and 65535` because the helper surfaces the
original `InfrastructureFailure` cause from `captureAppConfig`; no HTTP or
oRPC exposure changes. Main calls `disposeCoreRuntime` only for the bounded
pre-admission failure path. After workload admission, normal signal cleanup
does not invoke either helper and leaves the process-bound runtime acquired.

The `runRequest` signature in `apps/server/effect/runtime.ts` remains
`ManagedRuntime<R, never>` in this child. Main does not pass its fallible
`ManagedRuntime<CoreServices, CoreLayerError>` to `runRequest`; it obtains core
values through `acquireCoreServices` and passes the unchanged legacy bindings
to the existing Hono/oRPC application. Changing `runRequest` to accept a
fallible core runtime is deferred to the later transport-context child.

The existing `effect/runtime.ts` `ManagedRuntime` bridge remains the shared
runtime mechanism. `apps/server/effect/index.ts` adds exports for config,
database, auth, logging, `core-runtime.ts`, legacy bindings, and the live
layer while retaining all foundation exports already present.

### Main bootstrap

`apps/server/main.ts` changes its ownership imports and bootstrap sequence as
follows:

1. construct one `ManagedRuntime` from `makeAppLayer()`;
2. call the shared `acquireCoreServices(runtime)` helper. Its sequential
   `Effect.gen` requests `AppConfig`, then `Logging`, then `Database`, then
   `Auth`, retaining those values for the process; it does not use `Effect.all`
   for these resources and it reports every `CoreLayerError` through its
   `runPromiseExit`/`Cause` boundary;
3. build `LegacyBindings` from the Database and Auth services;
4. construct the existing provider with its existing
   `createAiProvider({ env: materializeLegacyEnvironment(config) })` entry
   point;
5. construct the existing shutdown closure and install the two existing
   signal handlers with their current ownership and behavior;
6. construct the existing Hono app with the legacy `db`, `auth`,
   `config.browser.corsOrigin`, `config.runtime.devtoolsEnabled`, and
   `config.registration.enabled`, plus the provider capabilities;
7. recover stale text work and log-and-continue on recovery failure exactly
   as today;
8. create the existing notification dispatcher and text scheduler;
9. recover stale image work and log-and-continue on recovery failure exactly
   as today;
10. create the existing image scheduler and create a draft-sweep closure over
    `database.db`; the closure performs the current draft/attempt reads and
    calls the unchanged `sweepDrafts` implementation;
11. call `Bun.serve` with `config.server.hostname` and `config.server.port`;
12. print `Redacted.value(config.runtime.readyToken)` only after the bind
    succeeds and only when it is non-empty.

The exact main-local sweep seam is:

```ts
function createSweep(db: Db): () => Promise<void>;
```

`start()` calls `const sweep = createSweep(database.db)` and schedules that
function. It must not close over the direct `db` export from
`apps/server/db/index.ts`.

The provider remains after foundation acquisition and before app/recovery/
scheduler/listener construction. `AppConfigLive` must not eagerly select,
import, validate, or connect to a provider. The compatibility environment
contains the captured `AI_PROVIDER` and `REGISTRATION_ENABLED` values, so
selection sees the same snapshot while provider construction remains lazy.
An unknown `AI_PROVIDER`, missing
OpenRouter key, invalid OpenRouter model route, invalid Codex role, missing
Codex credentials, or missing ElevenLabs key remains a failure at the same
lazy provider/operation boundary and keeps its exact current error text.

The Hono and oRPC modules remain unchanged compatibility adapters. They do not
construct a Layer for each request. The existing request context, bearer and
cookie authentication, SSE framing, route schemas, and current Promise
handlers remain in place until later router and transport children.

If initial foundation acquisition fails, `acquireCoreServices` disposes the
partially acquired scope exactly once through the outer
`Effect.runPromiseExit(runtime.disposeEffect)` boundary and presents its
mapped startup failure, aggregating a disposal defect after the primary cause
if necessary. If provider construction, app construction, or recovery setup
fails after foundation acquisition but before either scheduler is invoked, the
existing startup cleanup disposes any constructed provider and then calls
`disposeCoreRuntime(runtime)` exactly once. Main marks the startup
admission boundary immediately before creating the first scheduler, because
scheduler construction can admit durable work before a `Bun.serve` bind. If
any failure occurs at or after that boundary, existing cleanup still runs but
does not dispose the runtime; the process-bound client is left for process
termination because this child cannot prove that every worker has settled. A
successful bind keeps the same process-bound runtime and returns the existing
shutdown function; that normal shutdown path never calls
`disposeCoreRuntime(runtime)` or `runtime.dispose()`.

## Shutdown and deferred ownership

### Normal shutdown ordering

`apps/server/lifecycle.ts` remains the current idempotent shutdown owner. This
child does not add drain or disposer callbacks and does not remove signal
listeners. The existing signal handlers and `createShutdown` contract remain
unchanged: the first signal marks shutdown, the returned function is shared
across repeated signals, and the current server force-stop, text scheduler
stop, image scheduler stop, sweep interval clear, and provider disposal run
with `Promise.allSettled` in their existing order. Cleanup errors continue to
aggregate into the existing `AggregateError`.

Normal SIGINT/SIGTERM cleanup intentionally does not call
`runtime.dispose()` and does not close the scoped Database client. The
managed runtime and its client therefore remain process-bound after the
existing cleanup callback returns, preserving the current singleton's
lifetime semantics until the process exits. Scheduler stop is not presented
as proof that all active work has settled: the current server has active HTTP
handlers, durable text/image workers, detached legacy jobs, TTS,
notifications, sweep work, and admission paths that this child does not own.
The required characterization records whether each of those paths can still
touch the compatibility `db` after the existing cleanup callback returns. The
temporary compatibility-safe acceptance boundary is deliberately
process-bound: cleanup may return while such work is still live, the runtime
and client remain available until process termination, and tests assert that
no signal path closes either one. A post-cleanup database close is not
accepted as an optimization or as evidence of safety; active-work ownership
and drain semantics belong to the later child.

Runtime disposal is deferred to the later jobs/transport ownership child.
That child may add normal-shutdown disposal only after it owns active HTTP
handlers, durable text and image workers, legacy jobs, TTS, notifications,
the sweep, every admission path, and their cancellation/drain behavior. Until
then, no implementation in this child may close the production client from a
signal handler or from `createShutdown`.

### Safe disposal boundary for startup and tests

`disposeCoreRuntime` (and the equivalent disposal step internal to
`acquireCoreServices`) is used in two bounded cases only:

1. foundation/provider/app/recovery startup failure before the first
   scheduler is invoked and before any durable workload can be admitted; and
2. tests and one-shot scopes that have explicitly stopped their own work and
   are disposing a runtime they created.

In both cases the helper runs the outer
`Effect.runPromiseExit(runtime.disposeEffect)` boundary, so the Database close
fence must complete before the client closes and any reset/close defect is
reported through the helper. It deliberately bypasses
`ManagedRuntime.runPromiseExit` for disposal because that method re-enters the
failed uncached `runtimeEffect`. A normal production shutdown is not one of
these cases. This keeps the transitional scope honest: the current cleanup
sequence does not establish a safe Database close boundary for detached work.

## Error mapping and redaction

The tagged errors in `apps/server/effect/errors.ts` remain the transport-
independent expected-error vocabulary. This child adds Database acquisition,
read, write, and transaction failures as `DatabaseFailure` values with an
operation and diagnostic cause. It does not change existing router
`ORPCError` construction or transport mapping.

The rules are:

- `PORT` validation throws the exact existing plain error text. Config tests
  assert that text directly, and startup unwraps the layer failure before
  reporting it so the CLI-visible message remains unchanged.
- `AppConfigLive` and `LoggingLive` fail with `InfrastructureFailure`;
  `DatabaseLive` fails with `DatabaseFailure`; `AuthLive` fails with
  `InfrastructureFailure`; and `makeAppLayer` exposes exactly the union
  `InfrastructureFailure | DatabaseFailure`. No acquisition Layer error is
  widened to `unknown` or converted to a defect. Only release failures are
  converted to defects because `acquireRelease` releases have error type
  `never`.
- Database acquisition, read, write, and transaction boundary failures are
  tagged as `DatabaseFailure`; the original low-level cause is diagnostic only
  and is not serialized into HTTP or oRPC responses. Queue close, delegate
  reset, and client close failures carry a `DatabaseFailure` payload inside a
  finalizer defect and are normalized only by `disposeCoreRuntime` for its
  startup/test caller.
- Better Auth and legacy provider failures remain at their current Promise
  boundaries and retain their current messages. No config layer wraps a lazy
  provider failure into a different category.
- Future Effect router conversion will map `Unauthorized`, `NotFound`,
  `Conflict`, `Validation`, `DependencyUnavailable`, `DatabaseFailure`,
  `ProviderFailure`, `MediaFailure`, `Interrupted`, and
  `InfrastructureFailure` in one transport adapter. That mapping is not part
  of this child.
- Auth secrets, OpenRouter and ElevenLabs keys, and readiness tokens are
  stored in `Redacted` fields. They are unwrapped only at the Better Auth or
  third-party constructor boundary, or for the deliberate post-bind
  readiness print. The new logging adapter recursively renders those values
  as `"<redacted>"`; it cannot prevent a caller from passing a sensitive
  plain string to the general LogTape Logger. New owned callers must keep
  prompts, raw provider payloads, authorization headers, and private media
  paths out of fields or wrap sensitive values as `Redacted`. Broad cleanup of
  existing raw sites is deferred to their owner children.

## Testing strategy

Each implementation slice starts with a focused contract test and keeps the
existing characterization tests as the compatibility oracle.

### Configuration tests

Create `apps/server/effect/config.test.ts` covering:

- every default and boundary from the capture table;
- `PORT` invalid values `invalid`, empty, decimal, zero, negative, and
  `65536`, with the exact current error text;
- `PORT` values `1` and `65535`;
- unset versus explicitly empty `CORS_ORIGIN`;
- exact registration parsing;
- relative, absolute, memory, non-file, and empty database/media values;
- secure-cookie calculation for production, HTTPS, HTTP, and empty values;
- raw provider values and lazy optional fields, including no eager failure for
  unknown provider or missing optional secrets;
- plain direct `PORT` failure versus `InfrastructureFailure` from
  `makeAppConfigLayer`, including main's exact-message unwrapping;
- deep immutability and stability after mutating the source environment and
  argument arrays;
- one `AppConfigLive` acquisition reused by two runtime programs.

### Database tests

Create `apps/server/effect/database.test.ts` with the
`makeDatabaseLayer` client/factory seam so tests do not depend on a production
database. Supply a test `Logging` service because the live Database layer
requires it to enforce ordered ownership. Cover:

- one client and one Drizzle handle per runtime scope;
- exact directory setup and PRAGMA order;
- client close once on `disposeCoreRuntime` and on partial acquisition failure,
  with the close finalizer registered before the first PRAGMA;
- explicit read mode, commit on success, close on callback failure, and close
  on commit failure;
- FIFO writes, rejection recovery, and no queue release leak;
- close-fence races: reject admissions after the atomic closing transition,
  await all already-admitted work, restore only the matching installation,
  and close the client once;
- immediate nested-lock rejection rather than a hanging Promise;
- interrupted waiters and interrupted in-flight writes remain uninterruptible
  through libSQL Promise settlement, then surface interruption after queue
  release;
- finalizer failures are defects with the tagged close operation in the
  disposal Cause, and `disposeCoreRuntime` converts those defects to an
  actionable cleanup error;
- nested test/runtime installations restore the correct active predecessor,
  including out-of-order stale-finalizer cases;
- compatibility `withWriteLock` calls reaching the scoped queue while the
  runtime is live and restoring the direct fallback after disposal;
- Better Auth adapter writes not using the application queue.

Retain `db/write-lock.test.ts`, `db/schema.test.ts`, and
`db/migrations.test.ts` unchanged except for the compatibility setup required
to exercise the installed queue. Drizzle CLI and migration tests continue to
open their direct client path.

### Auth and logging tests

Create `apps/server/effect/auth.test.ts` and
`apps/server/effect/logging.test.ts`. Auth tests use the existing temporary
database fixture and assert UUIDv7 IDs, custom-field defaults and updates,
registration enablement, trusted origins, native bearer responses, browser
cookie-only responses, secure-cookie attributes, and exactly one instance per
runtime. A focused adapter spy asserts `transaction: false` and that no
application write-lock callback surrounds Auth writes.

Logging tests assert one canonical configuration, structured category/field
delivery, recursive rendering of nested redacted fields at the sanitizing sink
boundary, and the same redaction through `getChild(...)` and `with(...)`
derived/context loggers. They assert that importing a deferred provider after
`LoggingLive` reuses the active configuration and that direct shim import with
no active configuration initializes it once. They cover finalizer
disposal/reset defects and compatibility `getLogger` behavior. They also
document that a general Logger cannot statically reject arbitrary sensitive
plain strings; caller policy and deferred raw-site cleanup are the enforced
boundary.
Existing `apps/server/logging.test.ts` remains a direct compatibility check.

### Runtime, bootstrap, and lifecycle tests

Create `apps/server/effect/legacy-bindings.test.ts`,
`apps/server/effect/live.test.ts`, and
`apps/server/effect/core-runtime.test.ts`. Extend `apps/server/main.test.ts`;
retain
`apps/server/lifecycle.test.ts` as the unchanged existing cleanup
characterization, and assert:

- acquisition order config → LogTape → Database → Auth → existing provider;
- reverse release order Auth → Database → LogTape (then the inert AppConfig
  scope) for a disposed scope, with LogTape still available while Database
  finalizes;
- provider selection remains lazy and failure prevents app/recovery/schedule/
  bind while releasing the already-acquired foundation;
- one runtime is used for all startup values and no per-request Layer is
  created;
- the app receives the exact `db` and `auth` objects from the compatibility
  binding;
- the main sweep closes over the scoped Database `db` handle rather than the
  direct singleton export;
- recovery still logs and continues on failure;
- readiness output occurs only after a successful bind;
- normal SIGINT/SIGTERM shutdown remains idempotent across both signals,
  attempts all existing cleanups, preserves signal ownership, and does not
  call `runtime.dispose()` or close the client;
- startup/foundation/provider failure before scheduler admission disposes the
  runtime exactly once, while later startup failure leaves the process-bound
  scope open; a test or one-shot runtime can dispose it through the close
  fence.

`core-runtime.test.ts` specifically exercises the shared acquisition
`runtime.runPromiseExit` boundary with an `InfrastructureFailure` carrying the
exact PORT Error, an
`InfrastructureFailure` carrying a different actionable Error, a
`DatabaseFailure` carrying an Error, and a cause-less `DatabaseFailure`. It
asserts original Error identity/message preservation, the stable safe database
startup message, and the fallback for an unexpected Cause. It also makes a
finalizer throw a tagged close/reset defect and asserts that the helper reports
it as cleanup information only after the primary startup Error, using
`AggregateError([primary, cleanup], "Core startup failed")`. A direct
`disposeCoreRuntime` test covers a one-shot scope with a disposal defect and
asserts that failed uncached Layer acquisition uses
`Effect.runPromiseExit(runtime.disposeEffect)`, not
the ManagedRuntime method, so partial finalizers run.
These tests keep the fallible core runtime out of `runRequest` and verify that
no HTTP-facing error mapping changes.

The existing black-box tests remain required: `app.test.ts`,
`auth.test.ts`, `browser-auth.test.ts`, `images.test.ts`, `audio.test.ts`,
`sse-contract.test.ts`, provider tests, creation and scheduler tests,
notification tests, and Codex lifecycle tests. The new import-boundary test
must prove that the owned Effect modules do not evaluate the old global
database or auth singleton.

The production-shaped `apps/server/scripts/runtime-smoke.ts` continues to
cover migration, disabled registration, sign-in, authenticated deck create
and list, unauthenticated media, readiness, and bounded SIGTERM shutdown.
Its database and media setup remain direct tool fixtures; the running server
must use the scoped runtime. Its bounded SIGTERM assertion covers process
exit and existing cleanup, not a normal-shutdown Database close.

## File ownership and implementation sequencing

The implementation plan for this spec uses non-overlapping batches in this
order. Every batch runs its focused tests, `bun run server:check`, and
`git diff --check` before the next batch changes an overlapping interface.

### Batch 1: AppConfig and parser unification

Own:

- create `apps/server/effect/config.ts`;
- create `apps/server/effect/config.test.ts`;
- modify `apps/server/app.ts` only to delegate `serverOptions` to the shared
  parser while preserving its export and tests;
- add config exports to `apps/server/effect/index.ts`.

Deliver the immutable snapshot, exact parsing table, provider/media capture,
and no eager provider validation.

### Batch 2: Database owner and lock compatibility

Own:

- create `apps/server/effect/database.ts`;
- create `apps/server/effect/database.test.ts`;
- modify `apps/server/db/write-lock.ts` to provide the scoped queue and
  compatibility delegate;
- add Database exports to `apps/server/effect/index.ts`.

Do not modify schema, migration SQL, Drizzle config, or router transaction
boundaries.

### Batch 3: Auth owner

Own:

- create `apps/server/effect/auth.ts`;
- create `apps/server/effect/auth.test.ts`;
- modify `apps/server/auth.ts` only to accept the explicit secure-cookie
  value while preserving the existing default for direct callers;
- add Auth exports to `apps/server/effect/index.ts`.

Do not modify Better Auth routes, browser response filtering, registration
responses, or adapter semantics.

### Batch 4: LogTape owner and compatibility shim

Own:

- create `apps/server/effect/logging.ts`;
- create `apps/server/effect/logging.test.ts`;
- modify `apps/server/logging.ts` into the compatibility shim;
- add Logging exports to `apps/server/effect/index.ts`.

No raw console site outside the compatibility module is migrated.

### Batch 5: Layer composition and legacy bindings

Own:

- create `apps/server/effect/live.ts`;
- create `apps/server/effect/core-runtime.ts`;
- create `apps/server/effect/legacy-bindings.ts`;
- create `apps/server/effect/live.test.ts`;
- create `apps/server/effect/core-runtime.test.ts`;
- create `apps/server/effect/legacy-bindings.test.ts`;
- add live-layer and binding exports to `apps/server/effect/index.ts`.

Prove the dependency graph and object identity without changing Hono or oRPC
procedures.

### Batch 6: Main bootstrap integration

Own:

- modify `apps/server/main.ts`;
- modify `apps/server/main.test.ts`;
- modify `apps/server/import-boundary.test.ts` for the new owned modules.

Keep `apps/server/lifecycle.ts` and its tests unchanged: provider/media imports,
existing signal ownership, cleanup ordering, idempotence, and aggregate error
behavior remain the compatibility contract. Run the startup/recovery/binding
tests and the existing lifecycle characterization before the full server
suite. Main tests must additionally prove that normal shutdown does not call
`runtime.dispose()`.

### Batch 7: Integrated verification

Own no production source changes. Reconcile the complete diff, run all gates,
review the compatibility matrix below, and close `mnimi-pi5.2` only after
the implementation has passed every completion gate. The Bead status change
is part of implementation handoff, not this documentation-only task. The
gates accept process-bound production Database lifetime; they do not require
normal-shutdown disposal or active-job ownership that belongs to a later
child.

## Rollback

No schema or migration change is allowed, so rollback never requires data
rollback. The compatibility path remains available throughout the migration:

1. revert main integration to use `db/index.ts` and `auth.instance.ts`,
   leaving the already-compatible `lifecycle.ts` unchanged;
2. remove the `DatabaseLive`, `AuthLive`, `LoggingLive`, and live-layer
   acquisition from `main.ts`;
3. restore the old `logging.ts` initializer and the default write-lock
   delegate;
4. leave `db/index.ts`, `auth.instance.ts`, Drizzle CLI paths, and all old
   tests intact.

The config/database/auth/logging modules may remain unused after a rollback;
they do not open production resources on import. The rollback restores the
old process-bound singleton lifetime and the existing normal-shutdown
behavior, including no Database close from the signal cleanup. A rollback is
a local conventional commit operation and does not push, merge, or deploy
anything.

## Compatibility matrix

| Surface | Current contract | Transitional implementation | Completion evidence |
| --- | --- | --- | --- |
| Configuration | Defaults, raw values, exact `PORT` error, and parser asymmetries | One frozen AppConfig snapshot; direct `serverOptions` delegates to shared parser | `effect/config.test.ts`, app tests, CLI validation |
| Browser origins/CORS | Comma split/trim/filter and current Hono allowlist | Config passes resolved origin string to app and parsed list to Auth | app and browser-auth tests, preflight cases |
| Registration | Exact `"true"` opt-in; Better Auth sign-up disabled otherwise | Config boolean passed to unchanged app/Auth compatibility adapters | app/auth tests and runtime smoke |
| Auth | UUIDv7, custom fields, trusted origins, bearer, cookie-only browser responses, `transaction: false` | One Auth instance over Database; writes remain outside queue | auth/browser tests and adapter spy |
| Database client | One client, exact PRAGMAs, explicit read snapshots, FIFO lock, and process-bound lifetime with no signal-time close | One managed-scope client and handle; raw `client`/`db` fields compatibility-only; scoped queue installed behind old `withWriteLock`; close fence applies to disposed test/startup scopes, not normal production shutdown | database/lock/schema/migration tests and close-fence race tests |
| Drizzle CLI | Direct `drizzle.config.ts`, direct migrations | Unchanged direct path, never Layer-backed | drizzle config and migration tests |
| Provider selection | Lazy dynamic selection and exact provider errors | Existing `createAiProvider()` called after foundation; AppConfig does not validate | provider tests, main tests, runtime smoke |
| Provider fields | OpenRouter raw defaults/effort warnings; Codex trim/default/validation; ElevenLabs lazy key | Captured for future slices but old modules remain untouched | provider/Codex/OpenRouter/ElevenLabs tests |
| Media | Module-root path capture, secure path checks, atomic writes, auth ownership | Captured paths are not wired into media modules in this child | image/audio/write-media tests |
| HTTP and RPC | Existing routes, schemas, codes, statuses, context, SSE | Explicit `{ db, auth }` bindings feed unchanged app/router code | app, router, SSE, and smoke tests |
| Startup | Provider before app/recovery/scheduler/bind; recovery logs and continues | Config/LogTape/Database/Auth precede the same provider/app sequence; shared `runPromiseExit` helper preserves every actionable core cause and aggregates disposal after the primary | main/core-runtime tests, runtime smoke |
| Core errors | Startup diagnostics retain actionable underlying failures | Exhaustive `CoreLayerError` cause extraction; cause-less Database failures use the stable safe operation message; release defects are normalized only by `disposeCoreRuntime` | core-runtime cause/defect tests |
| Shutdown | Idempotent aggregate cleanup and provider cancellation; signal listener ownership remains current | Existing cleanup only; normal SIGINT/SIGTERM does not dispose runtime or close Database; disposal is deferred until jobs/transport ownership | lifecycle/main tests and smoke; explicit no-dispose assertion |
| Logging | LogTape console sink and compatibility `getLogger` | Scoped service owns production config/release; sanitizing sink covers direct and derived loggers; guarded shim reuses one active config | logging tests, shim-import tests, and existing raw-site tests |

## Alternatives considered

### a) Layer definitions only

Define tags and empty Layers but leave the process-wide client, auth singleton,
LogTape configuration, and `main.ts` startup untouched. This would make type
ports available but would not give this child its required acquisition graph,
scoped failure cleanup, lock fence, or compatibility binding proof. It also
would not make a single scoped client available to the later owners. It does
not satisfy `mnimi-pi5.2` even though production normal-shutdown disposal is
correctly deferred.

### b) Big-bang bootstrap conversion

Rewrite `main.ts`, all routers, provider/media adapters, jobs, workers,
schedulers, transport context, and error mapping in one bootstrap change.
This couples every later child to uncharacterized service interfaces,
multiplies the detached-job shutdown risk, and makes a behavior-preserving
rollback difficult. It also violates the parent program's non-overlapping
child boundaries.

### Selected: transitional scoped ownership

Own the core resources now, expose exact temporary bindings, and keep old
Promise behavior at named edges. The child gains one client lifetime, one
config snapshot, one Auth instance, canonical LogTape lifecycle, and one
runtime without pretending that deferred services already have Effect owners.
Production normal shutdown intentionally keeps that runtime and Database
client process-bound. The lock close fence makes startup-failure and
test/one-shot disposal safe, while normal-shutdown disposal waits for the
later jobs/transport ownership child to own every active workload and
admission path.

## Completion gates

The implementation is complete only when all of the following are true:

- `effect/config.test.ts`, `effect/database.test.ts`,
  `effect/auth.test.ts`, `effect/logging.test.ts`,
  `effect/live.test.ts`, `effect/core-runtime.test.ts`, and
  `effect/legacy-bindings.test.ts` pass;
- `bun run server:check` passes;
- `VITEST_MAX_WORKERS=2 bun run server:test` passes, including runtime smoke;
- `bun run check` passes;
- `VITEST_MAX_WORKERS=2 bun run test` passes;
- `EXPO_PUBLIC_API_URL=https://api.example.com bun run web:build` passes;
- `bun run --cwd apps/server scripts/runtime-smoke.ts` passes with bounded
  startup and SIGTERM shutdown;
- `git diff --check` passes;
- no `@effect/platform` package is added;
- `apps/server/main.ts` has no runtime import of `db/index.ts` or
  `auth.instance.ts`;
- the owned Effect modules have no runtime import of deferred provider/media,
  router, app, or old logging implementations;
- normal SIGINT/SIGTERM cleanup does not call `runtime.dispose()` or close the
  production Database client, while startup failure before scheduler
  admission and explicit test/one-shot disposal close through the queue fence;
- the shared helper handles every `CoreLayerError`, preserves the primary
  startup cause before any disposal defect, and the ordered Layer composition
  typechecks against Effect 3.22.2 without casts;
- the compatibility shim never resets an active `LoggingLive` configuration,
  and the sanitizing sink covers direct, child, and contextual LogTape
  loggers;
- the compatibility matrix has evidence for every row;
- no implementation file, schema file, migration file, public route, client
  contract, or deployment file changed outside this scope;
- the Bead `mnimi-pi5.2` is closed only after these gates pass. Its successor
  owns the later normal-shutdown disposal acceptance boundary after jobs,
  transport, and every active workload/admission path are owned.

The implementation must not report a provider-dependent check as passing when
credentials were unavailable; deterministic, browser, device, and hosted
evidence remain separately labeled as required by the parent design.
