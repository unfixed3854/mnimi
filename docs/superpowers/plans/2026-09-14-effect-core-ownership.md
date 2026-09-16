# Effect Core Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Mnimi one immutable configuration snapshot, one scoped Database/Auth/LogTape graph, and one process-bound production ManagedRuntime while preserving every existing Promise adapter and normal signal-cleanup boundary.

**Architecture:** Capture all startup inputs once in `AppConfig`, then compose `LoggingLive`, `DatabaseLive`, and `AuthLive` with sequential `Layer.provideMerge` calls. Expose the scoped Database and Auth through an exact `{ db, auth }` compatibility binding so the current Hono/oRPC, provider, media, recovery, and scheduler code keeps its existing interfaces. Main acquires the graph once; bounded pre-admission startup failures use the outer `Effect.runPromiseExit(runtime.disposeEffect)` boundary, while normal SIGINT/SIGTERM cleanup leaves the runtime and libSQL client process-bound for the later jobs/transport child.

**Tech Stack:** Bun 1.3.13, TypeScript 6.0.3, Vitest 4.1.10, Effect 3.22.2, Hono 4.13.0, oRPC 1.14.14, Better Auth 1.6.26, Drizzle/libSQL, LogTape 2.3.0, uuidv7 1.2.1.

**Spec:** `docs/superpowers/specs/2026-09-13-effect-core-ownership-design.md`

Execute the numbered tasks in order: Task 1 (configuration), Task 2 (LogTape), Task 3 (write-lock), Task 4 (Database), Task 5 (Auth), Task 6 (Layer graph and bindings), Task 7 (core-runtime Cause boundary), Task 8 (main bootstrap), then Task 9 (integrated verification). Each task’s interface block is the handoff contract for a fresh implementer.

## Global Constraints

- Use `bun` for package management and public script execution in this project. Do not use Deno, `npm`, `npx`, Yarn, or pnpm.
- Use conventional commits.
- This child does not convert domain routers, Hono middleware, oRPC context, media or TTS operations, OpenRouter, Codex, notifications, creation jobs, events, workers, schedulers, transport error mapping, or Promise-era public APIs.
- It does not change the SQLite schema, migrations, HTTP routes, request schemas, cookies, CORS policy, provider policy, retry policy, or deployment topology.
- Normal shutdown disposal is outside this child. Existing shutdown continues to stop the server, schedulers, sweep interval, and provider with its current idempotent aggregate behavior, but it does not dispose the managed runtime or close the Database client.
- Runtime disposal remains deferred until a later jobs/transport ownership child owns active HTTP handlers, durable text and image workers, detached legacy jobs, TTS, notifications, the sweep, and every admission path. Signal listener ownership and removal remain unchanged here.
- `apps/server/drizzle.config.ts` and the `db:*` scripts continue to use the direct Drizzle/libSQL path; `apps/server/db/index.ts` remains available to existing tests and direct scripts; `apps/server/auth.instance.ts` remains a compatibility singleton for code that still imports it but `main.ts` must not import it; `apps/server/logging.ts` continues to expose `getLogger` for unconverted owners; `apps/server/ai/jobs.ts` remains untouched; existing raw `console.error` sites outside this child are not migrated.
- The new owned modules must not import `main.ts`, `app.ts`, any router, `auth.instance.ts`, the runtime `db/index.ts` value, provider implementations, media implementations, or the old logging module. Type-only imports of the `Db` and `Auth` types are allowed where they do not evaluate those modules.
- `captureAppConfig` preserves the exact plain `Error("PORT must be an integer between 1 and 65535")` for direct callers; its Layer maps failures to `InfrastructureFailure({ operation: "config.capture", ... })` and the shared startup helper unwraps the original Error.
- `DatabaseLive` acquires one client per managed scope, registers its client finalizer before PRAGMAs, executes `PRAGMA journal_mode = WAL`, then `PRAGMA busy_timeout = 5000`, then `PRAGMA foreign_keys = ON`, installs one scoped write queue, and releases queue then client in that order.
- `WriteLock.close()` only fences and settles its queue. The callback from `installWriteLock` alone owns identity removal and delegate restoration; both are idempotent and an out-of-order stale finalizer cannot replace a newer installation.
- Better Auth writes remain outside the application write queue. Read snapshots do not acquire the write queue and always close their explicit `client.transaction("read")` transaction.
- `LoggingLive` uses synchronous LogTape configuration with `reset: true`, console sink `console`, warning-level `mnimi` routing, and error-level `["logtape", "meta"]` routing. Its sanitizing sink renders every Effect `Redacted` value as the literal `"<redacted>"` in category, level, message, and properties without calling `Redacted.value`.
- `makeAppLayer` uses the sequential two-argument `Layer.provideMerge` chain from the spec, never `Layer.mergeAll` or `Layer.zipWith`; its error type is exactly `InfrastructureFailure | DatabaseFailure` with no cast or defect conversion.
- `runRequest` remains `ManagedRuntime<R, never>` in this child. Main does not pass the fallible core runtime to it.
- Production acquires the runtime once and keeps it acquired after normal SIGINT/SIGTERM cleanup. `disposeCoreRuntime` is used only for startup failure before the first scheduler is invoked and for explicitly stopped test/one-shot scopes.
- `disposeCoreRuntime` and failed foundation acquisition use outer `Effect.runPromiseExit(runtime.disposeEffect)`, not `runtime.runPromiseExit(runtime.disposeEffect)`. Disposal defects aggregate after the primary startup Error as `AggregateError([primary, cleanup], "Core startup failed")`.
- No implementation file, schema file, migration file, public route, client contract, or deployment file changes outside this scope, and no `@effect/platform` package is added.
- Run focused tests, `bun run server:check`, and `git diff --check` at each task boundary. The full repository suite is `VITEST_MAX_WORKERS=2 bun run test`, never raw `bun test`.

---


## File and ownership map

Each path has one task owner. Later tasks consume the named interfaces from earlier tasks and do not edit an earlier task’s implementation files except where the map explicitly says so.

| Path | Responsibility | Task |
| --- | --- | --- |
| `apps/server/effect/config.ts` | Immutable startup snapshot, exact parser, redacted legacy environment | 1 |
| `apps/server/effect/config.test.ts` | Configuration defaults, all input boundaries, immutability, Layer error contract | 1 |
| `apps/server/app.ts` | Delegate direct `serverOptions` to the shared exact parser | 1 |
| `apps/server/effect/logging.ts` | Scoped LogTape configuration and recursive sanitizing sink | 2 |
| `apps/server/effect/logging.test.ts` | Canonical config, all record-field redaction, derived loggers, reset defects | 2 |
| `apps/server/logging.ts` | Guarded no-runtime compatibility shim | 2 |
| `apps/server/db/write-lock.ts` | Pure FIFO queue plus identity-protected compatibility delegate | 3 |
| `apps/server/db/write-lock.test.ts` | FIFO, close fence, interruption settlement, nested installation compatibility | 3 |
| `apps/server/effect/database.ts` | Scoped client/Drizzle owner, PRAGMAs, read/write/transaction Effect operations | 4 |
| `apps/server/effect/database.test.ts` | Database acquisition, operations, queue integration, interruption, finalizer contracts | 4 |
| `apps/server/effect/auth.ts` | One Better Auth instance over the scoped Database | 5 |
| `apps/server/effect/auth.test.ts` | Auth Layer identity, adapter options, and unchanged Better Auth behavior | 5 |
| `apps/server/auth.ts` | Optional explicit secure-cookie value with current direct-call fallback | 5 |
| `apps/server/effect/live.ts` | Sequential AppConfig → Logging → Database → Auth Layer graph | 6 |
| `apps/server/effect/legacy-bindings.ts` | Exact `{ db, auth }` compatibility bridge | 6 |
| `apps/server/effect/live.test.ts` | Executable Layer acquisition/release order and graph identity | 6 |
| `apps/server/effect/legacy-bindings.test.ts` | Binding identity contract | 6 |
| `apps/server/effect/core-runtime.ts` | Shared acquisition, tagged Cause extraction, safe disposal | 7 |
| `apps/server/effect/core-runtime.test.ts` | Primary-cause preservation, partial finalizers, disposal defects | 7 |
| `apps/server/effect/index.ts` | Public exports for all owned Effect modules, including core-runtime | 7 |
| `apps/server/main.ts` | One production runtime, legacy bindings, pre-admission disposal boundary | 8 |
| `apps/server/main.test.ts` | Startup order, binding identity, admission boundary, no signal-time disposal | 8 |
| `apps/server/import-boundary.test.ts` | Pure import and narrowly-scoped owned-module import safety | 8 |

The existing `apps/server/lifecycle.ts` and `apps/server/lifecycle.test.ts` remain unchanged. The existing provider, media, TTS, router, schema, migration, scheduler, jobs, and direct singleton tests remain compatibility oracles and are read before implementation but are not owned by these tasks.

## Interfaces between tasks

Task 1 produces `AppConfig`, `AppConfigValue`, `captureAppConfig`, `makeAppConfigLayer`, `AppConfigLive`, and `materializeLegacyEnvironment`.

Task 2 consumes `AppConfig` and produces `Logging`, `LoggingService`, `LoggingLive`, and `makeSanitizingSink`; the old `logging.ts` remains a guarded shim.

Task 3 is independent of later service layers and produces `WriteLock`, `createWriteLock`, `installWriteLock`, and the compatibility `withWriteLock` delegate.

Task 4 consumes `AppConfig`, `Logging`, `WriteLock`, and existing schema/read-transaction types, and produces `Database`, `DatabaseService`, `DatabaseLive`, and `makeDatabaseLayer`.

Task 5 consumes `AppConfig` and `Database`, and produces `Auth`, `AuthService`, and `AuthLive`.

Task 6 consumes the four service layers from Tasks 1, 2, 4, and 5, and produces `LegacyBindings`, `makeLegacyBindings`, `CoreServices`, `CoreLayerError`, and `makeAppLayer`. It does not edit `effect/index.ts`; Task 7 owns the barrel.

Task 7 consumes `CoreServices`, `CoreLayerError`, and the four service tags and produces `CoreServicesValue`, `acquireCoreServices`, and `disposeCoreRuntime`; it also adds all new exports to `effect/index.ts`.

Task 8 consumes all prior interfaces and changes only `main.ts` startup ownership; `runRequest`, lifecycle ownership, routers, providers, media, and public Promise APIs remain unchanged.

### Task 1: Capture one immutable AppConfig and unify the server parser

**Files:**

- Create: `apps/server/effect/config.ts`
- Create: `apps/server/effect/config.test.ts`
- Modify: `apps/server/app.ts:17-31`

**Interfaces:**

- Consumes: `resolveDatabaseUrl`, `resolveRuntimePath`, `browserOrigins`, `isRegistrationEnabled`, and the existing `serverOptions` tests. Do not import the provider implementation to resolve `CODEX_HOME`; reproduce the current undefined/empty/non-empty path branch locally from `resolveRuntimePath` so the owned module has no provider runtime import.
- Produces: the exact `AppConfigValue` shape and functions below. Later tasks treat the returned value as frozen and never read `process.env` for captured fields.

- [ ] **Step 1: Write the failing configuration contract**

Create `apps/server/effect/config.test.ts` with a table-driven capture test and direct/Layer error tests:

