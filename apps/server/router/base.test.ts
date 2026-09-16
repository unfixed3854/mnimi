import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORPCError } from "@orpc/server";
import { call } from "@orpc/server";
import { Effect, Layer } from "effect";
import * as z from "zod";
import { Application } from "../effect/application.ts";
import { makeCreationEvents } from "../effect/creation-events.ts";
import { makeAppRuntime } from "../effect/runtime.ts";
import { createTestServer } from "./testing.ts";
import {
  authed,
  runDetachedWorkflow,
  runRouter,
  runWorkflowStream,
} from "./base.ts";

const whoami = authed
  .input(z.object({}))
  .handler(({ context }) => context.userId);

const runtimeWhoami = authed
  .input(z.object({}))
  .handler(({ context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    return `runtime:${context.userId}:${database.db === server.db}`;
  })));

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => {
  server.close();
});

describe("authed", () => {
  it("releases a creation subscriber when return races after registration", async () => {
    const events = makeCreationEvents({
      readDetail: async () => null,
      readInbox: async () => [],
    });
    let bridge!: ReturnType<typeof runWorkflowStream>;
    let returning!: Promise<IteratorResult<unknown, void>>;
    const stream = events.subscribeDetail("ada", "creation-1").pipe(Effect.tap(() =>
      Effect.sync(() => queueMicrotask(() => {
        returning = bridge.return();
      })),
    ));

    bridge = runWorkflowStream({ db: server.db, auth: server.auth }, stream, async (event) => event);

    await bridge.next().catch(() => undefined);
    await returning;
    await vi.waitFor(() =>
      expect(events.detailSubscriberCount("ada", "creation-1")).toBe(0)
    );
  });

  it("releases a creation subscriber when event mapping fails", async () => {
    const events = makeCreationEvents({
      readDetail: async () => null,
      readInbox: async () => [],
    });
    const bridge = runWorkflowStream(
      { db: server.db, auth: server.auth },
      events.subscribeDetail("ada", "creation-1"),
      async () => {
        throw new Error("mapping failed");
      },
    );

    await expect(bridge.next()).rejects.toBeDefined();
    await vi.waitFor(() =>
      expect(events.detailSubscriberCount("ada", "creation-1")).toBe(0)
    );
  });

  it("rejects a call with no request headers at all", async () => {
    const { db, auth } = server;
    await expect(call(whoami, {}, { context: { db, auth } })).rejects
      .toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a call with no Authorization header", async () => {
    const { db, auth } = server;
    await expect(
      call(whoami, {}, { context: { db, auth, reqHeaders: new Headers() } }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a garbage token", async () => {
    const { db, auth } = server;
    await expect(
      call(whoami, {}, {
        context: {
          db,
          auth,
          reqHeaders: new Headers({ authorization: "Bearer garbage" }),
        },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("maps UNAUTHORIZED to HTTP 401", async () => {
    const { db, auth } = server;
    const error = await call(whoami, {}, { context: { db, auth } }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.status).toBe(401);
  });

  it("injects the verified userId into context", async () => {
    const ada = await server.signIn("ada@example.com");
    await expect(call(whoami, {}, { context: ada.context })).resolves.toBe(
      ada.userId,
    );
  });

  it("authenticates and runs the downstream procedure through the supplied Effect runtime", async () => {
    const runtime = makeAppRuntime(Layer.succeed(Application, {
      database: { db: server.db },
      auth: {
        instance: {
          api: {
            getSession: async () => ({ user: { id: "effect-user" } }),
          },
        },
      },
      workflows: {},
      provider: {},
    } as never));

    try {
      await expect(call(whoami, {}, {
        context: {
          db: server.db,
          auth: server.auth,
          runtime,
          request: {
            headers: new Headers(),
            requestId: "effect-request",
            signal: new AbortController().signal,
          },
        },
      })).resolves.toBe("effect-user");
    } finally {
      await runtime.dispose();
    }
  });

  it("resolves router dependencies from the application-owned runtime", async () => {
    const runtime = makeAppRuntime(Layer.succeed(Application, {
      database: { db: server.db },
      auth: {
        instance: {
          api: {
            getSession: async () => ({ user: { id: "effect-user" } }),
          },
        },
      },
      workflows: {},
      provider: {},
    } as never));

    try {
      await expect(call(runtimeWhoami, {}, {
        context: {
          db: server.db,
          auth: server.auth,
          runtime,
          request: {
            headers: new Headers(),
            requestId: "effect-promise-request",
            signal: new AbortController().signal,
          },
        },
      })).resolves.toBe("runtime:effect-user:true");
    } finally {
      await runtime.dispose();
    }
  });

  it("runs detached admissions after the client has disconnected", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = makeAppRuntime(Layer.succeed(Application, {} as never));
    let admitted = false;

    try {
      await runDetachedWorkflow({
        db: server.db,
        auth: server.auth,
        runtime,
        request: {
          headers: new Headers(),
          requestId: "aborted-request",
          signal: controller.signal,
        },
      }, Effect.sync(() => { admitted = true; }));

      expect(admitted).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it("resolves each user to their own id, not merely to some user", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");

    await expect(call(whoami, {}, { context: ada.context })).resolves.toBe(
      ada.userId,
    );
    await expect(call(whoami, {}, { context: bob.context })).resolves.toBe(
      bob.userId,
    );
  });
});
