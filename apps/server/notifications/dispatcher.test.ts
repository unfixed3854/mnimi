import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/testing.ts";
import { drafts, pushInstallations, user } from "../db/schema.ts";
import { createNotificationDispatcher } from "./dispatcher.ts";
import type { ExpoPushMessage } from "./expo-push.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(user).values({
    id: "ada",
    name: "Ada",
    email: "ada@example.com",
  });
  await testDb.db.insert(pushInstallations).values({
    userId: "ada",
    token: "ExponentPushToken[device-one]",
    platform: "android",
  });
});
afterEach(() => testDb.close());

describe("creation notification dispatcher", () => {
  it("requires a delivery dependency", () => {
    expect(() => createNotificationDispatcher({ db: testDb.db })).toThrow(/delivery dependency/);
  });
  it("groups close ready transitions and deep-links grouped attention", async () => {
    await testDb.db.insert(drafts).values([
      { id: "one", userId: "ada", sourceText: "one", status: "ready" },
      { id: "two", userId: "ada", sourceText: "two", status: "ready" },
    ]);
    const send = vi.fn(async (_messages: ExpoPushMessage[]) => ({
      invalidTokens: [] as string[],
    }));
    const dispatcher = createNotificationDispatcher({ db: testDb.db, send });

    dispatcher.queue("ada", "one");
    dispatcher.queue("ada", "two");
    await dispatcher.flush("ada");

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        token: "ExponentPushToken[device-one]",
        body: "2 creations are ready to review",
        data: { route: "/add" },
      }),
    ]);
  });

  it("uses a creation deep link for one choice and removes invalid tokens", async () => {
    await testDb.db.insert(drafts).values({
      id: "choice",
      userId: "ada",
      sourceText: "choice",
      status: "needs_choice",
      operation: null,
    });
    const send = vi.fn(async (_messages: ExpoPushMessage[]) => ({
      invalidTokens: ["ExponentPushToken[device-one]"],
    }));
    const dispatcher = createNotificationDispatcher({ db: testDb.db, send });

    dispatcher.queue("ada", "choice");
    await dispatcher.flush("ada");

    expect(send.mock.calls[0][0][0]).toMatchObject({
      body: "Your creation needs a deck choice",
      data: { creationId: "choice" },
    });
    expect(await testDb.db.select().from(pushInstallations)).toHaveLength(0);
  });

  it("uses the singular ready body and skips non-actionable rows", async () => {
    await testDb.db.insert(drafts).values([
      { id: "ready", userId: "ada", sourceText: "one", status: "ready" },
      { id: "queued", userId: "ada", sourceText: "two", status: "queued" },
    ]);
    const send = vi.fn(async (_messages: ExpoPushMessage[]) => ({
      invalidTokens: [] as string[],
    }));
    const dispatcher = createNotificationDispatcher({ db: testDb.db, send });

    dispatcher.queue("ada", "ready");
    dispatcher.queue("ada", "queued");
    await dispatcher.flush("ada");

    expect(send).toHaveBeenCalledWith([expect.objectContaining({
      body: "Your creation is ready to review",
      data: { creationId: "ready" },
    })]);
    dispatcher.stop();
  });

  it("resolves and logs the original delivery failure only once", async () => {
    await testDb.db.insert(drafts).values({
      id: "failed",
      userId: "ada",
      sourceText: "one",
      status: "ready",
    });
    const primary = new Error("offline");
    const send = vi.fn(async (_messages: ExpoPushMessage[]) => {
      throw primary;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatcher = createNotificationDispatcher({ db: testDb.db, send });

    try {
      dispatcher.queue("ada", "failed");
      await expect(dispatcher.flush("ada")).resolves.toBeUndefined();
      await expect(dispatcher.flush("ada")).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        "creation notification delivery failed",
        primary,
      );
    } finally {
      dispatcher.stop();
      consoleError.mockRestore();
    }
  });

  it("preserves a database read rejection without logging it as delivery failure", async () => {
    const primary = new Error("database unavailable");
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            throw primary;
          },
        }),
      }),
    } as unknown as typeof testDb.db;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatcher = createNotificationDispatcher({ db, send: async () => ({ invalidTokens: [] }) });

    try {
      dispatcher.queue("ada", "failed-read");
      await expect(dispatcher.flush("ada")).rejects.toBe(primary);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      dispatcher.stop();
      consoleError.mockRestore();
    }
  });

  it("replaces the debounce timer and sends one grouped notification", async () => {
    await testDb.db.insert(drafts).values([
      { id: "debounce-one", userId: "ada", sourceText: "one", status: "ready" },
      { id: "debounce-two", userId: "ada", sourceText: "two", status: "ready" },
    ]);
    vi.useFakeTimers();
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
    await testDb.db.insert(drafts).values({
      id: "stopped",
      userId: "ada",
      sourceText: "stopped",
      status: "ready",
    });
    vi.useFakeTimers();
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
});