```ts
import { describe, expect, it } from "vitest";
import { Effect, Exit, Redacted } from "effect";
import {
  AppConfig,
  captureAppConfig,
  makeAppConfigLayer,
  materializeLegacyEnvironment,
} from "./config.ts";
import { InfrastructureFailure } from "./errors.ts";
import { makeTestRuntime } from "./testing.ts";
import { repositoryRoot, resolveDatabaseUrl, resolveRuntimePath } from "../runtime-paths.ts";

const required = {
  BETTER_AUTH_SECRET: "auth-secret",
  OPENROUTER_API_KEY: "router-secret",
  ELEVENLABS_API_KEY: "tts-secret",
  MNIMI_DEV_READY_TOKEN: "ready-secret",
};

describe("AppConfig", () => {
  it("captures every default and raw provider/media field once", () => {
    const config = captureAppConfig({ env: required, argv: ["--devtools"] });
    expect(config.server).toEqual({ hostname: "0.0.0.0", port: 8787 });
    expect(config.browser).toEqual({
      corsOrigin: "http://localhost:8081,http://127.0.0.1:8081",
      origins: ["http://localhost:8081", "http://127.0.0.1:8081"],
    });
    expect(config.registration.enabled).toBe(false);
    expect(config.database.url).toMatch(/\/data\/mnimi\.db$/);
    expect(config.media.imagesDir).toMatch(/\/data\/images$/);
    expect(config.media.audioDir).toMatch(/\/data\/audio$/);
    expect(config.auth.baseURL).toBe("http://127.0.0.1:8787");
    expect(Redacted.value(config.auth.secret)).toBe("auth-secret");
    expect(config.ai.selected).toBe("openrouter");
    expect(Redacted.value(config.ai.openRouter.apiKey)).toBe("router-secret");
    expect(config.ai.openRouter.classifyModel).toBe("google/gemini-2.5-flash");
    expect(config.ai.openRouter.generateModel).toBe("anthropic/claude-sonnet-4.5");
    expect(config.ai.openRouter.imageModel).toBe("black-forest-labs/flux.2-klein-4b");
    expect(config.ai.codex.classifyModel).toBeUndefined();
    expect(config.ai.codex.classifyEffort).toBeUndefined();
    expect(config.ai.codex.generateModel).toBeUndefined();
    expect(config.ai.codex.generateEffort).toBeUndefined();
    expect(config.ai.codex.codexHome).toMatch(/\/data\/codex$/);
    expect(Redacted.value(config.elevenLabs.apiKey)).toBe("tts-secret");
    expect(config.elevenLabs.model).toBe("eleven_multilingual_v2");
    expect(config.elevenLabs.voiceId).toBe("JBFqnCBsd6RMkjVDRZzb");
    expect(config.runtime.nodeEnv).toBeUndefined();
    expect(config.runtime.devtoolsEnabled).toBe(true);
    expect(Redacted.value(config.runtime.readyToken)).toBe("ready-secret");
    const legacy = materializeLegacyEnvironment(config);
    expect(legacy.BETTER_AUTH_SECRET).toBe("auth-secret");
    expect(legacy.MNIMI_DEV_READY_TOKEN).toBe("ready-secret");
  });

  it.each(["invalid", "", "8787.5", "0", "-1", "65536"])(
    "keeps the exact direct PORT error for %j",
    (PORT) => expect(() => captureAppConfig({ env: { PORT } }))
      .toThrow("PORT must be an integer between 1 and 65535"),
  );

  it.each(["1", "65535"])("accepts PORT boundary %j", (PORT) => {
    expect(captureAppConfig({ env: { PORT } }).server.port).toBe(Number(PORT));
  });

  it("distinguishes unset and explicitly empty values and preserves raw fields", () => {
    const defaults = captureAppConfig({ env: {}, argv: [] });
    const empty = captureAppConfig({
      env: {
        CORS_ORIGIN: "",
        HOST: "",
        BETTER_AUTH_URL: "",
        DATABASE_URL: "",
        IMAGES_DIR: "",
        AUDIO_DIR: "",
        AI_PROVIDER: " ",
        CLASSIFY_MODEL: "",
        CLASSIFY_EFFORT: " ",
        GENERATE_MODEL: "",
        GENERATE_EFFORT: " ",
        CODEX_HOME: "",
        ELEVENLABS_MODEL: "",
        ELEVENLABS_VOICE_ID: "",
      },
      argv: ["--other"],
    });
    expect(defaults.browser.origins).toEqual([
      "http://localhost:8081", "http://127.0.0.1:8081",
    ]);
    expect(empty.browser.corsOrigin).toBe("");
    expect(empty.browser.origins).toEqual([]);
    expect(empty.server.hostname).toBe("");
    expect(empty.auth.baseURL).toBe("");
    expect(empty.database.url).toBe("");
    expect(empty.media.imagesDir).toBe(repositoryRoot);
    expect(empty.media.audioDir).toBe(repositoryRoot);
    expect(empty.ai.selected).toBe(" ");
    expect(empty.ai.openRouter.classifyModel).toBe("");
    expect(empty.ai.openRouter.classifyEffort).toBe(" ");
    expect(empty.ai.codex.classifyModel).toBe("");
    expect(empty.ai.codex.classifyEffort).toBe(" ");
    expect(empty.ai.codex.generateModel).toBe("");
    expect(empty.ai.codex.generateEffort).toBe(" ");
    expect(empty.ai.codex.codexHome).toBe("");
    expect(empty.elevenLabs.model).toBe("");
    expect(empty.elevenLabs.voiceId).toBe("");
    expect(empty.runtime.devtoolsEnabled).toBe(false);
  });

  it("covers absolute, relative, non-file, and empty URL/path forms", () => {
    expect(captureAppConfig({ env: { DATABASE_URL: "file:./custom.db" }, argv: [] }).database.url)
      .toBe(resolveDatabaseUrl("file:./custom.db"));
    expect(captureAppConfig({ env: { DATABASE_URL: "file:/tmp/mnimi.db" }, argv: [] }).database.url)
      .toBe("file:/tmp/mnimi.db");
    expect(captureAppConfig({ env: { DATABASE_URL: "file::memory:" }, argv: [] }).database.url)
      .toBe("file::memory:");
    expect(captureAppConfig({ env: { DATABASE_URL: "libsql://example.turso.io" }, argv: [] }).database.url)
      .toBe("libsql://example.turso.io");
    expect(captureAppConfig({ env: { DATABASE_URL: "" }, argv: [] }).database.url).toBe("");
    expect(captureAppConfig({ env: { IMAGES_DIR: "./var/images" }, argv: [] }).media.imagesDir)
      .toBe(resolveRuntimePath("./var/images"));
    expect(captureAppConfig({ env: { IMAGES_DIR: "/tmp/images" }, argv: [] }).media.imagesDir).toBe("/tmp/images");
    expect(captureAppConfig({ env: { IMAGES_DIR: "" }, argv: [] }).media.imagesDir).toBe(repositoryRoot);
    expect(captureAppConfig({ env: { AUDIO_DIR: "./var/audio" }, argv: [] }).media.audioDir)
      .toBe(resolveRuntimePath("./var/audio"));
    expect(captureAppConfig({ env: { AUDIO_DIR: "/tmp/audio" }, argv: [] }).media.audioDir).toBe("/tmp/audio");
    expect(captureAppConfig({ env: { AUDIO_DIR: "" }, argv: [] }).media.audioDir).toBe(repositoryRoot);
  });

  it("trims CORS entries while preserving the raw CORS string", () => {
    const config = captureAppConfig({ env: { CORS_ORIGIN: "  https://a.test, ,https://b.test  " }, argv: [] });
    expect(config.browser.corsOrigin).toBe("  https://a.test, ,https://b.test  ");
    expect(config.browser.origins).toEqual(["https://a.test", "https://b.test"]);
  });

  it("redacts every supplied legacy environment value and preserves an empty ready token", () => {
    const env = {
      BETTER_AUTH_SECRET: "auth", OPENROUTER_API_KEY: "openrouter",
      ELEVENLABS_API_KEY: "eleven", MNIMI_DEV_READY_TOKEN: "",
      HOST: "127.0.0.1", PORT: "9999", CORS_ORIGIN: "https://a.test",
      DATABASE_URL: "file:/tmp/db", IMAGES_DIR: "/tmp/images", AUDIO_DIR: "./audio",
      AI_PROVIDER: "codex", CLASSIFY_MODEL: "classify", CLASSIFY_EFFORT: "high",
      GENERATE_MODEL: "generate", GENERATE_EFFORT: "low", IMAGE_MODEL: "image", CODEX_HOME: "/tmp/codex",
      ELEVENLABS_MODEL: "model", ELEVENLABS_VOICE_ID: "voice",
    };
    const config = captureAppConfig({ env, argv: [] });
    for (const [key, value] of Object.entries(env)) {
      expect(Redacted.value(config.legacyEnvironment[key]!)).toBe(value);
    }
    expect(Redacted.value(config.runtime.readyToken)).toBe("");
    expect(materializeLegacyEnvironment(config)).toMatchObject(env);
  });

  it("uses exact registration and secure-cookie rules without eager provider validation", () => {
    expect(captureAppConfig({ env: { REGISTRATION_ENABLED: "true" } }).registration.enabled).toBe(true);
    expect(captureAppConfig({ env: { REGISTRATION_ENABLED: "TRUE" } }).registration.enabled).toBe(false);
    expect(captureAppConfig({ env: { NODE_ENV: "production" } }).auth.useSecureCookies).toBe(true);
    expect(captureAppConfig({ env: { BETTER_AUTH_URL: "https://example.test" } }).auth.useSecureCookies).toBe(true);
    expect(captureAppConfig({ env: { BETTER_AUTH_URL: "http://example.test" } }).auth.useSecureCookies).toBe(false);
    expect(captureAppConfig({ env: { BETTER_AUTH_URL: "" } }).auth.useSecureCookies).toBe(false);
    expect(captureAppConfig({ env: { AI_PROVIDER: "unknown", OPENROUTER_API_KEY: "" } }).ai.selected).toBe("unknown");
  });

  it("is deeply frozen and stable after source objects change", () => {
    const env: NodeJS.ProcessEnv = { HOST: "before", CLASSIFY_MODEL: "before" };
    const argv = ["--devtools"];
    const config = captureAppConfig({ env, argv });
    env.HOST = "after";
    env.CLASSIFY_MODEL = "after";
    argv[0] = "--other";
    expect(config.server.hostname).toBe("before");
    expect(config.ai.codex.classifyModel).toBe("before");
    expect(config.runtime.devtoolsEnabled).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.browser.origins)).toBe(true);
    expect(() => (config as { server: { hostname: string } }).server.hostname = "mutated").toThrow();
  });

  it("maps direct parser failure to InfrastructureFailure in its Layer", async () => {
    const runtime = makeTestRuntime(makeAppConfigLayer({ env: { PORT: "bad" }, argv: [] }));
    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      return yield* AppConfig;
    }));
    await runtime.dispose();
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(failure).toBeInstanceOf(InfrastructureFailure);
      expect(failure).toMatchObject({ operation: "config.capture", message: "PORT must be an integer between 1 and 65535" });
    }
  });

  it("acquires AppConfig once and reuses the same frozen object", async () => {
    const runtime = makeTestRuntime(makeAppConfigLayer({ env: { HOST: "one" }, argv: [] }));
    const read = Effect.gen(function* () { return yield* AppConfig; });
    const first = await runtime.runPromise(read);
    const second = await runtime.runPromise(read);
    expect(second).toBe(first);
    await runtime.dispose();
  });
});
```

- [ ] **Step 2: Run the focused test to verify the missing owned module fails**

Run:

```bash
bun run --cwd apps/server vitest run effect/config.test.ts
```

Expected: FAIL because `effect/config.ts` does not exist. Use the current path helpers and parser tests as the compatibility oracle; do not weaken the exact error or raw-value assertions.

- [ ] **Step 3: Implement the exact AppConfig value and parser**

Create `apps/server/effect/config.ts`. Keep this module free of provider/media implementation imports. The public declarations are:

```ts
import { Context, Effect, Layer } from "effect";
import * as Redacted from "effect/Redacted";
import { resolveRuntimePath, resolveDatabaseUrl } from "../runtime-paths.ts";
import { InfrastructureFailure } from "./errors.ts";

export type AppConfigValue = Readonly<{
  server: Readonly<{ hostname: string; port: number }>;
  browser: Readonly<{ corsOrigin: string; origins: readonly string[] }>;
  registration: Readonly<{ enabled: boolean }>;
  database: Readonly<{ url: string }>;
  media: Readonly<{ imagesDir: string; audioDir: string }>;
  auth: Readonly<{ baseURL: string; secret: Redacted.Redacted<string>; useSecureCookies: boolean }>;
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
  elevenLabs: Readonly<{ apiKey: Redacted.Redacted<string>; model: string; voiceId: string }>;
  runtime: Readonly<{ nodeEnv: string | undefined; devtoolsEnabled: boolean; readyToken: Redacted.Redacted<string> }>;
  legacyEnvironment: Readonly<Record<string, Redacted.Redacted<string> | undefined>>;
}>;

export class AppConfig extends Context.Tag("@mnimi/server/AppConfig")<AppConfig, AppConfigValue>() {}
```

`captureAppConfig` must copy `input.env ?? process.env` and `input.argv ?? process.argv.slice(2)` before parsing. Apply the exact digit-only/safe-integer/1..65535 port checks and error text; preserve raw strings; split/trim/filter CORS origins; use exact registration and secure-cookie expressions; resolve database/media paths with the existing helpers; reproduce `resolveCodexHome`’s `undefined` → `resolveRuntimePath("./data/codex")`, empty → `""`, non-empty → `resolveRuntimePath(value)` branch locally; copy every environment value into a Redacted compatibility record; and never call provider validation. Recursively freeze the returned object, arrays, and nested plain objects. `materializeLegacyEnvironment` alone may call `Redacted.value` to make a short-lived `ProcessEnv` copy.

`makeAppConfigLayer` must snapshot supplied `env`/`argv` at layer-construction time, acquire once with `Layer.effect(AppConfig, Effect.try({ try: () => captureAppConfig(snapshot), catch: (cause) => new InfrastructureFailure({ operation: "config.capture", message: cause instanceof Error ? cause.message : String(cause), cause }) }))`, and keep the Layer error type `InfrastructureFailure`. `AppConfigLive` is `makeAppConfigLayer()` with default inputs.

- [ ] **Step 4: Make direct `serverOptions` delegate to the shared parser**

In `apps/server/app.ts`, remove the duplicate numeric checks and retain the export with its existing parameter shape:

```ts
import { captureAppConfig } from "./effect/config.ts";

export function serverOptions(env: Record<string, string | undefined>) {
  return captureAppConfig({ env }).server;
}
```

Do not change `createApp`, its CORS middleware, route registration, request context, or handler behavior. The direct parser still throws the exact current text and the CLI validation script still imports `serverOptions`.

- [ ] **Step 5: Export the new config module and run its focused gate**

Do not edit `apps/server/effect/index.ts` in this task; Task 7 adds all owned-module exports atomically while retaining the existing foundation exports.

Run:

```bash
bun run --cwd apps/server vitest run effect/config.test.ts app.test.ts runtime-paths.test.ts
bun run server:check
git diff --check
```

Expected: config and existing app/path tests PASS, `server:check` PASS, and no whitespace errors. If the repository root is not the worktree path shown in the test fixture, assert paths with `repositoryRoot` from `runtime-paths.ts` rather than hard-coding a filesystem path.

- [ ] **Step 6: Commit the parser and snapshot boundary**

```bash
git add apps/server/effect/config.ts apps/server/effect/config.test.ts apps/server/app.ts
git commit -m "feat(server): capture immutable AppConfig"
```

---


### Task 2: Own canonical LogTape configuration and guard the compatibility shim

**Files:**

- Create: `apps/server/effect/logging.ts`
- Create: `apps/server/effect/logging.test.ts`
- Modify: `apps/server/logging.ts:1-19`

**Interfaces:**

- Consumes: `AppConfig`, LogTape `Logger`, `Sink`, and `LogRecord` types, plus the current synchronous routing in `apps/server/logging.ts`.
- Produces: `LoggingService`, `Logging`, `makeSanitizingSink`, and `LoggingLive`; old `logging.ts` remains a guarded `getLogger` shim.

- [ ] **Step 1: Write the failing sink and derived-logger tests**

Create `apps/server/effect/logging.test.ts` using LogTape's public `configureSync`, `getLogger`, `getConfig`, and `resetSync` APIs. `Logger` is an interface, so never construct it with `new`; configure one recording sink globally and reset it in `afterEach`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Redacted from "effect/Redacted";
import {
  configureSync, getConfig, getLogger, resetSync,
  type LogLevel, type LogRecord,
} from "@logtape/logtape";
import { makeSanitizingSink, Logging, LoggingLive } from "./logging.ts";

const records: LogRecord[] = [];
const recordSink = (record: LogRecord) => { records.push(record); };

beforeEach(() => {
  records.length = 0;
  resetSync();
  configureSync({ reset: true, recording: makeSanitizingSink(recordSink) });
});
afterEach(() => { resetSync(); });

it("sanitizes category, level, message, properties, and preserves metadata", () => {
  const input: LogRecord = {
    category: ["mnimi", Redacted.make("secret-category") as unknown as string],
    level: Redacted.make("secret-level") as unknown as LogLevel,
    message: ["token=", Redacted.make("secret"), { nested: [Redacted.make("inner")] }],
    rawMessage: "token={token}", timestamp: 123,
    properties: { authorization: Redacted.make("header"), nested: { key: Redacted.make("value") } },
  };
  makeSanitizingSink(recordSink)(input);
  expect(records[0].category).toEqual(["mnimi", "<redacted>"]);
  expect(records[0].level).toBe("<redacted>" as unknown as LogLevel);
  expect(records[0].message).toEqual(["token=", "<redacted>", { nested: ["<redacted>"] }]);
  expect(records[0].properties).toEqual({ authorization: "<redacted>", nested: { key: "<redacted>" } });
  expect(records[0].rawMessage).toBe(input.rawMessage);
  expect(records[0].timestamp).toBe(123);
});

it("sanitizes direct, child, and context logger records through one sink", () => {
  const logger = getLogger(["mnimi"]);
  logger.info("direct", { secret: Redacted.make("direct-secret") });
  logger.getChild("child").warning("child", { secret: Redacted.make("child-secret") });
  logger.with({ secret: Redacted.make("context-secret") }).error("context");
  expect(records).toHaveLength(3);
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain("direct-secret");
  expect(serialized).not.toContain("child-secret");
  expect(serialized).not.toContain("context-secret");
  expect(records.every((record) => record.properties?.secret === "<redacted>")).toBe(true);
});

