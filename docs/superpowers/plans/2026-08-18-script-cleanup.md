# Bun Workspace and Runtime Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Deno dependency management, scripts, and server runtime with one Bun workspace whose members own their dependencies and commands.

**Architecture:** Move server internals onto standard Web and Node APIs first so the existing Deno suite remains a safety net during the transition. Then make Bun own workspace installation, move the server entrypoint to `Bun.serve`, add package-local environment loading and a Bun runtime smoke test, and finally replace the remaining mobile/root Deno tooling before updating CI and documentation.

**Tech Stack:** Bun 1.3.13, Node 24.15.0, TypeScript 6.0.3, Expo SDK 57, React Native 0.86, Hono, Drizzle/libSQL, Vitest 4.1.10, Jest 29.7.0

**Spec:** `docs/superpowers/specs/2026-08-18-script-cleanup-design.md`

## Global Constraints

- Bun 1.3.13 owns package installation, workspace scripts, orchestration, and the production server runtime.
- Node 24.15.0 remains installed for Expo, Jest, Vitest, and Drizzle Kit CLIs.
- Java 17.0.2 and `android-sdk = "1.0"` remain unchanged in `mise.toml`.
- Do not add a Deno compatibility shim or preload.
- Prefer standard Web and `node:*` APIs; use Bun APIs only at runtime/process boundaries.
- Root `package.json` routes commands and declares workspaces; application dependencies belong to their consuming member.
- Keep `dev`, `check`, and `test` as the short root workflows.
- Expo must be the only interactive TUI in `bun run dev`.
- Use one text `bun.lock`; remove all Deno configuration and lockfiles by the end of Task 4.
- Set `env = false`, `install.auto = "disable"`, and `install.linker = "hoisted"` in root `bunfig.toml`.
- Keep server/shared tests on Vitest and mobile tests on Jest; do not migrate those suites to `bun:test`.
- Keep runtime data under root `data/`, independent of process working directory.
- Split environment examples between `apps/mobile` and `apps/server`; never read or rewrite the developer's ignored root `.env`.
- Remove the Expo doctor command and wrapper without a compatibility alias.
- Preserve historical plans and specifications; update only active documentation and source comments.
- Do not change product behavior, API contracts, database schema, authentication, AI behavior, or mobile UI.

---

## File Responsibility Map

| File or group | Responsibility after migration |
| --- | --- |
| `package.json` | Bun version, workspace membership, aggregate and scoped routing scripts |
| `bunfig.toml` | Disable implicit env/installs and select the React Native-compatible linker |
| `apps/*/package.json`, `libs/shared/package.json` | Member-owned dependencies and executable scripts |
| `apps/server/tsconfig.json`, `libs/shared/tsconfig.json` | Node/Bun-compatible static checking |
| `apps/server/runtime-paths.ts` | Repository-root path and SQLite URL normalization |
| `apps/server/fs-errors.ts` | Portable filesystem errno classification |
| `apps/server/main.ts` | Bun-only HTTP entrypoint |
| `apps/server/scripts/runtime-smoke.ts` | Migrate a temporary database and prove the Bun server over HTTP |
| `scripts/dev.mjs` | Keep the server in the background while Expo owns the terminal |
| `apps/mobile/scripts/build-android.ts` | Bun-owned Expo prebuild and Gradle release orchestration |
| `apps/mobile/e2e/android-smoke.sh` | Validate the LAN URL and route to the canonical root dev command |
| package-local `.env.example` files | Public mobile configuration versus private server configuration |
| `.github/workflows/ci.yml` | Frozen Bun install followed by the root check/test contracts |

---

### Task 1: Make Server Internals Runtime-Portable

**Files:**
- Create: `apps/server/runtime-paths.ts`
- Create: `apps/server/runtime-paths.test.ts`
- Create: `apps/server/fs-errors.ts`
- Create: `apps/server/fs-errors.test.ts`
- Modify: `apps/server/db/url.ts`
- Modify: `apps/server/audio.ts`
- Modify: `apps/server/images.ts`
- Modify: `apps/server/app.ts`
- Modify: `apps/server/auth.ts`
- Modify: `apps/server/ai/openrouter.ts`
- Modify: `apps/server/tts/elevenlabs.ts`
- Modify: `apps/server/devtools/german-seed.ts`
- Modify: `apps/server/router/debug.ts`
- Modify: `apps/server/router/notes.ts`
- Modify: server tests that currently call `Deno.env`, Deno file APIs, or construct `Deno.errors.*`

**Interfaces:**
- Consumes: existing root-relative defaults `file:./data/mnimi.db`, `./data/images`, and `./data/audio`
- Produces: `repositoryRoot: string`
- Produces: `resolveRuntimePath(value: string): string`
- Produces: `resolveDatabaseUrl(value: string): string`
- Produces: `hasFsErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException`

- [ ] **Step 1: Write failing path and errno tests**

Create `apps/server/runtime-paths.test.ts`:

```ts
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  repositoryRoot,
  resolveDatabaseUrl,
  resolveRuntimePath,
} from "./runtime-paths.ts";

describe("runtime paths", () => {
  it("anchors relative storage paths at the repository root", () => {
    expect(resolveRuntimePath("./data/images")).toBe(
      join(repositoryRoot, "data/images"),
    );
    expect(isAbsolute(resolveRuntimePath("./data/images"))).toBe(true);
  });

  it("leaves absolute storage paths unchanged", () => {
    expect(resolveRuntimePath("/tmp/mnimi-images")).toBe("/tmp/mnimi-images");
  });

  it("normalizes only relative file database URLs", () => {
    expect(resolveDatabaseUrl("file:./data/mnimi.db")).toBe(
      `file:${join(repositoryRoot, "data/mnimi.db")}`,
    );
    expect(resolveDatabaseUrl("file::memory:")).toBe("file::memory:");
    expect(resolveDatabaseUrl("file:/tmp/mnimi.db")).toBe("file:/tmp/mnimi.db");
    expect(resolveDatabaseUrl("libsql://example.turso.io")).toBe(
      "libsql://example.turso.io",
    );
  });
});
```

