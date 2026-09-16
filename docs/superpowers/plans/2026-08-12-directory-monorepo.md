# Directory Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the frontend, API, and shared code into named `apps/*` and `libs/*` Deno workspace members while preserving the existing root Deno developer experience.

**Architecture:** The root remains the sole dependency and task coordinator. `apps/app`, `apps/server`, and `libs/shared` become named workspace members; package-local source and configuration move with their owner. Root tasks explicitly target package-local config and entrypoints, while `.env`, `deno.lock`, `package.json`, and runtime `data/` remain at the root.

**Tech Stack:** Deno 2.9.3, Vite 7, Vitest 4, TypeScript 5.8, React 19, Tauri 2, Hono, Drizzle.

## Global Constraints

- Use `deno` for all package management and script execution; never use `npm`, `npx`, `yarn`, or `pnpm`.
- Keep one root `deno.lock`, root `package.json`, root `.env`/`.env.example`, and root `data/`.
- Preserve the public package identifier `@mnimi/shared`; introduce `@mnimi/app` and `@mnimi/server`.
- Preserve all existing behavior and root command names; only paths and configuration locations change.
- Do not modify the values in `.env` or move/delete root `data/`.

---

### Task 1: Define workspace package boundaries and root commands

**Files:**
- Modify: `deno.json`
- Create: `apps/app/deno.json`
- Create: `apps/server/deno.json`
- Create: `libs/shared/deno.json`
- Delete: `server/deno.json`
- Delete: `shared/deno.json`

**Interfaces:**
- Consumes: root dependency declarations in `package.json` and root `.env`.
- Produces: workspace packages named `@mnimi/app`, `@mnimi/server`, and `@mnimi/shared`; root tasks target `apps/app` and `apps/server`.

- [ ] **Step 1: Add a failing workspace-layout test**

Create `apps/app/workspace-layout.test.ts` that asserts the workspace declaration and package metadata are the intended public contract:

```ts
import { assertEquals } from "jsr:@std/assert";

Deno.test("the root exposes the three named workspace members", async () => {
  const root = JSON.parse(await Deno.readTextFile("deno.json"));
  assertEquals(root.workspace, ["./apps/app", "./apps/server", "./libs/shared"]);
  for (const [path, name] of [
    ["apps/app/deno.json", "@mnimi/app"],
    ["apps/server/deno.json", "@mnimi/server"],
    ["libs/shared/deno.json", "@mnimi/shared"],
  ]) {
    assertEquals(JSON.parse(await Deno.readTextFile(path)).name, name);
  }
});
```

- [ ] **Step 2: Run the layout test and verify it fails because the new paths do not exist**

Run: `deno test -A apps/app/workspace-layout.test.ts`

Expected: FAIL with a missing `apps/app/deno.json` or mismatched workspace assertion.

- [ ] **Step 3: Create named member metadata and update root tasks**

Set the root workspace to the three directories and update each task path without changing its meaning:

```json
{
  "workspace": ["./apps/app", "./apps/server", "./libs/shared"],
  "minimumDependencyAge": "0",
  "tasks": {
    "dev": "deno run -A npm:concurrently@9 --kill-others -n web,api -c cyan,magenta \"deno task dev:web\" \"deno task dev:api\"",
    "dev:web": "cd apps/app && vite",
    "dev:api": "deno run -A --env-file --watch apps/server/main.ts --devtools",
    "start": "deno run -A --env-file apps/server/main.ts",
    "build": "deno task routes:generate && cd apps/app && tsc && vite build",
    "check:api": "deno check apps/server/**/*.ts",
    "routes:generate": "cd apps/app && tsr generate",
    "preview": "cd apps/app && vite preview",
    "tauri": "tauri --config apps/app/src-tauri/tauri.conf.json",
    "test": "cd apps/app && vitest run",
    "test:watch": "cd apps/app && vitest",
    "db:generate": "deno run -A --env-file npm:drizzle-kit@0.31.10 generate --config apps/server/drizzle.config.ts",
    "db:migrate": "deno run -A --env-file npm:drizzle-kit@0.31.10 migrate --config apps/server/drizzle.config.ts",
    "db:studio": "deno run -A --env-file npm:drizzle-kit@0.31.10 studio --config apps/server/drizzle.config.ts"
  }
}
```

