import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { decks, drafts, user } from "../db/schema.ts";
import { claimCreationWork } from "../creations/scheduler.ts";
import {
  makeDurableTextWorkflow,
  type DurableTextDatabase,
} from "./durable-text.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;

function databaseFor(db: typeof testDb.db): DurableTextDatabase {
  return {
    db,
    withWriteLock: (_operation, work) => work,
    transaction: (_operation, work) => work(db),
  };
}

beforeEach(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(user).values({
    id: "ada",
    name: "Ada",
    email: "ada@example.com",
  });
  await testDb.db.insert(decks).values({
    id: "german",
    userId: "ada",
    name: "German",
    description: "Vocabulary",
  });
});

afterEach(() => testDb.close());

describe("DurableTextWorkflow", () => {
  it("does not dispatch a claim whose database result arrives after shutdown", async () => {
    await testDb.db.insert(drafts).values({ id: "delayed-result", userId: "ada", sourceText: "hello", status: "queued", operation: "generate" });
    const claimed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
    const runAttempt = vi.fn(() => Effect.void);
    const database = databaseFor(testDb.db);
    const workflow = makeDurableTextWorkflow({ database: { ...database,
      transaction: (_operation, work) => work(testDb.db).pipe(
        Effect.tap(() => Effect.promise(() => { claimed.resolve(); return release.promise; })),
        Effect.ensuring(Effect.sync(() => finished.resolve())),
      ),
    }, runAttempt });
    await Effect.runPromise(workflow.kick("ada")); await claimed.promise;
    await Effect.runPromise(workflow.stop()); release.resolve(); await finished.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runAttempt).not.toHaveBeenCalled();
    const [row] = await testDb.db.select().from(drafts).where(eq(drafts.id, "delayed-result"));
    // The already issued durable write is left fenced for the next recovery.
    expect(row.status).toBe("generating"); expect(row.activeAttemptId).not.toBeNull();
  });
  it("does not claim queued work after shutdown while waiting for the database", async () => {
    await testDb.db.insert(drafts).values({ id: "late", userId: "ada", sourceText: "hello", status: "queued", operation: "generate" });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const runAttempt = vi.fn(() => Effect.void);
    const database = databaseFor(testDb.db);
    const workflow = makeDurableTextWorkflow({ database: { ...database,
      transaction: (_operation, work) => Effect.promise(() => { entered.resolve(); return release.promise; }).pipe(
        Effect.zipRight(Effect.suspend(() => work(testDb.db))),
        Effect.ensuring(Effect.sync(() => finished.resolve())),
      ),
    }, runAttempt });
    await Effect.runPromise(workflow.kick("ada"));
    await entered.promise;
    await Effect.runPromise(workflow.stop());
    release.resolve();
    await finished.promise;
    const [row] = await testDb.db.select().from(drafts).where(eq(drafts.id, "late"));
    expect(row).toMatchObject({ status: "queued", activeAttemptId: null, leaseOwner: null });
    expect(runAttempt).not.toHaveBeenCalled();
  });
  it("requeues lease-less active work during boot recovery", async () => {
    await testDb.db.insert(drafts).values({
      id: "creation-1",
      userId: "ada",
      clientRequestId: "request-1",
      sourceText: "hello",
      status: "generating",
      operation: "generate",
      activeAttemptId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      queuedAt: new Date(100),
    });
    const workflow = makeDurableTextWorkflow({ database: databaseFor(testDb.db) });

    await expect(Effect.runPromise(workflow.recover(new Date(2_000), {
      allLeases: true,
      includeUnleased: true,
    }))).resolves.toBe(1);

    const [creation] = await testDb.db.select().from(drafts)
      .where(eq(drafts.id, "creation-1"));
    expect(creation).toMatchObject({
      status: "queued",
      operation: "generate",
      activeAttemptId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCategory: "interrupted",
      errorStage: "cards",
      error: "Creation was interrupted. Try again.",
      queuedAt: new Date(2_000),
      updatedAt: new Date(2_000),
    });
  });

  it("leaves an unexpired lease active during regular recovery", async () => {
    await testDb.db.insert(drafts).values([
      {
        id: "expired",
        userId: "ada",
        clientRequestId: "request-expired",
        sourceText: "expired",
        status: "generating",
        operation: "generate",
        activeAttemptId: "attempt-expired",
        leaseOwner: "previous-process",
        leaseExpiresAt: new Date(1_000),
        queuedAt: new Date(100),
      },
      {
        id: "current",
        userId: "ada",
        clientRequestId: "request-current",
        sourceText: "current",
        status: "generating",
        operation: "generate",
        activeAttemptId: "attempt-current",
        leaseOwner: "current-process",
        leaseExpiresAt: new Date(3_000),
        queuedAt: new Date(200),
      },
    ]);
    const workflow = makeDurableTextWorkflow({ database: databaseFor(testDb.db) });

    await expect(Effect.runPromise(workflow.recover(new Date(2_000), {})))
      .resolves.toBe(1);

    const rows = await testDb.db.select().from(drafts)
      .where(eq(drafts.userId, "ada"));
    expect(rows.find((row) => row.id === "expired")).toMatchObject({
      status: "queued",
      activeAttemptId: null,
      leaseOwner: null,
    });
    expect(rows.find((row) => row.id === "current")).toMatchObject({
      status: "generating",
      activeAttemptId: "attempt-current",
      leaseOwner: "current-process",
      leaseExpiresAt: new Date(3_000),
    });
  });

  it("claims queued work through an Effect fiber when kicked", async () => {
    await testDb.db.insert(drafts).values({
      id: "queued",
      userId: "ada",
      clientRequestId: "request-queued",
      sourceText: "queued",
      status: "queued",
      operation: "generate",
      queuedAt: new Date(100),
    });
    const releaseAttempt = Promise.withResolvers<void>();
    const workflow = makeDurableTextWorkflow({
      database: databaseFor(testDb.db),
      runAttempt: () => Effect.promise(() => releaseAttempt.promise),
    });

    await Effect.runPromise(workflow.kick("ada"));

    await expect.poll(async () => {
      const [creation] = await testDb.db.select().from(drafts)
        .where(eq(drafts.id, "queued"));
      return {
        status: creation.status,
        activeAttemptId: creation.activeAttemptId,
        leaseOwner: creation.leaseOwner,
      };
    }).toMatchObject({
      status: "generating",
      activeAttemptId: expect.any(String),
      leaseOwner: expect.any(String),
    });

    await Effect.runPromise(workflow.stop());
    releaseAttempt.resolve();
  });

  it("renews a running attempt lease from its Effect fiber", async () => {
    await testDb.db.insert(drafts).values({
      id: "heartbeat",
      userId: "ada",
      clientRequestId: "request-heartbeat",
      sourceText: "heartbeat",
      status: "queued",
      operation: "generate",
      queuedAt: new Date(100),
    });
    const releaseAttempt = Promise.withResolvers<void>();
    let clockReads = 0;
    const workflow = makeDurableTextWorkflow({
      database: databaseFor(testDb.db),
      heartbeatMs: 1,
      now: () => new Date(clockReads++ === 0 ? 1_000 : 2_000),
      runAttempt: () => Effect.promise(() => releaseAttempt.promise),
    });

    await Effect.runPromise(workflow.kick("ada"));

    await expect.poll(async () => {
      const [creation] = await testDb.db.select().from(drafts)
        .where(eq(drafts.id, "heartbeat"));
      return creation.leaseExpiresAt;
    }).toEqual(new Date(92_000));

    await Effect.runPromise(workflow.stop());
    releaseAttempt.resolve();
  });

  it("waits for a heartbeat already admitted when the workflow stops", async () => {
    const renewalStarted = Promise.withResolvers<void>();
    const releaseRenewal = Promise.withResolvers<boolean>();
    const releaseAttempt = Promise.withResolvers<void>();
    const workflow = makeDurableTextWorkflow({
      database: databaseFor(testDb.db),
      heartbeatMs: 1,
      renewLease: () => Effect.promise(() => {
        renewalStarted.resolve();
        return releaseRenewal.promise;
      }),
      runAttempt: () => Effect.promise(() => releaseAttempt.promise),
    });
    const running = Effect.runPromise(workflow.runAttempt({
      creationId: "heartbeat-stop",
      userId: "ada",
      attemptId: "attempt",
      leaseOwner: "worker",
      operation: "generate",
    }));

    await renewalStarted.promise;
    await Effect.runPromise(workflow.stop());
    const settling = Effect.runPromise(workflow.settle());

    try {
      await expect(Promise.race([
        settling.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
      ])).resolves.toBe(false);
    } finally {
      releaseRenewal.resolve(true);
      releaseAttempt.resolve();
    }

    await Promise.all([running, settling]);
  });

  it("logs an initial poll failure without rejecting scheduler startup", async () => {
    const failure = new Error("poll failed");
    const db = new Proxy(testDb.db, {
      get(target, property, receiver) {
        if (property === "delete") throw failure;
        return Reflect.get(target, property, receiver);
      },
    });
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const workflow = makeDurableTextWorkflow({
      database: databaseFor(db),
      intervalMs: 60_000,
    });

    try {
      await expect(Effect.runPromise(workflow.start())).resolves.toBeUndefined();
      expect(report).toHaveBeenCalledWith(
        "creation scheduler failed",
        expect.objectContaining({ cause: failure }),
      );
    } finally {
      await Effect.runPromise(workflow.stop());
      report.mockRestore();
    }
  });

  it("runs a claimed text generation through the workflow's built-in Effect attempt", async () => {
    await testDb.db.insert(drafts).values({
      id: "direct-attempt",
      userId: "ada",
      clientRequestId: "request-direct-attempt",
      sourceText: "hello",
      status: "queued",
      operation: "generate",
      deckId: "german",
      learningGoal: "Learn German",
      queuedAt: new Date(100),
    });
    const [work] = await claimCreationWork(testDb.db, "ada", {
      leaseOwner: "workflow-test",
      now: new Date(1_000),
    });
    const baseDatabase = databaseFor(testDb.db);
    const withWriteLockCalls = vi.fn();
    const withWriteLock: DurableTextDatabase["withWriteLock"] = (
      operation,
      work,
    ) => {
      withWriteLockCalls(operation, work);
      return baseDatabase.withWriteLock(operation, work);
    };
    const transactionCalls = vi.fn();
    const transaction: DurableTextDatabase["transaction"] = (operation, work) => {
      transactionCalls(operation, work);
      return baseDatabase.transaction(operation, work);
    };
    const database = {
      db: testDb.db,
      withWriteLock,
      transaction,
    } satisfies DurableTextDatabase;
    const workflow = makeDurableTextWorkflow({
      database,
      models: {
        adjust: async () => ({
          generationSummary: "Practise the meaning of Banane.",
          cards: [],
        }),
        route: async () => ({ kind: "matched", deckId: "german", learningGoal: "Learn German" }),
        classify: async () => ({ domain: "language", language: "de", partOfSpeech: "noun" }),
        generate: async function* () {
          yield JSON.stringify({
            imagePrompt: null,
            generationSummary: "Practise the meaning of Banane.",
            cards: [{
              aspect: "word",
              front: "Banane",
              back: "banana",
              imageCue: false,
            }],
          });
          return {
            imagePrompt: null,
            generationSummary: "Practise the meaning of Banane.",
            cards: [{
              aspect: "word",
              front: "Banane",
              back: "banana",
              imageCue: false,
            }],
          };
        },
      },
      nextId: () => "card-direct",
    });

    await Effect.runPromise(workflow.runAttempt(work!));

    const [creation] = await testDb.db.select().from(drafts)
      .where(eq(drafts.id, "direct-attempt"));
    expect(creation).toMatchObject({
      status: "ready",
      operation: null,
      activeAttemptId: null,
      leaseOwner: null,
      cards: [{
        key: "card-direct",
        aspect: "word",
        front: "Banane",
        back: "banana",
        imageCue: false,
      }],
    });
    expect(withWriteLockCalls).toHaveBeenCalledWith(
      "durable-text.patch",
      expect.anything(),
    );
    expect(transactionCalls).toHaveBeenCalledWith(
      "durable-text.finish-generation",
      expect.any(Function),
    );
  });
});
