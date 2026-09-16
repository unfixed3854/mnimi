# Monorepo DX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the repo's two dependency graphs, two env files, two dev processes and two task files into one of each, closing issue #5.

**Architecture:** Make the repo a Deno workspace with `server/` as its only member, so one `deno install` at the root produces one `deno.lock` and one `node_modules`. Move every task into the root `deno.json`, which makes tasks run at the repo root and lets a single root `.env` serve Vite, the server and drizzle-kit through a bare `--env-file`. A `dev` task runs the Vite and API processes together under `concurrently`.

**Tech Stack:** Deno 2.9.3 (pinned in `mise.toml`), Vite 7, Vitest 4, drizzle-kit 0.31.10, `npm:concurrently@9`.

## Global Constraints

- **Use `deno` for all package management and script execution. Never `npm`, `npx`, `yarn` or `pnpm`.** (`AGENTS.md`) This applies to commands you run *and* to any command string you write into a config file.
- **This design spec is the source of truth:** `docs/superpowers/specs/2026-08-07-monorepo-dx-design.md`. Read it before starting.
- **Deno version is 2.9.3.** Every workspace behavior this plan relies on was verified against it. Do not upgrade Deno as part of this work.
- **No resolved dependency version may change.** This work deletes duplicated *pins*, it does not bump anything. If `deno install` wants to change a version in `deno.lock`, stop and report it.
- **The working tree is a git worktree.** `.env.local` and `server/.env` are **symlinks** into `/home/magmast/Projects/github.com/unfixed3854/mnimi/`. Removing a symlink is fine. **Never write to, truncate, or delete a symlink's target** — those are the developer's real secrets in the main checkout. Read them with `cat` (which follows the link) and remove the link with `rm` (which does not).
- **`server/data/mnimi.db` is a real 120 KB database, not a fixture.** It gets moved, never recreated or deleted.
- **Task boundaries keep the repo working.** After every task, `deno task test` and `deno task build` must pass and the app must still be startable. Do not batch tasks.

---

### Task 1: Deno workspace — one dependency graph

Makes `server/` a workspace member and deletes the eight pins duplicated between `server/deno.json` and the root `package.json`. Tasks stay where they are in this task, so every existing command keeps working exactly as before.

**Files:**
- Modify: `deno.json`
- Modify: `server/deno.json`
- Delete: `server/deno.lock`
- Delete: `server/node_modules/`

**Interfaces:**
- Consumes: nothing.
- Produces: a single root `node_modules` and `deno.lock`. Later tasks assume `deno install` at the root is the only install command.

- [ ] **Step 1: Record the current resolved versions so you can prove nothing moved**

This is the evidence for the "no resolved dependency version may change" constraint. Write the helper first — it reads the `npm` section of any number of lockfiles and prints a normalized, sorted `name@version` set:

```bash
cat > /tmp/mnimi-pkgs.ts <<'EOF'
// Normalized name@version set from one or more Deno lockfiles.
const names = new Set<string>();
for (const path of Deno.args) {
  let text: string;
  try { text = Deno.readTextFileSync(path); } catch { continue; }
  for (const key of Object.keys(JSON.parse(text).npm ?? {})) {
    // Strip the peer-dependency suffix: it legitimately changes when two
    // graphs merge, and is not a version change.
    names.add(key.split("_")[0]);
  }
}
console.log([...names].sort().join("\n"));
EOF
deno run -A --quiet /tmp/mnimi-pkgs.ts deno.lock server/deno.lock > /tmp/before.txt
wc -l < /tmp/before.txt
```

Expected: 689 packages. Take the union of *both* lockfiles here — that is the whole dependency set today, and it is what the single lockfile has to reproduce.

- [ ] **Step 2: Add the workspace declaration to the root `deno.json`**

Replace the whole file with:

```json
{
  "workspace": ["./server"],
  "minimumDependencyAge": "0"
}
```

- [ ] **Step 3: Strip `server/deno.json` to server-only imports**

Replace the whole file with the following. This deletes `nodeModulesDir` (the root `package.json` already creates `node_modules` at the workspace root; leaving this on the member is what would give it a second one), the eight shared pins, and — for now — nothing else. The `tasks` block stays so existing commands keep working; Task 3 moves it.