Create metadata retaining the current server-only imports and shared export:

```json
// apps/app/deno.json
{ "name": "@mnimi/app", "version": "0.1.0" }

// apps/server/deno.json
{
  "name": "@mnimi/server",
  "version": "0.1.0",
  "imports": {
    "@logtape/logtape": "npm:@logtape/logtape@2.3.0",
    "@openrouter/sdk": "npm:@openrouter/sdk@0.13.20",
    "@tanstack/ai": "npm:@tanstack/ai@0.42.0",
    "@tanstack/ai-openrouter": "npm:@tanstack/ai-openrouter@0.15.10",
    "hono": "npm:hono@4.13.0"
  }
}

// libs/shared/deno.json
{ "name": "@mnimi/shared", "version": "0.1.0", "exports": { ".": "./cloze.ts" } }
```

Delete the superseded `server/deno.json` and `shared/deno.json` only after their contents have been preserved in the corresponding new metadata files.

- [ ] **Step 4: Run the workspace-layout test and verify it passes**

Run: `deno test -A apps/app/workspace-layout.test.ts`

Expected: PASS.

- [ ] **Step 5: Confirm dependency topology is still singular**

Run:

```bash
deno install
test -f deno.lock
test ! -e apps/app/deno.lock
test ! -e apps/server/deno.lock
test ! -e libs/shared/deno.lock
```

Expected: exit code 0; no package-local lockfile is created.

- [ ] **Step 6: Commit the workspace contract**

```bash
git add deno.json apps/app/deno.json apps/server/deno.json libs/shared/deno.json apps/app/workspace-layout.test.ts server/deno.json shared/deno.json
git commit -m "refactor: define named monorepo packages"
```

### Task 2: Move the shared and server packages with path-safe database tooling

**Files:**
- Move: `shared/cloze.ts` → `libs/shared/cloze.ts`
- Move: `shared/cloze.test.ts` → `libs/shared/cloze.test.ts`
- Move: `server/` source, tests, `db/`, `drizzle/`, `ai/`, `router/`, `tts/`, and `devtools/` → `apps/server/`
- Move: `server/drizzle.config.ts` → `apps/server/drizzle.config.ts`
- Modify: `vite.config.ts`
- Modify: `vitest.config.ts`
- Modify: `tsconfig.json`
- Modify: `apps/server/drizzle.config.ts`
- Modify: `apps/server/devtools/german-seed.ts`
- Modify: all server test comments/error strings containing `server/`

**Interfaces:**
- Consumes: Task 1 workspace names and root database tasks.
- Produces: `@mnimi/shared` still resolves its `parseCloze`, `revealCloze`, and related types; API entrypoint is `apps/server/main.ts`; migrations are under `apps/server/drizzle/`.

- [ ] **Step 1: Add a failing Drizzle configuration test**

Create `apps/server/drizzle-config.test.ts`:

```ts
import { expect, test } from "vitest";
import config from "./drizzle.config.ts";

test("Drizzle paths target the relocated server package from the root", () => {
  expect(config.schema).toBe("./apps/server/db/schema.ts");
  expect(config.out).toBe("./apps/server/drizzle");
});
```

- [ ] **Step 2: Run the test and verify it fails before the configuration is retargeted**

Run: `deno task test -- apps/server/drizzle-config.test.ts`

Expected: FAIL because the relocated config or its `schema`/`out` values are absent.

- [ ] **Step 3: Move package files without changing their module-relative imports**

Use `git mv` for the shared files and each server child. Preserve all relative imports, since source files keep their relationships within the moved package. Update only literals that model the repository root from a task's working directory:

```ts
// apps/server/drizzle.config.ts
export default defineConfig({
  dialect: "sqlite",
  schema: "./apps/server/db/schema.ts",
  out: "./apps/server/drizzle",
  dbCredentials: { url: databaseUrl },
});

// apps/server/devtools/german-seed.ts fallback branch
`${Deno.cwd()}/apps/server/devtools/seed-assets/german/${asset}`;
```

