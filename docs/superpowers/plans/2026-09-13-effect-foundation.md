# Effect Foundation and Server Characterization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Characterize Mnimi's missing server transport and lifecycle contracts, then add a stable Effect 3 foundation without converting production domain behavior.

**Architecture:** Keep the current Bun/Hono/oRPC/Better Auth/Drizzle server untouched while adding behavior-level tests around its remaining unpinned boundaries. Add only cross-cutting Effect primitives: tagged expected errors, request-local context, a generic `ManagedRuntime` bridge, and test Layer helpers; domain service interfaces and live Layers belong to later child projects.

**Tech Stack:** Bun 1.3.13, TypeScript 6, Vitest 4, Hono 4, oRPC 1, Better Auth 1, Drizzle/libSQL, Effect 3.22.2.

**Spec:** `docs/superpowers/specs/2026-09-13-effect-server-migration-design.md`

**Pimp source IDs:** Parent program `mnimi-pi5`; this child project `mnimi-pi5.1`.

## Global Constraints

- Use `bun` for package management and public scripts; never use npm, npx, pnpm, Yarn, or Deno.
- Pin exactly `effect@3.22.2`; do not add Effect 4 or `@effect/platform-bun`.
- Retain Bun, Hono, oRPC, Better Auth, Drizzle/libSQL, Zod, and LogTape.
- Do not modify production domain behavior in `main.ts`, `app.ts`, routers, database code, jobs, schedulers, providers, media, or authentication.
- Preserve all routes, wire shapes, error payloads, SSE framing, authentication behavior, database semantics, provider behavior, and lifecycle behavior.
- New Effect foundation modules must not import `main.ts`, `app.ts`, router modules, `db/index.ts`, `auth.instance.ts`, provider implementations, filesystem implementations, or `logging.ts`.
- Do not predeclare domain service interfaces. Each later child project defines its interfaces after its current behavior is characterized.
- Keep request values out of application-wide Layers. `RequestContext` is supplied once per invocation.
- Promise boundaries remain only at transport, test, and third-party/runtime interoperability edges.
- Use conventional commits. Stage only the paths listed for the current task and do not push this ephemeral branch.
- Run the full repository suite with `bun run test`, never raw `bun test`.

## Existing characterization retained

Do not duplicate or weaken the contracts already covered by the current suite:

- `auth.test.ts`, `browser-auth.test.ts`, and `app.test.ts` cover native bearer,
  browser cookie, registration reporting, authenticated and unauthenticated
  RPC, safe HTTP errors, and provider injection.
- `images.test.ts` and `audio.test.ts` cover authenticated ownership, missing
  resources, invalid identifiers, and unauthenticated media responses.
- `creations/events.test.ts`, `worker.test.ts`, and
  `image-scheduler.test.ts` cover generator cleanup, ordering/fencing, durable
  recovery, retry, late results, and the existing text heartbeat terminal path.
- `notifications/dispatcher.test.ts`, `lifecycle.test.ts`, and `main.test.ts`
  cover grouping, invalid-token cleanup, idempotent resource cleanup,
  startup order, admission fencing, and signal-driven shutdown order.
- `ai/jobs.test.ts`, provider tests, and the Codex lifecycle tests remain the
  detailed source of truth for cancellation, retry, detached work, and process
  ownership. This child adds no replacement behavior for those contracts.

## File and ownership map

Every named worker is `gpt-5.6-luna` at the indicated `high` or `xhigh`
reasoning effort.

| Path | Responsibility | Planned owner |
| --- | --- | --- |
| `apps/server/app.test.ts` | Missing registration and CORS transport contracts | Luna high |
| `apps/server/images.test.ts` | Authenticated media CORS response contract | Luna high |
| `apps/server/import-boundary.test.ts` | Pure server-module import contract | Luna high |
| `apps/server/sse-contract.test.ts` | Real Hono/oRPC SSE framing and cleanup | Luna xhigh |
| `apps/server/creations/scheduler.test.ts` | Text scheduler start/stop contract | Luna xhigh |
| `apps/server/creations/image-scheduler.test.ts` | Image scheduler and heartbeat cleanup contract | Luna xhigh |
| `apps/server/notifications/dispatcher.test.ts` | Debounce and drop-on-stop contract | Luna high |
| `apps/server/lifecycle.test.ts` | Cleanup error aggregation contract | Luna high |
| `apps/server/scripts/runtime-smoke.ts` | Production-shaped auth/RPC/process smoke | Luna xhigh |
| `apps/server/package.json`, `bun.lock` | Exact Effect dependency | Luna high, single owner |
| `apps/server/effect/errors.ts` | Transport-independent tagged expected errors | Luna high |
| `apps/server/effect/request-context.ts` | Request-local Effect service | Luna xhigh |
| `apps/server/effect/runtime.ts` | Generic managed-runtime request bridge | Luna xhigh |
| `apps/server/effect/testing.ts` | Small Layer/runtime test helpers | Luna high |
| `apps/server/effect/index.ts` | Foundation public exports | Luna high |

Tasks are sequential unless the coordinator explicitly assigns non-overlapping
characterization tasks in parallel. Every worker reads the program spec and
this complete plan before editing. The coordinator reviews the diff and reruns
the task gate before accepting a worker result.

---

### Task 1: Characterize registration, CORS, and pure imports

**Files:**

- Modify: `apps/server/app.test.ts:92-283`
- Modify: `apps/server/images.test.ts:90-115`
- Create: `apps/server/import-boundary.test.ts`

**Interfaces:**

- Consumes: existing `createApp`, `createAuth`, `createTestDb`, and Bun subprocess APIs.
- Produces: transport assertions that later runtime/config adapters must continue to satisfy; no production exports.

- [ ] **Step 1: Add the disabled-registration and CORS preflight cases**

Append these cases inside the existing `describe("app", ...)` block in
`apps/server/app.test.ts`:

```ts
it("rejects HTTP signup when public registration is disabled", async () => {
  const closedAuth = createAuth(db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    registrationEnabled: false,
  });
  const closedApp = createApp({
    db,
    auth: closedAuth,
    corsOrigin: "http://localhost:1420",
    registrationEnabled: false,
  });

  const response = await closedApp.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "blocked@example.com",
      password: "correct-horse",
      name: "blocked",
    }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    message: "Email and password sign up is not enabled",
    code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
  });
});

it.each([
  ["http://localhost:1420", "http://localhost:1420"],
  ["https://evil.example", null],
])(
  "preserves CORS preflight visibility for %s",
  async (origin, allowedOrigin) => {
    const response = await app.request("/rpc/decks/create", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin"))
      .toBe(allowedOrigin);
  },
);
```

- [ ] **Step 2: Run the new app characterizations against the current server**

Run:

```bash
bun run --cwd apps/server vitest run app.test.ts
```

Expected: PASS. These are characterization tests. If they fail, inspect the
actual response and correct the documented assumption; do not change
production behavior to force the expected result.

- [ ] **Step 3: Add the authenticated image CORS response contract**

Append this case inside `describe("GET /images/notes/:noteId", ...)` in
`apps/server/images.test.ts`:

```ts
it("includes the allowed browser CORS header on an authenticated image", async () => {
  const ada = await signUp("cors-image@example.com");
  const noteId = await seedNote(ada.userId, `${ada.userId}/cors.png`);
  writePng(`${ada.userId}/cors.png`);

  const response = await app.request(`/images/notes/${noteId}`, {
    headers: {
      ...ada.headers,
      Origin: "http://localhost:1420",
    },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin"))
    .toBe("http://localhost:1420");
});
```

- [ ] **Step 4: Add the pure import subprocess test**

Create `apps/server/import-boundary.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const temporaryDirectories: string[] = [];
const serverDir = fileURLToPath(new URL(".", import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("server import boundary", () => {
  it("imports pure transport modules without opening production resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnimi-import-boundary-"));
    temporaryDirectories.push(root);
    const databaseDir = join(root, "database");
    const imagesDir = join(root, "images");
    const audioDir = join(root, "audio");
    const source = [
      'await import("./app.ts")',
      'await import("./router/index.ts")',
      'await import("./images.ts")',
      'await import("./audio.ts")',
    ].join(";");
    const process = Bun.spawn(["bun", "--no-env-file", "-e", source], {
      cwd: serverDir,
      env: {
        ...globalThis.process.env,
        DATABASE_URL: `file:${join(databaseDir, "mnimi.db")}`,
        IMAGES_DIR: imagesDir,
        AUDIO_DIR: audioDir,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(existsSync(databaseDir)).toBe(false);
    expect(existsSync(imagesDir)).toBe(false);
    expect(existsSync(audioDir)).toBe(false);
  });
});
```

- [ ] **Step 5: Run the import contract**

Run:

```bash
bun run --cwd apps/server vitest run import-boundary.test.ts
```

Expected: PASS with no stdout or stderr and no configured database or media
directory created by the child import. This is a characterization test; if it
fails, diagnose the current import side effect rather than changing production
behavior in this child project.

- [ ] **Step 6: Run the characterization files**

Run:

```bash
bun run --cwd apps/server vitest run app.test.ts images.test.ts import-boundary.test.ts
```

Expected: all three files PASS and no configured database or media directory
is created by the child import.

- [ ] **Step 7: Commit Task 1**

```bash
git add apps/server/app.test.ts apps/server/images.test.ts apps/server/import-boundary.test.ts
git commit -m "test(server): characterize transport import boundaries"
```

---

### Task 2: Characterize real oRPC SSE framing and disconnect cleanup

**Files:**

- Create: `apps/server/sse-contract.test.ts`

**Interfaces:**

- Consumes: `createApp`, `createTestServer`, `drafts`, `publishCreationSnapshots`, and `detailSubscriberCount`.
- Produces: a black-box SSE contract for the later Effect Stream adapter.

- [ ] **Step 1: Create the complete SSE contract test**

Create `apps/server/sse-contract.test.ts` with the imports, fixture, frame
parser, and test below:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { createApp } from "./app.ts";
import { drafts } from "./db/schema.ts";
import {
  detailSubscriberCount,
  publishCreationSnapshots,
} from "./creations/events.ts";
import { createTestServer } from "./router/testing.ts";

type TestServer = Awaited<ReturnType<typeof createTestServer>>;

let server: TestServer;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => server.close());

function sseMessageReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  const decoder = new TextDecoder();
  const messages: unknown[] = [];
  let buffered = "";

  return async function readMessage(): Promise<unknown> {
    while (messages.length === 0) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended before the next message");
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";

      for (const frame of frames) {
        const data = frame.split("\n")
          .find((line) => line.startsWith("data: "));
        if (data) messages.push(JSON.parse(data.slice("data: ".length)));
      }
    }

    return messages.shift();
  };
}