```json
{
  "imports": {
    "@openrouter/sdk": "npm:@openrouter/sdk@0.13.20",
    "@tanstack/ai": "npm:@tanstack/ai@0.42.0",
    "@tanstack/ai-openrouter": "npm:@tanstack/ai-openrouter@0.15.10",
    "hono": "npm:hono@4.13.0"
  },
  "tasks": {
    "dev": "deno run -A --env-file --watch main.ts",
    "start": "deno run -A --env-file main.ts",
    "db:generate": "deno run -A --env-file npm:drizzle-kit@0.31.10 generate",
    "db:migrate": "deno run -A --env-file npm:drizzle-kit@0.31.10 migrate"
  }
}
```

The eight deleted specifiers were `drizzle-orm`, `drizzle-orm/`, `@libsql/client`, `@orpc/client`, `@orpc/server`, `better-auth`, `uuidv7`, `zod` and `drizzle-kit`. Every one is already declared at an identical version in the root `package.json`, and a workspace member resolves bare specifiers from the workspace root's `package.json`.

- [ ] **Step 4: Delete the member's lockfile and `node_modules`**

```bash
rm -f server/deno.lock
rm -rf server/node_modules
```

- [ ] **Step 5: Reinstall from the root and confirm the member gets neither back**

```bash
deno install
ls -d node_modules && echo "root node_modules: OK"
test ! -e server/node_modules && echo "no server/node_modules: OK"
test ! -e server/deno.lock && echo "no server/deno.lock: OK"
```

Expected: all three lines print `OK`. If `server/node_modules` reappears, `nodeModulesDir` is still set somewhere in `server/deno.json`.

- [ ] **Step 6: Confirm no resolved version changed**

```bash
deno run -A --quiet /tmp/mnimi-pkgs.ts deno.lock > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "versions unchanged: OK"
```

Expected: `versions unchanged: OK` — the one merged lockfile reproduces the union of the two it replaced, package for package and version for version.

A `>` line means something new appeared. A `<` line means a package vanished, which is the failure that matters: it means a pin was deleted that the root `package.json` does not actually cover. Either way, stop and report which specifier moved rather than editing `deno.lock` by hand.

- [ ] **Step 7: Typecheck the server — this is the guard on the riskiest deleted pin**

```bash
cd server && deno check main.ts; cd ..
```

Expected: PASS.

This step matters more than it looks. Seven of the deleted specifiers were plain bare names that resolve from the root `package.json` identically. The eighth, `"drizzle-orm/": "npm:/drizzle-orm@0.45.2/"`, was a trailing-slash mapping, so `server/db/index.ts`'s `import { drizzle } from "drizzle-orm/libsql"` now has to resolve through node_modules subpath exports instead of an import map — a different mechanism, not just a different location. If this step fails on `drizzle-orm/libsql`, restore only that one line to `server/deno.json`'s imports, note it in the commit message, and continue.

- [ ] **Step 8: Run the full suite and the frontend build**

```bash
deno task test
deno task build
```

Expected: both PASS. The suite covers `src/**` and `server/**` through the root graph, so it is the real regression net for the deleted pins.

- [ ] **Step 9: Confirm the server still starts under its old command**

```bash
timeout 10 deno task --cwd server start 2>&1 | head -5
```

Expected: no module-resolution error. A missing-env or port complaint is fine; an `Uncaught SyntaxError`/`Module not found` is not.

- [ ] **Step 10: Commit**

```bash
git add deno.json server/deno.json deno.lock
git add -A server
git commit -m "refactor: make server a deno workspace member

One root deno install now produces one deno.lock and one node_modules.
Deletes the eight dependency pins that were duplicated between
server/deno.json and package.json and had to be hand-synced; a workspace
member resolves bare specifiers from the workspace root's package.json,
so every one resolves to the identical version it did before."
```

---

### Task 2: One `.env`

Merges `.env.local` and `server/.env` into a single root `.env`. Tasks have not moved yet, so the server still runs with its working directory at `server/` — its `--env-file` gets an explicit `../.env` here, which Task 3 simplifies back to a bare `--env-file` once tasks run from the root.

**Files:**
- Create: `.env.example` (replacing the existing one)
- Create: `.env` (gitignored, local only)
- Modify: `.gitignore`
- Modify: `server/deno.json`
- Delete: `server/.env.example`
- Delete: `server/.env` (a symlink — remove the link, never the target)
- Delete: `.env.local` (a symlink — same rule)

**Interfaces:**
- Consumes: Task 1's workspace.
- Produces: a root `.env` holding all nine variables. Every later task assumes exactly one env file, at the repo root.

