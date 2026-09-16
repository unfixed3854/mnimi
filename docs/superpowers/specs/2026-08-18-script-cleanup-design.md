# Bun Workspace and Script Cleanup Design

**Issue:** #50 — Refactor scripts
**Status:** Approved in chat; awaiting written-spec review before planning

## Goal

Replace the repository's mixed Deno/npm configuration with one coherent Bun
workspace. Every member owns its dependencies and executable scripts, the root
only routes or aggregates those scripts, and the server runs on Bun using
standard Web and Node APIs wherever possible.

The finished repository has one install command, one lockfile, one public
command vocabulary, package-local environment files, and no Deno compatibility
layer. Expo remains the only interactive terminal application during combined
development.

## Runtime and Tool Boundary

Bun owns:

- dependency installation and the workspace lockfile;
- root and member `package.json` script execution;
- the production server runtime;
- the combined development-process orchestrator; and
- the Android release-build helper.

Node remains installed because Expo requires it for operations including
prebuild. Bun respects executable shebangs, so Expo, Jest, Vitest, and Drizzle
Kit may execute with Node when their installed CLIs require it. Developers do
not invoke Node or npm-family package managers directly; all public commands
begin with `bun`.

The server's application code is runtime-portable except for its entrypoint:

| Deno API | Replacement |
| --- | --- |
| `Deno.env` | `process.env` |
| `Deno.args` | `process.argv` |
| `Deno.exit` | `process.exitCode` where practical |
| Deno file APIs | `node:fs` and `node:fs/promises` |
| `Deno.errors.*` | a small `NodeJS.ErrnoException.code` predicate |
| `Deno.serve` | `Bun.serve` in `apps/server/main.ts` |
| `Deno.Command` | `Bun.spawn` in Bun-owned tooling |

There is no global `Deno` shim, preload, or compatibility package. Bun-specific
application code is limited to the actual runtime boundary so the router,
database, storage, authentication, and AI modules remain ordinary TypeScript.

## Workspace Manifests

### Root

The root `package.json` contains:

- `private: true`;
- `packageManager: "bun@1.3.13"`;
- `workspaces: ["apps/*", "libs/*"]`; and
- routing and aggregate scripts only.

It has no application dependencies. The root development runner is plain
JavaScript and uses Bun's built-in process APIs, so it does not create a root
tooling dependency graph.

The root `bunfig.toml` contains only intentional Bun policy:

```toml
env = false

[install]
auto = "disable"
linker = "hoisted"
```

Automatic environment loading is disabled at the workspace level so a stale
ignored root `.env` cannot leak into filtered member commands. Automatic
package installation is disabled so missing declarations fail instead of being
fetched implicitly. The hoisted linker is an explicit React Native/Jest
compatibility choice: React Native's Jest preset does not recognize Bun's
isolated-store `.bun` realpaths when applying transforms. A clean hoisted Bun
install was verified with Expo configuration, TypeScript, and the functional
mobile Jest suites.

No dependency lifecycle script needs to be trusted. Bun reports only
`@openrouter/sdk`'s optional `node scripts/check-types.js || true` postinstall
as blocked; it produces no runtime artifact and remains blocked.

### Mobile

`apps/mobile/package.json` owns every Expo, React Native, NativeWind, Babel,
Jest, testing-library, and mobile TypeScript dependency. Expo-compatible
versions are reconciled through Expo's supported dependency checks rather than
duplicated at the root.

Its scripts are:

| Script | Behavior |
| --- | --- |
| `dev` | Start Expo for a development build. |
| `android` | Prebuild, install, and launch the Android development build. |
| `check` | Run the mobile TypeScript configuration without emitting. |
| `test` | Run Jest serially with Node's ESM VM support. |
| `smoke` | Run the existing physical-device Android smoke launcher. |
| `build:android` | Run the Bun-based Android release helper. |

The obsolete Expo doctor task and `scripts/run-expo-doctor.ts` are removed.
`scripts/build-android.ts` is rewritten around `Bun.spawn`; it invokes only
already-installed Expo tooling and the checked-in Gradle wrapper, propagates
exit codes, and never auto-installs dependencies.

### Server

`apps/server/package.json` owns all server runtime libraries, Drizzle Kit,
Vitest, TypeScript, `@types/node`, and `@types/bun`. It declares
`@mnimi/shared` as `workspace:*`.

