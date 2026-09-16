# Root Environment File for Expo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `deno task mobile:start` and `deno task dev` load `EXPO_PUBLIC_API_URL` from the repository-root `.env` before Expo bundles the mobile app.

**Architecture:** Keep `apps/mobile` as Expo's project directory, but add Deno's `--env-file=../../.env` to the command after changing into that directory. The existing `dev` task invokes `mobile:start`, so no second loading mechanism is needed. Verification executes Deno in the same mobile working directory and confirms the root value reaches its child-process environment.

**Tech Stack:** Deno tasks, Expo CLI, Jest, TypeScript, Markdown.

## Global Constraints

- Use `deno` for every package-management and script command; do not use npm, npx, yarn, or pnpm.
- Root `.env` is the only environment file; do not add or duplicate `apps/mobile/.env`.
- Preserve the user's unrelated working-tree edits in `apps/mobile/package.json`, `apps/mobile/tsconfig.json`, `deno.lock`, `package.json`, and `apps/mobile/.gitignore`.
- Keep `EXPO_PUBLIC_API_URL` public-only; server secrets must never use the `EXPO_PUBLIC_` prefix.

---

### Task 1: Load and document the root Expo environment

**Files:**
- Modify: `deno.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: root task `mobile:start` and root `.env` containing `EXPO_PUBLIC_API_URL`.
- Produces: an Expo CLI process whose environment includes values loaded from `../../.env` while its current directory remains `apps/mobile`.

- [ ] **Step 1: Pass the root environment file to Expo**

In the `mobile:start` task in root `deno.json`, replace:

```json
"mobile:start": "cd apps/mobile && deno run -A npm:expo start --dev-client"
```

with:

```json
"mobile:start": "cd apps/mobile && deno run -A --env-file=../../.env npm:expo start --dev-client"
```

This makes Deno parse the root `.env` and export `EXPO_PUBLIC_API_URL` to the Expo process without introducing another environment file.

- [ ] **Step 2: Update the development instructions**

In `README.md` under **Develop**, replace the example that prefixes the variable on the command line:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.20:8787 deno task dev
```

with text instructing the developer to set `EXPO_PUBLIC_API_URL=http://192.168.1.20:8787` in the root `.env`, followed by:

```bash
deno task dev
```

Keep the emulator (`10.0.2.2`) and physical-device LAN-address guidance intact.

- [ ] **Step 3: Run focused verification**

Run:

```bash
cd apps/mobile && deno eval --env-file=../../.env 'if (!Deno.env.get("EXPO_PUBLIC_API_URL")) throw new Error("root EXPO_PUBLIC_API_URL was not loaded"); console.log("root EXPO_PUBLIC_API_URL loaded")'
deno task mobile:typecheck
git diff --check
```

Expected: the command confirms the root API URL is loaded in the same working directory and environment-loading mechanism used by `mobile:start`, TypeScript reports no errors, and the diff has no whitespace errors.

- [ ] **Step 4: Commit the implementation**

```bash
git add deno.json README.md
git commit -m "fix: load root env for Expo development"
```

Do not stage unrelated pre-existing modifications.