- [ ] **Step 1: Write the merged `.env.example`**

Replace `.env.example` entirely:

```bash
# Copy to .env. This is the only env file in the repo — Vite, the API server
# and drizzle-kit all read it.
#
# ONLY variables prefixed VITE_ are compiled into the client bundle and shipped
# to the device. Never prefix a secret with VITE_.

# --- client ---
# The API server the client talks to. On Android the device cannot reach
# 127.0.0.1 on your machine — use the LAN address, and set CORS_ORIGIN to match.
VITE_API_URL=http://127.0.0.1:8787

# --- server ---
DATABASE_URL=file:./data/mnimi.db
BETTER_AUTH_SECRET=change-me-to-at-least-32-random-characters
BETTER_AUTH_URL=http://127.0.0.1:1420
CORS_ORIGIN=http://127.0.0.1:1420
IMAGES_DIR=./data/images
PORT=8787

# --- AI (server only — never prefixed VITE_) ---
OPENROUTER_API_KEY=sk-or-...
CLASSIFY_MODEL=~deepseek/deepseek-v4-flash-latest
GENERATE_MODEL=~deepseek/deepseek-v4-flash-latest
IMAGE_MODEL=qwen/qwen-image-3
```

- [ ] **Step 2: Build your local `.env` from the two files being retired**

`cat` follows symlinks, so this reads the real values out of the main checkout without touching them:

```bash
{ cat .env.local; echo; cat server/.env; } > .env
grep -c '=' .env
```

Expected: 9 or more. Open `.env` and delete any duplicated or blank-value line, keeping one entry per variable.

- [ ] **Step 3: Verify `.env` has real values, not the template's placeholders**

```bash
grep -q 'change-me-to-at-least-32-random-characters' .env && echo "STOP: placeholder secret" || echo "secret: OK"
grep -q 'sk-or-\.\.\.' .env && echo "STOP: placeholder key" || echo "key: OK"
```

Expected: both `OK`. If either says STOP, your `.env` came from the template rather than the real files — redo Step 2.

- [ ] **Step 4: Ignore the new file**

In `.gitignore`, change the line `.env.local` to:

```
.env
.env.local
```

`.env.local` stays ignored on purpose: Vite still honours it as a personal override over `.env`, which is a useful per-machine escape hatch for `VITE_API_URL`.

- [ ] **Step 5: Confirm git will not track the secret**

```bash
git check-ignore -v .env
git status --porcelain | grep -E '^\?\? \.env$' && echo "STOP: .env is untracked-but-visible" || echo "ignored: OK"
```

Expected: `check-ignore` names `.gitignore`, and the second line prints `ignored: OK`.

- [ ] **Step 6: Point the server's tasks at the root file**

In `server/deno.json`, change all four task commands from `--env-file` to `--env-file=../.env`:

```json
  "tasks": {
    "dev": "deno run -A --env-file=../.env --watch main.ts",
    "start": "deno run -A --env-file=../.env main.ts",
    "db:generate": "deno run -A --env-file=../.env npm:drizzle-kit@0.31.10 generate",
    "db:migrate": "deno run -A --env-file=../.env npm:drizzle-kit@0.31.10 migrate"
  }
```

`DATABASE_URL=file:./data/mnimi.db` is still resolved against `server/`, because these tasks still run there. The database does not move until Task 3.

- [ ] **Step 7: Remove the two retired files**

```bash
rm .env.local server/.env server/.env.example
ls -la /home/magmast/Projects/github.com/unfixed3854/mnimi/.env.local
ls -la /home/magmast/Projects/github.com/unfixed3854/mnimi/server/.env
```

Expected: both targets still exist in the main checkout. `rm` on a symlink removes only the link.

- [ ] **Step 8: Verify the server reads the merged file**

```bash
timeout 10 deno task --cwd server start 2>&1 | head -5
```

Expected: the server binds its port and logs no auth/key error, proving it picked up `BETTER_AUTH_SECRET` and the rest from `../.env`.

- [ ] **Step 9: Verify the client reads it and that tests still ignore it**

```bash
deno task test
```

Expected: PASS. This is the check flagged in the spec's Testing section. `vitest.config.ts` pins `VITE_API_URL` in `test.env` so the suite can never reach a real API, and the root `.env` now contains a real `VITE_API_URL` that Vite loads for the test run. This was verified in advance: `test.env` takes precedence over a loaded `.env`, so the pin holds and no change is needed. If the suite nonetheless fails on an API URL, the pin needs a different mechanism — report it rather than deleting `VITE_API_URL` from `.env`.