Its scripts are:

| Script | Behavior |
| --- | --- |
| `dev` | Run `main.ts` with Bun watch mode and server devtools enabled. |
| `start` | Run `main.ts` once under Bun. |
| `check` | Type-check the complete server package with `tsc --noEmit`. |
| `test` | Run the Vitest suite, followed by a real Bun runtime smoke test. |
| `db:generate` | Generate migrations from the package-local Drizzle config. |
| `db:migrate` | Apply migrations using the package-local environment. |
| `db:studio` | Launch Drizzle Studio using the package-local environment. |

Vitest continues to run with its supported Node host. Forcing Vitest itself
onto Bun failed in Vite's module interop, while moving the suite to `bun:test`
would require semantic replacements for the repository's uses of
`vi.waitFor` and `vi.hoisted`. That unrelated test-framework migration is not
part of this cleanup. The post-Vitest runtime smoke test launches the real Bun
entrypoint against a temporary migrated database, waits for an HTTP response,
and always terminates the child process.

### Shared

`libs/shared/package.json` exports the shared TypeScript entrypoint and owns its
TypeScript and Vitest tooling. Its public scripts are `check` and `test`.
Server imports resolve through `@mnimi/shared`; test-runner aliases are not used
to conceal a broken workspace link.

## Removed Configuration

The migration deletes:

- root, mobile, server, and shared `deno.json` files;
- `deno.lock`;
- Deno-specific ambient declarations used only by tooling;
- the `concurrently` dependency;
- the Expo doctor wrapper; and
- obsolete Deno task-contract assertions.

The only dependency lockfile is the text `bun.lock` generated by the pinned Bun
version.

## Root Command Surface

The three common workflows remain intentionally short:

| Command | Behavior |
| --- | --- |
| `bun run dev` | Start the server and Expo development client together. |
| `bun run check` | Run every member's `check` script. |
| `bun run test` | Run every member's `test` script. |

Scoped root scripts are thin `bun run --filter <member> <script>` routes:

- `mobile:dev`, `mobile:android`, `mobile:check`, `mobile:test`,
  `mobile:smoke`, and `mobile:build:android`;
- `server:dev`, `server:start`, `server:check`, and `server:test`;
- `shared:check` and `shared:test`; and
- `db:generate`, `db:migrate`, and `db:studio` routed to the server.

There are no aliases for old Deno names and no generic root `build` command.
Package-local commands also work directly, for example `bun run check` from
`apps/server`.

## Combined Development Runner

`scripts/dev.mjs` is a dependency-free Bun program. It:

1. creates the ignored `.dev/` directory;
2. starts the server package in watch mode with stdin disconnected;
3. writes server stdout and stderr to `.dev/server.log`;
4. starts the mobile `dev` script with inherited stdin, stdout, and stderr so
   Expo has exclusive control of the visible terminal;
5. forwards termination to both children; and
6. if the server exits unexpectedly, stops Expo, returns a failure status, and
   points the developer to the server log.

`bun run server:dev` remains available when interactive server logs are more
important than Expo's terminal UI. The runner does not hide failures, restart
the server itself, or contain package-manager logic.

## Environment and Runtime Paths

The combined root environment example is split by ownership:

- `apps/mobile/.env.example` contains only `EXPO_PUBLIC_API_URL` and documents
  that the value is shipped in the client bundle.
- `apps/server/.env.example` contains database, authentication, binding,
  storage, AI, and text-to-speech settings.

Developers copy each example to `.env` beside the consuming package. Server
runtime and Drizzle scripts explicitly pass `--env-file=.env` to Bun from
`apps/server`; Expo performs its own supported loading of `apps/mobile/.env`.
The root Bun policy disables implicit environment-file loading everywhere else.
There is no root forwarding wrapper. The existing ignored root `.env` is
user-owned and is not deleted automatically; after its values are split it is
inert, and README migration instructions explain that transition.

`apps/server/runtime-paths.ts` defines the repository root from
`import.meta.url` and normalizes configured filesystem values:

- absolute paths remain absolute;
- `file::memory:` and remote database URLs remain unchanged;
- relative SQLite `file:` URLs resolve from the repository root; and
- relative image and audio directories resolve from the repository root.

