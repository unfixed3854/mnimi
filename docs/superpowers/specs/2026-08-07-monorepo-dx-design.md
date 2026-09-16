# Monorepo DX

Collapse the repo's two dependency graphs, two env files and two dev processes
into one of each — closing issue #5.

## Problem

The repo is one project wearing two costumes. A contributor has to know which
half of it they are standing in before almost any command works.

**Two dependency graphs.** The root has `package.json`, `deno.lock` and
`node_modules`; `server/` has `deno.json` imports, its own `deno.lock` and its
own `node_modules`. Setup is `deno install` at the root *and* `deno install` in
`server/`. Worse, eight packages are pinned in both places and must be kept in
sync by hand — `drizzle-orm`, `drizzle-orm/`, `@libsql/client`, `@orpc/client`,
`@orpc/server`, `better-auth`, `zod`, `uuidv7` and `drizzle-kit`. The root needs
them because `vitest.config.ts` runs `server/**/*.test.ts` through the root
graph, so a version bump applied to one file and not the other means the tests
and the server disagree about what they are testing.

**Two env files.** `.env.local` at the root holds exactly one variable
(`VITE_API_URL`); `server/.env` holds the other eight. Two `.env.example`
templates, two `.gitignore` entries, and a setup step that copies each one
separately.

**Two dev processes.** `deno task server` and `deno task dev` in separate
terminals, preceded by a manual `deno task db:migrate` that a fresh clone
fails confusingly without.

**Tasks in two files.** Frontend scripts live in `package.json`; server and
database tasks live in `server/deno.json`. Neither file lists the whole set.

## Approach

Make the repo a **Deno workspace** with `server/` as its only member, run both
dev processes from a single root task, and read every variable from a single
root `.env`.

Containers were the alternative the issue named. Rejected: the frontend is a
Tauri app whose primary target is Android and the server writes a SQLite file
on local disk. `tauri android dev` needs the host toolchain regardless, so a
compose file would be a second path to maintain rather than a replacement for
the first, and it would add a networking layer to punch holes through for
on-device LAN testing.

A **full collapse** — deleting `server/deno.json` and moving hono,
`@tanstack/ai` and the OpenRouter SDK into the root `package.json` — was also
considered. It reaches one config file instead of two, but it puts server-only
dependencies into the frontend's manifest, where nothing distinguishes them
from things that ship to the device. The workspace keeps that boundary while
still producing a single lockfile and a single install.

The following were verified against Deno 2.9.3, the version pinned in
`mise.toml`, rather than assumed:

- A workspace member's `deno.json` needs no `name` or `version` field.
- One `deno install` at the root produces one `deno.lock` and one
  `node_modules`; the member gets neither of its own.
- A member resolves bare specifiers from the **workspace root's
  `package.json`**, not only from its own import map. This is what lets the
  duplicated pins be deleted rather than merely centralised.
- `--env-file` with no argument resolves `.env` against the running task's
  working directory, and a task defined in the root `deno.json` runs at the
  repo root.

## One dependency graph

The root `deno.json` gains the workspace declaration and keeps
`minimumDependencyAge`:

```jsonc
{
  "workspace": ["./server"],
  "minimumDependencyAge": "0",
  "tasks": { /* see below */ }
}
```

`server/deno.json` loses its tasks and every shared pin, retaining only the
imports no other part of the repo uses:

```jsonc
{
  "imports": {
    "@openrouter/sdk":         "npm:@openrouter/sdk@0.13.20",
    "@tanstack/ai":            "npm:@tanstack/ai@0.42.0",
    "@tanstack/ai-openrouter": "npm:@tanstack/ai-openrouter@0.15.10",
    "hono":                    "npm:hono@4.13.0"
  }
}
```

The eight deleted specifiers resolve from the root `package.json`, which
already declares every one of them at the identical version — so this removes
the duplication without changing a single resolved version.

`server/deno.json`'s `"nodeModulesDir": "auto"` is dropped rather than moved up:
the root `package.json` already makes Deno create `node_modules` at the
workspace root, and leaving the setting on the member is what would give it a
second one.

Deleted: `server/deno.lock`, `server/node_modules/`, `server/.gitignore`. The
last is deleted rather than trimmed because both of its entries stop applying —
`node_modules/` hoists to the root, and `data/` moves to the root, where the
root `.gitignore` already has `/data/`.

Setup becomes a single `deno install`.

## One `.env`