- [ ] **Step 10: Commit**

```bash
git add .env.example .gitignore server/deno.json
git add -A server
git commit -m "refactor: single root .env

Merges .env.local and server/.env into one gitignored root .env from one
committed .env.example. Only VITE_-prefixed vars reach the client bundle,
so the OpenRouter key is no more exposed than before — but the split is now
a naming convention rather than a structural one, so .env.example says so."
```

---

### Task 3: One place for tasks

Moves every task into the root `deno.json` and deletes `package.json`'s `scripts`. Because tasks then run at the repo root, this is also what moves the database to `/data/` and what forces drizzle-kit's config paths to be rewritten. These move together because each one breaks without the others.

**Files:**
- Modify: `deno.json`
- Modify: `package.json` (delete `scripts`)
- Modify: `server/deno.json` (delete `tasks`)
- Modify: `server/drizzle.config.ts:9-10`
- Delete: `server/.gitignore`
- Move: `server/data/` → `data/`

**Interfaces:**
- Consumes: Task 2's root `.env`.
- Produces: task names `dev:web`, `dev:api`, `start`, `build`, `check:api`, `routes:generate`, `preview`, `tauri`, `test`, `test:watch`, `db:generate`, `db:migrate`, all runnable as `deno task <name>` from the repo root. Task 4 adds `dev` on top of `dev:web` and `dev:api`. Task 5's CI and Task 6's README use these exact names.

- [ ] **Step 1: Put every task in the root `deno.json`**

Replace the whole file with:

```json
{
  "workspace": ["./server"],
  "minimumDependencyAge": "0",
  "tasks": {
    "dev:web": "vite",
    "dev:api": "deno run -A --env-file --watch server/main.ts",
    "start": "deno run -A --env-file server/main.ts",
    "build": "tsr generate && tsc && vite build",
    "check:api": "deno check server/main.ts",
    "routes:generate": "tsr generate",
    "preview": "vite preview",
    "tauri": "tauri",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "deno run -A --env-file npm:drizzle-kit@0.31.10 generate --config server/drizzle.config.ts",
    "db:migrate": "deno run -A --env-file npm:drizzle-kit@0.31.10 migrate --config server/drizzle.config.ts"
  }
}
```

`--env-file` goes back to taking no argument: these tasks run at the repo root, which is where `.env` now is. The old `server` task name is gone, replaced by `dev:api`.

Migrations stay manual. Neither `dev:api` nor `start` runs `db:migrate` — the spec rejects chaining it onto `dev:api` because it would make the dev and production start paths differ in what they do to the database.

- [ ] **Step 2: Delete `tasks` from `server/deno.json`**

The file becomes imports only:

```json
{
  "imports": {
    "@openrouter/sdk": "npm:@openrouter/sdk@0.13.20",
    "@tanstack/ai": "npm:@tanstack/ai@0.42.0",
    "@tanstack/ai-openrouter": "npm:@tanstack/ai-openrouter@0.15.10",
    "hono": "npm:hono@4.13.0"
  }
}
```

- [ ] **Step 3: Delete the `scripts` block from `package.json`**

Remove the entire `"scripts": { ... }` key, leaving `name`, `private`, `version`, `type`, `dependencies` and `devDependencies`. `package.json` is now a dependency manifest only, so there is exactly one file to look in for commands. Leave every dependency exactly as it is.

- [ ] **Step 4: Rewrite drizzle-kit's config paths**

drizzle-kit resolves the paths in its config against the working directory it runs in, **not** against the config file. The task now runs at the repo root, so in `server/drizzle.config.ts` change:

```ts
  schema: "./db/schema.ts",
  out: "./drizzle",
```

to:

```ts
  schema: "./server/db/schema.ts",
  out: "./server/drizzle",
```

Leave `import { databaseUrl, ensureDatabaseDir } from "./db/url.ts"` alone — that is an ESM specifier and stays relative to the config file. The migrations themselves do not move; only the way they are addressed changes.

- [ ] **Step 5: Move the database to the repo root**

`DATABASE_URL=file:./data/mnimi.db` and `IMAGES_DIR=./data/images` now resolve against the repo root. `git check-ignore` confirms the root `.gitignore` already covers `/data/`, so nothing needs adding there.