This preserves the existing root `data/` location while making server startup,
tests, and Drizzle independent of process working directory. A shared errno
predicate handles expected filesystem conditions such as `ENOENT`; unexpected
errors retain their original stack and propagate.

Drizzle's `schema` and migration-output paths become package-local because the
config now runs from `apps/server`. Its database URL uses the same normalization
as the application, so runtime and migrations cannot silently address different
files.

## Test Corrections

The runtime change includes narrowly required test hygiene:

- Hoisted mobile Jest mock factories stop referencing Babel-generated outer
  bindings; factories obtain React locally when they create elements.
- Query clients created by draft autosave and indicator tests are cleared after
  each test so their garbage-collection timers cannot keep Node alive.
- Test uses of Deno environment and filesystem APIs move to `process.env`,
  Node temporary directories, and Node filesystem calls.
- Tests asserting `Deno.errors.*` assert portable errno behavior instead.
- The mobile test that compares exact Deno task strings and CI source text is
  deleted. CI executing the public commands is the contract.

No product behavior, database schema, API contract, or mobile UI changes.

## Toolchain and Contributor Policy

`mise.toml` removes Deno and adds the Bun version pinned by `packageManager`:

```toml
[tools]
node = "24.15.0"
bun = "1.3.13"
java = "17.0.2"
android-sdk = "1.0"
```

Node, Java, Android SDK, and the existing NDK environment remain. Deno is no
longer required anywhere in setup, local scripts, builds, tests, or CI.

`AGENTS.md` changes from Deno-only instructions to Bun-only package management
and public script execution. Direct `npm`, `npx`, Yarn, pnpm, and Deno commands
are prohibited. Node-backed installed CLIs invoked by `bun run` are an internal
tool implementation detail, not a second developer workflow.

## CI

The GitHub Actions verification job:

1. installs the pinned mise tools, including Bun and Node but not Deno;
2. restores Bun's download cache keyed by `bun.lock`;
3. runs `bun install --frozen-lockfile`;
4. runs `bun run check`; and
5. runs `bun run test`.

The server member's test command includes the Bun runtime smoke test, so CI
proves both the Node-hosted Vitest suite and the production runtime. CI does not
duplicate member command lists or parse manifest/workflow text.

## Documentation Migration

Update active developer-facing references in:

- `README.md` setup, environment, development, checking, testing, Android
  build, and smoke instructions;
- `.github/workflows/ci.yml`;
- `AGENTS.md`;
- Android smoke launcher and acceptance guide; and
- active source comments that name Deno commands or APIs.

Historical specifications and plans remain unchanged as records of the system
that existed when they were written. The new design and implementation plan
supersede them for current commands.

## Verification and Acceptance

The migration is complete only when all of the following hold:

1. `mise install` installs Bun, Node, Java, and Android tooling without Deno.
2. A clean `bun install --frozen-lockfile` succeeds from only the manifests and
   `bun.lock`.
3. There is one lockfile and no Deno or pnpm workspace configuration.
4. `bun run check` passes every member's static checks.
5. `bun run test` passes all mobile, server, and shared tests and exits without
   leaked handles.
6. Every member's `check` and `test` scripts pass from that member directory.
7. Expo public configuration resolves from the Bun-installed workspace.
8. `@mnimi/shared` resolves through its workspace package without aliases.
9. Drizzle migration succeeds against a temporary database from both the root
   route and the server-local command.
10. A real Bun server starts, responds over HTTP, and shuts down cleanly.
11. `bun run dev` gives Expo the terminal, records server logs, propagates
    Ctrl-C, and fails visibly if the server dies.
12. `bun run mobile:build:android` produces the Android release artifact from
    the clean install.
13. A second clean frozen install succeeds after installed dependencies are
    moved aside.
14. Active configuration, scripts, source comments, and contributor docs contain
    no obsolete Deno commands or Expo doctor references.
15. `git diff --check` passes.

## Explicit Non-Goals

- Migrating the mobile Jest suite to Bun's test runner.
- Migrating the server/shared Vitest suites to `bun:test`.
- Replacing libSQL/Drizzle with Bun's SQLite API.
- Changing API, authentication, storage, AI, or mobile behavior.
- Automatically deleting or rewriting a developer's ignored root `.env`.
- Rewriting historical design and implementation documents.
