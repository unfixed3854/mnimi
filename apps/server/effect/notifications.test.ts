import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { createTestDb } from "../db/testing.ts";
import { drafts, pushInstallations, user } from "../db/schema.ts";
import type { ExpoPushMessage } from "./expo-push.ts";
import {
  makeNotificationDispatcherPromiseFacade,
  makeNotifications,
} from "./notifications.ts";
import { ProviderFailure } from "./errors.ts";

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

describe("Notifications", () => {
  it("constructs without timers or database work", () => {
    const setTimer = vi.fn();
    makeNotifications({
      db: testDb.db,
      send: () => Effect.succeed({ invalidTokens: [] }),
      setTimer,
    });
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("unrefs the injected debounce timer", () => {
    const unref = vi.fn();
    const service = makeNotifications({
      db: testDb.db,
      send: () => Effect.succeed({ invalidTokens: [] }),
      setTimer: () => ({ unref }),
      clearTimer: vi.fn(),
    });

    Effect.runSync(service.queue("ada", "creation-1"));

    expect(unref).toHaveBeenCalledOnce();
    Effect.runSync(service.stop());
  });

  it("keeps queue and stop synchronous and drops pending work", async () => {
    vi.useFakeTimers();
    const send = vi.fn((_messages: readonly ExpoPushMessage[]) =>
      Effect.succeed({ invalidTokens: [] as string[] })
    );
    const facade = makeNotificationDispatcherPromiseFacade(makeNotifications({
      db: testDb.db,
      send,
      delayMs: 2_000,
    }));

    try {
      facade.queue("ada", "creation-1");
      facade.stop();
      await vi.runAllTimersAsync();
      expect(send).not.toHaveBeenCalled();
    } finally {
      facade.stop();
      vi.useRealTimers();
    }
  });

  it("deduplicates, filters actionable rows, groups messages, and deletes invalid tokens", async () => {
    await testDb.db.insert(drafts).values([
      { id: "ready", userId: "ada", sourceText: "one", status: "ready" },
      {
        id: "choice",
        userId: "ada",
        sourceText: "two",
        status: "needs_choice",
        operation: null,
      },
      { id: "queued", userId: "ada", sourceText: "three", status: "queued" },
    ]);
    const send = vi.fn((_messages: readonly ExpoPushMessage[]) => Effect.succeed({
      invalidTokens: ["ExponentPushToken[device-one]"],
    }));
    const facade = makeNotificationDispatcherPromiseFacade(makeNotifications({
      db: testDb.db,
      send,
    }));

    facade.queue("ada", "ready");
    facade.queue("ada", "ready");
    facade.queue("ada", "choice");
    facade.queue("ada", "queued");
    await facade.flush("ada");

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toEqual([{
      token: "ExponentPushToken[device-one]",
      title: "Mnimi",
      body: "2 creations need your attention",
      data: { route: "/add" },
    }]);
    expect(await testDb.db.select().from(pushInstallations)).toHaveLength(0);
    facade.stop();
  });

  it("isolates users and clears pending state before a failed delivery", async () => {
    await testDb.db.insert(drafts).values({
      id: "ready",
      userId: "ada",
      sourceText: "one",
      status: "ready",
    });
    const primary = new Error("delivery failed");
    const reportError = vi.fn();
    const send = vi.fn(() => Effect.fail(new ProviderFailure({
      provider: "expo-push",
      operation: "expo-push.send",
      message: primary.message,
      cause: primary,
    })));
    const facade = makeNotificationDispatcherPromiseFacade(makeNotifications({
      db: testDb.db,
      send,
      reportError,
    }), reportError);

    facade.queue("ada", "ready");
    facade.queue("grace", "other");
    await expect(facade.flush("ada")).resolves.toBeUndefined();
    await expect(facade.flush("ada")).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(primary);
    facade.stop();
  });

  it("keeps provider failures typed for direct Effect consumers", async () => {
    await testDb.db.insert(drafts).values({
      id: "typed-failure",
      userId: "ada",
      sourceText: "one",
      status: "ready",
    });
    const primary = new Error("provider unavailable");
    const providerFailure = new ProviderFailure({
      provider: "expo-push",
      operation: "expo-push.send",
      message: primary.message,
      cause: primary,
    });
    const service = makeNotifications({
      db: testDb.db,
      send: () => Effect.fail(providerFailure),
    });

    Effect.runSync(service.queue("ada", "typed-failure"));
    const failure = await Effect.runPromise(Effect.flip(service.flush("ada")));

    expect(failure).toBe(providerFailure);
    expect(failure.cause).toBe(primary);
    Effect.runSync(service.stop());
  });

  it("settles an admitted debounce delivery before workflow resources release", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await testDb.db.insert(drafts).values({
      id: "in-flight",
      userId: "ada",
      sourceText: "one",
      status: "ready",
    });
    const service = makeNotifications({
      db: testDb.db,
      delayMs: 2_000,
      send: () => Effect.promise(async () => {
        started.resolve();
        await release.promise;
        return { invalidTokens: [] };
      }),
    });

    try {
      Effect.runSync(service.queue("ada", "in-flight"));
      await vi.advanceTimersByTimeAsync(2_000);
      await started.promise;

      Effect.runSync(service.stop());
      let settled = false;
      const settling = Effect.runPromise(service.settle()).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      release.resolve();
      await settling;
      expect(settled).toBe(true);
    } finally {
      release.resolve();
      Effect.runSync(service.stop());
      vi.useRealTimers();
    }
  });
});
