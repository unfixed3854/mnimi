import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import {
  creationImageAttempts,
  decks,
  drafts,
  notes,
  user,
} from "../db/schema.ts";
import {
  claimCreationImageWork,
  enqueueCreationImage,
  MAX_ACTIVE_IMAGE_WORK,
  retryCreationImage,
  recoverStaleCreationImageWork,
  runCreationImageAttempt,
  startImageScheduler,
  transferCreationImageToNote,
} from "./image-scheduler.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(user).values([
    { id: "ada", name: "Ada", email: "ada@example.com" },
    { id: "bob", name: "Bob", email: "bob@example.com" },
  ]);
  await testDb.db.insert(decks).values([
    { id: "ada-deck", userId: "ada", name: "Ada deck" },
    { id: "bob-deck", userId: "bob", name: "Bob deck" },
  ]);
});

afterEach(() => testDb.close());

async function seedCreation(owner: "ada" | "bob", id: string) {
  await testDb.db.insert(drafts).values({
    id,
    userId: owner,
    clientRequestId: `request-${id}`,
    deckId: `${owner}-deck`,
    sourceText: id,
    status: "ready",
    cards: [{
      key: `card-${id}`,
      aspect: "meaning",
      front: id,
      back: "answer",
      imageCue: false,
    }],
  });
  return await enqueueCreationImage(testDb.db, {
    creationId: id,
    userId: owner,
    prompt: `picture of ${id}`,
  });
}

async function seedNote(owner = "ada") {
  const [note] = await testDb.db.insert(notes).values({
    userId: owner,
    deckId: `${owner}-deck`,
    sourceText: "saved",
    domain: "concept",
    metadata: {},
  }).returning();
  return note;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    db: testDb.db,
    generateImageBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    writeDraftImage: vi.fn(async () => "draft-image-1"),
    claimDraftImage: vi.fn(async (userId: string, _draftId: string, noteId: string) =>
      `${userId}/${noteId}.png`),
    removeDraftImage: vi.fn(async () => {}),
    removeImage: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    kick: vi.fn(),
    ...overrides,
  };
}

