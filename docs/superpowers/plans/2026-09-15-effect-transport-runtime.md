# Effect Transport and Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Mnimi's remaining router and transport work onto one scoped
Effect runtime while preserving every Hono/oRPC, authentication, SSE, startup,
and shutdown contract.

**Architecture:** A new application runtime owns core services, the selected
provider, and the existing Effect-native background workflows for the lifetime
of one server process. Hono and oRPC retain request dispatch, but a narrow
request context runs Effects through that singleton runtime and maps tagged
domain failures once at the transport boundary. Routers receive service-backed
dependencies instead of process-global Promise facades.

**Tech Stack:** Bun 1.3.13, TypeScript 6.0.3, Vitest 4.1.10, Effect 3.22.2,
Hono 4.13.0, oRPC 1.14.14, Better Auth 1.6.26, Drizzle/libSQL, LogTape 2.3.0.

**Spec:** `docs/superpowers/specs/2026-09-15-effect-transport-runtime-design.md`

## Global Constraints

- Retain Bun, `Bun.serve`, Hono, oRPC, Better Auth, Drizzle/libSQL, all paths,
  public procedure inputs/outputs, and the exported `AppRouter` type.
- Use only stable Effect 3.22.2 APIs already pinned in `bun.lock`; do not add
  Effect Platform HTTP or alter the database schema, retry policy, or provider
  selection.
- Keep browser-cookie and native-bearer authentication, CORS and origin
  protection, error status/code/message payloads, and SSE framing compatible.
- Preserve snapshot-first stream registration, event ordering/coalescing,
  disconnection cleanup, eager provider validation, and readiness-token timing.
- Stop admissions before cleanup; release workflow resources before provider
  and database scope finalizers; aggregate cleanup defects; dispose once.
- Write every behavior test first and observe its expected failure before its
  production implementation. Use `bun run` scripts, never npm/yarn/pnpm.
- Do not create commits, push, merge, or deploy without an explicit user
  request. Keep unrelated working-tree changes untouched.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `apps/server/effect/transport.ts` | Run request Effects and map tagged expected errors into existing oRPC failures. |
| `apps/server/effect/application.ts` | Acquire the provider/workflow graph once and expose it to startup and transport. |
| `apps/server/effect/request-context.ts` | Carry only headers, request ID, abort signal, and authenticated user ID. |
| `apps/server/router/base.ts` | Define narrow oRPC context, Effect authentication middleware, and reusable route/stream adapters. |
| `apps/server/router/services.ts` | Translate the existing Effect services into router use-case dependencies without globals. |
| `apps/server/router/{decks,cards,notes,drafts,ai,debug,notifications}.ts` | Run domain procedures through router services rather than facade modules. |
| `apps/server/app.ts` | Create the existing Hono application from the scoped runtime and app configuration. |
| `apps/server/main.ts` / `apps/server/lifecycle.ts` | Compose the application runtime, bind Bun, and own exact-once shutdown. |
| `apps/server/router/testing.ts` | Build a scoped test runtime and explicit test services instead of synthetic mutable context. |

### Task 1: Characterize the transport runner and error mapping

**Files:**
- Create: `apps/server/effect/transport.ts`
- Create: `apps/server/effect/transport.test.ts`
- Modify: `apps/server/effect/errors.ts`

**Interfaces:**
- Consumes: `AppRuntime<R, E>` and `RequestContextValue` from
  `apps/server/effect/runtime.ts` and `request-context.ts`.
- Produces: `runTransport(runtime, request, program): Promise<A>` and
  `toOrpcError(error): ORPCError` for all router adapters.

- [ ] **Step 1: Write failing transport tests.**