it("does not reset active config when the guarded shim loads", async () => {
  const before = getConfig();
  vi.resetModules();
  await import("../logging.ts");
  expect(getConfig()).toBe(before);
});
```

Add primitive passthrough and one successful `LoggingLive` acquisition/release test. The shim test has no query-string import; `vi.resetModules()` plus a dynamic import is the Vitest-safe isolation boundary.

- [ ] **Step 2: Run the missing-module test**

```bash
bun run --cwd apps/server vitest run effect/logging.test.ts
```

Expected: FAIL because `effect/logging.ts` does not exist.

- [ ] **Step 3: Implement recursive redaction and the scoped LogTape Layer**

Implement `sanitize(value)` as `Redacted.isRedacted(value) ? "<redacted>"`, array mapping, plain-object enumerable copying, and primitive passthrough. `makeSanitizingSink(delegate)` forwards `{ ...record, category, level, message, properties }` with all four fields sanitized while preserving `rawMessage` and `timestamp`. Because LogTape types `level` as `LogLevel`, assign `level: sanitize(record.level) as LogRecord["level"]` after sanitization. Define:

```ts
export type LoggingService = Readonly<{ getLogger(category: readonly string[]): Logger }>;
export class Logging extends Context.Tag("@mnimi/server/Logging")<Logging, LoggingService>() {}
export function makeSanitizingSink(delegate: Sink): Sink;
export const LoggingLive: Layer.Layer<Logging, InfrastructureFailure, AppConfig>;
```

`LoggingLive` yields `AppConfig`, configures `{ reset: true, sinks: { console: makeSanitizingSink(getConsoleSink()) }, loggers: [{ category: ["mnimi"], sinks: ["console"], lowestLevel: "warning" }, { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "error" }] }`, and registers a release only after successful `configureSync`. The release calls `resetSync()` and dies with `InfrastructureFailure({ operation: "logging.reset", message, cause })` if reset throws. Configure failures are typed `InfrastructureFailure({ operation: "logging.configure", message, cause })`.

- [ ] **Step 4: Replace the old unconditional initializer with the guarded shim**

Modify `apps/server/logging.ts`:

```ts
import { configureSync, getConfig, getConsoleSink, getLogger } from "@logtape/logtape";
import { makeSanitizingSink } from "./effect/logging.ts";

if (getConfig() === null) {
  configureSync({
    reset: true,
    sinks: { console: makeSanitizingSink(getConsoleSink()) },
    loggers: [
      { category: ["mnimi"], sinks: ["console"], lowestLevel: "warning" },
      { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "error" },
    ],
  });
}
export { getLogger };
```

The shim never calls `resetSync`, does not instantiate `LoggingLive`, and cannot replace an active runtime configuration.

- [ ] **Step 5: Run logging gates and commit**

```bash
bun run --cwd apps/server vitest run effect/logging.test.ts logging.test.ts
bun run server:check
git diff --check
git add apps/server/effect/logging.ts apps/server/effect/logging.test.ts apps/server/logging.ts
git commit -m "feat(server): own sanitized LogTape service"
```

Expected: canonical/shim imports share one config, direct/child/context loggers redact recursively, and all existing compatibility logging tests pass.

---


### Task 3: Add the pure FIFO write-lock and scoped compatibility installation

**Files:**

- Modify: `apps/server/db/write-lock.ts`
- Modify: `apps/server/db/write-lock.test.ts`

**Interfaces:**

- Consumes: the existing Promise callback API and its FIFO/recovery characterization.
- Produces: `WriteLock`, `createWriteLock`, `installWriteLock`, and `withWriteLock`. This task does not import Effect or edit any Database module; Task 4 consumes these functions.

- [ ] **Step 1: Write RED tests for closure and identity-protected installation**

Extend `apps/server/db/write-lock.test.ts` without removing the current FIFO, rejection recovery, and callback-error tests:

```ts
it("closes once, fences new work, and waits for admitted work", async () => {
  const lock = createWriteLock();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const admitted = lock.withWriteLock(async () => held);
  await Promise.resolve();
  const closing = lock.close();
  await expect(lock.withWriteLock(async () => undefined)).rejects.toThrow(
    "database write lock is closing",
  );
  let settled = false;
  void closing.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await admitted;
  await closing;
  await expect(lock.close()).resolves.toBeUndefined();
});

it("restores inner to outer to fallback after normal top cleanup", async () => {
  const calls: string[] = [];
  const lock = (name: string): WriteLock => ({
    withWriteLock: async (work) => {
      calls.push(`${name}.delegate`);
      return work();
    },
    close: async () => undefined,
  });
  const outer = installWriteLock(lock("outer"));
  const inner = installWriteLock(lock("inner"));

  await withWriteLock(async () => undefined); // inner
  await inner();                              // normal top cleanup
  await withWriteLock(async () => undefined); // outer
  await outer();                              // normal top cleanup
  await withWriteLock(async () => {
    calls.push("fallback.delegate");
  });
  expect(calls).toEqual([
    "inner.delegate",
    "outer.delegate",
    "fallback.delegate",
  ]);
});

it("keeps inner current after stale outer cleanup and does not resurrect it", async () => {
  const calls: string[] = [];
  const lock = (name: string): WriteLock => ({
    withWriteLock: async (work) => {
      calls.push(`${name}.delegate`);
      return work();
    },
    close: async () => undefined,
  });
  const outer = installWriteLock(lock("outer"));
  const inner = installWriteLock(lock("inner"));

  await outer();                              // stale; inner remains current
  await withWriteLock(async () => undefined); // must be inner
  await inner();                              // top cleanup -> fallback
  await withWriteLock(async () => {
    calls.push("fallback.delegate");
  });
  await outer();                              // repeated stale cleanup is idempotent
  await inner();                              // repeated top cleanup is idempotent
  await withWriteLock(async () => {
    calls.push("fallback-again.delegate");
  });

  expect(calls).toEqual([
    "inner.delegate",
    "fallback.delegate",
    "fallback-again.delegate",
  ]);
});
```

- [ ] **Step 2: Run the focused RED gate**

```bash
bun run --cwd apps/server vitest run db/write-lock.test.ts
```

Expected: FAIL because the scoped lock exports are absent.

- [ ] **Step 3: Implement the pure lock and matching installation record**

Refactor `apps/server/db/write-lock.ts` around this exact shape:

```ts
export type WriteLock = Readonly<{
  withWriteLock<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

export function createWriteLock(): WriteLock {
  let tail: Promise<unknown> = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  return {
    withWriteLock<T>(work) {
      if (closing) return Promise.reject(new Error("database write lock is closing"));
      const result = tail.then(work);
      tail = result.catch(() => {});
      return result;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      const capturedTail = tail;
      closePromise = capturedTail.then(() => undefined);
      return closePromise;
    },
  };
}

const fallback = createWriteLock();
type Installation = { readonly lock: WriteLock; active: boolean };
const installations: Installation[] = [];

export function installWriteLock(lock: WriteLock): () => Promise<void> {
  const installation: Installation = { lock, active: true };
  installations.push(installation);
  return async () => {
    if (!installation.active) return;
    installation.active = false;
    const current = installations.at(-1);
    if (current !== installation) return;
    installations.pop();
    while (installations.length && !installations.at(-1)!.active) installations.pop();
  };
}

export function withWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const current = installations.findLast((entry) => entry.active)?.lock ?? fallback;
  return current.withWriteLock(work);
}
```

The matching record, not `WriteLock.close`, owns delegate removal/restoration. The tests cover both normal LIFO cleanup (inner → outer → fallback) and stale outer cleanup while inner remains current. A stale outer remover marks only itself inactive; it cannot pop a newer inner record. Only the current inner cleanup removes that top record and inactive predecessor, and repeated cleanup cannot resurrect either installation. The nearest active predecessor becomes current after removing the top record. Preserve all existing SQLite comments and fallback behavior.

- [ ] **Step 4: Add the lock-level review gate and commit**

```bash
bun run --cwd apps/server vitest run db/write-lock.test.ts
bun run server:check
git diff --check
git add apps/server/db/write-lock.ts apps/server/db/write-lock.test.ts
git commit -m "feat(server): add scoped write lock"
```

Expected: FIFO admission, rejection recovery, close fencing, admitted-work draining, stale-release protection, and idempotent cleanup all pass.


### Task 4: Own the scoped Database over the write-lock seam

**Files:**

- Create: `apps/server/effect/database.ts`
- Create: `apps/server/effect/database.test.ts`

**Interfaces:**

- Consumes: `AppConfig`, `Logging`, `WriteLock`, `Db`, `ReadDb`, `drizzle`, the existing schema, and current `withReadTransaction` semantics. Runtime imports of `db/index.ts` are forbidden; only `import type { Db } from "../db/index.ts"` is allowed.
- Produces: `DatabaseService`, `Database`, `DatabaseLayerDependencies`, `makeDatabaseLayer`, and `DatabaseLive`. Task 3 exclusively owns the lock implementation.

- [ ] **Step 1: Write the Database Layer contract with a fake client seam**

Create `apps/server/effect/database.test.ts`. Its fake client must record `execute` order, expose `transaction("read")`, `commit`, `close`, and a Drizzle-compatible client. Provide a test `Logging` service. Start with these assertions:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
import { AppConfig, makeAppConfigLayer } from "./config.ts";
import { Database, makeDatabaseLayer } from "./database.ts";
import { DatabaseFailure } from "./errors.ts";
import { Logging } from "./logging.ts";
import { makeTestRuntime, testService } from "./testing.ts";

const logging = testService(Logging, { getLogger: () => ({ error() {} }) as never });
const config = makeAppConfigLayer({ env: { DATABASE_URL: "file::memory:" }, argv: [] });
const fakeClient = { execute: async () => ({ rows: [] }), transaction: async () => ({ commit: async () => {}, rollback: async () => {} }), close: () => {} };

function makeDatabaseTestRuntime(onClientClose: () => void = () => {}) {
  const layer = makeDatabaseLayer({
    createClient: () => ({ ...fakeClient, close: onClientClose }) as never,
    ensureDatabaseDir: () => {},
  }).pipe(Layer.provide(Layer.mergeAll(config, logging)));
  return makeTestRuntime(layer);
}

it("acquires one client and Drizzle handle in exact order and closes once", async () => {
  const events: string[] = [];
  const client = {
    execute: async (statement: string) => { events.push(statement); return { rows: [] }; },
    transaction: async () => { throw new Error("not a read test"); },
    close: () => { events.push("close"); },
  };
  const runtime = makeTestRuntime(makeDatabaseLayer({
    createClient: () => { events.push("client"); return client as never; },
    ensureDatabaseDir: (url) => { events.push(`dir:${url}`); },
  }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
  const service = await runtime.runPromise(Effect.gen(function* () { return yield* Database; }));
  expect(service.client).toBe(client);
  expect(events.slice(0, 5)).toEqual([
    "dir:file::memory:", "client", "PRAGMA journal_mode = WAL",
    "PRAGMA busy_timeout = 5000", "PRAGMA foreign_keys = ON",
  ]);
  await runtime.dispose();
  expect(events.at(-1)).toBe("close");
  expect(events.filter((event) => event === "close")).toHaveLength(1);
});

it("closes the client when the first PRAGMA rejects before lock installation", async () => {
  vi.resetModules();
  const events: string[] = [];
  const createWriteLock = vi.fn(() => ({
    withWriteLock: async (work: () => Promise<unknown>) => work(),
    close: async () => undefined,
  }));
  const installWriteLock = vi.fn(() => async () => undefined);
  vi.doMock("../db/write-lock.ts", () => ({ createWriteLock, installWriteLock }));

  const { makeAppConfigLayer: makeDynamicConfigLayer } = await import("./config.ts");
  const { DatabaseFailure: DynamicDatabaseFailure } = await import("./errors.ts");
  const { Logging: DynamicLogging } = await import("./logging.ts");
  const {
    Database: DynamicDatabase,
    makeDatabaseLayer: makeDynamicDatabaseLayer,
  } = await import("./database.ts");
  const pragmaError = new Error("journal mode failed");
  const client = {
    execute: vi.fn(async (statement: string) => { events.push(statement); throw pragmaError; }),
    transaction: vi.fn(),
    close: vi.fn(async () => { events.push("client.close"); }),
  };
  const runtime = makeTestRuntime(makeDynamicDatabaseLayer({
    createClient: () => { events.push("client.create"); return client as never; },
    ensureDatabaseDir: () => {},
  }).pipe(Layer.provide(Layer.mergeAll(
    makeDynamicConfigLayer({ env: { DATABASE_URL: "file::memory:" }, argv: [] }),
    Layer.succeed(DynamicLogging, { getLogger: () => ({ error() {} }) as never }),
  ))));
  const exit = await runtime.runPromiseExit(Effect.gen(function* () {
    return yield* DynamicDatabase;
  }));

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
    const failure = exit.cause.error as DatabaseFailure;
    expect(failure).toBeInstanceOf(DynamicDatabaseFailure);
    expect(failure.operation).toBe("database.acquire");
    expect(failure.cause).toBe(pragmaError);
  }
  expect(client.close).toHaveBeenCalledTimes(1);
  expect(createWriteLock).not.toHaveBeenCalled();
  expect(installWriteLock).not.toHaveBeenCalled();
  expect(events).toEqual(["client.create", "PRAGMA journal_mode = WAL", "client.close"]);
  await runtime.dispose();
});
```

The following coverage is required before implementation: successful callback commits then closes; callback failure closes without commit and preserves the callback’s raw `E`; commit failure closes and returns `DatabaseFailure` with operation `read.test` and `.cause` equal to the original commit `Error`. Each transaction double asserts mode `read`, commit order, and one close. The first-PRAGMA test above proves the client finalizer is registered before any PRAGMA, that the Database Layer failure is `DatabaseFailure({ operation: "database.acquire", cause: pragmaError })` with the original cause identity, that the client closes exactly once, and that no lock is installed when that PRAGMA rejects. The same injected Database coverage exercises FIFO/rejection, nested-lock failure, queue close-fence, the Better Auth-outside-queue boundary, interrupted waiters and in-flight writes, and queue/client finalizer defects. Use `createTestDb` only for direct compatibility tests.

Use these explicit RED bodies for the three read outcomes. The helper creates the transaction double inside each test and returns the managed read result:

