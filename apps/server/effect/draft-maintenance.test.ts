import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createTestDb } from "../db/testing.ts";
import { creationImageAttempts, drafts, user } from "../db/schema.ts";
import { makeMediaStore } from "./media.ts";
import { MediaFailure } from "./errors.ts";
import { makeDraftMaintenance } from "./draft-maintenance.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let directory: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  testDb = await createTestDb();
  directory = await mkdtemp(join(tmpdir(), "mnimi-maintenance-"));
  await testDb.db.insert(user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  testDb.close();
  await rm(directory, { recursive: true, force: true });
});

describe("DraftMaintenance", () => {
  it("sweeps immediately and hourly, preserving both reference kinds and the 24-hour cutoff", async () => {
    const media = makeMediaStore({ imagesDir: directory, audioDir: join(directory, "audio") });
    const ids = await Promise.all(Array.from({ length: 4 }, () =>
      Effect.runPromise(media.writeDraftImage("ada", new Uint8Array([1])))));
    const [draftImageId, attemptImageId, stale, fresh] = ids as [string, string, string, string];
    const now = Date.now();
    const file = (id: string) => join(directory, "drafts", "ada", `${id}.png`);
    for (const id of [draftImageId, attemptImageId, stale]) {
      await utimes(file(id), new Date(now - 90_000_000), new Date(now - 90_000_000));
    }
    await utimes(file(fresh), new Date(now - 84_000_000), new Date(now - 84_000_000));
    await testDb.db.insert(drafts).values({ id: "creation", userId: "ada", sourceText: "hello", draftImageId });
    await testDb.db.insert(creationImageAttempts).values({
      id: "attempt", userId: "ada", creationId: "creation", prompt: "hello", status: "ready", draftImageId: attemptImageId,
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(now);
    const maintenance = makeDraftMaintenance({ database: testDb, media });
    cleanups.push(() => Effect.runPromise(maintenance.stop()));

    await Effect.runPromise(maintenance.start());
    await Effect.runPromise(maintenance.start());
    expect(vi.getTimerCount()).toBe(1);
    await expect(stat(file(stale))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(file(fresh))).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(3_599_999);
    await expect(stat(file(fresh))).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect.poll(async () => stat(file(fresh)).then(() => true, () => false)).toBe(false);
    await expect(stat(file(draftImageId))).resolves.toBeDefined();
    await expect(stat(file(attemptImageId))).resolves.toBeDefined();

    await Effect.runPromise(maintenance.stop());
    expect(vi.getTimerCount()).toBe(0);
    const afterStop = await Effect.runPromise(media.writeDraftImage("ada", new Uint8Array([1])));
    await utimes(file(afterStop), new Date(now - 90_000_000), new Date(now - 90_000_000));
    await Effect.runPromise(maintenance.start());
    await vi.advanceTimersByTimeAsync(7_200_000);
    await expect(stat(file(afterStop))).resolves.toBeDefined();
  });

  it("logs a failed sweep and performs the next scheduled sweep", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const failure = new MediaFailure({ operation: "media.sweepDrafts", message: "disk unavailable" });
    const reportError = vi.fn();
    const sweepDrafts = vi.fn().mockReturnValueOnce(Effect.fail(failure)).mockReturnValue(Effect.succeed(0));
    const maintenance = makeDraftMaintenance({ database: testDb, media: { sweepDrafts }, reportError });
    cleanups.push(() => Effect.runPromise(maintenance.stop()));
    await expect(Effect.runPromise(maintenance.start())).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await expect.poll(() => sweepDrafts.mock.calls.length).toBe(2);
  });

  it.each([false, true])("waits for an in-flight filesystem sweep before stop resolves (failure: %s)", async (failStat) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const order: string[] = [];
    const failure = new Error("delayed filesystem failure");
    const media = makeMediaStore({
      imagesDir: directory,
      audioDir: join(directory, "audio"),
      fs: {
        stat: async (path) => {
          entered.resolve();
          await release.promise;
          if (failStat) {
            completed.resolve();
            throw failure;
          }
          return stat(path);
        },
        rm: async (path) => {
          order.push("remove");
          await rm(path);
          completed.resolve();
        },
      },
    });
    const imageId = await Effect.runPromise(media.writeDraftImage("ada", new Uint8Array([1])));
    const file = join(directory, "drafts", "ada", `${imageId}.png`);
    const ancient = new Date(Date.now() - 90_000_000);
    await utimes(file, ancient, ancient);
    const reportError = vi.fn(() => { order.push("reported"); });
    const maintenance = makeDraftMaintenance({
      database: testDb,
      media,
      reportError,
    });
    cleanups.push(async () => { release.resolve(); await Effect.runPromise(maintenance.stop()); });
    const starting = Effect.runPromiseExit(maintenance.start());
    await entered.promise;
    const stopping = Effect.runPromise(maintenance.stop()).then(() => { order.push("stopped"); });
    const stoppingAgain = Effect.runPromise(maintenance.stop());
    await setImmediate();
    release.resolve();
    await completed.promise;
    await Promise.all([starting, stopping, stoppingAgain]);
    expect(order).toEqual(failStat ? ["reported", "stopped"] : ["remove", "stopped"]);
    if (failStat) {
      expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ cause: failure }));
      await expect(stat(file)).resolves.toBeDefined();
    } else {
      expect(reportError).not.toHaveBeenCalled();
      await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(vi.getTimerCount()).toBe(0);
    await Effect.runPromise(maintenance.start());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops during reference collection without starting the media sweep", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const execute = testDb.client.execute.bind(testDb.client);
    let finishedQueries = 0;
    const query = vi.spyOn(testDb.client, "execute").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      const result = await execute(...args);
      if (++finishedQueries === 2) completed.resolve();
      return result;
    });
    const sweepDrafts = vi.fn(() => Effect.succeed(0));
    const maintenance = makeDraftMaintenance({ database: testDb, media: { sweepDrafts } });
    cleanups.push(async () => { release.resolve(); await Effect.runPromise(maintenance.stop()); query.mockRestore(); });
    const starting = Effect.runPromiseExit(maintenance.start());
    await entered.promise;
    await Effect.runPromise(maintenance.stop());
    await starting;
    release.resolve();
    await completed.promise;
    expect(sweepDrafts).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a reference query failure and retries collection on the next hour", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const failure = new Error("database unavailable");
    let failing = true;
    const db = new Proxy(testDb.db, {
      get(target, key, receiver) {
        if (key === "select" && failing) throw failure;
        return Reflect.get(target, key, receiver);
      },
    });
    const reportError = vi.fn();
    const sweepDrafts = vi.fn(() => Effect.succeed(0));
    const maintenance = makeDraftMaintenance({ database: { db }, media: { sweepDrafts }, reportError });
    cleanups.push(() => Effect.runPromise(maintenance.stop()));
    await Effect.runPromise(maintenance.start());
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ _tag: "DatabaseFailure", cause: failure }));
    expect(sweepDrafts).not.toHaveBeenCalled();
    failing = false;
    await vi.advanceTimersByTimeAsync(3_600_000);
    await expect.poll(() => sweepDrafts.mock.calls.length).toBe(1);
  });
});