```bash
mv server/data data
ls -l data/mnimi.db
git check-ignore -v data/mnimi.db
```

Expected: the 120 KB database is at `data/mnimi.db` and git ignores it.

- [ ] **Step 6: Delete `server/.gitignore`**

```bash
rm server/.gitignore
```

Both of its entries have stopped applying: `node_modules/` hoisted to the root in Task 1, `data/` moved to the root in Step 5, and `.env` went away in Task 2. The root `.gitignore` covers what remains.

- [ ] **Step 7: Verify migrations run against the moved database**

```bash
deno task db:migrate
```

Expected: drizzle-kit reports the schema is up to date, and does **not** create a stray `server/data/` or a second `data/mnimi.db`.

```bash
test ! -e server/data && echo "no stray server/data: OK"
ls -l data/mnimi.db
```

- [ ] **Step 8: Verify every migrated task name runs from the root**

```bash
deno task check:api
deno task test
deno task build
timeout 10 deno task dev:api 2>&1 | head -5
timeout 10 deno task dev:web 2>&1 | head -5
```

Expected: the first three PASS; `dev:api` binds :8787 and `dev:web` reports Vite ready on :1420.

- [ ] **Step 9: Commit**

`data/` is gitignored, so it is deliberately not staged — only the deletion of `server/data/` and `server/.gitignore` needs recording.

```bash
git add deno.json package.json server/deno.json server/drizzle.config.ts
git add -A server
git status --porcelain | grep -E '^\?\?|data/' && echo "STOP: unexpected staging" || echo "staging clean: OK"
git commit -m "refactor: move every task to the root deno.json

package.json keeps dependencies only. Tasks now run at the repo root, so
--env-file finds the root .env with no argument, the database moves from
server/data to /data, and drizzle-kit's config paths become root-relative
(it resolves them against the cwd, not against the config file)."
```

---

### Task 4: One dev command

Adds the `dev` task that runs both processes together.

**Files:**
- Modify: `deno.json`
- Modify: `package.json` (add one devDependency)

**Interfaces:**
- Consumes: `dev:web` and `dev:api` from Task 3.
- Produces: `deno task dev`. Task 6's README documents it as the single way to start the stack.

- [ ] **Step 1: Add `concurrently` as a devDependency**

In `package.json`, add to `devDependencies`, keeping the block alphabetically ordered:

```json
    "concurrently": "^9.2.4",
```

The spec chooses this over deno_task_shell's built-in `deno task dev:web & deno task dev:api & wait`. The built-in works, but it gives unlabelled interleaved output and — decisively — leaves Vite running and apparently healthy when the API dies.

- [ ] **Step 2: Install it**

```bash
deno install
```

- [ ] **Step 3: Add the `dev` task**

In the root `deno.json`, add as the first entry of `tasks`:

```json
    "dev": "deno run -A npm:concurrently@9 --kill-others -n web,api -c cyan,magenta \"deno task dev:web\" \"deno task dev:api\"",
```

`--kill-others` is the whole point: if either process exits, the other goes down with it instead of leaving a half-dead dev environment.

- [ ] **Step 4: Verify both processes come up under one command**

```bash
timeout 20 deno task dev 2>&1 | tee /tmp/mnimi-dev.log | head -30
grep -q '\[web\]' /tmp/mnimi-dev.log && echo "web prefix: OK"
grep -q '\[api\]' /tmp/mnimi-dev.log && echo "api prefix: OK"
```

Expected: both `OK`, with Vite reporting :1420 and the API :8787, each line prefixed and coloured.

- [ ] **Step 5: Verify `--kill-others` actually kills**

Start `deno task dev` in one terminal, then from another:

```bash
pkill -f 'server/main.ts'
```

Expected: `concurrently` reports the `api` process exited and tears `web` down too, returning you to a prompt. Restart with `deno task dev` when done.

- [ ] **Step 6: Confirm `tauri.conf.json` needs no edit**

```bash
grep beforeDevCommand src-tauri/tauri.conf.json
```

Expected: `"beforeDevCommand": "deno task dev"` — already correct. Because `dev` now starts both processes, `tauri dev` and `tauri android dev` bring up the API alongside Vite, so an Android device gets a reachable backend from the same single command. Do not change this file.

- [ ] **Step 7: Commit**

```bash
git add deno.json package.json deno.lock
git commit -m "feat: single deno task dev for the whole stack

Runs Vite and the API under concurrently with labelled output.
--kill-others so an API crash takes the dev server down instead of
leaving Vite running and apparently healthy. tauri's beforeDevCommand
was already 'deno task dev', so android dev now gets a backend too."
```