describe("oRPC SSE transport", () => {
  it("preserves framing, snapshot order, and disconnect cleanup", async () => {
    const ada = await server.signIn("sse@example.com");
    const creationId = uuidv7();
    await server.db.insert(drafts).values({
      id: creationId,
      userId: ada.userId,
      clientRequestId: "sse-request",
      sourceText: "watch this",
      status: "queued",
      operation: "route_generate",
    });
    const authorization = ada.context.reqHeaders?.get("authorization");
    if (!authorization) throw new Error("test bearer token was not created");
    const app = createApp({ db: server.db, auth: server.auth });
    const controller = new AbortController();
    const response = await app.request("/rpc/drafts/watch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization,
      },
      body: JSON.stringify({ json: { creationId } }),
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    if (!response.body) throw new Error("SSE response had no body");
    const reader = response.body.getReader();
    const readMessage = sseMessageReader(reader);

    try {
      await expect(readMessage()).resolves.toMatchObject({
        json: {
          type: "snapshot",
          creationId,
          creation: { status: "queued" },
        },
      });
      expect(detailSubscriberCount(ada.userId, creationId)).toBe(1);

      const [ready] = await server.db.update(drafts).set({ status: "ready" })
        .where(eq(drafts.id, creationId)).returning();
      await publishCreationSnapshots(server.db, ready, null);

      await expect(readMessage()).resolves.toMatchObject({
        json: {
          type: "snapshot",
          creationId,
          creation: { status: "ready" },
        },
      });
    } finally {
      controller.abort();
      await reader.cancel();
    }

    await vi.waitFor(() =>
      expect(detailSubscriberCount(ada.userId, creationId)).toBe(0)
    );
  });
});
```

- [ ] **Step 2: Run the SSE characterization contract**

Run:

```bash
bun run --cwd apps/server vitest run sse-contract.test.ts
```

Expected: PASS. The parser ignores oRPC's initial `: ` heartbeat frame, reads
both message frames in order, and subscriber count returns to zero after
disconnect. This is a characterization test; diagnose any mismatch against the
current transport before changing production behavior.

- [ ] **Step 3: Commit Task 2**

```bash
git add apps/server/sse-contract.test.ts
git commit -m "test(server): pin oRPC SSE transport contract"
```

---

### Task 3: Characterize scheduler, notification, and cleanup lifecycles

**Files:**

- Modify: `apps/server/creations/scheduler.test.ts:1-181`
- Modify: `apps/server/creations/image-scheduler.test.ts:1-325`
- Modify: `apps/server/notifications/dispatcher.test.ts:1-75`
- Modify: `apps/server/lifecycle.test.ts:1-45`

**Interfaces:**

- Consumes: existing scheduler factories, notification dispatcher, and `createShutdown`.
- Produces: lifecycle contracts used by the later Effect fiber/finalizer migrations.

- [ ] **Step 1: Characterize creation scheduler immediate polling and stop**

Add `vi` to the Vitest import and `startCreationScheduler` to the scheduler
imports. Append this case to `apps/server/creations/scheduler.test.ts`:

```ts
it("polls immediately and ignores kicks after stop", async () => {
  await seedQueued("ada", "initial", new Date(100));
  const runWork = vi.fn(async () => {});
  const scheduler = startCreationScheduler({
    db: testDb.db,
    runWork,
    intervalMs: 60_000,
    leaseOwner: "scheduler-test",
    now: () => new Date(1_000),
  });

  try {
    await vi.waitFor(() => expect(runWork).toHaveBeenCalledTimes(1));
    expect(runWork.mock.calls[0][0].creationId).toBe("initial");

    scheduler.stop();
    await seedQueued("ada", "after-stop", new Date(200));
    scheduler.kick("ada");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(runWork).toHaveBeenCalledTimes(1);
  } finally {
    scheduler.stop();
  }
});
```

- [ ] **Step 2: Characterize completion-kick coalescing**

Append this case to `apps/server/creations/scheduler.test.ts`:

```ts
it("drains completion kicks without dispatching a claim twice", async () => {
  for (const [id, queuedAt] of [
    ["coalesced-1", new Date(100)],
    ["coalesced-2", new Date(200)],
    ["coalesced-3", new Date(300)],
  ] as const) {
    await seedQueued("ada", id, queuedAt);
  }
  const releases = new Map<string, () => void>();
  const runWork = vi.fn((work: { creationId: string }) =>
    new Promise<void>((resolve) => releases.set(work.creationId, resolve))
  );
  const scheduler = startCreationScheduler({
    db: testDb.db,
    runWork,
    intervalMs: 60_000,
    leaseOwner: "coalescing-test",
    now: () => new Date(1_000),
  });

  try {
    await vi.waitFor(() =>
      expect(runWork).toHaveBeenCalledTimes(MAX_ACTIVE_TEXT_WORK_PER_USER)
    );
    const firstBatch = [...releases.entries()];
    expect(firstBatch).toHaveLength(MAX_ACTIVE_TEXT_WORK_PER_USER);
    for (const [, release] of firstBatch) release();

    await vi.waitFor(() => expect(runWork).toHaveBeenCalledTimes(3));
    expect(new Set(
      runWork.mock.calls.map(([work]) => work.creationId),
    )).toEqual(new Set(["coalesced-1", "coalesced-2", "coalesced-3"]));
  } finally {
    scheduler.stop();
    for (const release of releases.values()) release();
  }
});
```

- [ ] **Step 3: Characterize recovery after a failed text poll**

Append this case to `apps/server/creations/scheduler.test.ts`:

```ts
it("logs a failed poll and retries on the next interval", async () => {
  vi.useFakeTimers();
  await seedQueued("ada", "after-failed-poll", new Date(100));
  const failure = new Error("poll failed");
  let failNextDelete = true;
  const flakyDb = new Proxy(testDb.db, {
    get(target, property) {
      if (property === "delete" && failNextDelete) {
        return () => {
          failNextDelete = false;
          throw failure;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const runWork = vi.fn(async () => {});
  const scheduler = startCreationScheduler({
    db: flakyDb,
    runWork,
    intervalMs: 60_000,
    leaseOwner: "failed-poll-test",
    now: () => new Date(1_000),
  });

  try {
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith("creation scheduler failed", failure)
    );
    expect(runWork).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(runWork).toHaveBeenCalledOnce());
  } finally {
    scheduler.stop();
    report.mockRestore();
    vi.useRealTimers();
  }
});
```

- [ ] **Step 4: Characterize image scheduler immediate polling and stop**

Add `startImageScheduler` to the imports in
`apps/server/creations/image-scheduler.test.ts` and append:

```ts
it("polls immediately and ignores image kicks after stop", async () => {
  await seedCreation("ada", "initial");
  const runWork = vi.fn(async () => {});
  const scheduler = startImageScheduler({
    db: testDb.db,
    runWork,
    intervalMs: 60_000,
    leaseOwner: "image-scheduler-test",
    now: () => new Date(1_000),
  });

  try {
    await vi.waitFor(() => expect(runWork).toHaveBeenCalledTimes(1));
    expect(runWork.mock.calls[0][0].creationId).toBe("initial");

    scheduler.stop();
    await seedCreation("ada", "after-stop");
    scheduler.kick();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(runWork).toHaveBeenCalledTimes(1);
  } finally {
    scheduler.stop();
  }
});
```

- [ ] **Step 5: Characterize image completion-kick coalescing**

Append this case to `apps/server/creations/image-scheduler.test.ts`:

```ts
it("drains image completion kicks without dispatching an attempt twice", async () => {
  await seedCreation("ada", "coalesced-image-1");
  await seedCreation("ada", "coalesced-image-2");
  await seedCreation("bob", "coalesced-image-3");
  const releases = new Map<string, () => void>();
  const runWork = vi.fn((work: { creationId: string }) =>
    new Promise<void>((resolve) => releases.set(work.creationId, resolve))
  );
  const scheduler = startImageScheduler({
    db: testDb.db,
    runWork,
    intervalMs: 60_000,
    leaseOwner: "image-coalescing-test",
    now: () => new Date(1_000),
  });

  try {
    await vi.waitFor(() =>
      expect(runWork).toHaveBeenCalledTimes(MAX_ACTIVE_IMAGE_WORK)
    );
    const firstBatch = [...releases.entries()];
    expect(firstBatch).toHaveLength(MAX_ACTIVE_IMAGE_WORK);
    for (const [, release] of firstBatch) release();

    await vi.waitFor(() => expect(runWork).toHaveBeenCalledTimes(3));
    expect(new Set(
      runWork.mock.calls.map(([work]) => work.creationId),
    )).toEqual(new Set([
      "coalesced-image-1",
      "coalesced-image-2",
      "coalesced-image-3",
    ]));
  } finally {
    scheduler.stop();
    for (const release of releases.values()) release();
  }
});
```

- [ ] **Step 6: Characterize recovery after a failed image poll**

Append this case to `apps/server/creations/image-scheduler.test.ts`:

```ts
it("logs a failed image poll and retries on the next interval", async () => {
  vi.useFakeTimers();
  await seedCreation("ada", "after-failed-image-poll");
  const failure = new Error("image poll failed");
  let failNextUpdate = true;
  const flakyDb = new Proxy(testDb.db, {
    get(target, property) {
      if (property === "update" && failNextUpdate) {
        return () => {
          failNextUpdate = false;
          throw failure;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const runWork = vi.fn(async () => {});
  const scheduler = startImageScheduler({
    db: flakyDb,
    runWork,
    intervalMs: 60_000,
    leaseOwner: "failed-image-poll-test",
    now: () => new Date(1_000),
  });

  try {
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith("image scheduler failed", failure)
    );
    expect(runWork).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(runWork).toHaveBeenCalledOnce());
  } finally {
    scheduler.stop();
    report.mockRestore();
    vi.useRealTimers();
  }
});
```

- [ ] **Step 7: Pin image heartbeat cleanup on failure**

Append this case to `apps/server/creations/image-scheduler.test.ts`:

```ts
it("clears the image heartbeat when generation fails", async () => {
  await seedCreation("ada", "heartbeat-failure");
  const [work] = await claimCreationImageWork(testDb.db, {
    leaseOwner: "image-worker",
  });
  const heartbeat = 123 as unknown as ReturnType<typeof setInterval>;
  const interval = vi.spyOn(globalThis, "setInterval")
    .mockReturnValue(heartbeat);
  const clear = vi.spyOn(globalThis, "clearInterval")
    .mockImplementation(() => {});

  try {
    await runCreationImageAttempt(work, deps({
      generateImageBytes: vi.fn(async () => {
        throw new Error("provider diagnostic");
      }),
    }));

    expect(interval).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(heartbeat);
  } finally {
    interval.mockRestore();
    clear.mockRestore();
  }
});
```

- [ ] **Step 8: Pin notification timer replacement and drop-on-stop**

Append these cases to `apps/server/notifications/dispatcher.test.ts`:

```ts
it("replaces the debounce timer and sends one grouped notification", async () => {
  vi.useFakeTimers();
  await testDb.db.insert(drafts).values([
    { id: "debounce-one", userId: "ada", sourceText: "one", status: "ready" },
    { id: "debounce-two", userId: "ada", sourceText: "two", status: "ready" },
  ]);
  const send = vi.fn(async (_messages: ExpoPushMessage[]) => ({
    invalidTokens: [] as string[],
  }));
  const dispatcher = createNotificationDispatcher({
    db: testDb.db,
    send,
    delayMs: 2_000,
  });

  try {
    dispatcher.queue("ada", "debounce-one");
    await vi.advanceTimersByTimeAsync(1_000);
    dispatcher.queue("ada", "debounce-two");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0][0]).toMatchObject({
      body: "2 creations are ready to review",
      data: { route: "/add" },
    });
  } finally {
    dispatcher.stop();
    vi.useRealTimers();
  }
});

it("drops pending notifications when stopped", async () => {
  vi.useFakeTimers();
  await testDb.db.insert(drafts).values({
    id: "stopped",
    userId: "ada",
    sourceText: "stopped",
    status: "ready",
  });
  const send = vi.fn(async (_messages: ExpoPushMessage[]) => ({
    invalidTokens: [] as string[],
  }));
  const dispatcher = createNotificationDispatcher({
    db: testDb.db,
    send,
    delayMs: 2_000,
  });

  try {
    dispatcher.queue("ada", "stopped");
    dispatcher.stop();
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
  } finally {
    dispatcher.stop();
    vi.useRealTimers();
  }
});
```

- [ ] **Step 9: Pin aggregate cleanup failure behavior**

Append this case to `apps/server/lifecycle.test.ts`:

```ts
it("attempts every cleanup and aggregates a resource failure", async () => {
  const failure = new Error("HTTP stop failed");
  const resources = {
    server: { stop: vi.fn(async () => { throw failure; }) },
    creationScheduler: { stop: vi.fn() },
    imageScheduler: { stop: vi.fn() },
    sweepInterval: 123 as unknown as ReturnType<typeof setInterval>,
  };
  const aiProvider = {
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
  const clearSweep = vi.fn();
  const markShuttingDown = vi.fn();
  const shutdown = createShutdown({
    aiProvider,
    resources,
    clearSweep,
    markShuttingDown,
  });

  await expect(shutdown()).rejects.toMatchObject({
    name: "AggregateError",
    errors: [failure],
  });
  expect(markShuttingDown).toHaveBeenCalledOnce();
  expect(resources.server.stop).toHaveBeenCalledWith(true);
  expect(resources.creationScheduler.stop).toHaveBeenCalledOnce();
  expect(resources.imageScheduler.stop).toHaveBeenCalledOnce();
  expect(clearSweep).toHaveBeenCalledWith(resources.sweepInterval);
  expect(aiProvider[Symbol.asyncDispose]).toHaveBeenCalledOnce();
});
```

- [ ] **Step 10: Run the lifecycle characterization group**

Run:

```bash
bun run --cwd apps/server vitest run creations/scheduler.test.ts creations/image-scheduler.test.ts notifications/dispatcher.test.ts lifecycle.test.ts
```

Expected: all characterization tests PASS against the unchanged production
implementation. A failure is an assumption mismatch to diagnose before any
Effect conversion.

- [ ] **Step 11: Commit Task 3**

```bash
git add apps/server/creations/scheduler.test.ts apps/server/creations/image-scheduler.test.ts apps/server/notifications/dispatcher.test.ts apps/server/lifecycle.test.ts
git commit -m "test(server): characterize resource lifecycles"
```

---

### Task 4: Expand the production-shaped runtime smoke

**Files:**

- Modify: `apps/server/scripts/runtime-smoke.ts:1-119`

**Interfaces:**

- Consumes: the existing migration command, `main.ts` process entrypoint, Better Auth HTTP API, and oRPC HTTP routes.
- Produces: one black-box process contract for startup, disabled registration, sign-in, authenticated RPC, media authentication, and bounded SIGTERM shutdown.

- [ ] **Step 1: Add checked subprocess and JSON request helpers**

Add these helpers below `output()`:

```ts
async function runChecked(
  command: string[],
  environment: Record<string, string | undefined>,
  label: string,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: serverDir,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    output(child.stdout),
    output(child.stderr),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${exitCode}\n${lastLines(stdout, stderr)}`,
    );
  }
}

async function jsonRequest(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}
```

- [ ] **Step 2: Replace the inline migration process with `runChecked`**

Replace the current migration spawn/result block with:

```ts
    await runChecked(
      ["bun", "run", "db:migrate"],
      environment,
      "migration",
    );
```

- [ ] **Step 3: Seed a user without enabling public registration**

Immediately after migration, add:

```ts
    const seedUser = [
      'const { db } = await import("./db/index.ts")',
      'const { createUser } = await import("./scripts/create-user.ts")',
      'await createUser(db, { email: "runtime@example.com", name: "Runtime", password: "correct-horse" }, { secret: process.env.BETTER_AUTH_SECRET, baseURL: process.env.BETTER_AUTH_URL })',
    ].join(";");
    await runChecked(
      ["bun", "--no-env-file", "-e", seedUser],
      environment,
      "user seed",
    );
```

Keep `REGISTRATION_ENABLED: "false"` in the server environment.

- [ ] **Step 4: Add registration, sign-in, RPC, and media checks**

After the readiness loop succeeds and before leaving the `try` block, add:

```ts
    const baseUrl = `http://127.0.0.1:${port}`;
    const registration = await jsonRequest(`${baseUrl}/api/registration`);
    if (
      registration.response.status !== 200 ||
      JSON.stringify(registration.body) !== JSON.stringify({ enabled: false })
    ) {
      throw new Error(
        `registration contract failed: ${registration.response.status} ${JSON.stringify(registration.body)}`,
      );
    }

    const signIn = await jsonRequest(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "runtime@example.com",
        password: "correct-horse",
      }),
    });
    const token = signIn.response.headers.get("set-auth-token");
    if (signIn.response.status !== 200 || !token) {
      throw new Error(
        `sign-in contract failed: ${signIn.response.status} ${JSON.stringify(signIn.body)}`,
      );
    }
    const rpcHeaders = {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
    };
    const created = await jsonRequest(`${baseUrl}/rpc/decks/create`, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({ json: { name: "Runtime smoke" } }),
    });
    if (created.response.status !== 200) {
      throw new Error(
        `deck create failed: ${created.response.status} ${JSON.stringify(created.body)}`,
      );
    }
    const listed = await jsonRequest(`${baseUrl}/rpc/decks/list`, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({ json: {} }),
    });
    if (
      listed.response.status !== 200 ||
      !JSON.stringify(listed.body).includes("Runtime smoke")
    ) {
      throw new Error(
        `deck list failed: ${listed.response.status} ${JSON.stringify(listed.body)}`,
      );
    }

    for (const path of [
      "/images/notes/0198c0b0-0000-7000-8000-000000000099",
      "/audio/cards/0198c0b0-0000-7000-8000-000000000099",
    ]) {
      const media = await fetch(`${baseUrl}${path}`);
      if (media.status !== 401) {
        throw new Error(`media auth failed for ${path}: ${media.status}`);
      }
    }
```

- [ ] **Step 5: Bound graceful process shutdown and force-clean a timeout**

Replace `stopServer()` with:

```ts
  async function stopServer(): Promise<string> {
    if (!server) return "";
    const runningServer = server;
    if (runningServer.exitCode === null) runningServer.kill("SIGTERM");
    let timedOut = false;
    const exitCode = await Promise.race([
      runningServer.exited,
      Bun.sleep(5_000).then(() => {
        timedOut = true;
        return null;
      }),
    ]);
    if (timedOut) {
      if (runningServer.exitCode === null) runningServer.kill("SIGKILL");
      await runningServer.exited;
    }
    const logs = lastLines(
      stdout ? await stdout : "",
      stderr ? await stderr : "",
    );
    server = undefined;
    if (timedOut) {
      throw new Error(
        `server did not exit within five seconds of SIGTERM${
          logs ? `\nserver output:\n${logs}` : ""
        }`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(
        `server exited with status ${exitCode}${
          logs ? `\nserver output:\n${logs}` : ""
        }`,
      );
    }
    return logs;
  }
```

- [ ] **Step 6: Run the production-shaped smoke**

Run:

```bash
bun run --cwd apps/server scripts/runtime-smoke.ts
```

Expected: PASS with no output. If the observed handled-SIGTERM exit status is
not zero, record the actual current status in the assertion instead of
changing `main.ts` in this child.

- [ ] **Step 7: Run the server package gate**

Run:

```bash
bun run server:check
VITEST_MAX_WORKERS=2 bun run server:test
```

Expected: server TypeScript check and all server tests, including runtime
smoke, PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/server/scripts/runtime-smoke.ts
git commit -m "test(server): expand runtime smoke contract"
```

---

### Task 5: Pin Effect 3 and add tagged expected errors

**Files:**

- Modify: `apps/server/package.json:15-32`
- Modify: `bun.lock`
- Create: `apps/server/effect/errors.ts`
- Create: `apps/server/effect/errors.test.ts`

**Interfaces:**

- Consumes: stable `effect@3.22.2` `Data.TaggedError`, `Effect.catchTag`, and `Exit` APIs.
- Produces: `ValidationIssue`, ten tagged error classes, and the `ExpectedError` union.

- [ ] **Step 1: Add the exact stable Effect dependency**

Run:

```bash
bun add --cwd apps/server --exact effect@3.22.2
```

Expected: `apps/server/package.json` contains `"effect": "3.22.2"` under
runtime dependencies and `bun.lock` changes only as required by that package.

- [ ] **Step 2: Write the tagged-error tests before the module exists**

Create `apps/server/effect/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import {
  Conflict,
  DatabaseFailure,
  DependencyUnavailable,
  InfrastructureFailure,
  Interrupted,
  MediaFailure,
  NotFound,
  ProviderFailure,
  Unauthorized,
  Validation,
  type ExpectedError,
} from "./errors.ts";

describe("Effect expected errors", () => {
  it("keeps every expected failure uniquely tagged", () => {
    const errors: ExpectedError[] = [
      new Unauthorized({}),
      new NotFound({ message: "Deck not found" }),
      new Conflict({ message: "Creation changed" }),
      new Validation({
        issues: [{ path: ["name"], message: "Name is required" }],
      }),
      new DependencyUnavailable({
        dependency: "AI provider",
        message: "AI provider is not configured",
      }),
      new DatabaseFailure({ operation: "decks.list" }),
      new ProviderFailure({
        provider: "openrouter",
        operation: "classify",
        message: "Classification failed",
      }),
      new MediaFailure({
        operation: "image.read",
        message: "Image read failed",
      }),
      new Interrupted({ operation: "creation.generate" }),
      new InfrastructureFailure({
        operation: "server.start",
        message: "Server startup failed",
      }),
    ];

    expect(new Set(errors.map((error) => error._tag)).size)
      .toBe(errors.length);
  });

  it("is directly yieldable as a typed Effect failure", async () => {
    const yielded = Effect.gen(function* () {
      yield* new Unauthorized({ message: "Sign in required" });
    });

    await expect(Effect.runPromise(Effect.flip(yielded))).resolves
      .toMatchObject({
        _tag: "Unauthorized",
        message: "Sign in required",
      });
  });

  it("narrows a selected tag without swallowing other failures", async () => {
    const handled = Effect.fail(
      new NotFound({ message: "Deck not found" }),
    ).pipe(
      Effect.catchTag("NotFound", (error) => Effect.succeed(error.message)),
    );

    await expect(Effect.runPromise(handled)).resolves.toBe("Deck not found");
    const unhandled = await Effect.runPromiseExit(
      Effect.fail(new Conflict({ message: "Creation changed" })),
    );
    expect(Exit.isFailure(unhandled)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify the missing module failure**

Run:

```bash
bun run --cwd apps/server vitest run effect/errors.test.ts
```

Expected: FAIL because `effect/errors.ts` does not exist.

- [ ] **Step 4: Implement the tagged errors**

Create `apps/server/effect/errors.ts`:

```ts
import { Data } from "effect";

export type ValidationIssue = {
  readonly path: ReadonlyArray<string | number>;
  readonly code?: string;
  readonly message: string;
};

export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly message?: string;
}> {}

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly message: string;
}> {}