describe("durable creation image scheduling", () => {
  it("claims only two image attempts globally without consuming text slots", async () => {
    await seedCreation("ada", "ada-1");
    await seedCreation("ada", "ada-2");
    await seedCreation("bob", "bob-1");
    await testDb.db.insert(drafts).values([
      {
        id: "text-1",
        userId: "ada",
        clientRequestId: "text-1",
        sourceText: "text-1",
        status: "generating",
        operation: "generate",
        activeAttemptId: "text-attempt-1",
        leaseOwner: "text-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
      {
        id: "text-2",
        userId: "bob",
        clientRequestId: "text-2",
        sourceText: "text-2",
        status: "routing",
        operation: "route_generate",
        activeAttemptId: "text-attempt-2",
        leaseOwner: "text-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    const [first, second] = await Promise.all([
      claimCreationImageWork(testDb.db, { leaseOwner: "image-a" }),
      claimCreationImageWork(testDb.db, { leaseOwner: "image-b" }),
    ]);

    expect([...first, ...second]).toHaveLength(MAX_ACTIVE_IMAGE_WORK);
    expect(await testDb.db.select().from(creationImageAttempts)
      .where(eq(creationImageAttempts.status, "queued"))).toHaveLength(1);
  });

  it("settles image state independently from ready cards", async () => {
    await seedCreation("ada", "creation-1");
    const [work] = await claimCreationImageWork(testDb.db, {
      leaseOwner: "image-worker",
    });
    const workerDeps = deps();

    await runCreationImageAttempt(work, workerDeps);

    const [creation] = await testDb.db.select().from(drafts)
      .where(eq(drafts.id, "creation-1"));
    expect(creation).toMatchObject({
      status: "ready",
      imageStatus: "ready",
      draftImageId: "draft-image-1",
      leaseOwner: null,
    });
  });

  it("marks only the image failed when generation rejects", async () => {
    await seedCreation("ada", "creation-1");
    const [work] = await claimCreationImageWork(testDb.db, {
      leaseOwner: "image-worker",
    });

    await runCreationImageAttempt(work, deps({
      generateImageBytes: vi.fn(async () => {
        throw new Error("provider diagnostic");
      }),
    }));

    const [creation] = await testDb.db.select().from(drafts);
    expect(creation).toMatchObject({
      status: "ready",
      imageStatus: "failed",
      errorCategory: "image_failed",
    });
  });

  it("cancels a prior attempt on retry and rejects its late result", async () => {
    const firstId = await seedCreation("ada", "creation-1");
    const [staleWork] = await claimCreationImageWork(testDb.db, {
      leaseOwner: "image-worker",
    });
    const nextId = await retryCreationImage(testDb.db, {
      creationId: "creation-1",
      userId: "ada",
    });

    expect(nextId).not.toBe(firstId);
    const workerDeps = deps();
    await runCreationImageAttempt(staleWork, workerDeps);

    const [creation] = await testDb.db.select().from(drafts);
    expect(creation).toMatchObject({
      imageAttemptId: nextId,
      imageStatus: "queued",
      draftImageId: null,
    });
    expect(workerDeps.writeDraftImage).not.toHaveBeenCalled();
  });

  it("deletes only the superseded attempt's ready media on retry", async () => {
    await seedCreation("ada", "creation-1");
    const [work] = await claimCreationImageWork(testDb.db, {
      leaseOwner: "image-worker",
    });
    const workerDeps = deps();
    await runCreationImageAttempt(work, workerDeps);
    const removeDraftImage = vi.fn(async () => {});

    await retryCreationImage(testDb.db, {
      creationId: "creation-1",
      userId: "ada",
    }, { removeDraftImage });

    expect(removeDraftImage).toHaveBeenCalledWith("ada", "draft-image-1");
    const [creation] = await testDb.db.select().from(drafts);
    expect(creation).toMatchObject({ imageStatus: "queued", draftImageId: null });
  });

  it("fences every active image lease during boot recovery", async () => {
    await seedCreation("ada", "creation-1");
    await claimCreationImageWork(testDb.db, {
      leaseOwner: "previous-process",
      now: new Date(1_000),
      leaseMs: 90_000,
    });

    expect(await recoverStaleCreationImageWork(
      testDb.db,
      new Date(2_000),
      { allLeases: true },
    )).toBe(1);
    expect((await testDb.db.select().from(creationImageAttempts))[0])
      .toMatchObject({ status: "queued", leaseOwner: null });
  });

  it("removes bytes whose owner disappears during the disk write", async () => {
    await seedCreation("ada", "creation-1");
    const [work] = await claimCreationImageWork(testDb.db, {
      leaseOwner: "image-worker",
    });
    const workerDeps = deps({
      writeDraftImage: vi.fn(async () => {
        await testDb.db.delete(drafts).where(eq(drafts.id, "creation-1"));
        return "orphan-image";
      }),
    });

    await runCreationImageAttempt(work, workerDeps);

    expect(workerDeps.removeDraftImage).toHaveBeenCalledWith("ada", "orphan-image");
  });

  it("deletes a written file when retry supersedes it during the disk write", async () => {
    const staleId = await seedCreation("ada", "creation-1");
    const [work] = await claimCreationImageWork(testDb.db, {
      leaseOwner: "image-worker",
    });
    let replacementId = "";
    const workerDeps = deps({
      writeDraftImage: vi.fn(async () => {
        replacementId = await retryCreationImage(testDb.db, {
          creationId: "creation-1",
          userId: "ada",
        });
        return "stale-image";
      }),
    });

    await runCreationImageAttempt(work, workerDeps);

    expect(replacementId).not.toBe(staleId);
    expect(workerDeps.removeDraftImage).toHaveBeenCalledWith("ada", "stale-image");
    const [creation] = await testDb.db.select().from(drafts);
    expect(creation).toMatchObject({
      imageAttemptId: replacementId,
      imageStatus: "queued",
      draftImageId: null,
    });
  });

  it("transfers pending work to a note and attaches the late result", async () => {
    const attemptId = await seedCreation("ada", "creation-1");
    const [work] = await claimCreationImageWork(testDb.db, {
      leaseOwner: "image-worker",
    });
    const note = await seedNote();
    const workerDeps = deps();

    await expect(transferCreationImageToNote(testDb.db, {
      creationId: "creation-1",
      imageAttemptId: attemptId,
      noteId: note.id,
      userId: "ada",
    }, workerDeps)).resolves.toEqual({ kind: "pending" });
    await testDb.db.delete(drafts).where(eq(drafts.id, "creation-1"));

    await runCreationImageAttempt(work, workerDeps);

    const [saved] = await testDb.db.select().from(notes).where(eq(notes.id, note.id));
    expect(saved.imagePath).toBe(`ada/${note.id}.png`);
    expect(workerDeps.claimDraftImage).toHaveBeenCalledWith(
      "ada",
      "draft-image-1",
      note.id,
    );
  });

  it("claims an already-ready image synchronously during transfer", async () => {
    const attemptId = await seedCreation("ada", "creation-1");
    const [work] = await claimCreationImageWork(testDb.db, {
      leaseOwner: "image-worker",
    });
    const workerDeps = deps();
    await runCreationImageAttempt(work, workerDeps);
    const note = await seedNote();

    await expect(transferCreationImageToNote(testDb.db, {
      creationId: "creation-1",
      imageAttemptId: attemptId,
      noteId: note.id,
      userId: "ada",
    }, workerDeps)).resolves.toEqual({
      kind: "ready",
      imagePath: `ada/${note.id}.png`,
    });

    const [saved] = await testDb.db.select().from(notes).where(eq(notes.id, note.id));
    expect(saved.imagePath).toBe(`ada/${note.id}.png`);
    const [creation] = await testDb.db.select().from(drafts)
      .where(eq(drafts.id, "creation-1"));
    expect(creation).toMatchObject({
      imageAttemptId: null,
      imageStatus: "none",
      draftImageId: null,
    });
  });

  it("polls immediately and ignores image kicks after stop", async () => {
    const initialAttemptId = await seedCreation("ada", "initial");
    const runWork = vi.fn(async (_work: { attemptId: string }) => {});
    const scheduler = startImageScheduler({
      db: testDb.db,
      runWork,
      intervalMs: 60_000,
      leaseOwner: "image-scheduler-test",
      now: () => new Date(1_000),
    });

    try {
      await vi.waitFor(() => expect(runWork).toHaveBeenCalledTimes(1));
      expect(runWork.mock.calls[0][0].attemptId).toBe(initialAttemptId);

      scheduler.stop();
      await seedCreation("ada", "after-stop");
      scheduler.kick();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(runWork).toHaveBeenCalledTimes(1);
    } finally {
      scheduler.stop();
    }
  });

  it("drains image completion kicks without dispatching an attempt twice", async () => {
    const attemptIds = new Map([
      ["coalesced-image-1", await seedCreation("ada", "coalesced-image-1")],
      ["coalesced-image-2", await seedCreation("ada", "coalesced-image-2")],
      ["coalesced-image-3", await seedCreation("bob", "coalesced-image-3")],
    ]);
    const releases = new Map<string, () => void>();
    const runWork = vi.fn((work: { attemptId: string }) =>
      new Promise<void>((resolve) => releases.set(work.attemptId, resolve))
    );
    let scheduler: ReturnType<typeof startImageScheduler>;
    let nowCalls = 0;
    let nowDepth = 0;
    let reentrantNow = false;
    const schedulerNow = vi.fn(() => {
      if (nowDepth > 0) reentrantNow = true;
      nowDepth += 1;
      try {
        nowCalls += 1;
        if (nowCalls === 2) scheduler.kick();
        return new Date(1_000);
      } finally {
        nowDepth -= 1;
      }
    });
    scheduler = startImageScheduler({
      db: testDb.db,
      runWork,
      intervalMs: 60_000,
      leaseOwner: "image-coalescing-test",
      now: schedulerNow,
    });

    try {
      await vi.waitFor(() =>
        expect(runWork).toHaveBeenCalledTimes(MAX_ACTIVE_IMAGE_WORK)
      );
      expect(schedulerNow).toHaveBeenCalledTimes(3);
      expect(reentrantNow).toBe(false);
      const firstBatch = [...releases.entries()];
      expect(firstBatch).toHaveLength(MAX_ACTIVE_IMAGE_WORK);
      for (const [attemptId, release] of firstBatch) {
        await testDb.db.update(creationImageAttempts).set({
          status: "ready",
          leaseOwner: null,
          leaseExpiresAt: null,
        }).where(eq(creationImageAttempts.id, attemptId));
        release();
      }

      await vi.waitFor(() => expect(runWork).toHaveBeenCalledTimes(3));
      expect(new Set(
        runWork.mock.calls.map(([work]) => work.attemptId),
      )).toEqual(new Set(attemptIds.values()));
    } finally {
      scheduler.stop();
      for (const release of releases.values()) release();
    }
  });

  it("logs a failed image poll and retries on the next interval", async () => {
    await seedCreation("ada", "after-failed-image-poll");
    vi.useFakeTimers();
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
});