---

### Task 5: CI and editor entry points

Updates the three non-README consumers of the old layout.

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.claude/launch.json`
- Modify: `src/lib/orpc.ts:11`

**Interfaces:**
- Consumes: task names from Task 3.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Collapse the two installs in both CI jobs**

In `.github/workflows/ci.yml`, both the `verify` and `desktop-build` jobs have these two steps:

```yaml
      - name: Install root dependencies
        run: deno install

      - name: Install server dependencies
        working-directory: server
        run: deno install
```

In each job, replace both with:

```yaml
      - name: Install dependencies
        run: deno install
```

- [ ] **Step 2: Fix the cache key in both jobs**

`server/deno.lock` no longer exists, so `hashFiles` on it silently contributes nothing and the key is weaker than it looks. In both jobs change:

```yaml
          key: deno-${{ runner.os }}-${{ hashFiles('deno.lock', 'server/deno.lock') }}
```

to:

```yaml
          key: deno-${{ runner.os }}-${{ hashFiles('deno.lock') }}
```

- [ ] **Step 3: Move the server typecheck to the root task**

In the `verify` job, replace:

```yaml
      - name: Typecheck server
        working-directory: server
        run: deno check main.ts
```

with:

```yaml
      - name: Typecheck server
        run: deno task check:api
```

- [ ] **Step 4: Confirm no CI step needs a `.env`**

```bash
grep -n 'env-file' .github/workflows/ci.yml && echo "STOP: a CI step wants an env file" || echo "no env-file in CI: OK"
```

Expected: `OK`. CI runs `build`, `check:api`, `test` and `tauri build`; none of them passes `--env-file`, so no CI step depends on a file that CI never creates.

- [ ] **Step 5: Fix `.claude/launch.json`**

It currently runs `npm run dev`, which both violates `AGENTS.md` and breaks now that `package.json` has no `scripts`. Change the configuration's `runtimeExecutable` and `runtimeArgs` to:

```json
      "runtimeExecutable": "deno",
      "runtimeArgs": ["task", "dev"],
```

Leave `name`, `version` and `port` as they are.

- [ ] **Step 6: Retarget the error message in `src/lib/orpc.ts`**

At line 11, change:

```ts
  throw new Error("VITE_API_URL must be set in .env.local");
```

to:

```ts
  throw new Error("VITE_API_URL must be set in .env");
```

This is the message a developer sees as a blank window on a fresh clone, so it has to name the file that now exists.

- [ ] **Step 7: Verify**

```bash
deno task test
deno task build
deno eval 'import { parse } from "jsr:@std/yaml@1"; parse(Deno.readTextFileSync(".github/workflows/ci.yml")); console.log("ci.yml parses: OK")'
grep -rn 'npm run\|working-directory: server\|server/deno.lock' .github .claude && echo "STOP: stale reference" || echo "no stale refs: OK"
```

Expected: tests and build PASS, `ci.yml parses: OK`, `no stale refs: OK`.

The YAML parse only catches syntax, not a wrong step. CI itself is the real check, and it runs on the pull request opened at the end of this plan.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/ci.yml .claude/launch.json src/lib/orpc.ts
git commit -m "ci: single install, root typecheck task

Drops the second working-directory: server install and stops hashing the
deleted server/deno.lock in the cache key. launch.json moves off npm run
(which AGENTS.md forbids and which no longer resolves), and orpc.ts's
throw names .env instead of .env.local."
```

---

### Task 6: README

The README documents the two-env-file, two-terminal flow throughout. It is the deliverable that makes this work discoverable, so it is a task rather than a footnote.

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Rewrite Setup**

Replace the Setup section's body with the following. The outer `~~~` fence is this plan's quoting only — what you write into `README.md` starts at `## Setup` and uses ordinary triple-backtick fences.

~~~markdown
## Setup

```bash
mise install                    # node, deno, java 17, android-sdk
deno install                    # all dependencies, root and server
cp .env.example .env
```

`server/` is a Deno workspace member, so the one `deno install` at the root
covers it too — there is a single `deno.lock` and a single `node_modules`.

Set `BETTER_AUTH_SECRET` to at least 32 random characters and
`OPENROUTER_API_KEY` to your key in `.env`. Then create the database:

```bash
deno task db:migrate
```