A single gitignored `.env` at the repo root, created from a single committed
`.env.example` that merges both current templates. Vite reads the root `.env`
natively. The server and drizzle-kit read it through `--env-file` with no
argument, which lands on the repo root because every task now lives in the root
`deno.json`. No path juggling and no `--env-file=../.env`.

Deleted: `server/.env.example`, and `server/.env` on developer machines.
`.gitignore` gains `.env`; `.env.local` stays ignored, since Vite still honours
it as a personal override over `.env` and that is a useful escape hatch for
per-machine `VITE_API_URL` values.

Two consequences follow and are deliberate:

**The data directory moves to `/data/`.** Tasks run at the repo root now, so
`DATABASE_URL=file:./data/mnimi.db` and `IMAGES_DIR=./data/images` resolve to
the repo root instead of `server/`. The root `.gitignore` already ignores
`/data/`, so nothing new is needed there, but every developer with an existing
database needs a one-time `mv server/data data`. This is called out in the
README and in the implementation plan.

**The OpenRouter key now shares a file with a `VITE_` variable.** This is safe:
Vite inlines only `VITE_`-prefixed variables into the bundle, so
`OPENROUTER_API_KEY` in the root `.env` is no more exposed than it was in
`server/.env`. But the separation used to be structural — the key lived in a
file the client build never read — and now it rests on a naming convention.
`.env.example` therefore carries an explicit comment: never prefix a secret
with `VITE_`. The README's existing warning to the same effect is retargeted at
the new file rather than dropped.

## One dev command

Every task moves to the root `deno.json`. `package.json` keeps `dependencies`
and `devDependencies` only; its `scripts` block is deleted, so there is exactly
one file to look in for the full set of commands.

```jsonc
"tasks": {
  "dev":        "deno run -A npm:concurrently@9 --kill-others -n web,api -c cyan,magenta \"deno task dev:web\" \"deno task dev:api\"",
  "dev:web":    "vite",
  "dev:api":    "deno run -A --env-file --watch server/main.ts",
  "start":      "deno run -A --env-file server/main.ts",
  "build":      "tsr generate && tsc && vite build",
  "check:api":  "deno check server/main.ts",
  "routes:generate": "tsr generate",
  "preview":    "vite preview",
  "tauri":      "tauri",
  "test":       "vitest run",
  "test:watch": "vitest",
  "db:generate":"deno run -A --env-file npm:drizzle-kit@0.31.10 generate --config server/drizzle.config.ts",
  "db:migrate": "deno run -A --env-file npm:drizzle-kit@0.31.10 migrate --config server/drizzle.config.ts"
}
```

`deno task dev` starts both processes with labelled, coloured output.
`dev:web` and `dev:api` remain available for running one alone. The old
`server` task name disappears in favour of `dev:api`.

Moving the database tasks to the root changes what they resolve against.
drizzle-kit resolves the paths in its config relative to the working directory
it runs in, not relative to the config file, so `server/drizzle.config.ts` must
be updated in step with the move:

```ts
schema: "./server/db/schema.ts",
out:    "./server/drizzle",
```

Its `import { databaseUrl, ensureDatabaseDir } from "./db/url.ts"` is an ESM
specifier and stays relative to the config file, so it is untouched. The
generated migrations stay where they are in `server/drizzle/`; only the way
they are addressed changes.

Migrations stay **manual**. `deno task db:migrate` is a step in setup and a
step to repeat when a pull brings new migrations; neither `dev:api` nor `start`
runs it. Chaining it onto `dev:api` was considered and rejected — it would make
the dev and production start paths differ in what they do to the database,
which is exactly the kind of divergence that makes a migration bug show up only
in production.

`concurrently` is added as a devDependency rather than using deno_task_shell's
built-in `deno task dev:web & deno task dev:api & wait`. The built-in works —
it was tested — but it gives unlabelled interleaved output and, decisively, it
leaves Vite running and apparently healthy when the API dies. `--kill-others`
makes a crash impossible to miss.

`src-tauri/tauri.conf.json` needs no change. Its `beforeDevCommand` is already
`deno task dev`, so `tauri dev` and `tauri android dev` now start the API
alongside Vite — an Android device gets a reachable backend from the same
single command, without the separate `dev:android` task the issue's "other?"
might have suggested.

## Fallout