```ts
it("supplies only this request's values to a program", async () => {
  const runtime = makeTestRuntime(Layer.empty);
  await expect(runTransport(runtime, request("one"),
    Effect.map(RequestContext, ({ requestId }) => requestId),
  )).resolves.toBe("one");
  await runtime.dispose();
});

it("maps a tagged missing resource to the existing oRPC response", () => {
  const error = toOrpcError(new NotFound({ message: "Deck not found" }));
  expect(error.code).toBe("NOT_FOUND");
  expect(error.message).toBe("Deck not found");
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the module
  and exports do not exist.**

Run: `bun run --filter @mnimi/server test -- effect/transport.test.ts`

Expected: TypeScript/Vitest reports that `transport.ts`, `runTransport`, and
`toOrpcError` are missing.

- [ ] **Step 3: Implement the smallest common runner and mapper.**

```ts
export function runTransport<R, A, E>(
  runtime: AppRuntime<R, never>, request: RequestContextValue,
  program: Effect.Effect<A, E, R | RequestContext>,
): Promise<A> {
  return runRequest(runtime, program, request).catch((cause) => {
    throw toOrpcError(cause);
  });
}

export function toOrpcError(cause: unknown): ORPCError {
  if (cause instanceof NotFound) return new ORPCError("NOT_FOUND", { message: cause.message });
  if (cause instanceof Unauthorized) return new ORPCError("UNAUTHORIZED");
  if (cause instanceof Conflict) return new ORPCError("CONFLICT", { message: cause.message });
  if (cause instanceof Validation) return new ORPCError("BAD_REQUEST", { message: cause.message ?? "Invalid request" });
  if (cause instanceof DependencyUnavailable) return new ORPCError("INTERNAL_SERVER_ERROR", { message: cause.message });
  return new ORPCError("INTERNAL_SERVER_ERROR");
}
```

Unwrap the expected failure from an Effect runtime fiber before matching it;
leave an incoming `ORPCError` unchanged so oRPC input validation retains its
current response. Log unexpected defects exactly here using the request ID,
not in each router.

- [ ] **Step 4: Run focused transport and error tests.**

Run: `bun run --filter @mnimi/server test -- effect/transport.test.ts effect/errors.test.ts`

Expected: all pass, including the old expected-error assertions.

### Task 2: Build an application-owned Effect graph

**Files:**
- Create: `apps/server/effect/application.ts`
- Create: `apps/server/effect/application.test.ts`
- Modify: `apps/server/effect/live.ts`
- Modify: `apps/server/effect/index.ts`

**Interfaces:**
- Consumes: `CoreServices`, `BackgroundProvider`, `BackgroundWorkflows`,
  `MediaStore`, `ElevenLabs`, `ExpoPush`, and `AppConfig` services.
- Produces: `ApplicationServices` with `{ config, database, auth, provider,
  workflows }`, `makeApplicationLayer`, and `acquireApplication`.

- [ ] **Step 1: Write failing ownership tests.**

```ts
it("acquires the selected provider once and releases it after workflows", async () => {
  const events: string[] = [];
  const runtime = makeApplicationRuntime(testLayer(events));
  await acquireApplication(runtime);
  await runtime.dispose();
  expect(events).toEqual(["provider.acquire", "workflows.acquire", "workflows.release", "provider.release"]);
});
```

- [ ] **Step 2: Confirm red.**

Run: `bun run --filter @mnimi/server test -- effect/application.test.ts`

Expected: the application runtime exports are absent.

- [ ] **Step 3: Compose provider and workflows in one scoped Layer.**

`makeApplicationLayer` must acquire `BackgroundProvider` through
`acquireBackgroundProvider({ config })`, construct `BackgroundWorkflows` with
the same `Database`, provider, media, ElevenLabs, and Expo Push services, and
expose both through tags. Use `Layer.scoped`/`Effect.acquireRelease`, not a
manual `Scope.make` in `main.ts`. The workflow release calls `workflows.stop()`;
the provider scope closes only after that finalizer settles.

- [ ] **Step 4: Confirm green.**

Run: `bun run --filter @mnimi/server test -- effect/application.test.ts effect/core-runtime.test.ts effect/background-workflows.test.ts`

Expected: exact ordering, single acquisition, and the previous core/runtime
contracts pass.

### Task 3: Narrow oRPC context and authenticate through Effect

**Files:**
- Modify: `apps/server/effect/request-context.ts`
- Modify: `apps/server/router/base.ts`
- Modify: `apps/server/router/base.test.ts`
- Modify: `apps/server/router/testing.ts`

**Interfaces:**
- Consumes: `ApplicationServices`, `runTransport`, `Auth`, and
  `RequestContext`.
- Produces: `AppContext = { runtime, request }`, `AuthedContext` with only a
  verified `userId`, `runRoute`, and `runRouteStream`.

- [ ] **Step 1: Write failing context tests.**

```ts
it("does not expose database or provider objects in oRPC context", async () => {
  const { context } = await server.signIn("ada@example.test");
  expect(context).toEqual(expect.objectContaining({ runtime: expect.anything(), request: expect.anything() }));
  expect("db" in context).toBe(false);
  expect("modelCalls" in context).toBe(false);
});