Create `apps/server/fs-errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hasFsErrorCode } from "./fs-errors.ts";

describe("hasFsErrorCode", () => {
  it("matches Node filesystem errors by code", () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(hasFsErrorCode(error, "ENOENT")).toBe(true);
    expect(hasFsErrorCode(error, "ENOTDIR")).toBe(false);
  });

  it("rejects non-errors and errors without a code", () => {
    expect(hasFsErrorCode(new Error("plain"), "ENOENT")).toBe(false);
    expect(hasFsErrorCode("ENOENT", "ENOENT")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the missing modules fail**

Run:

```bash
deno task api:test apps/server/runtime-paths.test.ts apps/server/fs-errors.test.ts
```

Expected: FAIL because `runtime-paths.ts` and `fs-errors.ts` do not exist.

- [ ] **Step 3: Implement the portable helpers**

Create `apps/server/runtime-paths.ts`:

```ts
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function resolveRuntimePath(value: string): string {
  return isAbsolute(value) ? value : resolve(repositoryRoot, value);
}

export function resolveDatabaseUrl(value: string): string {
  if (!value.startsWith("file:") || value === "file::memory:") return value;
  const path = value.slice("file:".length);
  return isAbsolute(path) ? value : `file:${resolveRuntimePath(path)}`;
}
```

Create `apps/server/fs-errors.ts`:

```ts
export function hasFsErrorCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
```

- [ ] **Step 4: Run the helper tests and verify they pass**

Run:

```bash
deno task api:test apps/server/runtime-paths.test.ts apps/server/fs-errors.test.ts
```

Expected: 2 files and 5 tests PASS.

- [ ] **Step 5: Migrate server environment and filesystem consumers**

Make these exact mechanical conversions in the listed runtime files:

```ts
// Environment reads
process.env.OPENROUTER_API_KEY
process.env.BETTER_AUTH_SECRET
process.env.ELEVENLABS_API_KEY

// File APIs
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { mkdirSync, statSync } from "node:fs";

// Expected missing-file handling
if (hasFsErrorCode(error, "ENOENT")) return false;
```

Apply the conversions as follows:

- `db/url.ts`: export `resolveDatabaseUrl(process.env.DATABASE_URL ?? "file:./data/mnimi.db")`; use `mkdirSync` for its parent.
- `images.ts`: export `resolveRuntimePath(process.env.IMAGES_DIR ?? "./data/images")`; use `mkdir`, `writeFile`, `rename`, `rm`, `readFile`, `readdir`, and `stat`; call Node `Stats.isFile()` as a method.
- `audio.ts`: export `resolveRuntimePath(process.env.AUDIO_DIR ?? "./data/audio")`; use the same Node file operations and errno predicate.
- `devtools/german-seed.ts`: use Node `statSync` and call `isDirectory()`/`isFile()` methods.
- `router/debug.ts`: use Node `readFile`.
- `router/notes.ts`: classify `ENOENT` with `hasFsErrorCode`.
- `app.ts`, `auth.ts`, `ai/openrouter.ts`, and `tts/elevenlabs.ts`: replace `Deno.env.get(name)` with `process.env[name]` or the corresponding property.
- In `db/url.ts`, `drizzle.config.ts`, and `images.ts`, rewrite active comments that name Deno commands, Deno errors, or Deno file APIs so they describe the portable behavior and canonical Bun command without changing the documented guarantees.

For `images.ts` directory iteration, replace each async Deno iterator with a Node array:

```ts
let userDirs;
try {
  userDirs = await readdir(DRAFTS_DIR, { withFileTypes: true });
} catch (error) {
  if (hasFsErrorCode(error, "ENOENT")) return 0;
  throw error;
}

for (const userDir of userDirs) {
  if (!userDir.isDirectory()) continue;
  const path = `${DRAFTS_DIR}/${userDir.name}`;

  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (referenced.has(entry.name.replace(/\.png$/, ""))) continue;
    const file = `${path}/${entry.name}`;
    const info = await stat(file);
    const modified = info.mtime?.getTime() ?? now;
    if (now - modified <= maxAgeMs) continue;
    await rm(file);
    deleted++;
  }
}
```

- [ ] **Step 6: Convert test setup to Node-compatible APIs**

In all affected server tests, use this environment pattern:

```ts
const previousUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "file::memory:";