```ts
async function runReadCase(callback: Effect.Effect<unknown, Error>, commit: () => Promise<void>) {
  const events: string[] = [];
  const tx = {
    execute: vi.fn(), commit: vi.fn(async () => { events.push("commit"); await commit(); }),
    rollback: vi.fn(), close: vi.fn(async () => { events.push("close"); }),
  };
  const client = {
    execute: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async (mode: "read") => { events.push(mode); return tx; }),
    close: vi.fn(),
  };
  const layer = makeDatabaseLayer({
    createClient: () => client as never,
    ensureDatabaseDir: () => {},
  }).pipe(Layer.provide(Layer.mergeAll(config, logging)));
  const runtime = makeTestRuntime(layer);
  const exit = await runtime.runPromiseExit(Effect.gen(function* () {
    const database = yield* Database;
    return yield* database.readSnapshot("read.test", () => callback);
  }));
  await runtime.dispose();
  return { exit, events, tx };
}

it("commits a successful read before closing", async () => {
  const result = await runReadCase(Effect.succeed("ok"), async () => undefined);
  expect(Exit.isSuccess(result.exit)).toBe(true);
  expect(result.events).toEqual(["read", "commit", "close"]);
  expect(result.tx.rollback).not.toHaveBeenCalled();
});

it("closes a callback failure without committing and preserves it", async () => {
  const error = new Error("callback failed");
  const result = await runReadCase(Effect.fail(error), async () => undefined);
  expect(Exit.isFailure(result.exit) && result.exit.cause._tag === "Fail" && result.exit.cause.error).toBe(error);
  expect(result.events).toEqual(["read", "close"]);
  expect(result.tx.commit).not.toHaveBeenCalled();
});

it("closes a commit failure and preserves the commit error", async () => {
  const error = new Error("commit failed");
  const result = await runReadCase(Effect.succeed("ok"), async () => { throw error; });
  expect(Exit.isFailure(result.exit)).toBe(true);
  if (Exit.isFailure(result.exit) && result.exit.cause._tag === "Fail") {
    const failure = result.exit.cause.error as DatabaseFailure;
    expect(failure).toBeInstanceOf(DatabaseFailure);
    expect(failure.operation).toBe("read.test");
    expect(failure.cause).toBe(error);
  }
  expect(result.events).toEqual(["read", "commit", "close"]);
});

it("interrupts a readSnapshot only after its transaction closes", async () => {
  const events: string[] = [];
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const tx = {
    commit: vi.fn(async () => { events.push("commit"); }),
    rollback: vi.fn(), close: vi.fn(async () => { events.push("close"); }),
  };
  const client = {
    execute: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async (mode: "read") => { events.push(mode); return tx; }),
    close: vi.fn(),
  };
  const runtime = makeTestRuntime(makeDatabaseLayer({
    createClient: () => client as never, ensureDatabaseDir: () => {},
  }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
  const fiber = runtime.runFork(Effect.gen(function* () {
    const database = yield* Database;
    return yield* database.readSnapshot("read.interrupted", () => Effect.promise(() => {
      started.resolve();
      return gate.promise;
    }));
  }));
  await started.promise;
  const interrupted = runtime.runPromise(Fiber.interrupt(fiber));
  let settled = false;
  void interrupted.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(tx.close).not.toHaveBeenCalled();
  gate.resolve();
  await interrupted;
  const exit = await runtime.runPromise(Fiber.await(fiber));
  expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
  expect(events).toEqual(["read", "close"]);
  expect(tx.commit).not.toHaveBeenCalled();
  await runtime.dispose();
});
```

Use these concrete queue and non-reentrancy bodies against the same managed runtime:

```ts
it("serializes FIFO writes and rejects a nested acquisition", async () => {
  const runtime = makeDatabaseTestRuntime();
  const order: string[] = [];
  const first = runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database;
    return yield* database.withWriteLock("first", Effect.promise(async () => {
      order.push("first"); await Promise.resolve();
    }));
  }));
  const second = runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database;
    return yield* database.withWriteLock("second", Effect.sync(() => { order.push("second"); }));
  }));
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "second"]);
  const nested = await runtime.runPromiseExit(Effect.gen(function* () {
    const database = yield* Database;
    return yield* database.withWriteLock("outer", database.withWriteLock("inner", Effect.succeed("bad")));
  }));
  expect(Exit.isFailure(nested) && Cause.pretty(nested.cause)).toContain("nested database write lock acquisition");
  await runtime.dispose();
});

it("fences new writes while Database disposal drains the admitted callback", async () => {
  const events: string[] = [];
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const runtime = makeDatabaseTestRuntime(() => { events.push("client.close"); });
  const database = await runtime.runPromise(Effect.gen(function* () { return yield* Database; }));
  const admitted = Effect.runPromise(database.withWriteLock("held", Effect.promise(() => {
    started.resolve();
    return gate.promise;
  })));
  await started.promise;
  const closing = runtime.dispose();
  const late = Effect.runPromise(database.withWriteLock("late", Effect.succeed("not admitted")));
  await expect(late).rejects.toMatchObject({
    operation: "late", cause: expect.objectContaining({ message: "database write lock is closing" }),
  });
  expect(events).toEqual([]);
  gate.resolve();
  await admitted;
  await closing;
  expect(events).toEqual(["client.close"]);
});
```


Use the managed runtime's real fork/interruption API. `runFork` returns a fiber whose promise-backed callback remains admitted until the gate releases; interrupting the waiter must not make the queue's own promise callback settle early. Await the interrupted fiber only after releasing the gate, then inspect its `Exit`:

```ts
it("settles an interrupted waiter only after the admitted callback releases", async () => {
  const gate = Promise.withResolvers<void>();
  const admittedStarted = Promise.withResolvers<void>();
  const runtime = makeDatabaseTestRuntime();
  const admittedFiber = runtime.runFork(Effect.gen(function* () {
    const database = yield* Database;
    return yield* database.withWriteLock("held", Effect.promise(() => {
      admittedStarted.resolve();
      return gate.promise;
    }));
  }));
  await admittedStarted.promise;
  const waiterFiber = runtime.runFork(Effect.gen(function* () {
    const database = yield* Database;
    return yield* database.withWriteLock("waiter", Effect.succeed("done"));
  }));
  const interrupted = runtime.runPromise(Fiber.interrupt(waiterFiber));
  let settled = false;
  void interrupted.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.resolve();
  await runtime.runPromise(Fiber.interrupt(admittedFiber));
  await interrupted;
  const exit = await runtime.runPromise(Fiber.await(waiterFiber));
  expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
  await runtime.dispose();
});

it("interrupts an in-flight libSQL write but still closes its queue slot", async () => {
  const gate = Promise.withResolvers<void>();
  const runningStarted = Promise.withResolvers<void>();
  const runtime = makeDatabaseTestRuntime();
  const runningFiber = runtime.runFork(Effect.gen(function* () {
    const database = yield* Database;
    return yield* database.withWriteLock("write", Effect.promise(() => {
      runningStarted.resolve();
      return gate.promise;
    }));
  }));
  await runningStarted.promise;
  const running = runtime.runPromise(Fiber.interrupt(runningFiber));
  let settled = false;
  void running.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.resolve();
  await running;
  const exit = await runtime.runPromise(Fiber.await(runningFiber));
  expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
  await runtime.dispose();
});

it("reports a tagged queue-close defect and still closes the client", async () => {
  vi.resetModules();
  vi.doMock("../db/write-lock.ts", async () => {
    const actual = await vi.importActual<typeof import("../db/write-lock.ts")>("../db/write-lock.ts");
    return { ...actual, createWriteLock: () => ({
      withWriteLock: (work: () => Promise<unknown>) => work(),
      close: async () => { throw new Error("queue close failed"); },
    }) };
  });
  const { makeAppConfigLayer: makeDynamicConfigLayer } = await import("./config.ts");
  const { Logging: DynamicLogging } = await import("./logging.ts");
  const { makeDatabaseLayer: makeDynamicDatabaseLayer, Database: DynamicDatabase } = await import("./database.ts");
  const events: string[] = [];
  const runtime = makeTestRuntime(makeDynamicDatabaseLayer({
    createClient: () => ({ ...fakeClient, close: () => { events.push("client.close"); } }) as never,
    ensureDatabaseDir: () => {},
  }).pipe(Layer.provide(Layer.mergeAll(
    makeDynamicConfigLayer({ env: { DATABASE_URL: "file::memory:" }, argv: [] }),
    Layer.succeed(DynamicLogging, { getLogger: () => ({ error() {} }) as never }),
  ))));
  await runtime.runPromise(Effect.gen(function* () { return yield* DynamicDatabase; }));
  const exit = await Effect.runPromiseExit(runtime.disposeEffect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect([...Cause.defects(exit.cause)]).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "database.close", cause: expect.any(Error) }),
    ]));
  }
  expect(events).toEqual(["client.close"]);
});

it("retains tagged client-close and queue-close defects together", async () => {
  vi.resetModules();
  vi.doMock("../db/write-lock.ts", () => ({
    createWriteLock: () => ({
      withWriteLock: (work: () => Promise<unknown>) => work(),
      close: async () => { throw new Error("queue close failed"); },
    }),
    installWriteLock: () => async () => undefined,
  }));
  const { makeAppConfigLayer: makeDynamicConfigLayer } = await import("./config.ts");
  const { Logging: DynamicLogging } = await import("./logging.ts");
  const { makeDatabaseLayer: makeDynamicDatabaseLayer, Database: DynamicDatabase } = await import("./database.ts");
  const runtime = makeTestRuntime(makeDynamicDatabaseLayer({
    createClient: () => ({ ...fakeClient, close: async () => { throw new Error("client close failed"); } }) as never,
    ensureDatabaseDir: () => {},
  }).pipe(Layer.provide(Layer.mergeAll(
    makeDynamicConfigLayer({ env: { DATABASE_URL: "file::memory:" }, argv: [] }),
    Layer.succeed(DynamicLogging, { getLogger: () => ({ error() {} }) as never }),
  ))));
  await runtime.runPromise(Effect.gen(function* () { return yield* DynamicDatabase; }));
  const exit = await Effect.runPromiseExit(runtime.disposeEffect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const defects = [...Cause.defects(exit.cause)];
    expect(defects).toHaveLength(1);
    expect(defects[0]).toBeInstanceOf(AggregateError);
    expect((defects[0] as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "database.close", cause: expect.objectContaining({ message: "queue close failed" }) }),
      expect.objectContaining({ operation: "database.close", cause: expect.objectContaining({ message: "client close failed" }) }),
    ]));
  }
});
```


- [ ] **Step 2: Run the new database tests to verify the missing Layer**

Run:

```bash
bun run --cwd apps/server vitest run effect/database.test.ts
```

Expected: FAIL because `effect/database.ts` does not yet exist; Task 2 has already supplied the `Logging` tag.

- [ ] **Step 3: Implement `DatabaseService` and ordered scoped acquisition**

Create `apps/server/effect/database.ts` with these exact public declarations:

```ts
import { Context, Effect, Layer } from "effect";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../db/schema.ts";
import { ensureDatabaseDir } from "../db/url.ts";
import type { Db } from "../db/index.ts";
import type { ReadDb } from "../db/read-transaction.ts";
import { AppConfig } from "./config.ts";
import { DatabaseFailure } from "./errors.ts";
import { Logging } from "./logging.ts";
import { createWriteLock, installWriteLock, type WriteLock } from "../db/write-lock.ts";

export type DatabaseService = Readonly<{
  client: Client;
  db: Db;
  withWriteLock<A, E, R>(operation: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseFailure, R>;
  transaction<A, E, R>(operation: string, work: (tx: Db) => Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseFailure, R>;
  readSnapshot<A, E, R>(operation: string, read: (tx: ReadDb) => Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseFailure, R>;
}>;

export class Database extends Context.Tag("@mnimi/server/Database")<Database, DatabaseService>() {}

export type DatabaseLayerDependencies = Readonly<{
  createClient: (options: { url: string }) => Client;
  ensureDatabaseDir: (url: string) => void;
}>;

export function makeDatabaseLayer(dependencies?: Partial<DatabaseLayerDependencies>): Layer.Layer<Database, DatabaseFailure, AppConfig | Logging>;
export const DatabaseLive: Layer.Layer<Database, DatabaseFailure, AppConfig | Logging>;
```

Inside `Layer.scoped(Database, Effect.gen(...))`, yield `AppConfig` and `Logging`, resolve `config.database.url`, and call the injected directory function. Create the client with `Effect.try`, then immediately register that client in `Effect.acquireRelease` before the first PRAGMA. The registered resource keeps mutable optional `lock` and `uninstall` fields so a PRAGMA, Drizzle-construction, or lock-installation failure still closes the client even though no lock exists yet. Only after registration, execute the three PRAGMAs sequentially, construct `drizzle({ client, schema })` once, call the private Task 3 `createWriteLock` implementation, install it, and assign both cleanup fields:

```ts
type DatabaseResource = {
  readonly client: Client;
  lock?: WriteLock;
  uninstall?: () => Promise<void>;
};

const releaseDatabase = (resource: DatabaseResource) =>
  Effect.promise(async () => {
    const failures: DatabaseFailure[] = [];
    if (resource.lock) {
      try { await resource.lock.close(); } catch (cause) {
        failures.push(new DatabaseFailure({ operation: "database.close", cause }));
      }
    }
    if (resource.uninstall) {
      try { await resource.uninstall(); } catch (cause) {
        failures.push(new DatabaseFailure({ operation: "database.close", cause }));
      }
    }
    try { await resource.client.close(); } catch (cause) {
      failures.push(new DatabaseFailure({ operation: "database.close", cause }));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Database close failed");
  });

const acquireDatabase = Effect.gen(function* () {
  const config = yield* AppConfig;
  yield* Logging;
  const url = config.database.url;
  yield* Effect.try({
    try: () => dependencies.ensureDatabaseDir(url),
    catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
  });
  const resource = yield* Effect.acquireRelease(
    Effect.try({
      try: (): DatabaseResource => ({ client: dependencies.createClient({ url }) }),
      catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
    }),
    releaseDatabase,
  );
  for (const pragma of [
    "PRAGMA journal_mode = WAL",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA foreign_keys = ON",
  ]) {
    yield* Effect.tryPromise({
      try: () => resource.client.execute(pragma),
      catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
    });
  }
  const db = yield* Effect.try({
    try: () => drizzle({ client: resource.client, schema }),
    catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
  });
  const lock = yield* Effect.try({
    try: () => createWriteLock(),
    catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
  });
  resource.lock = lock;
  const uninstall = yield* Effect.try({
    try: () => installWriteLock(lock),
    catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
  });
  resource.uninstall = uninstall;
  return { client: resource.client, db, lock };
});

const scoped = Layer.scoped(Database, acquireDatabase);
```

The `Effect.promise` release has error type `never`; a single caught queue/uninstall/client close failure becomes a `DatabaseFailure` defect, while multiple failures become one `AggregateError` defect whose `.errors` retain each tagged `DatabaseFailure`. Every available release stage runs in order, including when `lock.close()` rejects, so uninstall and client close cannot be skipped. There is only this one release closure: do not add another client finalizer or close the client anywhere else, because the client must close exactly once. Acquisition failures use `DatabaseFailure({ operation: "database.acquire", cause })` with the original cause, while operation failures use their supplied operation. Keep the `Logging` service available while the Database finalizer runs. Tests replace the private lock module with `vi.doMock` before the dynamic Database import; this test seam is not part of `DatabaseLayerDependencies`.

- [ ] **Step 4: Implement uninterruptible Effect operations and non-reentrant marker**

Use a module-local `FiberRef` whose value is the currently owned `WriteLock | undefined`. Run queue admission, `Runtime.runPromise` of the callback, and bookkeeping inside `Effect.uninterruptible`. If the marker equals this Database’s scoped lock, fail immediately with:

```ts
new DatabaseFailure({
  operation,
  cause: new Error("nested database write lock acquisition"),
})
```

The callback is invoked with only its transaction/operation argument and no `Database` service. An interrupted waiter or in-flight libSQL write must still settle, release its queue slot, then surface the normal Effect interruption. `readSnapshot` opens `service.client.transaction("read")`, builds the existing schema-backed Drizzle read handle, and runs the callback under an uninterruptible region through Promise settlement. Preserve the callback’s `E` exactly as supplied; do not wrap callback failures in `DatabaseFailure`. After a successful callback exit, pass through one interruptible checkpoint immediately before commit so a pending interruption skips commit and is surfaced after close. Once that checkpoint passes, commit through its Promise settlement, and always close in an explicit `finally`; map transaction open, commit, and close boundary rejections to `DatabaseFailure({ operation, cause })`. It does not use the write queue.

Use this typed implementation shape so callback failures and interruption remain in the Effect channel while the Promise queue slot is always released:

```ts
import { Effect, Exit, FiberRef, Runtime } from "effect";

const lockOwner = FiberRef.unsafeMake<WriteLock | undefined>(undefined);

const runQueued = <A, E, R>(
  operation: string,
  lock: WriteLock,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseFailure, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const owner = yield* FiberRef.get(lockOwner);
      if (owner === lock) {
        return yield* Effect.fail(new DatabaseFailure({
          operation,
          cause: new Error("nested database write lock acquisition"),
        }));
      }
      const runInLock = Effect.gen(function* () {
        const runtime = yield* Effect.runtime<R>();
        const exit = yield* Effect.tryPromise({
          try: () => lock.withWriteLock(() => Runtime.runPromiseExit(runtime, restore(work))),
          catch: (cause) => new DatabaseFailure({ operation, cause }),
        });
        return yield* Exit.matchEffect(exit, {
          onFailure: Effect.failCause,
          onSuccess: Effect.succeed,
        });
      });
      return yield* Effect.locally(runInLock, lockOwner, lock);
    }),
  );
```

The implementer must use the repository's typed Runtime runner: obtain the runtime for `R`, run `restore(work)` in `Runtime.runPromiseExit` inside `Effect.tryPromise`, map a rejected lock promise to the operation-tagged `DatabaseFailure`, and convert the returned `Exit` with `Exit.matchEffect(exit, { onFailure: Effect.failCause, onSuccess: Effect.succeed })` so both `E`/Cause and interruption survive without squashing. The outer `uninterruptibleMask` covers queue admission, callback execution, and slot release; `restore` is applied only to the user operation, while `Effect.locally(runInLock, lockOwner, lock)` marks this lock only for the admitted callback. `readSnapshot` uses an explicit `try/finally` around commit/close and never calls `runQueued`.



- [ ] **Step 5: Run database, lock, and type gates**

Leave `apps/server/effect/index.ts` unchanged in this task; Task 7 owns the complete barrel, then run:

```bash
bun run --cwd apps/server vitest run effect/database.test.ts db/schema.test.ts db/migrations.test.ts
bun run server:check
git diff --check
```

Expected: focused database/schema/migration tests PASS, while the lock tests remain green from Task 3; no migration SQL or schema file changes are present.

- [ ] **Step 6: Commit the scoped Database owner**

```bash
git add apps/server/effect/database.ts apps/server/effect/database.test.ts
git commit -m "feat(server): own scoped Database"
```

---


### Task 5: Construct one Auth service over the scoped Database

**Files:**

- Create: `apps/server/effect/auth.ts`
- Create: `apps/server/effect/auth.test.ts`
- Modify: `apps/server/auth.ts:12-58`

**Interfaces:**

- Consumes: `AppConfig` and `Database.db`, plus the existing `createAuth` factory and the `auth.test.ts`/`browser-auth.test.ts` behavior characterized after Tasks 1, 2, and 4.
- Produces: `AuthService`, `Auth`, and `AuthLive`; the service contains exactly `instance: LegacyAuth`.

- [ ] **Step 1: Write the failing Auth Layer contract**

Create `apps/server/effect/auth.test.ts` using the async `createTestDb` fixture and an injected Database service. Import `ManagedRuntime`, `Effect`, and `Layer` from `effect` plus `DatabaseService` from `./database.ts`. Await and destructure the fixture's `{ db, client, close }` result; close it in `finally`. Do not mutate global `process.env`:

```ts
const { adapterOptions, wrapAdapter } = vi.hoisted(() => ({
  adapterOptions: [] as unknown[],
  wrapAdapter: vi.fn(),
}));
vi.mock("better-auth/adapters/drizzle", async (loadOriginal) => {
  const actual = await loadOriginal<typeof import("better-auth/adapters/drizzle")>();
  return {
    ...actual,
    drizzleAdapter: (db, options) => {
      adapterOptions.push(options);
      wrapAdapter(db, options);
      return actual.drizzleAdapter(db, options);
    },
  };
});

async function makeAuthRuntime(env: Record<string, string>) {
  const { db, client, close } = await createTestDb();
  const config = makeAppConfigLayer({ env, argv: [] });
  const database = Layer.succeed(Database, {
    db, client,
    withWriteLock: vi.fn((_operation, work) => work),
    transaction: vi.fn(),
    readSnapshot: vi.fn(),
  } satisfies DatabaseService);
  const runtime = ManagedRuntime.make(AuthLive.pipe(
    Layer.provide(Layer.merge(config, database)),
  ));
  return { runtime, close, database };
}

it("reuses one Auth instance and observes adapter options", async () => {
  const { runtime, close, database } = await makeAuthRuntime({
    BETTER_AUTH_URL: "https://api.example.com",
    REGISTRATION_ENABLED: "true",
  });
  try {
    const first = await runtime.runPromise(Effect.gen(function* () { return yield* Auth; }));
    const second = await runtime.runPromise(Effect.gen(function* () { return yield* Auth; }));
    expect(second.instance).toBe(first.instance);
    expect(adapterOptions[0]).toMatchObject({ provider: "sqlite", transaction: false });
    expect(database.withWriteLock).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
    await close();
  }
});
```

These executable compatibility assertions belong in the same file, reusing the awaited fixture and `finally` cleanup. They deliberately exercise the real Better Auth handler, so the adapter spy and the Database `withWriteLock` spy observe the actual path:

```ts
it("preserves UUIDv7/custom fields and keeps Auth outside the write queue", async () => {
  const { runtime, close, database } = await makeAuthRuntime({
    BETTER_AUTH_URL: "https://api.example.com",
    CORS_ORIGIN: " https://app.example, ,https://other.example ",
    REGISTRATION_ENABLED: "true",
  });
  try {
    const { instance } = await runtime.runPromise(Effect.gen(function* () { return yield* Auth; }));
    const signedUp = await instance.api.signUpEmail({
      body: { email: "ada@example.com", password: "correct-horse", name: "Ada" },
      returnHeaders: true,
    });
    expect(signedUp.response.user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const token = signedUp.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    const bearerHeaders = new Headers({ authorization: `Bearer ${token}` });
    const defaults = await instance.api.getSession({ headers: bearerHeaders });
    expect(defaults?.user).toMatchObject({ nativeLanguage: "en", uiLanguage: "en", ttsAutoplay: true });
    await instance.api.updateUser({
      body: { nativeLanguage: "pl", uiLanguage: "pl", ttsAutoplay: false },
      headers: bearerHeaders,
    });
    expect(await instance.api.getSession({ headers: bearerHeaders })).toMatchObject({
      user: { nativeLanguage: "pl", uiLanguage: "pl", ttsAutoplay: false },
    });
    const native = await instance.handler(new Request("https://api.example.com/api/auth/get-session", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(native.status).toBe(200);
    const browser = await instance.handler(new Request("https://api.example.com/api/auth/sign-in/email", {
      method: "POST",
      headers: { Origin: "https://app.example", "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: "correct-horse" }),
    }));
    expect(browser.status).toBe(200);
    expect(browser.headers.get("set-auth-token")).toBeNull();
    expect(browser.headers.getSetCookie().join(";")).toMatch(/; HttpOnly/i);
    expect(browser.headers.getSetCookie().join(";")).toMatch(/; Secure/i);
    const rejected = await instance.handler(new Request("https://api.example.com/api/auth/sign-in/email", {
      method: "POST",
      headers: { Origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: "correct-horse" }),
    }));
    expect(rejected.status).toBe(403);
    expect(database.withWriteLock).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
    await close();
  }
});

it("enforces the captured registration flag", async () => {
  const { runtime, close } = await makeAuthRuntime({
    BETTER_AUTH_URL: "http://localhost:3000", REGISTRATION_ENABLED: "false",
  });
  try {
    const { instance } = await runtime.runPromise(Effect.gen(function* () { return yield* Auth; }));
    const response = await instance.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "blocked@example.com", password: "correct-horse", name: "Blocked" }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
  } finally {
    await runtime.dispose();
    await close();
  }
});
```

The direct `auth.test.ts` and `browser-auth.test.ts` suites remain compatibility oracles; this new body is the executable proof that trimmed `CORS_ORIGIN` becomes a trusted origin, a native bearer request has no Origin requirement, browser responses are cookie-only and secure, registration is captured once, and Auth does not enter the application queue.

- [ ] **Step 2: Run the focused test before the Auth module exists**

Run:

```bash
bun run --cwd apps/server vitest run effect/auth.test.ts
```

Expected: FAIL because `effect/auth.ts` does not exist.

- [ ] **Step 3: Add the optional secure-cookie input without changing direct callers**

Modify `apps/server/auth.ts` to accept `useSecureCookies?: boolean` and retain the current fallback when omitted:

```ts
options?: {
  secret?: string;
  baseURL?: string;
  trustedOrigins?: string[];
  registrationEnabled?: boolean;
  autoSignIn?: boolean;
  useSecureCookies?: boolean;
}
// ...
useSecureCookies: options?.useSecureCookies ??
  (process.env.NODE_ENV === "production" || baseURL.startsWith("https://")),
```

Leave the adapter schema, `transaction: false`, UUIDv7 generator, custom fields/defaults, bearer plugin, cookie attributes, and registration fallback untouched.

- [ ] **Step 4: Implement `AuthLive` with explicit redacted-secret unwrapping**

Create `apps/server/effect/auth.ts`:

```ts
import { Context, Effect, Layer } from "effect";
import * as Redacted from "effect/Redacted";
import type { Auth as LegacyAuth } from "../auth.ts";
import { createAuth } from "../auth.ts";
import { AppConfig } from "./config.ts";
import { Database } from "./database.ts";
import { InfrastructureFailure } from "./errors.ts";

export type AuthService = Readonly<{ instance: LegacyAuth }>;
export class Auth extends Context.Tag("@mnimi/server/Auth")<Auth, AuthService>() {}

export const AuthLive: Layer.Layer<Auth, InfrastructureFailure, AppConfig | Database> = Layer.scoped(
  Auth,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const database = yield* Database;
    try {
      return {
        instance: createAuth(database.db, {
          secret: Redacted.value(config.auth.secret),
          baseURL: config.auth.baseURL,
          trustedOrigins: [...config.browser.origins],
          registrationEnabled: config.registration.enabled,
          useSecureCookies: config.auth.useSecureCookies,
        }),
      } satisfies AuthService;
    } catch (cause) {
      return yield* Effect.fail(new InfrastructureFailure({
        operation: "auth.construct",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }));
    }
  }),
);
```

Do not put the Auth adapter inside `Database.withWriteLock`; the only secret unwrapping in this module is the explicit Better Auth constructor boundary.

- [ ] **Step 5: Run Auth and compatibility gates**

```bash
bun run --cwd apps/server vitest run effect/auth.test.ts auth.test.ts browser-auth.test.ts
bun run server:check
git diff --check
```

Expected: new Layer tests and existing auth/browser tests PASS with unchanged response bodies, cookies, bearer behavior, registration reporting, and adapter transaction setting.

- [ ] **Step 6: Commit the Auth owner**

```bash
git add apps/server/effect/auth.ts apps/server/effect/auth.test.ts apps/server/auth.ts
git commit -m "feat(server): own scoped Auth instance"
```

---


### Task 6: Compose the ordered core Layer and exact legacy bindings

**Files:**

- Create: `apps/server/effect/live.ts`
- Create: `apps/server/effect/legacy-bindings.ts`
- Create: `apps/server/effect/live.test.ts`
- Create: `apps/server/effect/legacy-bindings.test.ts`

**Interfaces:**

- Consumes: `AppConfigLive`/`makeAppConfigLayer`, `LoggingLive`, `DatabaseLive`, `AuthLive`, and the exact `DatabaseService`/`AuthService` outputs from Tasks 1, 2, 4, and 5.
- Produces: `CoreServices`, `CoreLayerError`, `makeAppLayer`, `LegacyBindings`, and `makeLegacyBindings`.

- [ ] **Step 1: Write executable RED tests for graph order and binding identity**

Create `live.test.ts` with a concrete dynamic-mock seam. Reset modules before each case; each fake is a real `Layer.scoped` with an injected event list and release callback:

```ts
import { Effect, Layer } from "effect";
import { vi } from "vitest";

it("acquires and releases AppConfig, Logging, Database, Auth in order", async () => {
  vi.resetModules();
  const events: string[] = [];
  const fakeLayer = (tag: any, name: string) =>
    Layer.scoped(tag, Effect.acquireRelease(
      Effect.sync(() => { events.push(name + ".acquire"); return {}; }),
      () => Effect.sync(() => { events.push(name + ".release"); }),
    ));
  vi.doMock("./config.ts", async () => {
    const actual = await vi.importActual<typeof import("./config.ts")>("./config.ts");
    return { ...actual, makeAppConfigLayer: () => fakeLayer(actual.AppConfig, "config") };
  });
  vi.doMock("./logging.ts", async () => {
    const actual = await vi.importActual<typeof import("./logging.ts")>("./logging.ts");
    return { ...actual, LoggingLive: fakeLayer(actual.Logging, "logging") };
  });
  vi.doMock("./database.ts", async () => {
    const actual = await vi.importActual<typeof import("./database.ts")>("./database.ts");
    return { ...actual, DatabaseLive: fakeLayer(actual.Database, "database") };
  });
  vi.doMock("./auth.ts", async () => {
    const actual = await vi.importActual<typeof import("./auth.ts")>("./auth.ts");
    return { ...actual, AuthLive: fakeLayer(actual.Auth, "auth") };
  });
  const { makeAppLayer } = await import("./live.ts");
  const { AppConfig } = await import("./config.ts");
  const { Logging } = await import("./logging.ts");
  const { Database } = await import("./database.ts");
  const { Auth } = await import("./auth.ts");
  const runtime = makeTestRuntime(makeAppLayer());
  await runtime.runPromise(Effect.gen(function* () {
    yield* AppConfig; yield* Logging; yield* Database; yield* Auth;
  }));
  await runtime.dispose();
  expect(events).toEqual([
    "config.acquire", "logging.acquire", "database.acquire", "auth.acquire",
    "auth.release", "database.release", "logging.release", "config.release",
  ]);
});

it("keeps Logging available while the Database finalizer runs", async () => {
  vi.resetModules();
  let loggingActive = false;
  let databaseSawLogging = false;
  const scoped = (tag: any, acquire: () => unknown, release: () => void) =>
    Layer.scoped(tag, Effect.acquireRelease(
      Effect.sync(acquire),
      () => Effect.sync(release),
    ));
  vi.doMock("./config.ts", async () => {
    const actual = await vi.importActual<typeof import("./config.ts")>("./config.ts");
    return { ...actual, makeAppConfigLayer: () => scoped(actual.AppConfig, () => ({}), () => {}) };
  });
  vi.doMock("./logging.ts", async () => {
    const actual = await vi.importActual<typeof import("./logging.ts")>("./logging.ts");
    return { ...actual, LoggingLive: scoped(actual.Logging, () => { loggingActive = true; return {}; }, () => { loggingActive = false; }) };
  });
  vi.doMock("./database.ts", async () => {
    const actual = await vi.importActual<typeof import("./database.ts")>("./database.ts");
    return { ...actual, DatabaseLive: scoped(actual.Database, () => ({}), () => { databaseSawLogging = loggingActive; }) };
  });
  vi.doMock("./auth.ts", async () => {
    const actual = await vi.importActual<typeof import("./auth.ts")>("./auth.ts");
    return { ...actual, AuthLive: scoped(actual.Auth, () => ({}), () => {}) };
  });
  const { makeAppLayer } = await import("./live.ts");
  const { AppConfig } = await import("./config.ts");
  const { Logging } = await import("./logging.ts");
  const { Database } = await import("./database.ts");
  const { Auth } = await import("./auth.ts");
  const runtime = makeTestRuntime(makeAppLayer());
  await runtime.runPromise(Effect.gen(function* () {
    yield* AppConfig; yield* Logging; yield* Database; yield* Auth;
  }));
  await runtime.dispose();
  expect(databaseSawLogging).toBe(true);
});
```