Update the still-root frontend configuration at the same time so this task is independently testable: point its `~server` and `@mnimi/shared` aliases at `./apps/server` and `./libs/shared/cloze.ts`; point Vitest's shared/server include patterns at `libs/shared/**` and `apps/server/**`; and change the root `tsconfig.json` `~server/*` and `@mnimi/shared` paths to `./apps/server/*` and `./libs/shared/cloze.ts`. Update test descriptions and developer errors that identify source paths to say `apps/server/...`; do not change tests that assert application behavior.

- [ ] **Step 4: Run the focused moved-package tests**

Run:

```bash
deno task test -- libs/shared/cloze.test.ts apps/server/drizzle-config.test.ts apps/server/devtools/german-seed.test.ts
deno task check:api
```

Expected: all focused tests and the API typecheck PASS.

- [ ] **Step 5: Verify database migration targeting without modifying the tracked runtime data**

Run: `deno task db:migrate`

Expected: drizzle-kit loads `apps/server/drizzle.config.ts`, uses root `.env`, and migrates the root `data/` location. Do not delete or recreate `data/` as part of this check.

- [ ] **Step 6: Commit the shared/API move**

```bash
git add -A apps/server libs/shared server shared vite.config.ts vitest.config.ts tsconfig.json
git commit -m "refactor: move shared and server packages"
```

### Task 3: Move the app and localize frontend tooling

**Files:**
- Move: `src/` → `apps/app/src/`
- Move: `public/` → `apps/app/public/`
- Move: `src-tauri/` → `apps/app/src-tauri/`
- Move: `index.html` → `apps/app/index.html`
- Move: `vite.config.ts` → `apps/app/vite.config.ts`
- Move: `vitest.config.ts` → `apps/app/vitest.config.ts`
- Move: `tsconfig.json` → `apps/app/tsconfig.json`
- Move: `tsconfig.node.json` → `apps/app/tsconfig.node.json`
- Modify: `apps/app/vite.config.ts`
- Modify: `apps/app/vitest.config.ts`
- Modify: `apps/app/tsconfig.json`
- Modify: `apps/app/src-tauri/tauri.conf.json`
- Modify: `components.json`

**Interfaces:**
- Consumes: relocated API at `apps/server` and shared package at `libs/shared`.
- Produces: frontend root is `apps/app`; aliases `@` and `~server` resolve to `apps/app/src` and `apps/server`; Vite and Vitest are invoked through package-local configuration.

- [ ] **Step 1: Add a failing frontend layout test**

Create `apps/app/frontend-layout.test.ts`:

```ts
import { expect, test } from "vitest";
import viteConfig from "./vite.config.ts";

test("frontend aliases resolve to app and server package paths", () => {
  expect(viteConfig.resolve?.alias).toMatchObject({
    "@": expect.stringContaining("apps/app/src"),
    "~server": expect.stringContaining("apps/server"),
  });
});
```

- [ ] **Step 2: Run the layout test and verify it fails before aliases are retargeted**

Run: `deno task test -- frontend-layout.test.ts`

Expected: FAIL because the migrated config or its relocated aliases are absent.

- [ ] **Step 3: Move frontend files and retarget paths**

Move the listed app directories/files with `git mv`. In `apps/app/vite.config.ts` and `apps/app/vitest.config.ts`, preserve the existing `@mnimi/shared` source alias (Vite/Vitest do not consume Deno workspace exports directly) and retarget it to `../../libs/shared/cloze.ts`; set the remaining aliases using the config directory:

```ts
alias: {
  "@": path.resolve(__dirname, "./src"),
  "~server": path.resolve(__dirname, "../server"),
  "@mnimi/shared": path.resolve(__dirname, "../../libs/shared/cloze.ts"),
}
```

Change Vitest includes to:

```ts
include: [
  "../../libs/shared/**/*.test.ts",
  "src/**/*.test.ts",
  "src/**/*.test.tsx",
  "../server/**/*.test.ts",
],
```

Set `apps/app/tsconfig.json` aliases to `@/*: ["./src/*"]` and `~server/*: ["../server/*"]`, change `include` to `["src"]`, and retain its node-config reference as `./tsconfig.node.json`.

Update `apps/app/index.html` to load `/src/main.tsx`, which remains correct because Vite runs from `apps/app`. Keep Tauri `frontendDist` as `../dist`, which resolves from `apps/app/src-tauri/` to the app package's Vite output. Update `components.json`'s Tailwind CSS location to `apps/app/src/index.css`.