it("maps failed Effect authentication to the same HTTP 401", async () => {
  await expect(pub.handler(({ context }) => context).call({ context: server.noHeaders })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
```

- [ ] **Step 2: Confirm red.**

Run: `bun run --filter @mnimi/server test -- router/base.test.ts`

Expected: the current context still exposes `db`, `auth`, and provider fields.

- [ ] **Step 3: Replace the context bag.**

Build a request object from the oRPC request headers, a `crypto.randomUUID()`
request ID, and `request.signal`. The authentication middleware uses
`runTransport` with `Auth`, wraps Better Auth's `getSession` promise in
`Effect.tryPromise`, fails `Unauthorized` when it has no session, and passes
only `{ userId }` to `next`. Move test overrides into test Layers and provide
the resulting managed runtime from `createTestServer`.

- [ ] **Step 4: Confirm green.**

Run: `bun run --filter @mnimi/server test -- router/base.test.ts browser-auth.test.ts app.test.ts`

Expected: cookie/bearer authentication and CORS tests preserve their original
status and headers.

### Task 4: Replace facade imports with explicit router services

**Files:**
- Create: `apps/server/router/services.ts`
- Create: `apps/server/router/services.test.ts`
- Modify: `apps/server/effect/background-workflows.ts`
- Modify: `apps/server/effect/media.ts`
- Modify: `apps/server/effect/audio-jobs.ts`

**Interfaces:**
- Consumes: `Database`, `BackgroundWorkflows`, `MediaStore`, `Auth`, and
  `RequestContext`.
- Produces: `RouterServices` methods for database effects, legacy creation,
  durable text/image work, creation events, audio jobs, notifications, and
  media operations.

- [ ] **Step 1: Write a failing no-facade test.**

```ts
it("uses the application workflow instead of the installed scheduler", async () => {
  const services = await testRouterServices();
  await Effect.runPromise(services.kickText("u1"));
  expect(services.workflows.text.kick).toHaveBeenCalledWith("u1");
});
```

- [ ] **Step 2: Confirm red.**

Run: `bun run --filter @mnimi/server test -- router/services.test.ts`

Expected: `RouterServices` and its direct workflow methods are missing.

- [ ] **Step 3: Expose Effect-native dependencies.**

Create a service that wraps a single Drizzle call with `Effect.tryPromise` at
the call site and delegates locked work to `Database.withWriteLock` or
`Database.transaction`. Expose `workflows.legacy`, `workflows.text`,
`workflows.images`, `workflows.events`, `workflows.audio`, and
`workflows.notifications` directly. Do not call
`installCreationSchedulerFacade`, `installDurableImageWorkflowFacade`,
`installCreationEventsFacade`, `installAudioJobsFacade`,
`installLegacyCreationWorkflowFacade`, or `installNotificationsFacade`.

- [ ] **Step 4: Confirm green.**

Run: `bun run --filter @mnimi/server test -- router/services.test.ts effect/background-workflows.test.ts effect/audio-jobs.test.ts`

Expected: service calls use the same live instances and no service is selected
from a module-global registry.

### Task 5: Convert simple router families to `runRoute`

**Files:**
- Modify: `apps/server/router/decks.ts`
- Modify: `apps/server/router/cards.ts`
- Modify: `apps/server/router/notifications.ts`
- Modify: `apps/server/router/ai.ts`
- Modify: corresponding `*.test.ts` files

**Interfaces:**
- Consumes: `runRoute(context, effect)`, `RouterServices`, and authenticated
  user ID from Task 3.
- Produces: unchanged decks/cards/notifications/AI oRPC procedure outputs with
  tagged expected errors instead of inline `ORPCError` throws.

- [ ] **Step 1: Add one failing test per family that proves it runs on the
  shared runtime.**

```ts
it("grades through the shared runtime without rebuilding it", async () => {
  const { server, runtimeStarts } = await createInstrumentedTestServer();
  await server.cards.grade({ cardId, rating: "good" }, context);
  expect(runtimeStarts()).toBe(1);
});
```

- [ ] **Step 2: Confirm each focused test is red.**

Run: `bun run --filter @mnimi/server test -- router/decks.test.ts router/cards.test.ts router/notifications.test.ts router/ai.test.ts`

Expected: test observes the old async handler/facade path.

- [ ] **Step 3: Convert handlers mechanically while preserving database
  boundaries.**

Each handler returns `runRoute(context, Effect.gen(...))`. Use
`Database.readSnapshot`, `Database.withWriteLock`, and
`Database.transaction` at the same places that currently call read
transactions, `withWriteLock`, and Drizzle transactions. Delegate audio,
image generation, image cleanup, and notification work to `RouterServices`.
Return `NotFound`, `Conflict`, `Validation`, or `DependencyUnavailable` from
the Effect program; the Task 1 mapper alone creates oRPC errors.

- [ ] **Step 4: Confirm green.**

Run: `bun run --filter @mnimi/server test -- router/decks.test.ts router/cards.test.ts router/notifications.test.ts router/ai.test.ts router/concurrency.test.ts`

Expected: all ownership, rollback, image-cleanup, and write-serialization
tests retain their assertions.

### Task 6: Convert notes and creation mutation use cases

**Files:**
- Modify: `apps/server/router/notes.ts`
- Modify: `apps/server/router/creation-save.ts`
- Modify: `apps/server/router/drafts.ts`
- Modify: corresponding `*.test.ts` files

**Interfaces:**
- Consumes: Task 4 `RouterServices`, its `legacy`, `text`, `images`, `audio`,
  `events`, and `media` members, plus Task 1 errors.
- Produces: Effect-returning note save, creation save/submit/resolve/retry,
  cancel, and media-claim use cases.

- [ ] **Step 1: Add failing transaction and admission tests.**

```ts
it("starts durable text only after its insert commits", async () => {
  const kick = vi.fn();
  await server.drafts.submit(input, context);
  expect(kick).toHaveBeenCalledWith(context.userId);
  expect(await insertedCreation()).toMatchObject({ status: "queued" });
});

it("keeps a running legacy image attached while a note is saved", async () => {
  await expect(server.notes.save(input, context)).resolves.toMatchObject({ id: expect.any(String) });
  expect(server.legacy.claimJobForNote).toHaveBeenCalled();
});
```

- [ ] **Step 2: Confirm red.**

Run: `bun run --filter @mnimi/server test -- router/notes.test.ts router/creation-save.test.ts router/drafts.test.ts router/creations.test.ts`

Expected: each test reaches old global scheduler, job, or event facade calls.

- [ ] **Step 3: Convert write flows without moving effects across their
  existing lock/transaction boundaries.**

Keep note draft consumption, creation receipt idempotency, card insertion, and
image-attempt ownership in their current single serialized transactions. After
successful commits, sequence Effect event publication and durable scheduler
kicks exactly where the previous code publishes/kicks. Preserve detached audio
behavior by forking the existing `AudioJobs` Effect after the note transaction
settles; it must not become request-owned.

- [ ] **Step 4: Confirm green.**

Run: `bun run --filter @mnimi/server test -- router/notes.test.ts router/creation-save.test.ts router/drafts.test.ts router/creations.test.ts router/concurrency.test.ts`

Expected: all retry, revision, media cleanup, rollback, and lease tests pass.

### Task 7: Bridge Effect creation streams to oRPC SSE

**Files:**
- Modify: `apps/server/router/drafts.ts`
- Modify: `apps/server/sse-contract.test.ts`
- Modify: `apps/server/router/creations.test.ts`
- Delete: `apps/server/creations/events.ts`
- Delete: `apps/server/creations/events.test.ts`

**Interfaces:**
- Consumes: `CreationEvents.subscribeDetail` and `subscribeInbox` Effects
  from `BackgroundWorkflows` and `runRouteStream(context, stream)`.
- Produces: unchanged `watch`, `watchInbox`, and legacy watch async-generator
  procedures with scope-backed disconnect cleanup.

- [ ] **Step 1: Add failing subscriber-lifetime tests.**

```ts
it("removes a durable watch subscriber when the oRPC iterator returns", async () => {
  const stream = await server.drafts.watch({ creationId }, context);
  await stream.next();
  await stream.return?.();
  expect(server.events.detailSubscriberCount(context.userId, creationId)).toBe(0);
});
```

- [ ] **Step 2: Confirm red.**

Run: `bun run --filter @mnimi/server test -- sse-contract.test.ts router/creations.test.ts`

Expected: the old `creations/events.ts` facade owns the subscriber scope.

- [ ] **Step 3: Implement the stream adapter.**

`runRouteStream` opens one Effect Scope per oRPC iterator, acquires the stream
pull in that scope, yields one chunk only when oRPC asks for the next value,
and closes the scope in `finally`. It supplies the request context, maps an
expected failure through `toOrpcError`, and does not prefetch a sliding-queue
snapshot. Rebuild the legacy draft watch from `workflows.legacy` with the same
snapshot then delta event order.

- [ ] **Step 4: Confirm green.**

Run: `bun run --filter @mnimi/server test -- sse-contract.test.ts router/creations.test.ts effect/creation-events.test.ts`

Expected: snapshot order, coalescing, error delivery, and disconnect cleanup
remain unchanged while the facade module is absent.

### Task 8: Convert debug operations and remove direct oRPC errors

**Files:**
- Modify: `apps/server/router/debug.ts`
- Modify: `apps/server/router/debug.test.ts`
- Modify: `apps/server/router/base.ts`

**Interfaces:**
- Consumes: Task 4 router services and Task 1 `Validation`, `NotFound`, and
  `Conflict` errors.
- Produces: Effect-backed devtools checks, reset operations, and German seed
  preparation with unchanged public errors.

- [ ] **Step 1: Add failing tests for tagged devtool failures.**

```ts
it("maps disabled devtools through the central transport mapper", async () => {
  await expect(server.debug.resetSrs({}, context)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
```

- [ ] **Step 2: Confirm red.**

Run: `bun run --filter @mnimi/server test -- router/debug.test.ts`

Expected: direct `ORPCError` construction remains in the debug router.

- [ ] **Step 3: Convert the debug handler and extend only the central mapper
  for the existing forbidden code.**

Use a tagged `Forbidden` error added beside the other Effect errors, map it to
the existing `FORBIDDEN` oRPC error, and retain the existing confirmation,
owner filtering, transaction, post-commit media cleanup, and cleanup-error
logging behavior. All database/filesystem work stays within Effects supplied
by Task 4 services.

- [ ] **Step 4: Confirm green.**

Run: `bun run --filter @mnimi/server test -- router/debug.test.ts german-seed-media.integration.test.ts`

Expected: all destructive-devtool and German seed media cases pass.

### Task 9: Wire startup, exact-once shutdown, and delete facades

**Files:**
- Modify: `apps/server/main.ts`
- Modify: `apps/server/main.test.ts`
- Modify: `apps/server/lifecycle.ts`
- Modify: `apps/server/lifecycle.test.ts`
- Modify: `apps/server/app.ts`
- Modify: `apps/server/app.test.ts`
- Delete: `apps/server/effect/legacy-bindings.ts`
- Delete: `apps/server/effect/legacy-bindings.test.ts`
- Delete: `apps/server/effect/background-provider-adapter.ts`
- Delete: `apps/server/effect/background-provider-adapter.test.ts`
- Delete the facade-only exports and tests in `apps/server/ai/jobs.ts`,
  `apps/server/creations/scheduler.ts`, `apps/server/creations/image-scheduler.ts`,
  `apps/server/tts/jobs.ts`, and `apps/server/notifications/dispatcher.ts`.

**Interfaces:**
- Consumes: `acquireApplication`, `createApp({ runtime, config })`, and the
  lifecycle cleanup contract.
- Produces: unchanged top-level `start()` behavior with one application scope
  and `shutdown(): Promise<void>` that fences then releases it once.

- [ ] **Step 1: Add failing startup and shutdown ordering tests.**

```ts
it("fences requests, stops Bun, then disposes the application runtime once", async () => {
  const shutdown = await start();
  await Promise.all([shutdown(), shutdown()]);
  expect(state.events).toEqual([
    "admissions.closed", "server.stop", "workflows.stop", "provider.dispose", "core.dispose",
  ]);
  expect(state.disposeApplication).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Confirm red.**

Run: `bun run --filter @mnimi/server test -- main.test.ts lifecycle.test.ts app.test.ts`

Expected: startup still allocates a manual provider scope and installs facade
registries.

- [ ] **Step 3: Replace manual bootstrap.**

Acquire `ApplicationServices` once, construct `createApp({ runtime, config })`,
recover and start workflows before `Bun.serve`, and register one signal handler
that invokes the shared shutdown promise. Lifecycle first rejects new transport
admissions, force-stops the Bun server, then releases the managed application
runtime. Collect server and scope release failures into the existing
`AggregateError` form. Remove all facade installation calls and all deleted
module imports; a repository search must find none of their names.

- [ ] **Step 4: Confirm green.**

Run: `bun run --filter @mnimi/server test -- main.test.ts lifecycle.test.ts app.test.ts runtime-paths.test.ts`

Expected: startup order, readiness timing, signal idempotence, cleanup
aggregation, and app transport behavior pass without facade modules.

### Task 10: Run the compatibility and production-shaped gates

**Files:**
- Modify only if a failing deterministic test exposes a compatibility defect
  in the preceding task's owned file.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a verified, facade-free single-runtime server migration.

- [ ] **Step 1: Run static and focused import-boundary checks.**

Run:

```bash
bun run check
bun run --filter @mnimi/server test -- import-boundary.test.ts sse-contract.test.ts main.test.ts lifecycle.test.ts
rg -n 'installCreationSchedulerFacade|installDurableImageWorkflowFacade|installCreationEventsFacade|installAudioJobsFacade|installLegacyCreationWorkflowFacade|installNotificationsFacade|makeLegacyBindings|makeAiProviderAdapter' apps/server
```

Expected: checks pass and the final search has no production hits.

- [ ] **Step 2: Run the complete deterministic suite.**

Run: `VITEST_MAX_WORKERS=2 bun run test`

Expected: exit 0. Report pre-existing Expo Go notification warnings separately
from server assertions if the mobile test environment emits them.

- [ ] **Step 3: Run production-shaped server validation.**

Run:

```bash
bun run --filter @mnimi/server validate-runtime-config
bun run --filter @mnimi/server runtime-smoke
git diff --check
git status --short
```

Expected: runtime configuration and smoke checks pass; diff whitespace is
clean; status contains only the scoped implementation and design/plan files.

## Plan Self-Review

- Scope coverage: Tasks 1, 3, and 5–8 move transport and all router families;
  Task 2 owns the application graph; Task 7 preserves SSE; Task 9 owns startup,
  shutdown, and facade removal; Task 10 runs every required gate.
- No-placeholder scan: the plan contains concrete paths, interfaces, tests,
  commands, and implementation directions for every task.
- Type consistency: `ApplicationServices`, `RouterServices`, `runTransport`,
  `runRoute`, and `runRouteStream` are introduced before later tasks consume
  them; the final bootstrap consumes `acquireApplication` from Task 2.