The mock functions above own the only event/probe variables, and the `legacy-bindings.test.ts` test asserts `makeLegacyBindings({ db }, { instance })` returns exactly those two objects. No repository singleton is opened and no unbound event injection is referenced.

- [ ] **Step 2: Run the missing graph tests**

```bash
bun run --cwd apps/server vitest run effect/live.test.ts effect/legacy-bindings.test.ts
```

Expected: FAIL because `live.ts` and `legacy-bindings.ts` do not exist.

- [ ] **Step 3: Implement exact legacy bindings**

Create `apps/server/effect/legacy-bindings.ts`:

```ts
import type { Auth as LegacyAuth } from "../auth.ts";
import type { Db } from "../db/index.ts";
import type { DatabaseService } from "./database.ts";
import type { AuthService } from "./auth.ts";

export type LegacyBindings = Readonly<{ db: Db; auth: LegacyAuth }>;
export function makeLegacyBindings(database: DatabaseService, auth: AuthService): LegacyBindings {
  return { db: database.db, auth: auth.instance };
}
```

This module may import only the two type declarations from legacy modules. It must not proxy, rebind, or import singleton values.

- [ ] **Step 4: Implement the sequential `provideMerge` graph**

Create `apps/server/effect/live.ts`:

```ts
import * as Layer from "effect/Layer";
import { AppConfig, makeAppConfigLayer } from "./config.ts";
import { Auth, AuthLive } from "./auth.ts";
import { Database, DatabaseLive } from "./database.ts";
import { InfrastructureFailure, DatabaseFailure } from "./errors.ts";
import { Logging, LoggingLive } from "./logging.ts";

export type CoreServices = AppConfig | Logging | Database | Auth;
export type CoreLayerError = InfrastructureFailure | DatabaseFailure;

export function makeAppLayer(input?: { env?: NodeJS.ProcessEnv; argv?: readonly string[] }): Layer.Layer<CoreServices, CoreLayerError, never> {
  const config = makeAppConfigLayer(input);
  const configAndLogging = Layer.provideMerge(LoggingLive, config);
  const configLoggingDatabase = Layer.provideMerge(DatabaseLive, configAndLogging);
  const core: Layer.Layer<CoreServices, CoreLayerError, never> = Layer.provideMerge(AuthLive, configLoggingDatabase);
  return core;
}
```

The first argument is the target and the second is its provider in Effect 3.22.2’s two-argument form. Do not replace the chain with `Layer.mergeAll` or `Layer.zipWith`, and do not create a Layer per request. Do not edit `effect/index.ts` here; Task 7 owns all new barrel exports so this task has a single owner for that file.

- [ ] **Step 5: Run graph, import, and type gates, then commit**

```bash
bun run --cwd apps/server vitest run effect/live.test.ts effect/legacy-bindings.test.ts import-boundary.test.ts
bun run server:check
git diff --check
git add apps/server/effect/live.ts apps/server/effect/legacy-bindings.ts apps/server/effect/live.test.ts apps/server/effect/legacy-bindings.test.ts
git commit -m "feat(server): compose core ownership layers"
```

Expected: one graph is acquired/released in order, binding identity is exact, all pure import tests pass, and the explicit Layer error union typechecks without casts.

---


### Task 7: Add the shared Core runtime acquisition and disposal Cause boundary

**Files:**

- Create: `apps/server/effect/core-runtime.ts`
- Create: `apps/server/effect/core-runtime.test.ts`
- Modify: `apps/server/effect/index.ts`

**Interfaces:**

- Consumes: `CoreServices`, `CoreLayerError`, `AppConfig`, `Logging`, `Database`, and `Auth` from Tasks 1–6, plus Effect 3.22.2 `ManagedRuntime.runPromiseExit`, `Effect.runPromiseExit`, `Exit`, `Cause`, and `Option`.
- Produces: `CoreServicesValue`, `acquireCoreServices`, and `disposeCoreRuntime`.

- [ ] **Step 1: Write concrete Cause and disposal RED tests**

Create `core-runtime.test.ts` with a real typed Layer helper named `runtimeFailingWith`. The helper provides every tag and fails at a chosen acquisition point while registering a finalizer:

```ts
const fakeLogging = { getLogger: () => ({}) } as LoggingService;
const fakeDatabase = { db: {}, client: {} } as DatabaseService;
const fakeAuth = { instance: {} } as AuthService;
const fakeConfig: AppConfigValue = {
  server: { hostname: "127.0.0.1", port: 8787 },
  browser: { corsOrigin: "", origins: [] }, registration: { enabled: false },
  database: { url: "file::memory:" }, media: { imagesDir: "", audioDir: "" },
  auth: { baseURL: "", secret: Redacted.make(""), useSecureCookies: false },
  ai: { selected: "test", openRouter: {
    apiKey: Redacted.make(""), classifyModel: "classify", generateModel: "generate",
    imageModel: "image", classifyEffort: undefined, generateEffort: undefined,
  }, codex: {
    classifyModel: undefined, classifyEffort: undefined, generateModel: undefined,
    generateEffort: undefined, codexHome: "",
  } },
  elevenLabs: { apiKey: Redacted.make(""), model: "", voiceId: "" },
  runtime: { nodeEnv: undefined, devtoolsEnabled: false, readyToken: Redacted.make("") },
  legacyEnvironment: {},
};

function runtimeFailingWith(
  failure: CoreLayerError,
): ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError> {
  const failingTag = failure.operation === "config.capture" ? AppConfig
    : failure.operation === "logging.configure" ? Logging
    : failure.operation.startsWith("database.") ? Database
    : Auth;
  const config = failingTag === AppConfig
    ? Layer.effect(AppConfig, Effect.fail(failure))
    : Layer.succeed(AppConfig, fakeConfig);
  const logging = failingTag === Logging
    ? Layer.effect(Logging, Effect.fail(failure))
    : Layer.succeed(Logging, fakeLogging);
  const database = failingTag === Database
    ? Layer.effect(Database, Effect.fail(failure))
    : Layer.succeed(Database, fakeDatabase);
  const auth = failingTag === Auth
    ? Layer.effect(Auth, Effect.fail(failure))
    : Layer.succeed(Auth, fakeAuth);
  return ManagedRuntime.make(Layer.mergeAll(config, logging, database, auth));
}

function runtimeDefectWith(defect: unknown): ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError> {
  return { runPromiseExit: vi.fn(async () => Exit.die(defect)), disposeEffect: Effect.void } as unknown as ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>;
}

function runtimeWithFinalizerDefect(
  primary: CoreLayerError,
  cleanup: Error,
): { runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>; events: string[] } {
  const events: string[] = [];
  const config = Layer.scoped(
    AppConfig,
    Effect.acquireRelease(
      Effect.sync(() => { events.push("config.acquire"); return fakeConfig; }),
      () => Effect.sync(() => { events.push("config.release"); }),
    ),
  );
  const logging = Layer.scoped(
    Logging,
    Effect.acquireRelease(
      Effect.sync(() => { events.push("logging.acquire"); return fakeLogging; }),
      () => Effect.die(cleanup).pipe(Effect.ensuring(Effect.sync(() => { events.push("logging.release"); }))),
    ),
  );
  const database = Layer.scoped(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => { events.push("database.acquire"); return fakeDatabase; }),
      () => Effect.sync(() => { events.push("database.release"); }),
    ),
  );
  const auth = Layer.effect(Auth, Effect.gen(function* () {
    events.push("auth.acquire");
    return yield* Effect.fail(primary);
  }));
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      auth,
      Layer.provideMerge(database, Layer.provideMerge(logging, config)),
    ),
  );
  return { runtime, events };
}
```

Use `runtimeFailingWith` for tagged fallbacks and original Error identity, including cause-less and non-Error causes:

```ts
it.each([
  [new InfrastructureFailure({ operation: "config.capture", message: "PORT must be an integer between 1 and 65535", cause: new Error("PORT must be an integer between 1 and 65535") }), "PORT must be an integer between 1 and 65535", true],
  [new InfrastructureFailure({ operation: "auth.construct", message: "wrapped", cause: new Error("actionable") }), "actionable", true],
  [new InfrastructureFailure({ operation: "auth.construct", message: "wrapped", cause: "diagnostic" }), "wrapped", false],
  [new DatabaseFailure({ operation: "database.acquire", cause: new Error("driver detail") }), "driver detail", true],
  [new DatabaseFailure({ operation: "database.acquire", cause: "diagnostic" }), "Database startup failed during database acquisition", false],
  [new DatabaseFailure({ operation: "database.acquire" }), "Database startup failed during database acquisition", false],
] as const)("converts tagged Cause values", async (failure, message, preservesIdentity) => {
  const runtime = runtimeFailingWith(failure);
  const error = await acquireCoreServices(runtime).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
  if (preservesIdentity && failure.cause instanceof Error) expect(error).toBe(failure.cause);
});

it("uses Cause.pretty for an unexpected defect", async () => {
  const error = await acquireCoreServices(runtimeDefectWith(new Error("unexpected defect")))
    .catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("unexpected defect");
});
```

Use the helper for partial finalizers and primary-first cleanup:

```ts
it("puts cleanup defects after the primary", async () => {
  const primary = new Error("primary startup failure");
  const { runtime, events } = runtimeWithFinalizerDefect(
    new InfrastructureFailure({ operation: "config.capture", message: primary.message, cause: primary }),
    new Error("close failed"),
  );
  const error = await acquireCoreServices(runtime).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([primary, expect.any(Error)]);
  expect((error as AggregateError).message).toBe("Core startup failed");
  expect(events).toEqual([
    "config.acquire", "logging.acquire", "database.acquire", "auth.acquire",
    "database.release", "logging.release", "config.release",
  ]);
});
```

Add a direct `disposeCoreRuntime` assertion with a fully specified facade:

```ts
it("uses the outer disposal runner and reports reset defects", async () => {
  const runPromiseExit = vi.fn(async () => Exit.fail(new Error("acquire failed")));
  const disposeEffect = Effect.die(new Error("reset failed"));
  const runtime = { runPromiseExit, disposeEffect } as unknown as ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>;
  await expect(disposeCoreRuntime(runtime)).rejects.toThrow("reset failed");
  expect(runPromiseExit).toHaveBeenCalledTimes(0);
});

it.each([
  new DatabaseFailure({ operation: "database.close", cause: new Error("client close failed") }),
  new InfrastructureFailure({ operation: "logging.reset", message: "reset failed", cause: new Error("reset failed") }),
])("surfaces tagged close/reset defects from the outer runner", async (defect) => {
  const runtime = {
    disposeEffect: Effect.die(defect),
  } as unknown as ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>;
  await expect(disposeCoreRuntime(runtime)).rejects.toBe(defect);
});
```

- [ ] **Step 2: Run the helper test before the module exists**

```bash
bun run --cwd apps/server vitest run effect/core-runtime.test.ts
```

Expected: FAIL because `effect/core-runtime.ts` does not exist.

- [ ] **Step 3: Implement typed acquisition and exhaustive Cause conversion, then own the barrel**

Create the exact public surface:

```ts
import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect";
import type { AppConfigValue } from "./config.ts";
import { AppConfig } from "./config.ts";
import type { AuthService } from "./auth.ts";
import { Auth } from "./auth.ts";
import type { DatabaseService } from "./database.ts";
import { Database } from "./database.ts";
import type { LoggingService } from "./logging.ts";
import { Logging } from "./logging.ts";
import type { CoreLayerError, CoreServices } from "./live.ts";
import { DatabaseFailure, InfrastructureFailure } from "./errors.ts";

export type CoreServicesValue = Readonly<{
  config: AppConfigValue;
  logging: LoggingService;
  database: DatabaseService;
  auth: AuthService;
}>;

export function acquireCoreServices(runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>): Promise<CoreServicesValue>;
export function disposeCoreRuntime(runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>): Promise<void>;
```

Implement the acquisition and disposal boundary with these concrete helpers; do not substitute `Cause.squash` for the tagged cases because the primary Error identity and stable database fallback are part of the contract:

```ts
function causeToError(cause: Cause.Cause<unknown>): Error {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure instanceof InfrastructureFailure) {
    return failure.cause instanceof Error ? failure.cause : new Error(failure.message);
  }
  if (failure instanceof DatabaseFailure) {
    return failure.cause instanceof Error
      ? failure.cause
      : new Error("Database startup failed during database acquisition");
  }
  const defect = Option.getOrUndefined(Cause.dieOption(cause));
  return defect instanceof Error ? defect : new Error(Cause.pretty(cause));
}

const acquisition = Effect.gen(function* () {
  return {
    config: yield* AppConfig,
    logging: yield* Logging,
    database: yield* Database,
    auth: yield* Auth,
  } satisfies CoreServicesValue;
});

export async function acquireCoreServices(
  runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>,
): Promise<CoreServicesValue> {
  const exit = await runtime.runPromiseExit(acquisition);
  if (Exit.isSuccess(exit)) return exit.value;
  const primary = causeToError(exit.cause);
  const cleanup = await Effect.runPromiseExit(runtime.disposeEffect);
  if (Exit.isSuccess(cleanup)) throw primary;
  throw new AggregateError([primary, causeToError(cleanup.cause)], "Core startup failed");
}

export async function disposeCoreRuntime(
  runtime: ManagedRuntime.ManagedRuntime<CoreServices, CoreLayerError>,
): Promise<void> {
  const exit = await Effect.runPromiseExit(runtime.disposeEffect);
  if (Exit.isFailure(exit)) throw causeToError(exit.cause);
}
```