- [ ] **Step 4: Run focused frontend checks**

Run:

```bash
deno task test -- frontend-layout.test.ts src/lib/server-boundary.test.ts
deno task routes:generate
deno task build
```

Expected: focused tests, route generation, and build all PASS; the build emits `apps/app/dist/`.

- [ ] **Step 5: Commit the app move**

```bash
git add -A apps/app src public src-tauri index.html vite.config.ts vitest.config.ts tsconfig.json tsconfig.node.json components.json
git commit -m "refactor: move frontend into app package"
```

### Task 4: Update repository integration and documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: references in `apps/app/src/**` and `apps/server/**` that present repository paths to users/developers

**Interfaces:**
- Consumes: final workspace layout and root task names from Tasks 1–3.
- Produces: CI caches/builds the relocated Tauri app, and contributor documentation describes the new paths without changing setup/run commands.

- [ ] **Step 1: Add a failing documentation-contract test**

Create `apps/app/repository-docs.test.ts`:

```ts
import { expect, test } from "vitest";

test("README documents the named package layout", async () => {
  const readme = await Deno.readTextFile("README.md");
  expect(readme).toContain("apps/app/");
  expect(readme).toContain("apps/server/");
  expect(readme).toContain("libs/shared/");
  expect(readme).not.toContain("\nsrc/\n");
  expect(readme).not.toContain("\nserver/\n");
});
```

- [ ] **Step 2: Run the documentation-contract test and verify it fails against the old layout description**

Run: `deno task test -- repository-docs.test.ts`

Expected: FAIL because README still presents top-level `src/`, `server/`, and `shared/` paths.

- [ ] **Step 3: Update CI and the README**

Set the Rust cache workspace to `apps/app/src-tauri`. In README, replace all source-path references with the new locations and replace the Layout tree with:

```text
apps/
  app/             # @mnimi/app: Vite, React, Tauri, routes, components and tests
  server/          # @mnimi/server: Hono, Drizzle, oRPC, AI, TTS and tests
libs/
  shared/          # @mnimi/shared: framework-neutral cloze logic
data/              # root-level SQLite database and generated media (gitignored)
```

Keep the existing root setup, run, test, Android, and environment commands unchanged. Update every cited file path in explanatory prose, including the Android server reference, API architecture references, and source/test-layout references.

- [ ] **Step 4: Run the documentation test and full regression suite**

Run:

```bash
deno task test -- repository-docs.test.ts
deno task test
deno task check:api
deno task build
git diff --check
```

Expected: every command exits 0 and all tests pass.

- [ ] **Step 5: Commit integration updates**

```bash
git add .github/workflows/ci.yml README.md apps/app apps/server
git commit -m "docs: document directory monorepo"
```

### Task 5: Perform final workspace verification

**Files:**
- Verify only: root task and workspace configuration

**Interfaces:**
- Consumes: all migrated packages and updated documentation.
- Produces: evidence that contributors can use the same Deno-first workflow after the move.

- [ ] **Step 1: Check for retired top-level project directories**

Run:

```bash
test ! -e src
test ! -e server
test ! -e shared
test ! -e public
test ! -e src-tauri
test ! -e index.html
```

Expected: exit code 0; all project-owned source paths are under `apps/` or `libs/`.

- [ ] **Step 2: Verify package and task discovery**

Run:

```bash
deno info --json apps/app/deno.json
deno info --json apps/server/deno.json
deno info --json libs/shared/deno.json
deno task test
deno task check:api
deno task build
```

Expected: Deno resolves all three workspace members and the full suite, server typecheck, and production build pass from the root.

- [ ] **Step 3: Smoke-test the combined development command**

Run: `timeout 20 deno task dev`

Expected: output shows both `web` and `api` processes start. `timeout` ends the foreground processes after confirming startup; do not treat that intentional timeout exit as a failure.

- [ ] **Step 4: Review the final diff and commit verification evidence only if there are intentional documentation/test edits left**

Run:

```bash
git status --short
git diff --check HEAD~4..HEAD
git log --oneline -4
```

Expected: only the four migration commits from this plan are present, with no generated data, lockfile duplication, or untracked build output.