**`ci.yml`.** Drop the `working-directory: server` install step. Change the
server typecheck from a `working-directory: server` `deno check main.ts` to a
root `deno task check:api`. The cache key stops hashing the deleted
`server/deno.lock` and hashes `deno.lock` alone. CI never creates a `.env`, and
none of the tasks CI runs (`build`, `check:api`, `test`) pass `--env-file`, so
no CI step depends on the file existing.

**`.claude/launch.json`.** Currently `npm run dev`, which both contradicts
`AGENTS.md` and breaks once `scripts` is deleted. Becomes `deno` with
`["task", "dev"]`.

**`src/lib/orpc.ts`.** Its throw message names `.env.local` as the file to
edit; it becomes `.env`.

**`README.md`.** Setup collapses to `mise install`, `deno install`,
`cp .env.example .env`, `deno task db:migrate`. Running collapses to
`deno task dev`. The OpenRouter-key section retargets from `server/.env` to
`.env` and keeps the never-prefix-a-secret warning. Every remaining mention of
`server/.env`, `.env.local` or `deno task server` is retargeted — they appear
across all four Troubleshooting entries and the Android section, including the
warning not to run the API on an untrusted network. The Layout tree drops
`server/`'s description of itself as a separately-installed project.

## Testing

No new tests. This change moves configuration, not behaviour, and the existing
suite is the regression net: `deno task test` runs the same Vitest suite over
`src/**` and `server/**` through the same root graph as before, and it must
pass unchanged.

The verification that matters is that each collapsed command still works from
a clean state, which the implementation plan covers explicitly: a fresh
`deno install` produces no `server/node_modules` and no `server/deno.lock`;
`deno task db:migrate` creates `/data/mnimi.db` from `server/drizzle/`;
`deno task dev` serves both ports; `deno task build` and `deno task check:api`
pass.

`deno task check:api` is the specific guard on the deleted pins. Deleting the
`"drizzle-orm/": "npm:/drizzle-orm@0.45.2/"` trailing-slash mapping means
`server/db/index.ts`'s `import { drizzle } from "drizzle-orm/libsql"` has to
resolve through the root `package.json` and node_modules subpath exports
instead. That is the one deleted specifier whose replacement mechanism differs
in kind rather than only in location, so it is the one most worth watching; a
typecheck of `server/main.ts` reaches it.

One existing test-time behaviour needs confirming rather than assuming.
`vitest.config.ts` pins `VITE_API_URL` in `test.env` specifically so that a
gitignored env file cannot leak a real API URL into the suite — the comment
there says tests must never reach a real API and a fresh clone has no file to
read. The root `.env` now *does* contain a real `VITE_API_URL`, and Vite loads
`.env` for the test run. The implementation must verify that `test.env` still
takes precedence over the loaded `.env`. If it does not, the pin needs a
different mechanism and that becomes part of this change rather than a
discovered breakage.

## Error handling

The failure modes this changes are setup-time and want to be loud.

A missing `.env` leaves `VITE_API_URL` unset, and `src/lib/orpc.ts` already
throws at module load with a message naming the file to copy — retargeted to
`.env`. A missing `.env` on the server side leaves every variable on its
existing fallback: `DATABASE_URL`, `IMAGES_DIR`, `PORT`, `CORS_ORIGIN` and
`BETTER_AUTH_URL` all have working defaults, `BETTER_AUTH_SECRET` defaults to
`""`, and `OPENROUTER_API_KEY` throws from `server/ai/openrouter.ts` when
generation is attempted. That is the behaviour today and it is unchanged.

An un-migrated database is the one case made slightly more likely by keeping
migrations manual. It surfaces as a SQLite "no such table" error on the first
query. The README lists `deno task db:migrate` as a setup step and as the fix
when a pull adds migrations.

## Out of scope

- **A `deno task setup` bootstrap task.** The workspace reduces setup to three
  commands that are each meaningful on their own; wrapping them hides what
  `mise install` versus `deno install` actually do from someone debugging a
  broken checkout.
- **A `dev:android` task.** `tauri android dev` already inherits the API
  through `beforeDevCommand`.
- **A compose file.** Reasoning under Approach.
- **Collapsing `server/deno.json` entirely.** Reasoning under Approach.
- **Deduplicating the frontend/server dependency *sets*.** The root
  `package.json` keeps declaring `drizzle-orm`, `better-auth` and the rest
  because Vitest genuinely needs them to run server tests. Only the duplicated
  *pins* go away, not the shared declarations.