The acquisition program is one sequential `Effect.gen` yielding `AppConfig`, `Logging`, `Database`, and `Auth`. Inspect `runtime.runPromiseExit(program)` with `Cause.failureOption`; the helper preserves an Error `cause` by identity, uses the stable database message for cause-less/non-Error Database failures, uses the InfrastructureFailure message for cause-less/non-Error infrastructure failures, and turns an untagged defect into `new Error(Cause.pretty(cause))` without an unsafe cast. On failure it saves the primary, runs the outer `Effect.runPromiseExit(runtime.disposeEffect)` so every partially acquired finalizer runs, and produces primary-only or `AggregateError([primary, cleanup], "Core startup failed")` with the primary first.

After `core-runtime.ts` exists, and only in this task, modify `apps/server/effect/index.ts` to add the complete new barrel exports while retaining foundation exports:

```ts
export * from "./config.ts";
export * from "./database.ts";
export * from "./auth.ts";
export * from "./logging.ts";
export * from "./live.ts";
export * from "./legacy-bindings.ts";
export * from "./core-runtime.ts";
```

- [ ] **Step 4: Run focused helper and graph gates**

```bash
bun run --cwd apps/server vitest run effect/core-runtime.test.ts effect/live.test.ts
bun run server:check
git diff --check
```

Expected: every tagged-cause case preserves its required message/identity, partial finalizers run, cleanup defects are secondary, and the graph’s union error type remains `InfrastructureFailure | DatabaseFailure`.

- [ ] **Step 5: Commit the shared runtime boundary**

```bash
git add apps/server/effect/core-runtime.ts apps/server/effect/core-runtime.test.ts apps/server/effect/index.ts
git commit -m "feat(server): add core runtime disposal boundary"
```

---


### Task 8: Integrate the one process-bound runtime into main

**Files:**

- Modify: `apps/server/main.ts`
- Modify: `apps/server/main.test.ts`
- Modify: `apps/server/import-boundary.test.ts`

**Interfaces:**

- Consumes: `makeAppLayer`, `acquireCoreServices`, `disposeCoreRuntime`, `makeLegacyBindings`, `materializeLegacyEnvironment`, and the existing `createShutdown`/provider/app/scheduler APIs.
- Produces: unchanged `start()` return type and unchanged Hono/oRPC/lifecycle behavior, with one runtime and explicit scoped `{ db, auth }` bindings.

- [ ] **Step 1: Extend main tests with concrete mocked core state**

Retain every current provider-order, late-claim, dual-signal, and bind-failure test. Import `Redacted`, `Db`, and `LegacyAuth` for the typed fixtures. Follow the existing `main.test.ts` `vi.hoisted` pattern: define every value used by a hoisted mock inside the hoisted callback, then dynamically import `main.ts` after `vi.resetModules()`. The fake `Db` has the real sweep query shape, and the runtime returned by the mocked `ManagedRuntime.make` is the same object passed to acquisition/disposal:

```ts
import { Redacted } from "effect";
import type { Db } from "./db/index.ts";
import type { Auth as LegacyAuth } from "./auth.ts";
import type { AppConfigValue } from "./effect/config.ts";

const signals = new Map<string, () => void>();
const state = vi.hoisted(() => {
  const events: string[] = [];
  const client = { close: vi.fn(async () => { events.push("client.close"); }) };
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    insert: vi.fn(), delete: vi.fn(),
  } as unknown as Db;
  const auth = { handler: vi.fn() } as unknown as LegacyAuth;
  const provider = {
    modelCalls: {}, generateImageBytes: vi.fn(async () => new Uint8Array()),
    [Symbol.asyncDispose]: vi.fn(async () => { events.push("provider.dispose"); }),
  };
  const core = {
    config: null as unknown as AppConfigValue,
    database: { db, client }, auth: { instance: auth }, logging: { getLogger: vi.fn() },
  };
  const runtimeDispose = vi.fn(async () => { events.push("runtime.dispose"); });
  const runtime = { dispose: runtimeDispose, disposeEffect: undefined };
  return {
    events, core, runtime, runtimeDispose, client, db, provider,
    acquireCore: vi.fn(async () => core),
    disposeCore: vi.fn(async (received: typeof runtime) => { await received.dispose(); }),
    bindings: vi.fn((database: typeof core.database, authValue: typeof core.auth) => ({ db: database.db, auth: authValue.instance })),
    providerEnv: undefined as NodeJS.ProcessEnv | undefined,
    providerFactory: vi.fn(async (input: { env: NodeJS.ProcessEnv }) => { state.providerEnv = input.env; return provider; }),
    app: vi.fn(() => ({ fetch: () => new Response() })),
    textStart: vi.fn(), imageStart: vi.fn(),
  };
});

vi.mock("./effect/core-runtime.ts", () => ({
  acquireCoreServices: state.acquireCore,
  disposeCoreRuntime: state.disposeCore,
}));
vi.mock("./effect/legacy-bindings.ts", () => ({ makeLegacyBindings: state.bindings }));
vi.mock("./effect/live.ts", () => ({ makeAppLayer: vi.fn(() => ({})) }));
vi.mock("./ai/provider.ts", () => ({ createAiProvider: state.providerFactory }));
vi.mock("./app.ts", () => ({ createApp: state.app }));
vi.mock("./creations/scheduler.ts", () => ({
  recoverStaleCreationWork: vi.fn(async () => 0), startCreationScheduler: state.textStart,
}));
vi.mock("./creations/image-scheduler.ts", () => ({
  recoverStaleCreationImageWork: vi.fn(async () => 0), startImageScheduler: state.imageStart,
}));

vi.mock("effect", async (loadOriginal) => {
  const actual = await loadOriginal<typeof import("effect")>();
  return { ...actual, ManagedRuntime: { ...actual.ManagedRuntime, make: vi.fn(() => state.runtime) } };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.events.length = 0;
  signals.clear();
  state.core.config = {
    server: { hostname: "127.0.0.1", port: 8787 },
    browser: { corsOrigin: "https://app.example", origins: ["https://app.example"] },
    registration: { enabled: true }, database: { url: "file::memory:" },
    media: { imagesDir: "./data/images", audioDir: "./data/audio" },
    auth: { baseURL: "https://api.example.com", secret: Redacted.make("auth-secret"), useSecureCookies: true },
    ai: { selected: "openrouter", openRouter: {
      apiKey: Redacted.make("openrouter-secret"), classifyModel: "classify", generateModel: "generate",
      imageModel: "image", classifyEffort: undefined, generateEffort: undefined,
    }, codex: { classifyModel: undefined, classifyEffort: undefined, generateModel: undefined, generateEffort: undefined, codexHome: "" } },
    elevenLabs: { apiKey: Redacted.make("eleven-secret"), model: "eleven", voiceId: "voice" },
    runtime: { nodeEnv: "test", devtoolsEnabled: false, readyToken: Redacted.make("ready") },
    legacyEnvironment: Object.fromEntries([
      "AI_PROVIDER", "OPENROUTER_API_KEY", "CLASSIFY_MODEL", "CLASSIFY_EFFORT", "GENERATE_MODEL", "GENERATE_EFFORT",
      "IMAGE_MODEL", "CODEX_HOME", "ELEVENLABS_API_KEY", "ELEVENLABS_MODEL", "ELEVENLABS_VOICE_ID",
      "DATABASE_URL", "IMAGES_DIR", "AUDIO_DIR", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "CORS_ORIGIN",
      "REGISTRATION_ENABLED", "NODE_ENV", "MNIMI_DEV_READY_TOKEN", "HOST", "PORT",
    ].map((key) => [key, Redacted.make("captured")])) as Record<string, ReturnType<typeof Redacted.make>>,
  };
  state.acquireCore.mockResolvedValue(state.core);
  state.disposeCore.mockClear(); state.runtimeDispose.mockClear();
  state.providerFactory.mockClear(); state.provider[Symbol.asyncDispose].mockClear();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGINT" || event === "SIGTERM") signals.set(event, listener);
    return process;
  });
});

it("uses one core acquisition and passes exact legacy objects to app/provider", async () => {
  await import("./main.ts");
  expect(state.acquireCore).toHaveBeenCalledTimes(1);
  expect(state.bindings).toHaveBeenCalledWith(state.core.database, state.core.auth);
  expect(state.providerFactory).toHaveBeenCalledWith({ env: expect.objectContaining({ AI_PROVIDER: "captured" }) });
  expect(state.app).toHaveBeenCalledWith(expect.objectContaining({
    db: state.core.database.db, auth: state.core.auth.instance,
    corsOrigin: state.core.config.browser.corsOrigin,
    devtoolsEnabled: state.core.config.runtime.devtoolsEnabled,
    registrationEnabled: state.core.config.registration.enabled,
  }));
});

it("disposes the core once when acquisition fails before a provider exists", async () => {
  const failure = new Error("config capture failed");
  state.acquireCore.mockImplementationOnce(async () => {
    await state.runtime.dispose();
    throw failure;
  });
  await expect(import("./main.ts")).rejects.toBe(failure);
  expect(state.providerFactory).not.toHaveBeenCalled();
  expect(state.disposeCore).not.toHaveBeenCalled();
  expect(state.runtimeDispose).toHaveBeenCalledTimes(1);
  expect(state.provider[Symbol.asyncDispose]).not.toHaveBeenCalled();
});

it("does not dispose core ownership on normal signals", async () => {
  await import("./main.ts");
  signals.get("SIGTERM")!(); signals.get("SIGINT")!();
  await vi.waitFor(() => expect(state.provider[Symbol.asyncDispose]).toHaveBeenCalledOnce());
  expect(state.disposeCore).not.toHaveBeenCalled();
  expect(state.runtimeDispose).not.toHaveBeenCalled();
  expect(state.client.close).not.toHaveBeenCalled();
});

it("disposes once for pre-admission provider failure", async () => {
  state.providerFactory.mockRejectedValueOnce(new Error("invalid provider"));
  await expect(import("./main.ts")).rejects.toThrow("invalid provider");
  expect(state.disposeCore).toHaveBeenCalledTimes(1);
  expect(state.runtimeDispose).toHaveBeenCalledTimes(1);
  expect(state.provider[Symbol.asyncDispose]).not.toHaveBeenCalled();
  expect(state.app).not.toHaveBeenCalled();
  expect(state.textStart).not.toHaveBeenCalled();
});

it("disposes provider and core once for a pre-admission app failure", async () => {
  const failure = new Error("app construction failed");
  state.app.mockImplementationOnce(() => { throw failure; });
  await expect(import("./main.ts")).rejects.toBe(failure);
  expect(state.provider[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  expect(state.disposeCore).toHaveBeenCalledTimes(1);
  expect(state.runtimeDispose).toHaveBeenCalledTimes(1);
});

it("keeps the original startup failure first when core disposal also fails", async () => {
  const primary = new Error("app construction failed");
  const cleanup = new Error("core close failed");
  state.app.mockImplementationOnce(() => { throw primary; });
  state.disposeCore.mockRejectedValueOnce(cleanup);
  const result = await import("./main.ts").catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toEqual([primary, cleanup]);
  expect((result as AggregateError).errors[0]).toBe(primary);
  expect(state.provider[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
});

it("keeps the core acquired after post-admission failure", async () => {
  state.textStart.mockImplementationOnce(() => { throw new Error("scheduler failed"); });
  await expect(import("./main.ts")).rejects.toThrow("scheduler failed");
  expect(state.provider[Symbol.asyncDispose]).toHaveBeenCalled();
  expect(state.disposeCore).not.toHaveBeenCalled();
});

it("keeps runtime and client acquired after a post-admission bind failure", async () => {
  vi.stubGlobal("Bun", { serve: vi.fn(() => { throw new Error("address in use"); }) });
  await expect(import("./main.ts")).rejects.toThrow("address in use");
  expect(state.provider[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  expect(state.disposeCore).not.toHaveBeenCalled();
  expect(state.runtimeDispose).not.toHaveBeenCalled();
  expect(state.client.close).not.toHaveBeenCalled();
});

it("prints a non-empty ready token only after Bun.serve binds", async () => {
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) => {
    output.push(String(value));
    if (String(value) === "ready") state.events.push("ready");
  });
  vi.stubGlobal("Bun", { serve: vi.fn(() => {
    state.events.push("serve");
    return { stop: vi.fn() };
  }) });
  await import("./main.ts");
  expect(output).toContain("ready");
  expect(state.events.indexOf("serve")).toBeGreaterThanOrEqual(0);
  expect(state.events.indexOf("serve")).toBeLessThan(state.events.indexOf("ready"));
});

it("does not print a readiness line for an empty captured token", async () => {
  state.core.config = {
    ...state.core.config,
    runtime: { ...state.core.config.runtime, readyToken: Redacted.make("") },
  };
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); });
  await import("./main.ts");
  expect(output.filter((line) => line === "")).toHaveLength(0);
});
```

Mock `Bun.serve` to resolve only after the server is fully constructed. The `ManagedRuntime.make` mock returns `state.runtime`, while `disposeCore` calls that exact object's `dispose`, so no-signal disposal and pre-admission disposal assertions are meaningful. Assert the provider receives a materialized copy of `legacyEnvironment`, the non-empty captured `Redacted` ready token is printed after bind, and an empty token emits no readiness line. The existing lifecycle tests remain unchanged.

- [ ] **Step 2: Run main/import tests to expose the old bootstrap contract**

```bash
bun run --cwd apps/server vitest run main.test.ts import-boundary.test.ts
```

Expected: the new ownership assertions fail against the old singleton imports while existing lifecycle characterization remains the oracle.

- [ ] **Step 3: Refactor imports and move sweep ownership behind scoped `Db`**

Remove the `serverOptions` import and call as well as runtime imports of `./auth.instance.ts` and `./db/index.ts` from `main.ts`; retain only `import type { Db } from "./db/index.ts"` if needed for the exact seam. Add:

```ts
import { ManagedRuntime, Redacted } from "effect";
import { makeAppLayer } from "./effect/live.ts";
import { acquireCoreServices, disposeCoreRuntime } from "./effect/core-runtime.ts";
import { makeLegacyBindings } from "./effect/legacy-bindings.ts";
import { materializeLegacyEnvironment } from "./effect/config.ts";

function createSweep(db: Db): () => Promise<void> {
  return async () => {
    const [creationRows, attemptRows] = await Promise.all([
      db.select({ draftImageId: drafts.draftImageId }).from(drafts).where(isNotNull(drafts.draftImageId)),
      db.select({ draftImageId: creationImageAttempts.draftImageId }).from(creationImageAttempts).where(isNotNull(creationImageAttempts.draftImageId)),
    ]);
    const referenced = new Set([...creationRows, ...attemptRows].map((row) => row.draftImageId as string));
    await sweepDrafts(DRAFT_MAX_AGE_MS, referenced);
  };
}
```

