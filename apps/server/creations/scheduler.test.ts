import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { drafts, user } from "../db/schema.ts";
import {
  claimCreationWork,
  MAX_ACTIVE_TEXT_WORK_PER_USER,
  purgeExpiredRemovedCreations,
  recoverStaleCreationWork,
  renewCreationLease,
  startCreationScheduler,
} from "./scheduler.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(user).values([
    { id: "ada", name: "Ada", email: "ada@example.com" },
    { id: "bob", name: "Bob", email: "bob@example.com" },
  ]);
});

afterEach(() => testDb.close());

async function seedQueued(owner: string, id: string, queuedAt: Date) {
  await testDb.db.insert(drafts).values({
    id,
    userId: owner,
    clientRequestId: `request-${id}`,
    sourceText: id,
    status: "queued",
    operation: "route_generate",
    queuedAt,
  });
}

describe("creation scheduler claims", () => {
  it("atomically grants two oldest slots per user under concurrent claims", async () => {
    for (const owner of ["ada", "bob"]) {
      await seedQueued(owner, `${owner}-3`, new Date(300));
      await seedQueued(owner, `${owner}-1`, new Date(100));
      await seedQueued(owner, `${owner}-2`, new Date(100));
    }

    const [adaA, adaB, bobA, bobB] = await Promise.all([
      claimCreationWork(testDb.db, "ada", { leaseOwner: "worker-a", now: new Date(1_000) }),
      claimCreationWork(testDb.db, "ada", { leaseOwner: "worker-b", now: new Date(1_000) }),
      claimCreationWork(testDb.db, "bob", { leaseOwner: "worker-c", now: new Date(1_000) }),
      claimCreationWork(testDb.db, "bob", { leaseOwner: "worker-d", now: new Date(1_000) }),
    ]);

    const adaClaims = [...adaA, ...adaB];
    const bobClaims = [...bobA, ...bobB];
    expect(adaClaims).toHaveLength(MAX_ACTIVE_TEXT_WORK_PER_USER);
    expect(bobClaims).toHaveLength(MAX_ACTIVE_TEXT_WORK_PER_USER);
    expect(adaClaims.map((claim) => claim.creationId).sort()).toEqual([
      "ada-1",
      "ada-2",
    ]);
    expect(bobClaims.map((claim) => claim.creationId).sort()).toEqual([
      "bob-1",
      "bob-2",
    ]);

    const queued = await testDb.db.select().from(drafts)
      .where(eq(drafts.status, "queued"));
    expect(queued.map((row) => row.id).sort()).toEqual(["ada-3", "bob-3"]);
  });

  it("renews only the matching attempt and lease owner", async () => {
    await seedQueued("ada", "creation-1", new Date(100));
    const [claim] = await claimCreationWork(testDb.db, "ada", {
      leaseOwner: "worker-a",
      now: new Date(1_000),
    });

    await expect(renewCreationLease(testDb.db, {
      ...claim,
      leaseOwner: "stale-worker",
    }, new Date(2_000))).resolves.toBe(false);
    await expect(renewCreationLease(testDb.db, claim, new Date(2_000)))
      .resolves.toBe(true);
  });

  it("requeues only expired leased work and fences its old attempt", async () => {
    await seedQueued("ada", "expired", new Date(100));
    await seedQueued("ada", "current", new Date(200));
    const claims = await claimCreationWork(testDb.db, "ada", {
      leaseOwner: "worker-a",
      now: new Date(1_000),
      leaseMs: 100,
    });
    expect(claims).toHaveLength(2);

    const current = claims.find((claim) => claim.creationId === "current")!;
    expect(await renewCreationLease(testDb.db, current, new Date(1_050), 1_000))
      .toBe(true);

    expect(await recoverStaleCreationWork(testDb.db, new Date(1_200))).toBe(1);

    const rows = await testDb.db.select().from(drafts);
    expect(rows.find((row) => row.id === "expired")).toMatchObject({
      status: "queued",
      activeAttemptId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      operation: "route_generate",
    });
    expect(rows.find((row) => row.id === "current")).toMatchObject({
      status: "routing",
      activeAttemptId: current.attemptId,
      leaseOwner: current.leaseOwner,
    });
  });

  it("fences every process-owned lease during boot recovery", async () => {
    await seedQueued("ada", "creation-1", new Date(100));
    const [claim] = await claimCreationWork(testDb.db, "ada", {
      leaseOwner: "previous-process",
      now: new Date(1_000),
      leaseMs: 90_000,
    });

    expect(await recoverStaleCreationWork(
      testDb.db,
      new Date(2_000),
      { allLeases: true },
    )).toBe(1);

    expect((await testDb.db.select().from(drafts))[0]).toMatchObject({
      status: "queued",
      operation: claim.operation,
      activeAttemptId: null,
      leaseOwner: null,
    });
  });

  it("recovers active legacy work that has no lease during boot", async () => {
    await seedQueued("ada", "legacy", new Date(100));
    await testDb.db.update(drafts).set({
      status: "generating",
      operation: "generate",
      activeAttemptId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(eq(drafts.id, "legacy"));

    expect(await recoverStaleCreationWork(
      testDb.db,
      new Date(2_000),
      { allLeases: true, includeUnleased: true },
    )).toBe(1);

    expect((await testDb.db.select().from(drafts))[0]).toMatchObject({
      status: "queued",
      operation: "generate",
      activeAttemptId: null,
      leaseOwner: null,
      errorCategory: "interrupted",
    });
  });

  it("purges only removed rows after their undo window", async () => {
    await seedQueued("ada", "active", new Date(100));
    await seedQueued("ada", "expired", new Date(200));
    await seedQueued("ada", "undoable", new Date(300));
    await testDb.db.update(drafts).set({
      status: "removed",
      undoUntil: new Date(1_000),
    }).where(eq(drafts.id, "expired"));
    await testDb.db.update(drafts).set({
      status: "removed",
      undoUntil: new Date(3_000),
    }).where(eq(drafts.id, "undoable"));

    expect(await purgeExpiredRemovedCreations(testDb.db, new Date(2_000)))
      .toBe(1);
    expect((await testDb.db.select().from(drafts)).map((row) => row.id).sort())
      .toEqual(["active", "undoable"]);
  });

  it("polls immediately and ignores kicks after stop", async () => {
    await seedQueued("ada", "initial", new Date(100));
    const runWork = vi.fn(async (_work: { creationId: string }) => {});
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
    let scheduler: ReturnType<typeof startCreationScheduler>;
    let nowCalls = 0;
    let nowDepth = 0;
    let reentrantNow = false;
    const schedulerNow = vi.fn(() => {
      if (nowDepth > 0) reentrantNow = true;
      nowDepth += 1;
      try {
        nowCalls += 1;
        if (nowCalls === 3) scheduler.kick("ada");
        return new Date(1_000);
      } finally {
        nowDepth -= 1;
      }
    });
    scheduler = startCreationScheduler({
      db: testDb.db,
      runWork,
      intervalMs: 60_000,
      leaseOwner: "coalescing-test",
      now: schedulerNow,
    });

    try {
      await vi.waitFor(() =>
        expect(runWork).toHaveBeenCalledTimes(MAX_ACTIVE_TEXT_WORK_PER_USER)
      );
      expect(schedulerNow).toHaveBeenCalledTimes(4);
      expect(reentrantNow).toBe(false);
      const firstBatch = [...releases.entries()];
      expect(firstBatch).toHaveLength(MAX_ACTIVE_TEXT_WORK_PER_USER);
      for (const [creationId, release] of firstBatch) {
        await testDb.db.update(drafts).set({
          status: "ready",
          activeAttemptId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        }).where(eq(drafts.id, creationId));
        release();
      }

      await vi.waitFor(() => expect(runWork).toHaveBeenCalledTimes(3));
      expect(new Set(
        runWork.mock.calls.map(([work]) => work.creationId),
      )).toEqual(new Set(["coalesced-1", "coalesced-2", "coalesced-3"]));
    } finally {
      scheduler.stop();
      for (const release of releases.values()) release();
    }
  });

  it("logs a failed poll and retries on the next interval", async () => {
    await seedQueued("ada", "after-failed-poll", new Date(100));
    vi.useFakeTimers();
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
});