export class Conflict extends Data.TaggedError("Conflict")<{
  readonly message: string;
}> {}

export class Validation extends Data.TaggedError("Validation")<{
  readonly issues: ReadonlyArray<ValidationIssue>;
  readonly message?: string;
}> {}

export class DependencyUnavailable
  extends Data.TaggedError("DependencyUnavailable")<{
    readonly dependency: string;
    readonly message: string;
  }> {}

export class DatabaseFailure extends Data.TaggedError("DatabaseFailure")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {}

export class ProviderFailure extends Data.TaggedError("ProviderFailure")<{
  readonly provider: string;
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class MediaFailure extends Data.TaggedError("MediaFailure")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class Interrupted extends Data.TaggedError("Interrupted")<{
  readonly operation: string;
}> {}

export class InfrastructureFailure
  extends Data.TaggedError("InfrastructureFailure")<{
    readonly operation: string;
    readonly message: string;
    readonly cause?: unknown;
  }> {}

export type ExpectedError =
  | Unauthorized
  | NotFound
  | Conflict
  | Validation
  | DependencyUnavailable
  | DatabaseFailure
  | ProviderFailure
  | MediaFailure
  | Interrupted
  | InfrastructureFailure;
```

- [ ] **Step 5: Run the error tests and typecheck**

Run:

```bash
bun run --cwd apps/server vitest run effect/errors.test.ts
bun run server:check
```

Expected: the focused tests and server TypeScript check PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/server/package.json bun.lock apps/server/effect/errors.ts apps/server/effect/errors.test.ts
git commit -m "feat(server): add Effect error foundation"
```

---

### Task 6: Add request-local context and the generic runtime bridge

**Files:**

- Create: `apps/server/effect/request-context.ts`
- Create: `apps/server/effect/runtime.ts`
- Create: `apps/server/effect/runtime.test.ts`

**Interfaces:**

- Consumes: Effect 3 `Context.Tag`, `ManagedRuntime.make`, `Effect.provideService`, and `ManagedRuntime.runPromise`.
- Produces: `RequestContextValue`, `RequestContext`, `AppRuntime<R, E>`, `makeAppRuntime`, and `runRequest`.

- [ ] **Step 1: Write the runtime tests before the modules exist**

Create `apps/server/effect/runtime.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { Context, Effect, Layer } from "effect";
import {
  RequestContext,
  type RequestContextValue,
} from "./request-context.ts";
import { makeAppRuntime, runRequest } from "./runtime.ts";

const runtimes: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

class Probe extends Context.Tag("@mnimi/server/test/Probe")<
  Probe,
  { readonly value: number }
>() {}

function request(requestId: string): RequestContextValue {
  return {
    headers: new Headers({ "x-request-id": requestId }),
    requestId,
    signal: new AbortController().signal,
  };
}

describe("Effect application runtime", () => {
  it("acquires one Layer and reuses it across programs", async () => {
    let acquisitions = 0;
    const layer = Layer.effect(
      Probe,
      Effect.sync(() => ({ value: ++acquisitions })),
    );
    const runtime = makeAppRuntime(layer);
    runtimes.push(runtime);
    const read = Effect.gen(function* () {
      return (yield* Probe).value;
    });

    await expect(runtime.runPromise(read)).resolves.toBe(1);
    await expect(runtime.runPromise(read)).resolves.toBe(1);
    expect(acquisitions).toBe(1);
  });

  it("isolates request context across concurrent invocations", async () => {
    const runtime = makeAppRuntime(Layer.empty);
    runtimes.push(runtime);
    const read = Effect.gen(function* () {
      const current = yield* RequestContext;
      yield* Effect.promise(() => Promise.resolve());
      return {
        requestId: current.requestId,
        header: current.headers.get("x-request-id"),
      };
    });

    await expect(Promise.all([
      runRequest(runtime, read, request("first")),
      runRequest(runtime, read, request("second")),
    ])).resolves.toEqual([
      { requestId: "first", header: "first" },
      { requestId: "second", header: "second" },
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test to verify missing module failures**

Run:

```bash
bun run --cwd apps/server vitest run effect/runtime.test.ts
```

Expected: FAIL because `request-context.ts` and `runtime.ts` do not exist.

- [ ] **Step 3: Implement request-local context**

Create `apps/server/effect/request-context.ts`:

```ts
import { Context } from "effect";

export type RequestContextValue = {
  readonly headers: Headers;
  readonly userId?: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
};

export class RequestContext extends Context.Tag(
  "@mnimi/server/RequestContext",
)<RequestContext, RequestContextValue>() {}
```

- [ ] **Step 4: Implement the generic managed-runtime bridge**

Create `apps/server/effect/runtime.ts`:

```ts
import { Effect, ManagedRuntime } from "effect";
import type * as Layer from "effect/Layer";
import {
  RequestContext,
  type RequestContextValue,
} from "./request-context.ts";

export type AppRuntime<R, E = never> =
  ManagedRuntime.ManagedRuntime<R, E>;

export function makeAppRuntime<R, E>(
  layer: Layer.Layer<R, E, never>,
): AppRuntime<R, E> {
  return ManagedRuntime.make(layer);
}

export function runRequest<R, A, E>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  program: Effect.Effect<A, E, R | RequestContext>,
  request: RequestContextValue,
): Promise<A> {
  return runtime.runPromise(
    Effect.provideService(program, RequestContext, request),
    { signal: request.signal },
  );
}
```

- [ ] **Step 5: Run runtime tests and typecheck**

Run:

```bash
bun run --cwd apps/server vitest run effect/runtime.test.ts
bun run server:check
```

Expected: focused tests and TypeScript check PASS. If Effect's inferred
environment type is narrower than the explicit signature, tighten the generic
signature without introducing `any`, `unknown` service ports, or a cast.

- [ ] **Step 6: Commit Task 6**

```bash
git add apps/server/effect/request-context.ts apps/server/effect/runtime.ts apps/server/effect/runtime.test.ts
git commit -m "feat(server): add Effect runtime bridge"
```

---

### Task 7: Add scoped test Layer helpers and protect foundation imports

**Files:**

- Create: `apps/server/effect/testing.ts`
- Create: `apps/server/effect/testing.test.ts`
- Create: `apps/server/effect/index.ts`
- Modify: `apps/server/import-boundary.test.ts`

**Interfaces:**

- Consumes: `makeAppRuntime`, Effect 3 `Layer.succeed`, `Layer.scoped`, and `Effect.acquireRelease`.
- Produces: `testService`, `testScopedService`, `makeTestRuntime`, and the foundation barrel exports.

- [ ] **Step 1: Write failing helper tests**

Create `apps/server/effect/testing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Context, Effect } from "effect";
import {
  makeTestRuntime,
  testScopedService,
  testService,
} from "./testing.ts";

