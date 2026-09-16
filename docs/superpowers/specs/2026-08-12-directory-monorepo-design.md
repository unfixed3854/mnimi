# Directory Monorepo

## Goal

Reorganize mnimi into a small, named Deno workspace while retaining one
dependency graph, one root environment file and the existing developer
commands. The resulting top-level layout is:

```text
apps/
  app/       # @mnimi/app: Vite, React, Tauri UI and app tests
  server/    # @mnimi/server: Hono API, Drizzle, server tests and migrations
libs/
  shared/    # @mnimi/shared: framework-neutral shared utilities
```

## Architecture

The repository root remains the workspace coordinator. Its `deno.json` lists
`apps/app`, `apps/server`, and `libs/shared` as workspace members; its
`package.json` remains the single source for external dependencies; and its
`deno.lock` remains the single lockfile. The member `deno.json` files declare
the named packages `@mnimi/app`, `@mnimi/server`, and `@mnimi/shared` and retain
only member-specific imports or exports.

The frontend moves intact from `src/`, `public/`, `index.html`, and
`src-tauri/` to `apps/app/`. The API moves from `server/` to `apps/server/`.
The existing shared package moves from `shared/` to `libs/shared/`, retaining
the public `@mnimi/shared` import surface. This is a physical layout migration,
not a change to application behavior or a split into independently installed
projects.

Root-level `deno task` commands remain the only supported scripts. Their file
arguments are updated to the new locations. The root `.env` and `.env.example`
remain the only environment-file convention: Vite consumes `VITE_*` variables,
and server/database commands continue to pass the root environment file. The
runtime SQLite and generated-media location remains `data/` at the repository
root, so local state does not become package-local.

## Tooling Boundaries

Vite, Vitest, TypeScript, Tailwind, TanStack Router generation, and Tauri
configuration will be placed or retargeted according to their natural package
boundary. App-specific configuration belongs in `apps/app/` when it uses
relative app paths; shared root configuration may remain at the root only when
it coordinates the whole workspace. All configuration must resolve paths
correctly when commands are invoked as `deno task <name>` from the root.

Drizzle configuration and migration references move with the server. Root
database tasks will explicitly point at `apps/server/drizzle.config.ts`; its
schema and migration paths must resolve from the root task working directory.
Tauri's dev and build commands will reference the migrated app paths while
preserving the one-command `deno task dev` development flow.

CI, documentation, aliases, test discovery, and any static file references are
updated in the same migration. No command may use npm, npx, yarn, or pnpm.

## Testing and Verification

Tests move with the code they exercise. The refactor adds focused checks for
configuration/path behavior where that can be verified automatically; it does
not duplicate behavioral tests merely because they changed directory.

The completed migration must demonstrate:

- `deno task test` passes the entire suite from the repository root.
- `deno task check:api` resolves the relocated server and passes.
- `deno task build` generates routes, typechecks, and produces the frontend
  build from its new location.
- `deno task db:migrate` addresses the relocated Drizzle configuration and
  continues to use root-level `data/`.
- The documented `deno task dev` still starts both the UI and API from a single
  command.

## Non-Goals

- Splitting dependencies or lockfiles per workspace member.
- Publishing packages or changing their runtime behavior.
- Moving secrets or runtime data into an app package.
- Replacing Deno task execution with another package manager.