if (previousUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = previousUrl;
```

Use `node:fs/promises` for test reads/writes and construct errno fixtures like:

```ts
throw Object.assign(new Error("swept"), { code: "ENOENT" });
```

Replace Deno error-instance assertions with code assertions:

```ts
await expect(operation()).rejects.toMatchObject({ code: "ENOENT" });
```

The affected tests are `ai/openrouter.test.ts`, `audio.test.ts`,
`drizzle-config.test.ts`, `german-seed-media.integration.test.ts`,
`images.test.ts`, `router/notes.test.ts`, `tts/elevenlabs.test.ts`,
`write-audio.test.ts`, and `write-image.test.ts`.

- [ ] **Step 7: Prove the existing Deno safety net remains green**

Run:

```bash
deno task api:check
deno task api:test
```

Expected: server/shared type-checking passes and the existing Vitest suite is green. `rg -n '\bDeno\.' apps/server` reports only the runtime calls in `main.ts` and the `Deno.serve` explanatory comment in `ai/jobs.ts`; no other server source or test uses `Deno`.

- [ ] **Step 8: Commit the portable server boundary**

```bash
git add apps/server
git commit -m "refactor(server): use portable runtime APIs"
```

---

### Task 2: Move Workspace Ownership and Tests to Bun

**Files:**
- Create: `bunfig.toml`
- Create: `libs/shared/package.json`
- Create: `libs/shared/tsconfig.json`
- Create: `apps/server/package.json`
- Modify: `package.json`
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/jest.config.js`
- Modify: six mobile screen/layout test files with hoisted mock factories
- Modify: `apps/mobile/__tests__/draft-autosave.test.tsx`
- Modify: `apps/mobile/__tests__/draft-indicator-tab.test.tsx`
- Delete: `apps/mobile/__tests__/repository-test-task.test.ts`
- Generate: `bun.lock`

**Interfaces:**
- Consumes: portable server source from Task 1
- Produces: Bun workspace members `@mnimi/mobile`, `@mnimi/server`, and `@mnimi/shared`
- Produces: `@mnimi/shared` export `.` -> `./cloze.ts`
- Produces: root `bun run check`, `bun run test`, and scoped check/test routes

- [ ] **Step 1: Add Bun workspace policy and package ownership**

Create `bunfig.toml`:

```toml
env = false

[install]
auto = "disable"
linker = "hoisted"
```

Rewrite root `package.json` to this orchestration-only shape:

```json
{
  "name": "mnimi",
  "private": true,
  "version": "0.1.0",
  "packageManager": "bun@1.3.13",
  "workspaces": ["apps/*", "libs/*"],
  "scripts": {
    "check": "bun run --workspaces --sequential --if-present check",
    "test": "bun run --workspaces --sequential --if-present test",
    "mobile:check": "bun run --filter @mnimi/mobile check",
    "mobile:test": "bun run --filter @mnimi/mobile test",
    "server:check": "bun run --filter @mnimi/server check",
    "server:test": "bun run --filter @mnimi/server test",
    "shared:check": "bun run --filter @mnimi/shared check",
    "shared:test": "bun run --filter @mnimi/shared test"
  }
}
```

Create `libs/shared/package.json`:

```json
{
  "name": "@mnimi/shared",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./cloze.ts" },
  "scripts": {
    "check": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "~6.0.3",
    "vitest": "4.1.10"
  }
}
```

Create `libs/shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["*.ts"]
}
```

- [ ] **Step 2: Give the server a complete package manifest while retaining its Deno scripts temporarily**

Create `apps/server/package.json`:

```json
{
  "name": "@mnimi/server",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "check": "deno check .",
    "test": "deno run -A --no-lock --node-modules-dir=manual npm:vitest@4.1.10 run --config vitest.config.ts"
  },
  "dependencies": {
    "@libsql/client": "0.17.4",
    "@logtape/logtape": "2.3.0",
    "@mnimi/shared": "workspace:*",
    "@openrouter/sdk": "0.13.20",
    "@orpc/server": "1.14.14",
    "@tanstack/ai": "0.42.0",
    "@tanstack/ai-openrouter": "0.15.10",
    "better-auth": "1.6.26",
    "drizzle-orm": "0.45.2",
    "hono": "4.13.0",
    "uuidv7": "1.2.1",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/bun": "1.3.14",
    "@types/node": "^26.1.1",
    "drizzle-kit": "0.31.10",
    "typescript": "~6.0.3",
    "vitest": "4.1.10"
  }
}
```

This task deliberately keeps the two Deno script bodies until Task 3 changes the runtime. Bun already owns installation and routing.

- [ ] **Step 3: Consolidate the mobile manifest**

Keep the existing mobile identity fields and move every mobile dependency out of the root. Add these scripts:

```json
{
  "scripts": {
    "check": "tsc --noEmit",
    "test": "NODE_OPTIONS=--experimental-vm-modules jest --runInBand",
    "expo:config": "expo config --type public"
  }
}
```

Use this complete mobile dependency ownership; the root manifest must contain none of these packages:

```json
{
  "dependencies": {
    "@babel/runtime": "7.29.7",
    "@expo/vector-icons": "^15.1.1",
    "@orpc/client": "1.14.14",
    "@orpc/server": "1.14.14",
    "@orpc/tanstack-query": "1.14.14",
    "@react-native-community/netinfo": "^12.0.1",
    "@rn-primitives/alert-dialog": "1.5.2",
    "@rn-primitives/portal": "1.5.3",
    "@rn-primitives/slot": "1.5.2",
    "@tanstack/react-query": "^5.101.4",
    "babel-preset-expo": "~57.0.6",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "expo": "^57.0.12",
    "expo-asset": "~57.0.10",
    "expo-audio": "^57.0.3",
    "expo-constants": "~57.0.10",
    "expo-dev-client": "^57.0.11",
    "expo-file-system": "^57.0.2",
    "expo-font": "~57.0.1",
    "expo-linking": "~57.0.5",
    "expo-router": "^57.0.12",
    "expo-secure-store": "^57.0.1",
    "nativewind": "4.2.6",
    "react": "19.2.3",
    "react-dom": "19.2.3",
    "react-native": "0.86.2",
    "react-native-css-interop": "0.2.6",
    "react-native-reanimated": "4.5.1",
    "react-native-safe-area-context": "5.7.0",
    "react-native-worklets": "0.10.1",
    "tailwind-merge": "3.6.0",
    "tailwindcss-animate": "1.0.7",
    "ts-fsrs": "^5.4.1"
  },
  "devDependencies": {
    "@babel/plugin-transform-react-jsx": "7.29.7",
    "@testing-library/react-native": "^14.0.1",
    "@types/jest": "29.5.14",
    "@types/node": "^26.1.1",
    "@types/react": "^19.1.8",
    "jest": "29.7.0",
    "jest-expo": "^57.0.4",
    "tailwindcss": "3.4.17",
    "typescript": "~6.0.3"
  }
}
```

- [ ] **Step 4: Generate the Bun lock and verify the expected Jest failure before fixing tests**

Run:

```bash
bun install
bun run mobile:check
bun run mobile:test
```

Expected: install and mobile check pass. Jest fails in the six suites whose hoisted factories contain JSX or `React.createElement`. The obsolete repository task test also fails because it still parses root `deno.json`.

- [ ] **Step 5: Make hoisted Jest factories self-contained**

Update these files:

- `apps/mobile/__tests__/note-screen.test.tsx`
- `apps/mobile/__tests__/deck-detail-screen.test.tsx`
- `apps/mobile/__tests__/deck-list-screen.test.tsx`
- `apps/mobile/__tests__/layout-primitives.test.tsx`
- `apps/mobile/__tests__/navigation-shell.test.tsx`
- `apps/mobile/__tests__/review-screen.test.tsx`

Inside every affected `jest.mock` factory, obtain React within the factory and create elements through that local require call. Do not use JSX or an imported outer `React` binding inside the factory:

```ts
jest.mock("expo-router", () => {
  const react = require("react");
  const { Text } = require("react-native");

  return {
    Link: ({ children, href, asChild }: LinkProps) =>
      asChild
        ? react.cloneElement(children, { href })
        : react.createElement(Text, undefined, children),
  };
});
```

For JSX currently returned by the `expo-router/stack` and `expo-router/tabs` factories, use the same local `react.createElement(Component, props, children)` form.

- [ ] **Step 6: Clear every test-created QueryClient**

In both draft test files, add a tracked constructor and cleanup:

```ts
const queryClients: QueryClient[] = [];

function createTestQueryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClients.push(client);
  return client;
}

afterEach(() => {
  for (const client of queryClients) client.clear();
  queryClients.length = 0;
});
```

Replace each direct `new QueryClient(...)` in `draft-autosave.test.tsx` and `draft-indicator-tab.test.tsx` with `createTestQueryClient()`.

- [ ] **Step 7: Remove Deno-layout Jest configuration and the brittle task test**

Delete `apps/mobile/__tests__/repository-test-task.test.ts`.

In `apps/mobile/jest.config.js`, remove the `@mnimi/shared` source alias and the `.deno/` alternative from `transformIgnorePatterns`. Retain the React Native, Expo, NativeWind, Reusables, and Reanimated transform allowlist. The first pattern becomes:

```js
"node_modules/(?!((react-native|@react-native|@react-native-community|@rn-primitives|expo|@expo|react-navigation|@react-navigation|standard-navigation|nativewind|react-native-css-interop)/))"
```

- [ ] **Step 8: Verify Bun installation and member test ownership**

Run:

```bash
bun install --frozen-lockfile
bun run mobile:check
bun run mobile:test
bun run shared:check
bun run shared:test
bun run server:check
bun run server:test
bun run check
bun run test
bun pm untrusted
```

Expected: all checks and tests pass and exit. `bun pm untrusted` lists only `@openrouter/sdk`'s optional `check-types.js || true` postinstall; do not trust or execute it.

- [ ] **Step 9: Commit workspace ownership and Bun lock**

```bash
git add bunfig.toml bun.lock package.json apps/mobile/package.json \
  apps/mobile/jest.config.js apps/mobile/__tests__ apps/server/package.json \
  libs/shared/package.json libs/shared/tsconfig.json
git commit -m "refactor: move workspace ownership to bun"
```

---

### Task 3: Run the Server on Bun with Package-Local Environment

**Files:**
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/scripts/runtime-smoke.ts`
- Create: `apps/mobile/.env.example`
- Create: `apps/server/.env.example`
- Modify: `apps/server/package.json`
- Modify: `apps/server/main.ts`
- Modify: `apps/server/vitest.config.ts`
- Modify: `apps/server/drizzle.config.ts`
- Modify: `apps/server/drizzle-config.test.ts`
- Delete: `.env.example`

**Interfaces:**
- Consumes: `resolveDatabaseUrl` and root-relative storage semantics from Task 1
- Consumes: Bun workspace dependencies from Task 2
- Produces: `Bun.serve({ hostname, port, fetch: app.fetch })`
- Produces: server scripts `dev`, `start`, `check`, `test`, and `db:*`
- Produces: runtime-smoke process exit `0` only after migration, HTTP response, and clean shutdown

- [ ] **Step 1: Add the server TypeScript contract**

Create `apps/server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun", "node"]
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 2: Replace the Deno entrypoint with Bun**

In `apps/server/main.ts`, preserve startup reconciliation and sweep scheduling, but change the argument and server boundary:

```ts
const devtoolsEnabled = process.argv.slice(2).includes("--devtools");
const options = serverOptions(process.env);

Bun.serve({
  hostname: options.hostname,
  port: options.port,
  fetch: app.fetch,
});
```

Update active source comments that say `Deno.serve` to say `Bun.serve` or "single server process" without changing their concurrency claims.

- [ ] **Step 3: Make Vitest and Drizzle package-local**

Rewrite `apps/server/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { DATABASE_URL: "file::memory:" },
    include: ["**/*.test.ts"],
  },
});
```

Change Drizzle paths to package-local values:

```ts
export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
});
```

Update `drizzle-config.test.ts` to assert `schema: "./db/schema.ts"`, `out: "./drizzle"`, and the memory URL.

- [ ] **Step 4: Split the environment examples**

Create `apps/mobile/.env.example`:

```dotenv
# Compiled into the public client bundle. Never put secrets in EXPO_PUBLIC_*.
# Android development builds may use a reachable private LAN address.
EXPO_PUBLIC_API_URL=http://192.168.1.20:8787
```

Create `apps/server/.env.example` by moving every existing non-mobile variable from the root example. Preserve these values:

```dotenv
DATABASE_URL=file:./data/mnimi.db
BETTER_AUTH_SECRET=change-me-to-at-least-32-random-characters
BETTER_AUTH_URL=http://127.0.0.1:8787
IMAGES_DIR=./data/images
PORT=8787
HOST=0.0.0.0
OPENROUTER_API_KEY=sk-or-...
CLASSIFY_MODEL=~deepseek/deepseek-v4-flash-latest
CLASSIFY_EFFORT=low
GENERATE_MODEL=~deepseek/deepseek-v4-flash-latest
GENERATE_EFFORT=high
IMAGE_MODEL=black-forest-labs/flux.2-klein-4b
ELEVENLABS_API_KEY=
ELEVENLABS_MODEL=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
AUDIO_DIR=./data/audio
```

State that relative filesystem values resolve from the repository root. Delete the root `.env.example`; do not inspect or modify the ignored root `.env`.

- [ ] **Step 5: Write the Bun runtime smoke test**

Create `apps/server/scripts/runtime-smoke.ts` with this port allocator:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  return address.port;
}
```

The main body must:

1. create a temp directory and database path;
2. run `bun run db:migrate` with an explicit temporary `DATABASE_URL`;
3. spawn `bun main.ts` with `HOST=127.0.0.1`, the allocated `PORT`, temporary image/audio directories, and a test auth secret;
4. retry `fetch(http://127.0.0.1:<port>/)` until it receives the expected 404 or a five-second deadline expires;
5. retain at most the final 100 lines of server stdout/stderr for failure diagnostics;
6. terminate and await the server in `finally`; and
7. recursively remove only the temp directory it created.

Use `Bun.spawn` with `stdin: "ignore"` and piped output. Never use the developer's configured database.

- [ ] **Step 6: Replace the temporary Deno server scripts**

Set `apps/server/package.json#scripts` to:

```json
{
  "dev": "bun --env-file=.env --watch main.ts --devtools",
  "start": "bun --env-file=.env main.ts",
  "check": "tsc --noEmit",
  "test": "vitest run && bun scripts/runtime-smoke.ts",
  "db:generate": "bun --env-file=.env run drizzle-kit generate --config drizzle.config.ts",
  "db:migrate": "bun --env-file=.env run drizzle-kit migrate --config drizzle.config.ts",
  "db:studio": "bun --env-file=.env run drizzle-kit studio --config drizzle.config.ts"
}
```

Explicit `--env-file=.env` overrides workspace `env = false` only for commands that consume server configuration. Tests supply their own isolated environment.

- [ ] **Step 7: Run server checks, tests, migration, and direct startup**

Run:

```bash
bun run server:check
bun run server:test
server_acceptance_dir="$(mktemp -d /tmp/mnimi-server-migration.XXXXXX)"
DATABASE_URL="file:${server_acceptance_dir}/mnimi.db" \
  bun run --filter @mnimi/server db:migrate
find "$server_acceptance_dir" -maxdepth 1 -type f -print
rm -rf -- "$server_acceptance_dir"
```

Expected: TypeScript, all server Vitest files, the Bun runtime smoke, and the explicit migration pass. Before removal, verify that the `mktemp` directory contains only the acceptance database and its SQLite sidecars; `rm` targets that exact generated directory only.

- [ ] **Step 8: Commit the Bun server runtime**

```bash
git add apps/server apps/mobile/.env.example .env.example
git commit -m "refactor(server): run the API on bun"
```

---

### Task 4: Complete Bun Commands, Development Orchestration, and Toolchain Cutover

**Files:**
- Create: `scripts/dev.mjs`
- Create: `scripts/dev.test.ts`
- Create: `apps/mobile/scripts/build-android.test.ts`
- Modify: `package.json`
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/scripts/build-android.ts`
- Modify: `apps/mobile/e2e/validate-api-url.ts`
- Modify: `apps/mobile/e2e/android-smoke.sh`
- Modify: `apps/mobile/__tests__/android-smoke-script.test.ts`
- Modify: `.gitignore`
- Modify: `mise.toml`
- Modify: `AGENTS.md`
- Delete: `apps/mobile/scripts/run-expo-doctor.ts`
- Delete: `apps/mobile/src/types/deno.d.ts`
- Delete: `deno.json`
- Delete: `deno.lock`
- Delete: `apps/mobile/deno.json`
- Delete: `apps/server/deno.json`
- Delete: `libs/shared/deno.json`

**Interfaces:**
- Consumes: final member scripts from Tasks 2-3
- Produces: full root command catalog from the approved spec
- Produces: `runDev(options?): Promise<number>` in `scripts/dev.mjs`
- Produces: `buildAndroid(options?): Promise<void>` in the mobile build helper
- Produces: Bun-only contributor/toolchain policy

- [ ] **Step 1: Write failing development-runner tests**

Create `scripts/dev.test.ts` with `bun:test`. Define a fake child as:

```ts
type FakeChild = {
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
};

function controlledChild() {
  let finish!: (code: number) => void;
  let killed = false;
  const child: FakeChild = {
    exited: new Promise<number>((resolve) => finish = resolve),
    kill: () => {
      killed = true;
      finish(0);
    },
  };
  return { child, finish, killed: () => killed };
}
```

Inject a spawn function that records `{ command, options }` and returns the server fake on the first call and mobile fake on the second. Cover:

```ts
import { describe, expect, it } from "bun:test";
import { runDev } from "./dev.mjs";

describe("runDev", () => {
  it("gives Expo inherited stdio and keeps server output out of the TUI", async () => {
    const server = controlledChild();
    const mobile = controlledChild();
    const calls: Array<{ command: string[]; options: Record<string, unknown> }> = [];
    const result = runDev({
      installSignals: false,
      spawn: (command, options) => {
        calls.push({ command, options });
        return calls.length === 1 ? server.child : mobile.child;
      },
    });
    mobile.finish(0);
    expect(await result).toBe(0);
    expect(calls[0].command).toEqual(["bun", "run", "server:dev"]);
    expect(calls[0].options.stdin).toBe("ignore");
    expect(calls[1].command).toEqual(["bun", "run", "mobile:dev"]);
    expect(calls[1].options).toMatchObject({
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(server.killed()).toBe(true);
  });

  it("terminates Expo and fails when the server exits", async () => {
    const server = controlledChild();
    const mobile = controlledChild();
    let calls = 0;
    const result = runDev({
      installSignals: false,
      spawn: () => ++calls === 1 ? server.child : mobile.child,
    });
    server.finish(9);
    expect(await result).toBe(1);
    expect(mobile.killed()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the development-runner tests and verify they fail**

Run:

```bash
bun test scripts/dev.test.ts
```

Expected: FAIL because `scripts/dev.mjs` does not exist.

- [ ] **Step 3: Implement the root development runner**

Create `scripts/dev.mjs` and export `runDev(options = {})`. Destructure
`spawn = Bun.spawn`, `installSignals = true`, and
`logPath = new URL("../.dev/server.log", import.meta.url)` from `options`.

Implement these exact behaviors:

- create the `.dev` parent with `mkdir(dirname(fileURLToPath(logPath)), { recursive: true })`;
- truncate/open the log with `open(fileURLToPath(logPath), "w")` from `node:fs/promises`;
- spawn `["bun", "run", "server:dev"]` with ignored stdin and both output streams sent to the opened file descriptor;
- spawn `["bun", "run", "mobile:dev"]` with inherited stdio;
- install SIGINT/SIGTERM handlers only when `installSignals` is true;
- use an idempotent `stop(child)` helper so each sibling is terminated once;
- race tagged server/mobile exit promises;
- on server exit, stop Expo, print the log path, and return `1`;
- on Expo exit, stop the server and return Expo's status; and
- execute with `if (import.meta.main) process.exitCode = await runDev()`.

Close the file handle in `finally` after both children have settled. Add `/.dev/` to `.gitignore`.

- [ ] **Step 4: Verify the development-runner unit tests pass**

Run:

```bash
bun test scripts/dev.test.ts
```

Expected: both runner tests PASS and no child process remains.

- [ ] **Step 5: Write a failing Android build-helper test**

Create `apps/mobile/scripts/build-android.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildAndroid } from "./build-android.ts";

describe("buildAndroid", () => {
  it("runs installed Expo prebuild before the Gradle release build", async () => {
    const calls: Array<{
      command: string[];
      cwd: string;
      env: Record<string, string | undefined>;
    }> = [];
    await buildAndroid({
      run: async (command, options) => {
        calls.push({ command, ...options });
      },
    });

    expect(calls[0].command).toEqual([
      "bun", "run", "--no-install", "expo", "prebuild",
      "--platform", "android", "--no-clean", "--no-install",
      "--skip-dependency-update", "expo,react,react-native",
    ]);
    expect(calls[0].env).toMatchObject({ CI: "1" });
    const androidDir = join(calls[1].cwd, "android");
    expect(calls[1].command).toEqual([
      join(androidDir, "gradlew"),
      "-p",
      androidDir,
      "assembleRelease",
      "--no-daemon",
    ]);
  });
});
```

- [ ] **Step 6: Run the build-helper test and verify the Deno implementation fails**

Run:

```bash
bun test apps/mobile/scripts/build-android.test.ts
```

Expected: FAIL because `buildAndroid` is not exported and the file uses `Deno.Command`.

- [ ] **Step 7: Rewrite the Android helper around Bun.spawn**

Keep the existing module-derived mobile root. Export:

```ts
type RunOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
};
type RunCommand = (command: string[], options: RunOptions) => Promise<void>;

export async function buildAndroid(
  { run = runCommand }: { run?: RunCommand } = {},
): Promise<void>;
```

`runCommand` calls `Bun.spawn` with ignored stdin, inherited output, the supplied cwd/env, awaits `child.exited`, and throws an error containing the command and exit code on failure. `buildAndroid` runs the two commands asserted by the test, passing `{ ...process.env, CI: "1" }` to prebuild and `{ ...process.env, NODE_ENV: "production", CI: "1" }` to Gradle. Execute it only under `if (import.meta.main)` and set `process.exitCode = 1` after logging a caught error.

- [ ] **Step 8: Convert the Android smoke launcher to canonical Bun commands**

In `validate-api-url.ts`, use:

```ts
const rawApiUrl = process.argv[2] ?? "";
```

Keep `isPrivateIpv4`, `isLoopbackOrWildcard`, the `getApiUrl` call, and both
validation branches byte-for-byte except for the runtime boundary. In the
existing `catch`, keep the error message and replace `Deno.exit(64)` with
`process.exitCode = 64`.

In `android-smoke.sh`, replace the Deno validator call with `bun run "$script_dir/validate-api-url.ts"`, remove its duplicate background API process and trap, and finish with:

```bash
cd "$repo_root"
HOST=0.0.0.0 bun run dev
```

Preserve `--check`, usage exit 64, LAN URL validation, and inherited `EXPO_PUBLIC_API_URL`. Retain every case in `android-smoke-script.test.ts`.

- [ ] **Step 9: Publish the complete root and mobile command catalogs**

Set mobile scripts to:

```json
{
  "dev": "expo start --dev-client",
  "android": "expo run:android",
  "check": "tsc --noEmit",
  "test": "NODE_OPTIONS=--experimental-vm-modules jest --runInBand && bun test ./scripts/build-android.test.ts",
  "smoke": "bash e2e/android-smoke.sh",
  "build:android": "bun --env-file=.env scripts/build-android.ts",
  "expo:config": "expo config --type public"
}
```

Set root scripts to:

```json
{
  "dev": "bun scripts/dev.mjs",
  "check": "bun run --workspaces --sequential --if-present check",
  "test": "bun test ./scripts/dev.test.ts && bun run --workspaces --sequential --if-present test",
  "mobile:dev": "bun run --filter @mnimi/mobile dev",
  "mobile:android": "bun run --filter @mnimi/mobile android",
  "mobile:check": "bun run --filter @mnimi/mobile check",
  "mobile:test": "bun run --filter @mnimi/mobile test",
  "mobile:smoke": "bun run --filter @mnimi/mobile smoke",
  "mobile:build:android": "bun run --filter @mnimi/mobile build:android",
  "server:dev": "bun run --filter @mnimi/server dev",
  "server:start": "bun run --filter @mnimi/server start",
  "server:check": "bun run --filter @mnimi/server check",
  "server:test": "bun run --filter @mnimi/server test",
  "shared:check": "bun run --filter @mnimi/shared check",
  "shared:test": "bun run --filter @mnimi/shared test",
  "db:generate": "bun run --filter @mnimi/server db:generate",
  "db:migrate": "bun run --filter @mnimi/server db:migrate",
  "db:studio": "bun run --filter @mnimi/server db:studio"
}
```

- [ ] **Step 10: Remove Deno and pin the final mise toolchain**

Delete every file listed in this task's Delete section. Set `mise.toml` tools to:

```toml
[tools]
node = "24.15.0"
bun = "1.3.13"
java = "17.0.2"
android-sdk = "1.0"
```

Retain the Android NDK environment block unchanged. Update `AGENTS.md` to:

```md
- Use `bun` for package management and public script execution in this project.
  Do not use `npm`, `npx`, Yarn, pnpm, or Deno. Node-backed CLIs invoked by
  `bun run` are an implementation detail of the declared scripts.
```

- [ ] **Step 11: Verify the complete local command surface**

Run:

```bash
bun install --frozen-lockfile
bun run check
bun run test
bun run mobile:smoke --check
bun run --filter @mnimi/mobile expo:config
rg -n '\bDeno\.|deno (task|run|install)|mobile:doctor' \
  package.json bunfig.toml mise.toml AGENTS.md .github apps libs scripts README.md
```

Expected: install/check/test/smoke/config pass. The search reports only active documentation not yet migrated in Task 5; source and executable configuration contain no Deno or doctor references.

- [ ] **Step 12: Commit the completed Bun toolchain cutover**

```bash
git add package.json bun.lock bunfig.toml mise.toml AGENTS.md .gitignore \
  scripts apps/mobile deno.json deno.lock apps/server/deno.json \
  libs/shared/deno.json
git commit -m "refactor: complete bun toolchain migration"
```

---

### Task 5: Update CI and Active Developer Documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `apps/mobile/e2e/android-smoke.md`
- Modify: `libs/shared/cloze.ts`
- Modify: `apps/server/db/migrations.test.ts`
- Modify: `apps/server/db/schema.ts`

**Interfaces:**
- Consumes: final command catalog from Task 4
- Produces: CI contract `bun install --frozen-lockfile`, `bun run check`, `bun run test`
- Produces: setup instructions for package-local mobile/server env files

- [ ] **Step 1: Replace CI's Deno install/cache and duplicated commands**

Keep checkout and `jdx/mise-action`. Change the verification body to:

```yaml
      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Check workspace
        run: bun run check

      - name: Test workspace
        run: bun run test
```

Rename the job from “API and native tests” to “Workspace checks and tests.” Do not list member commands separately and do not cache Deno.

- [ ] **Step 2: Rewrite README setup and command documentation**

Document this exact first-run flow:

```bash
mise install
bun install --frozen-lockfile
cp apps/mobile/.env.example apps/mobile/.env
cp apps/server/.env.example apps/server/.env
bun run db:migrate
bun run dev
```

Explain that an existing ignored root `.env` must be split between the two package files and is no longer read. Never suggest copying server secrets into the mobile environment.

List these canonical commands:

```bash
bun run server:dev
bun run mobile:dev
bun run mobile:android
bun run check
bun run test
bun run mobile:build:android
bun run mobile:smoke
```

State that Bun owns installation, scripts, and server runtime while Node remains an Expo/test CLI prerequisite managed by mise. Remove all claims that Deno owns package management or `deno.lock`.

- [ ] **Step 3: Update the Android acceptance guide**

Change its setup to:

```bash
cp apps/mobile/.env.example apps/mobile/.env
cp apps/server/.env.example apps/server/.env
bun run db:migrate
bun run mobile:android
bun run mobile:smoke
```

Retain the physical-device, LAN-address, HTTPS production, and acceptance checklists unchanged.

- [ ] **Step 4: Update the remaining active source comments**

Replace the task reference in `libs/shared/cloze.ts` with `bun run shared:check`.
In `apps/server/db/migrations.test.ts`, describe the SQL as what `bun run
db:migrate` executes. In `apps/server/db/schema.ts`, describe the schema shape
as matching Better Auth's SQLite generator without embedding a package-runner
command. Do not alter executable code or historical documentation.

- [ ] **Step 5: Prove active documentation contains only canonical commands**

Run:

```bash
rg -n 'deno (task|run|install)|mobile:doctor|mobile:run-android|api:(dev|start|check|test)' \
  README.md AGENTS.md .github apps libs scripts package.json mise.toml
```

Expected: no matches. Do not search historical `docs/superpowers/{plans,specs}` because those files intentionally record old commands.

- [ ] **Step 6: Run CI-equivalent verification and commit docs/CI**

Run:

```bash
bun install --frozen-lockfile
bun run check
bun run test
git diff --check
```

Expected: all pass.

```bash
git add .github/workflows/ci.yml README.md apps/mobile/e2e/android-smoke.md \
  libs/shared/cloze.ts apps/server/db/migrations.test.ts \
  apps/server/db/schema.ts
git commit -m "docs: publish bun workspace workflow"
```

---

### Task 6: Prove the Migration from a Clean Install

**Files:**
- Verify only; modify `bun.lock` or manifests only after identifying a specific missing declaration and adding a regression test in the task that owns that dependency

**Interfaces:**
- Consumes: the complete Bun workspace from Tasks 1-5
- Produces: release-level evidence for frozen install, runtime, tests, Expo, Drizzle, development orchestration, and Android build

- [ ] **Step 1: Record the final repository and tool state**

Run:

```bash
git status --short
bun --version
node --version
mise current
find . -path '*/node_modules' -prune -o \
  \( -name 'bun.lock*' -o -name 'deno.lock' -o -name 'pnpm-lock.yaml' \
  -o -name 'package-lock.json' \) -print
```

Expected: worktree clean, Bun 1.3.13, Node 24.15.0, and only root `bun.lock`.

- [ ] **Step 2: Move installed dependencies aside and perform a frozen install**

Resolve the exact installation directories first:

```bash
find . -path '*/node_modules' -type d -prune -print
```

Create a temporary backup and move only the four expected installation directories that exist; preserve their relative paths so the pre-verification installation is recoverable:

```bash
install_backup="$(mktemp -d /tmp/mnimi-node-modules.XXXXXX)"
for install_dir in node_modules apps/mobile/node_modules \
  apps/server/node_modules libs/shared/node_modules; do
  if [ -d "$install_dir" ]; then
    mkdir -p "$install_backup/$(dirname "$install_dir")"
    mv "$install_dir" "$install_backup/$install_dir"
  fi
done
find "$install_backup" -path '*/node_modules' -type d -prune -print
```

Confirm the second `find` accounts for every directory reported by the first, then run:

```bash
bun install --frozen-lockfile
bun pm untrusted
```

Expected: the frozen install succeeds. The only blocked lifecycle script is the optional OpenRouter type check.

- [ ] **Step 3: Run aggregate and member-local checks/tests**

Run:

```bash
bun run check
bun run test
(cd apps/mobile && bun run check && bun run test)
(cd apps/server && bun run check && bun run test)
(cd libs/shared && bun run check && bun run test)
```

Expected: every command passes and exits without a leaked process or timer.

- [ ] **Step 4: Prove Expo and workspace resolution**

Run:

```bash
(cd apps/mobile && bun run expo:config)
(cd apps/server && bun -e 'import("@mnimi/shared").then(() => console.log("shared-ok"))')
```

Expected: Expo prints a valid SDK 57 public config and the server prints `shared-ok` without an alias.

- [ ] **Step 5: Prove Drizzle against an isolated database**

Create a uniquely named temporary directory, then run:

```bash
database_acceptance_dir="$(mktemp -d /tmp/mnimi-bun-acceptance.XXXXXX)"
DATABASE_URL="file:${database_acceptance_dir}/mnimi.db" bun run db:migrate
DATABASE_URL="file:${database_acceptance_dir}/mnimi.db" \
  bun run --filter @mnimi/server db:migrate
find "$database_acceptance_dir" -maxdepth 1 -type f -print
```

Expected: both the root route and member-local command resolve the same package-local Drizzle config and complete successfully. After confirming the generated directory contains only the acceptance database and sidecars, remove it with `rm -rf -- "$database_acceptance_dir"`.

- [ ] **Step 6: Exercise combined development lifecycle**

Start `bun run dev` and confirm:

- Expo owns the visible terminal and accepts keyboard input;
- `.dev/server.log` records server startup;
- the API responds at its configured address; and
- Ctrl-C terminates both children.

Then run `PORT=invalid bun run dev` without editing either package `.env`. Confirm the server child exits, Expo is terminated, the root command returns non-zero, and stderr points to `.dev/server.log`.

- [ ] **Step 7: Build the Android release artifact**

Run:

```bash
bun run mobile:build:android
```

Expected: Expo prebuild uses installed dependencies without modifying manifests, Gradle `assembleRelease --no-daemon` succeeds, and the release APK is present under `apps/mobile/android/app/build/outputs/apk/release/`.

- [ ] **Step 8: Run final stale-reference and integrity checks**

Run:

```bash
rg -n '\bDeno\.|deno (task|run|install)|mobile:doctor|pnpm|npm run|npx ' \
  README.md AGENTS.md .github apps libs scripts package.json bunfig.toml mise.toml
git diff --check
git status --short
```

Expected: no obsolete active-workflow matches, no whitespace errors, and a clean worktree. Historical plan/spec references are intentionally excluded.

- [ ] **Step 9: Record verification evidence**

Add no verification-only commit. Report the exact passing commands, test counts, Bun/Node versions, Android artifact path, and any physical-device acceptance step that could not be executed. If source or a manifest changed during diagnosis, return to the owning task, add a focused regression test, commit that fix, and repeat all of Task 6.