class Probe extends Context.Tag("@mnimi/server/test/LayerProbe")<
  Probe,
  { readonly value: number }
>() {}

describe("Effect test Layers", () => {
  it("provides an in-memory service", async () => {
    const runtime = makeTestRuntime(testService(Probe, { value: 42 }));
    try {
      await expect(runtime.runPromise(Effect.gen(function* () {
        return (yield* Probe).value;
      }))).resolves.toBe(42);
    } finally {
      await runtime.dispose();
    }
  });

  it("releases a scoped service when its runtime is disposed", async () => {
    const events: string[] = [];
    const layer = testScopedService(
      Probe,
      Effect.sync(() => {
        events.push("acquire");
        return { value: 7 };
      }),
      () => Effect.sync(() => { events.push("release"); }),
    );
    const runtime = makeTestRuntime(layer);

    await expect(runtime.runPromise(Effect.gen(function* () {
      return (yield* Probe).value;
    }))).resolves.toBe(7);
    expect(events).toEqual(["acquire"]);
    await runtime.dispose();
    expect(events).toEqual(["acquire", "release"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify the missing module failure**

Run:

```bash
bun run --cwd apps/server vitest run effect/testing.test.ts
```

Expected: FAIL because `effect/testing.ts` does not exist.

- [ ] **Step 3: Implement the test helpers**

Create `apps/server/effect/testing.ts`:

```ts
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { makeAppRuntime } from "./runtime.ts";

export function testService<I, S>(
  tag: Context.Tag<I, S>,
  service: S,
): Layer.Layer<I> {
  return Layer.succeed(tag, service);
}

export function testScopedService<I, S, E, R>(
  tag: Context.Tag<I, S>,
  acquire: Effect.Effect<S, E, R>,
  release: (
    service: S,
    exit: Exit.Exit<unknown, unknown>,
  ) => Effect.Effect<void>,
): Layer.Layer<I, E, Exclude<R, Scope.Scope>> {
  return Layer.scoped(
    tag,
    Effect.acquireRelease(acquire, release),
  );
}

export function makeTestRuntime<R, E>(
  layer: Layer.Layer<R, E, never>,
): ManagedRuntime.ManagedRuntime<R, E> {
  return makeAppRuntime(layer);
}
```

- [ ] **Step 4: Add the foundation barrel**

Create `apps/server/effect/index.ts`:

```ts
export * from "./errors.ts";
export * from "./request-context.ts";
export * from "./runtime.ts";
```

- [ ] **Step 5: Extend the import boundary to the Effect foundation**

Add this line to the `source` array in
`apps/server/import-boundary.test.ts`:

```ts
      'await import("./effect/index.ts")',
      'await import("./effect/testing.ts")',
```

- [ ] **Step 6: Run the foundation tests and import contract**

Run:

```bash
bun run --cwd apps/server vitest run effect import-boundary.test.ts
bun run server:check
git diff --check
```

Expected: all Effect foundation tests and the import-boundary test PASS;
TypeScript and whitespace checks report no errors.

- [ ] **Step 7: Commit Task 7**

```bash
git add apps/server/effect/testing.ts apps/server/effect/testing.test.ts apps/server/effect/index.ts apps/server/import-boundary.test.ts
git commit -m "test(server): add Effect Layer helpers"
```

---

### Task 8: Run the child-project integration gate and close its Bead

**Files:**

- Verify only; no planned source changes.
- Update durable state: Pimp task with source ID `mnimi-pi5.1`.

**Interfaces:**

- Consumes: all commits from Tasks 1-7.
- Produces: a verified foundation checkpoint for the configuration/database/auth/logging child project.

- [ ] **Step 1: Inspect the complete child-project diff**

Run:

```bash
git log --oneline def9d7d..HEAD
git diff --stat def9d7d..HEAD
git diff --check def9d7d..HEAD
```

Expected: only the approved planning documents, characterization tests,
runtime smoke, the exact Effect dependency, and `apps/server/effect/*`
foundation files are present. The diff check reports no whitespace errors.

- [ ] **Step 2: Run the complete server gate**

Run:

```bash
bun run server:check
VITEST_MAX_WORKERS=2 bun run server:test
```

Expected: TypeScript passes; every server Vitest file and runtime smoke pass.

- [ ] **Step 3: Run the repository milestone gate**

Run:

```bash
bun run check
VITEST_MAX_WORKERS=2 bun run test
```

Expected: all workspace checks and the repository-declared full suite pass.

- [ ] **Step 4: Verify dependency and public-boundary constraints**

Run:

```bash
rg -n '"effect": "3\.22\.2"' apps/server/package.json
if rg -n '@effect/platform' apps/server/package.json bun.lock; then
  echo "unexpected Effect Platform package found"
  exit 1
fi
if rg -n -g '*.ts' -g '!*.test.ts' 'from "(effect|(\.\./|\./)*effect/)' apps/server/main.ts apps/server/app.ts apps/server/router apps/server/db apps/server/ai apps/server/creations apps/server/tts apps/server/notifications; then
  echo "production Effect imports found before their migration child"
  exit 1
fi
if rg -n 'from ".*(main|app|router|db/index|auth\.instance|ai/provider|images|audio|logging)\.ts"' apps/server/effect; then
  echo "Effect foundation imports a deferred production owner"
  exit 1
fi
git status --short --branch
```

Expected: the dependency is exactly `3.22.2`; no `@effect/platform*` package
is present; production modules do not consume the foundation yet; the worktree
contains no uncommitted implementation changes.

- [ ] **Step 5: Close the completed child project**

Run:

```bash
pimp close mnimi-11c64b6d99ae4f5fbe980b70b1f6f7e3
pimp show mnimi-11c64b6d99ae4f5fbe980b70b1f6f7e3
git status --short --branch
```

Expected: `mnimi-pi5.1` is closed, parent `mnimi-pi5` remains in progress,
and the ephemeral branch remains unpushed.
