# Effect Transport and Runtime Design

## Status

Proposed on 2026-09-15 for the Pimp-migrated feature with source ID `mnimi-pi5.5`.

## Goal

Finish Mnimi's Effect migration by making the application runtime own the
selected AI provider, all background workflows, the Hono/oRPC application, and
their shutdown order. Hono, oRPC, Better Auth, Drizzle/libSQL, and Bun remain
the existing compatibility boundaries; domain and transport orchestration runs
through the one managed Effect runtime.

## Scope and compatibility

This child owns `main.ts`, lifecycle ownership, request context, transport
error mapping, and the remaining server routers. It removes the legacy
bindings and installed singleton facades introduced by earlier migration
slices. It does not replace Hono, oRPC, Better Auth, Bun.serve, the database
schema, provider selection, retry policy, or any public procedure.

The following externally visible behavior is fixed:

- `/api/registration`, `/api/auth/*`, `/images/*`, `/audio/*`, and `/rpc/*`
  keep their current paths and authentication behavior.
- Browser cookie authentication, native bearer authentication, CORS, mutation
  origin protection, oRPC codes/statuses/messages, and `AppRouter` remain
  compatible.
- Legacy and durable creation streams keep their snapshot-first registration,
  event discriminants, ordering, coalescing, terminal behavior, and disconnect
  cleanup.
- Startup keeps provider validation and stale-work recovery before the server
  is bound; the readiness token is printed only after binding succeeds.
- Shutdown is idempotent, fences admissions first, and reports all cleanup
  failures without allowing one finalizer to skip another.

## Runtime ownership

`makeApplicationRuntime` will build a single scoped live graph. It composes the
existing core Layer with the selected `BackgroundProvider`, the already
Effect-native `BackgroundWorkflows`, media, ElevenLabs, and Expo push services.
The resulting runtime is acquired once in `main.ts`; no request constructs a
Layer, opens a provider scope, or creates a parallel runtime.

Acquisition order stays explicit: core configuration/database/auth, selected
provider, Effect-owned workflows, Hono/oRPC application, stale-work recovery,
then `Bun.serve`. A startup failure releases every acquired resource in reverse
dependency order and retains the primary error alongside cleanup failures.

Normal disposal stops the HTTP server and fences all new work before releasing
the application scope. The background workflow finalizer settles legacy jobs,
durable schedulers, audio work, maintenance, and notification timers; provider
and core resources release only after those dependents. Calling shutdown more
than once returns the same completion and disposes each resource once.

## Request and router boundary

The oRPC context becomes a narrow transport object: the shared application
runtime plus request headers, a generated request ID, and the HTTP abort
signal. Authentication is an Effect program that obtains the verified user ID
from the Auth service and supplies it as request-local context. No procedure
receives a mutable bag of database, provider, filesystem, or test override
functions.

Router use cases are expressed as Effects with explicit service requirements.
At the edge, a common `runRequest` adapter supplies the request context and
uses the singleton runtime. Promise-returning Drizzle, Better Auth, filesystem,
and Bun/oRPC calls are wrapped at their individual interoperability edges with
their existing behavior preserved. The decks, cards, notes, drafts, AI, debug,
and notification routers consume the Effect services directly; calls to the
old jobs, scheduler, event, audio, notification, and media facades disappear.

The two creation watch procedures obtain an Effect `Stream` from
`CreationEvents` and bridge it to the existing async-generator oRPC response.
Subscription registration precedes the initial snapshot; cancellation closes
the stream scope and removes the subscriber exactly as the current contract
tests require.

## Errors

Domain code returns the existing tagged Effect errors (`Unauthorized`,
`NotFound`, `Conflict`, `Validation`, `DependencyUnavailable`, and the
infrastructure failures). A single transport mapper converts them to the
current oRPC error code, status, safe message, and payload. Unexpected defects
are logged once with request metadata and become the existing safe internal
server error. Domain modules do not import or throw `ORPCError`.

## Testing and verification

New characterization tests will prove that the shared runtime is never rebuilt
per request, request values do not leak between calls, authenticated and
unauthenticated requests retain their current transport responses, and stream
disconnect removes the subscriber. Lifecycle tests will prove the exact
admission fence, reverse cleanup ordering, failure aggregation, and
idempotence. Existing per-router, SSE, browser-auth, runtime-smoke, and
background workflow tests remain compatibility oracles.

Validation will include targeted server tests while each boundary changes,
`bun run check`, `VITEST_MAX_WORKERS=2 bun run test`, `git diff --check`, and
the production-shaped server runtime smoke. Independent review happens only
after those deterministic checks pass.