Inside `start`, immediately after acquiring the core, write the ownership explicitly:

```ts
const sweep = createSweep(database.db);
const scheduleSweep = () => sweep().catch((error) => console.error("draft sweep failed", error));
scheduleSweep();
resources.sweepInterval = setInterval(scheduleSweep, SWEEP_INTERVAL_MS);
```

Remove every `process.env` and `process.argv` read from main (there are no exceptions); `createSweep` must receive `database.db` and must not close over the direct singleton export.

- [ ] **Step 4: Acquire once, preserve startup order, and mark admission**

At the top of `start()`, construct `const runtime = ManagedRuntime.make(makeAppLayer())`, then call `await acquireCoreServices(runtime)`. Use the returned `config`, `database`, `auth`, and `logging`; build `const bindings = makeLegacyBindings(database, auth)` and call:

```ts
const aiProvider = await createAiProvider({ env: materializeLegacyEnvironment(config) });
```

Keep provider construction before app/recovery/scheduler/listener construction. Pass `bindings.db`, `bindings.auth`, `config.browser.corsOrigin`, `config.runtime.devtoolsEnabled`, `config.registration.enabled`, and provider capabilities to `createApp`. Retain text recovery, notification dispatcher, text scheduler, image recovery, image scheduler, sweep scheduling, and `Bun.serve` order. Explicitly create `const sweep = createSweep(database.db)` and a `scheduleSweep` closure that calls `sweep`; use that closure for the immediate sweep and interval. Set `workloadAdmitted = true` immediately before the first scheduler constructor. Before that marker, startup failure runs constructed-provider cleanup and `disposeCoreRuntime(runtime)` exactly once; at or after it, existing cleanup runs but leaves runtime/client acquired. After successful bind, print only the non-empty unwrapped `config.runtime.readyToken`; no configuration value is read from environment or argv in main.

Implement the ownership boundary in `start()` with this concrete control-flow shape. Keep the existing recovery and scheduler calls in the shown order. `createShutdown` remains the only provider/resource owner after admission, and its existing idempotent Promise is also used by a pre-admission catch so a provider/app failure cannot dispose the provider twice:

```ts
export async function start() {
  const runtime = ManagedRuntime.make(makeAppLayer());
  const resources: ServerResources = {};
  let workloadAdmitted = false;
  let aiProvider: Awaited<ReturnType<typeof createAiProvider>> | undefined;
  let shutdown: ReturnType<typeof createShutdown> | undefined;
  const { config, database, auth } = await acquireCoreServices(runtime);

  try {
    const bindings = makeLegacyBindings(database, auth);
    aiProvider = await createAiProvider({ env: materializeLegacyEnvironment(config) });
    let shuttingDown = false;
    shutdown = createShutdown({
      aiProvider,
      resources,
      clearSweep: clearInterval,
      markShuttingDown: () => { shuttingDown = true; },
    });
    const onShutdownSignal = () => {
      void shutdown!().catch((error) => {
        console.error("server shutdown failed", error);
        process.exitCode = 1;
      });
    };
    process.on("SIGINT", onShutdownSignal);
    process.on("SIGTERM", onShutdownSignal);
    const app = createApp({
      db: bindings.db, auth: bindings.auth,
      corsOrigin: config.browser.corsOrigin,
      devtoolsEnabled: config.runtime.devtoolsEnabled,
      registrationEnabled: config.registration.enabled,
      ...aiProvider,
    });
    await recoverStaleCreationWork(bindings.db, new Date(), {
      allLeases: true, includeUnleased: true,
    }).then((count) => {
      if (count > 0) console.log(`requeued ${count} interrupted creation(s)`);
    }).catch((error) => console.error("creation recovery failed", error));
    if (shuttingDown) return shutdown;
    const notificationDispatcher = createNotificationDispatcher({ db: bindings.db });
    workloadAdmitted = true;
    resources.creationScheduler = startCreationScheduler({
      db: bindings.db,
      runWork: async (work) => {
        if (shuttingDown) return;
        await runCreationAttempt(work, {
          db: bindings.db, models: aiProvider!.modelCalls,
          notify: notificationDispatcher.queue,
        });
      },
    });
    await recoverStaleCreationImageWork(bindings.db, new Date(), { allLeases: true })
      .then((count) => {
        if (count > 0) console.log(`requeued ${count} interrupted image(s)`);
      }).catch((error) => console.error("creation image recovery failed", error));
    if (shuttingDown) return shutdown;
    resources.imageScheduler = startImageScheduler({
      db: bindings.db,
      runWork: async (work) => {
        if (shuttingDown) return;
        await runCreationImageAttempt(work, {
          db: bindings.db, generateImageBytes: aiProvider!.generateImageBytes,
          writeDraftImage, claimDraftImage, removeDraftImage, removeImage,
        });
      },
    });
    const sweep = createSweep(database.db);
    const scheduleSweep = () => sweep().catch((error) => console.error("draft sweep failed", error));
    scheduleSweep();
    resources.sweepInterval = setInterval(scheduleSweep, SWEEP_INTERVAL_MS);
    resources.server = Bun.serve({
      hostname: config.server.hostname, port: config.server.port,
      fetch: app.fetch,
    });
    const readyToken = Redacted.value(config.runtime.readyToken);
    if (readyToken !== "") console.log(readyToken);
    return shutdown;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (shutdown !== undefined) {
      try { await shutdown(); } catch (cleanupError) {
        console.error("startup cleanup failed", cleanupError);
        cleanupFailures.push(cleanupError);
      }
    }
    if (!workloadAdmitted) {
      try { await disposeCoreRuntime(runtime); } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], "Server startup failed");
    }
    throw error;
  }
}
```

The implementation must thread the existing scheduler/recovery argument shapes through the shown objects rather than inventing singleton reads. Acquisition is deliberately outside this catch: `acquireCoreServices` owns its outer disposal runner and already disposes a partially acquired core exactly once, so a rejected acquisition must not trigger `disposeCoreRuntime` in `main.ts`. If provider/app/recovery fails after acquisition but before `workloadAdmitted`, the existing idempotent `shutdown` disposes the constructed provider once and the catch disposes the acquired core once. A `shutdown` or `disposeCoreRuntime` rejection is collected after the original startup error and returned as `AggregateError([original, ...cleanupFailures], "Server startup failed")`, preserving the primary at index 0. Once the marker is set, the catch may invoke existing resource cleanup but never calls `disposeCoreRuntime`; ordinary SIGINT/SIGTERM follows that same contract and never disposes the core/client. No `process.env` or `process.argv` access and no `serverOptions` import/call may remain in `main.ts`.

- [ ] **Step 5: Preserve lifecycle and assert import boundaries**

Do not edit `apps/server/lifecycle.ts` or `apps/server/lifecycle.test.ts`. Extend the child source in `apps/server/import-boundary.test.ts` to import `./effect/index.ts` and every owned module needed by the boundary check, then assert exit 0, empty stdout/stderr, and no configured database/images/audio directory creation. Add static assertions that `main.ts` has no runtime `db/index.ts`, `auth.instance.ts`, or `serverOptions` import/call and owned Effect modules have no runtime app/router/provider/media/old-logging import.

- [ ] **Step 6: Run bootstrap and server gates**

```bash
bun run --cwd apps/server vitest run main.test.ts lifecycle.test.ts import-boundary.test.ts effect
bun run server:check
git diff --check
```

Expected: provider-before-app/recovery/scheduler/bind order, recovery log-and-continue, readiness timing, idempotent dual-signal cleanup, and aggregate failures remain unchanged; normal signal cleanup does not dispose runtime/client; pre-admission failure disposes once.

- [ ] **Step 7: Commit main integration**

```bash
git add apps/server/main.ts apps/server/main.test.ts apps/server/import-boundary.test.ts
git commit -m "feat(server): integrate process-bound core runtime"
```

---


### Task 9: Run integrated completion gates and hand off

**Files:**

- Verify only; no additional production/test changes are authorized by this task.

**Interfaces:**

- Consumes: Tasks 1–8 and every unchanged compatibility characterization in the repository.
- Produces: an evidence-backed implementation checkpoint; Bead state changes are outside this documentation plan and require the implementation coordinator’s authority.

- [ ] **Step 1: Inspect the scoped diff and narrowly verify forbidden imports**

Resolve the plan commit dynamically so this check excludes this planning document honestly while still showing implementation changes after it:

```bash
set -euo pipefail
core_plan_base=$(git log -1 --format=%H -- docs/superpowers/plans/2026-09-14-effect-core-ownership.md)
git diff --stat "$core_plan_base"..HEAD -- ':!docs/superpowers/plans/2026-09-14-effect-core-ownership.md'
git diff --check "$core_plan_base"..HEAD -- ':!docs/superpowers/plans/2026-09-14-effect-core-ownership.md'
if rg -n '@effect/platform' apps/server/package.json bun.lock; then exit 1; fi
if rg --pcre2 -n '^(?!\s*import\s+type\b)\s*import\b.*from\s+["'\''"]\./(?:auth\.instance|db/index)\.ts["'\''"]' apps/server/main.ts; then exit 1; fi
if rg -n '\bserverOptions\b' apps/server/main.ts; then exit 1; fi
if rg --pcre2 -n '^(?!\s*import\s+type\b)\s*import\b.*from\s+["'\''"]\.\./(?:db/index|auth\.instance|logging)\.ts["'\''"]' apps/server/effect -g '*.ts' -g '!*.test.ts'; then exit 1; fi
if rg --pcre2 -n '^(?!\s*import\s+type\b)\s*import\b.*from\s+["'\''"]\.\./(?:main|app|router(?:/|\.ts)|ai(?:/|\.ts)|images(?:/|\.ts)|audio(?:/|\.ts))["'\''"]' apps/server/effect -g '*.ts' -g '!*.test.ts'; then exit 1; fi
```

The first two commands use the implementation coordinator’s latest plan commit as the base. The import scans reject only runtime imports: type-only `Db`/`Auth` compatibility imports and owned `./logging.ts` imports remain legal; runtime `../logging.ts`, `../db/index.ts`, `../auth.instance.ts`, and actual forbidden owners fail. The explicit `import-boundary.test.ts` remains the authoritative behavioral check.

- [ ] **Step 2: Run all focused owned-service tests**

```bash
bun run --cwd apps/server vitest run effect/config.test.ts effect/logging.test.ts db/write-lock.test.ts effect/database.test.ts effect/auth.test.ts effect/live.test.ts effect/core-runtime.test.ts effect/legacy-bindings.test.ts
```

Expected: all eight owned-service files pass, including the complete config matrix, sanitized category/level/message/properties, lock interruption/fence, client/queue fences, Auth adapter semantics, executable ordered graph, binding identity, and Cause/disposal cases.

- [ ] **Step 3: Run server checks and the production-shaped smoke**

```bash
bun run server:check
VITEST_MAX_WORKERS=2 bun run server:test
bun run --cwd apps/server scripts/runtime-smoke.ts
```

Expected: TypeScript, all server tests, migration/disabled-registration/sign-in/deck/media/readiness coverage, and bounded SIGTERM process exit pass. The smoke test’s SIGTERM assertion proves process cleanup and exit, not a production Database close.

- [ ] **Step 4: Run repository and web gates**

```bash
bun run check
VITEST_MAX_WORKERS=2 bun run test
EXPO_PUBLIC_API_URL=https://api.example.com bun run web:build
git diff --check
```

Expected: all workspace checks, full sequential tests, web build, and whitespace validation pass. Do not call a provider-dependent check passing when credentials were unavailable; report deterministic, browser, device, and hosted evidence separately.

- [ ] **Step 5: Review the compatibility matrix and hand off**

Review every row of the spec matrix: configuration (including absolute/non-file/empty URLs and paths, trimmed CORS, all role fields, and full redacted legacy env); browser origins/CORS; registration; Auth; Database/lock lifetime; Drizzle CLI; lazy provider fields/errors; media paths; HTTP/RPC bindings; startup admission/readiness; core errors; shutdown; and logging. Confirm normal SIGINT/SIGTERM leaves runtime/client process-bound, bounded pre-admission startup and explicit test/one-shot scopes close via the queue fence, and the later jobs/transport child owns the successor disposal boundary. Report changed files, commits, validation results, and unavailable credential-dependent checks. Do not push, merge, deploy, or close a Bead from this plan.

---

## Self-review checklist

- [ ] Every spec configuration boundary is executable in Task 1: defaults, unset versus empty, digit-only/safe integer ports, absolute/relative/non-file/empty database URLs, absolute/relative/empty media paths, trimmed and raw CORS, registration, secure cookies, all optional classify/generate model/effort fields, lazy provider validation, deep freeze, exact PORT error, every legacy environment value in Effect Redacted, and empty ready-token behavior.
- [ ] Task 2 owns canonical LogTape configure/reset, guarded shim, recursive category/level/message/properties sanitization, rawMessage/timestamp preservation, direct/child/context logger coverage, and active-config preservation.
- [ ] Task 3 owns pure FIFO admission, rejection recovery, close fence/draining, interruption-safe callback handoff at the integration boundary, and identity-protected nested/stale installation restoration.
- [ ] Task 4 owns one client, directory handling, exact PRAGMA order, Drizzle handle, read transaction commit/close semantics including an interrupted read, queued writes, nested marker failure, queue/client finalizer defects with uninstall/client-close continuation and aggregation, and the Better Auth-outside-queue seam without changing schema/CLI paths.
- [ ] Task 5 owns Auth construction over scoped Database, explicit secure-cookie option plus direct fallback, UUIDv7/custom fields/registration/trusted origins/bearer/browser behavior, adapter options spy, and no Auth write-lock call.
- [ ] Task 6 owns executable sequential two-argument Layer.provideMerge order, reverse release, exact binding identity, and no premature barrel edit.
- [ ] Task 7 owns every CoreLayerError variant, original Error identity, stable fallbacks, unexpected Cause, outer disposal runner, concrete partial finalizer/acquisition order, primary-first aggregation, and the complete effect/index.ts barrel export.
- [ ] Task 8 owns one main runtime/acquisition, no serverOptions/env/argv reads, exact createSweep(database.db) closure, provider/app/recovery/scheduler/Bun.serve order, startup admission/readiness, primary-preserving pre-admission disposal, post-admission bind failure with runtime/client retained, process-bound signal shutdown, unchanged lifecycle, and static import-boundary tests.
- [ ] Task 9 gates include focused tests, server:check, server/full repository tests, web build, smoke, dynamic diff base, precise runtime import scan, matrix review, and no prohibited deployment/Bead changes.
- [ ] No undefined test helpers, event arrays, runtime state fields, or unresolved implementation markers remain; every central failure, interruption, finalizer, ordering, and readiness case has a concrete test body or typed seam.
- [ ] Type consistency checked: all tags, service members, Layer error unions, CoreServicesValue fields, { db, auth } members, redacted fields, logger level cast, and runtime helper signatures match the spec declarations.
