import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { createApp } from "./app.ts";
import { drafts } from "./db/schema.ts";
import { Application } from "./effect/application.ts";
import { makeAppRuntime } from "./effect/runtime.ts";
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
  const frames: Array<{ body: string; separator: string }> = [];
  let buffered = "";

  async function readFrame(): Promise<{ body: string; separator: string }> {
    while (frames.length === 0) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended before the next message");
      buffered += decoder.decode(value, { stream: true });
      while (true) {
        const match = buffered.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        frames.push({
          body: buffered.slice(0, match.index),
          separator: match[0],
        });
        buffered = buffered.slice(match.index + match[0].length);
      }
    }

    return frames.shift() as { body: string; separator: string };
  }

  async function readMessage(): Promise<unknown> {
    const { body, separator } = await readFrame();
    expect(separator).toBe("\n\n");
    const lines = body.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("event: message");
    expect(lines[1]?.startsWith("data: ")).toBe(true);
    const data = lines[1]?.slice("data: ".length) ?? "";
    const message = JSON.parse(data);
    expect(lines[1]).toBe(`data: ${JSON.stringify(message)}`);
    return message;
  }

  return Object.assign(readMessage, { readFrame });
}

function expectedCreation(row: typeof drafts.$inferSelect) {
  return {
    id: row.id,
    clientRequestId: row.clientRequestId,
    sourceText: row.sourceText,
    status: row.status,
    activity: null,
    revision: row.revision,
    attemptId: row.activeAttemptId,
    deck: null,
    learningGoal: row.learningGoal,
    routing: row.routing,
    cards: [],
    attemptCards: [],
    undoAvailable: row.undoCards !== null,
    generationSummary: row.generationSummary,
    imagePrompt: row.imagePrompt,
    imageCueAllowed: false,
    imageStatus: row.imageStatus,
    draftImageId: row.draftImageId,
    errorCategory: row.errorCategory,
    errorStage: row.errorStage,
    error: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function expectedSnapshot(row: typeof drafts.$inferSelect) {
  return {
    json: {
      type: "snapshot",
      creationId: row.id,
      attemptId: row.activeAttemptId,
      revision: row.revision,
      creation: expectedCreation(row),
    },
    meta: [
      [1, "creation", "createdAt"],
      [1, "creation", "updatedAt"],
    ],
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
    const runtime = makeAppRuntime(Layer.succeed(Application, {
      database: { db: server.db },
      auth: { instance: server.auth },
      workflows: { events: server.events },
      provider: {},
      media: {},
    } as never));
    try {
    const app = createApp({
      db: server.db,
      auth: server.auth,
      runtime,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let testFailed = false;
    let testError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;

    const recordCleanupError = (error: unknown) => {
      if (!cleanupFailed) {
        cleanupFailed = true;
        cleanupError = error;
      }
    };

    try {
      try {
        const response = await app.request("/rpc/drafts/watch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization,
          },
          body: JSON.stringify({ json: { creationId } }),
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        if (!response.body) throw new Error("SSE response had no body");
        reader = response.body.getReader();
        const readMessage = sseMessageReader(reader);
        await expect(readMessage.readFrame()).resolves.toEqual({
          body: ": ",
          separator: "\n\n",
        });
        const [queued] = await server.db.select().from(drafts)
          .where(eq(drafts.id, creationId)).limit(1);

        await expect(readMessage()).resolves.toEqual(expectedSnapshot(queued));
        expect(server.events.detailSubscriberCount(ada.userId, creationId)).toBe(1);

        const [ready] = await server.db.update(drafts).set({ status: "ready" })
          .where(eq(drafts.id, creationId)).returning();
        await Effect.runPromise(server.events.publish(ready, null));

        await expect(readMessage()).resolves.toEqual(expectedSnapshot(ready));
      } catch (error) {
        testFailed = true;
        testError = error;
      }
    } finally {
      try {
        await reader?.cancel();
      } catch (error) {
        recordCleanupError(error);
      }
    }

    if (testFailed) throw testError;
    if (cleanupFailed) throw cleanupError;

    await vi.waitFor(() =>
      expect(server.events.detailSubscriberCount(ada.userId, creationId)).toBe(0)
    );
    } finally {
      await runtime.dispose();
    }
  });
});