Re-run `deno task db:migrate` whenever a pull brings new migrations — nothing
applies them for you.
~~~

- [ ] **Step 2: Rewrite Running**

Replace the Running section's body with:

~~~markdown
## Running

```bash
deno task dev                   # Vite on :1420 and the API on :8787, together
```

One command starts both, with prefixed output; if either dies the other is
shut down rather than left running in a half-working state. To run one alone:

```bash
deno task dev:web               # Vite only
deno task dev:api               # API only
deno task test                  # vitest, one shot
```

`.env` at the repo root is the only env file, and `VITE_API_URL` in it points
the client at the server. Vite reads it once at startup, so restart after
changing it.
~~~

- [ ] **Step 3: Retarget the OpenRouter-key section**

In "The OpenRouter key", change `server/.env`, which is gitignored via `server/.gitignore` to `.env`, which is gitignored, and update the closing lines to:

```markdown
**The key never goes in client code and never gets a `VITE_` prefix.** Anything
prefixed `VITE_` is compiled into the bundle and shipped to the device; nothing
else in `.env` is. The key is read by the server only, via
`Deno.env.get("OPENROUTER_API_KEY")` in `server/ai/openrouter.ts`. The client
calls the server's generation endpoints with its bearer token and never sees
the key.

Restart the server after changing `.env` so the new values are picked up.
```

- [ ] **Step 4: Retarget Troubleshooting and Android**

Work through every remaining mention of `server/.env`, `.env.local` and `deno task server`:

- "Every request fails, or the app renders blank" — `.env.local` becomes `.env` (twice), and `start it with deno task server` becomes `start it with deno task dev`.
- "Requests return 401" — `BETTER_AUTH_SECRET` in `server/.env` becomes in `.env`.
- "Requests are blocked by CORS" — `CORS_ORIGIN` in `server/.env` becomes in `.env`.
- "Generation fails or returns malformed output" — `OPENROUTER_API_KEY` is set in `server/.env` becomes in `.env`.
- Android section — the warning **Do not run `deno task server` on an untrusted network** becomes **Do not run `deno task dev:api` on an untrusted network**, and `CORS_ORIGIN` in `server/.env` becomes in `.env`.

- [ ] **Step 5: Update the Layout tree**

In the Layout section, the `server/` subtree gains a line making the workspace relationship explicit. Add directly under `server/`:

```
  deno.json        workspace member: server-only imports (hono, @tanstack/ai)
```

and add above `docs/`:

```
data/              SQLite database and generated images (gitignored)
```

- [ ] **Step 6: Verify no stale instruction survives**

```bash
grep -n 'server/\.env\|\.env\.local\|deno task server\|cd server\|npm run' README.md && echo "STOP: stale instruction" || echo "README clean: OK"
```

Expected: `README clean: OK`.

- [ ] **Step 7: Walk the README's own setup path from a clean clone**

This is the point of the task — the instructions have to work for someone who has never run this repo.

```bash
git clone . /tmp/mnimi-readme-check && cd /tmp/mnimi-readme-check
deno install
cp .env.example .env
deno task db:migrate
ls -l data/mnimi.db && echo "fresh clone migrates: OK"
deno task build
cd - && rm -rf /tmp/mnimi-readme-check
```

Expected: `fresh clone migrates: OK` and a passing build, with no `deno install` inside `server/` and no second env file at any point. A fresh clone's `.env` has placeholder secrets, which is fine — nothing here calls OpenRouter.

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: README for the single-install, single-env, single-command flow

Setup is mise install, deno install, cp .env.example .env, db:migrate.
Running is deno task dev. Retargets every reference to server/.env,
.env.local and deno task server."
```

---

## Final verification

- [ ] **Step 1: Confirm nothing from the old layout survives**

```bash
test ! -e server/deno.lock && test ! -e server/node_modules && test ! -e server/.env.example && test ! -e server/.gitignore && test ! -e server/data && test ! -e .env.local && echo "old layout gone: OK"
grep -q '"scripts"' package.json && echo "STOP: package.json still has scripts" || echo "no scripts block: OK"
```

- [ ] **Step 2: Full green**

```bash
deno install
deno task check:api
deno task test
deno task build
```

Expected: all PASS.

- [ ] **Step 3: Confirm the issue's three asks are met**

One `.env` at the repo root; one `deno install`; one `deno task dev`. Verify each by running it, then push the branch and open a PR referencing issue #5.
