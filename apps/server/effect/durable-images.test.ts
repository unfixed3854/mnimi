import { Effect, Exit, Fiber, Runtime } from "effect";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { creationImageAttempts, decks, drafts, notes, user } from "../db/schema.ts";
import { makeDurableImageWorkflow, type DurableImageDatabase } from "./durable-images.ts";
import { DatabaseFailure, MediaFailure, ProviderFailure } from "./errors.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;

function databaseFor(db: typeof testDb.db): DurableImageDatabase {
  const semaphore = Effect.runSync(Effect.makeSemaphore(1));
  return {
    db,
    withWriteLock: (_operation, work) => semaphore.withPermits(1)(work),
    transaction: <A, E, R>(operation: string, work: (tx: typeof db) => Effect.Effect<A, E, R>) => semaphore.withPermits(1)(Effect.gen(function* () {
      const runtime = yield* Effect.runtime<R>();
      return yield* Effect.tryPromise({
        try: () => db.transaction(async (tx) => {
          const exit = await Runtime.runPromiseExit(runtime)(work(tx as unknown as typeof db));
          if (Exit.isFailure(exit)) throw exit.cause;
          return exit.value;
        }),
        catch: (cause) => new DatabaseFailure({ operation, cause }),
      });
    })),
  };
}

beforeEach(async () => {
  testDb = await createTestDb();
  await testDb.client.execute("PRAGMA journal_mode = WAL");
  await testDb.db.insert(user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
  await testDb.db.insert(decks).values({ id: "ada-deck", userId: "ada", name: "Ada deck" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  testDb.close();
});

const work = { attemptId: "attempt", userId: "ada", leaseOwner: "worker" };
const transferInput = (noteId: string) => ({ creationId: "creation", imageAttemptId: "attempt", userId: "ada", noteId });

async function seedAttempt(status: "queued" | "generating" | "ready" | "failed" | "canceled" = "generating", id = "attempt", owner = "ada") {
  const creationId = id === "attempt" ? "creation" : `creation-${id}`;
  await testDb.db.insert(drafts).values({
    id: creationId, userId: owner, clientRequestId: creationId, deckId: `${owner}-deck`,
    sourceText: "hello", status: "ready", activeAttemptId: "text-attempt",
    cards: [{ key: "card", aspect: "meaning", front: "hello", back: "answer", imageCue: false }],
    imageAttemptId: id, imagePrompt: "draw hello", imageStatus: status === "canceled" ? "none" : status,
    draftImageId: status === "ready" ? "draft-image" : null,
  });
  await testDb.db.insert(creationImageAttempts).values({
    id, userId: owner, creationId, prompt: "draw hello", status,
    leaseOwner: status === "generating" ? "worker" : null,
    leaseExpiresAt: status === "generating" ? new Date(121_000) : null,
    draftImageId: status === "ready" ? "draft-image" : null,
  });
}

async function seedNote() {
  return (await testDb.db.insert(notes).values({ userId: "ada", deckId: "ada-deck", sourceText: "saved", domain: "concept", metadata: { partOfSpeech: "noun", imageFailed: true } }).returning())[0];
}

const readAttempt = async (id = "attempt") => (await testDb.db.select().from(creationImageAttempts).where(eq(creationImageAttempts.id, id)))[0];
const readCreation = async () => (await testDb.db.select().from(drafts).where(eq(drafts.id, "creation")))[0];
const readNote = async (id: string) => (await testDb.db.select().from(notes).where(eq(notes.id, id)))[0];

function harness(overrides: Partial<Parameters<typeof makeDurableImageWorkflow>[0]> = {}) {
  const files = new Set<string>();
  const calls: string[] = [];
  const media = {
    writeDraftImage: (_owner: string, _bytes: Uint8Array) => Effect.sync(() => { calls.push("write"); files.add("draft-image"); return "draft-image"; }),
    claimDraftImage: (owner: string, id: string, noteId: string) => Effect.sync(() => {
      calls.push(`claim:${id}`); files.delete(id); const path = `${owner}/${noteId}.png`; files.add(path); return path;
    }),
    removeDraftImage: (_owner: string, id: string) => Effect.sync(() => { calls.push(`remove-draft:${id}`); files.delete(id); }),
    removeImage: (path: string) => Effect.sync(() => { calls.push(`remove-image:${path}`); files.delete(path); }),
  };
  const workflow = makeDurableImageWorkflow({
    database: databaseFor(testDb.db), now: () => new Date(1_000),
    provider: { generateImageBytes: () => Effect.sync(() => { calls.push("generate"); return new Uint8Array([1, 2, 3]); }) },
    events: { publish: () => Effect.void },
    media, ...overrides,
  });
  return { workflow, media, files, calls };
}

describe("direct durable image ownership and compensation", () => {
  it("leaves enqueued images queued until the scheduler starts after boot recovery", async () => {
    await testDb.db.insert(drafts).values({ id: "creation", userId: "ada", sourceText: "hello", status: "ready" });
    const { workflow, calls } = harness();
    try {
      const id = await Effect.runPromise(workflow.enqueue({ creationId: "creation", userId: "ada", prompt: "hello" }));
      await Effect.runPromise(workflow.kick());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await readAttempt(id)).toMatchObject({ status: "queued", leaseOwner: null });
      expect(calls).toEqual([]);
      await Effect.runPromise(workflow.recover(new Date(1_000), { allLeases: true }));
      await Effect.runPromise(workflow.start());
      await vi.waitFor(async () => expect(await readAttempt(id)).toMatchObject({ status: "ready" }));
    } finally { await Effect.runPromise(workflow.stop()); }
  });
  it("requires media, provider, and event dependencies at construction", () => {
    type Options = Parameters<typeof makeDurableImageWorkflow>[0];
    expectTypeOf<Options>().toExtend<Required<Pick<Options, "media" | "provider" | "events">>>();
  });

  it("reports a failed ready-transfer rollback through the media error channel", async () => {
    await seedAttempt("ready");
    const note = await seedNote();
    const failure = new MediaFailure({ operation: "remove", message: "cannot remove claimed image" });
    const { media } = harness();
    const { workflow } = harness({ media: { ...media, removeImage: () => Effect.fail(failure) } });
    await testDb.client.execute("CREATE TRIGGER reject_image BEFORE UPDATE OF image_path ON notes BEGIN SELECT RAISE(ABORT, 'guarded note write failed'); END");
    const result = await Effect.runPromise(Effect.either(workflow.transfer(transferInput(note.id))));
    expect(result).toMatchObject({ _tag: "Left", left: failure });
  });

  it("finishes ready-transfer ownership when its caller is interrupted during rename", async () => {
    await seedAttempt("ready");
    const note = await seedNote();
    const claiming = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const claimed = Promise.withResolvers<void>();
    const { media, files } = harness();
    files.add("draft-image");
    const path = `ada/${note.id}.png`;
    const { workflow } = harness({ media: { ...media, claimDraftImage: () => Effect.promise(async () => {
      claiming.resolve(); await release.promise;
      files.delete("draft-image"); files.add(path); claimed.resolve(); return path;
    }) } });
    const fiber = Effect.runFork(workflow.transfer(transferInput(note.id)));
    await claiming.promise;
    await Effect.runPromise(Fiber.interruptFork(fiber));
    release.resolve(); await claimed.promise;
    await Effect.runPromise(Fiber.await(fiber));
    expect((await readNote(note.id)).imagePath).toBe(path);
    expect([...files]).toEqual([path]);
    expect(await readCreation()).toMatchObject({ draftImageId: null, imageAttemptId: null });
  });

  it("compensates a late disk write when its caller is interrupted", async () => {
    await seedAttempt();
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    const files = new Set<string>();
    const { media } = harness();
    const { workflow } = harness({ media: {
      ...media,
      writeDraftImage: () => Effect.promise(async () => {
        writing.resolve(); await release.promise;
        files.add("late-image"); written.resolve(); return "late-image";
      }),
      removeDraftImage: (_owner, id) => Effect.sync(() => { files.delete(id); }),
    } });
    const fiber = Effect.runFork(workflow.runAttempt(work));
    await writing.promise;
    await Effect.runPromise(Fiber.interruptFork(fiber));
    release.resolve();
    await written.promise;
    await Effect.runPromise(Fiber.await(fiber));
    expect(files.size).toBe(0);
    expect((await readCreation()).draftImageId).toBeNull();
  });

  it("finalizes written bytes when settlement is interrupted", async () => {
    await seedAttempt();
    const database = databaseFor(testDb.db);
    const { workflow, files } = harness({ database: {
      ...database,
      withWriteLock: (operation, effect) => operation === "durable-images.settle" ? Effect.interrupt : database.withWriteLock(operation, effect),
    } });
    const exit = await Effect.runPromiseExit(workflow.runAttempt(work));
    expect(exit._tag).toBe("Failure");
    expect(files.size).toBe(0);
  });

  it.each(["draft", "note", "transfer"] as const)("compensates media after a guarded %s database write fails", async (target) => {
    await seedAttempt(target === "transfer" ? "ready" : "generating");
    const note = target === "draft" ? undefined : await seedNote();
    const { workflow, files } = harness();
    if (target === "transfer") files.add("draft-image");
    if (target === "note") await Effect.runPromise(workflow.transfer(transferInput(note!.id)));
    await testDb.client.execute(target === "draft"
      ? "CREATE TRIGGER reject_image BEFORE UPDATE OF image_status ON drafts WHEN NEW.image_status = 'ready' BEGIN SELECT RAISE(ABORT, 'guarded draft write failed'); END"
      : "CREATE TRIGGER reject_image BEFORE UPDATE OF image_path ON notes BEGIN SELECT RAISE(ABORT, 'guarded note write failed'); END");
    const exit = await Effect.runPromiseExit(target === "transfer" ? workflow.transfer(transferInput(note!.id)) : workflow.runAttempt(work));
    expect(exit._tag).toBe("Failure");
    expect(files.size).toBe(0);
    if (target === "draft") expect(await readCreation()).toMatchObject({ status: "ready", imageStatus: "failed", draftImageId: null });
    if (target === "note") expect(await readNote(note!.id)).toMatchObject({ imagePath: null, metadata: { partOfSpeech: "noun", imageFailed: true } });
    expect((await readAttempt()).status).toBe(target === "transfer" ? "ready" : "failed");
  });

  it("publishes ready state only after both writes and after releasing the write lock", async () => {
    await seedAttempt();
    let locked = false;
    const database = databaseFor(testDb.db);
    const snapshots: string[] = [];
    const { workflow } = harness({ database: {
      ...database,
      withWriteLock: (operation, effect) => database.withWriteLock(operation, Effect.gen(function* () {
        locked = true; return yield* effect;
      }).pipe(Effect.ensuring(Effect.sync(() => { locked = false; })))),
    }, events: { publish: (creation, attemptId) => Effect.promise(async () => {
      expect(locked).toBe(false);
      expect(await readCreation()).toMatchObject({ status: "ready", imageStatus: "ready", draftImageId: "draft-image" });
      expect(await readAttempt()).toMatchObject({ status: "ready", leaseOwner: null, draftImageId: "draft-image" });
      expect(attemptId).toBe("text-attempt");
      snapshots.push(creation.id);
    }) } });
    await Effect.runPromise(workflow.runAttempt(work));
    expect(snapshots).toEqual(["creation"]);
  });

  it("reports orphan cleanup failure instead of silently leaving its bytes", async () => {
    await seedAttempt();
    const cleanupFailure = new MediaFailure({ operation: "remove", message: "disk refused deletion" });
    const { workflow } = harness({ media: {
      writeDraftImage: () => Effect.promise(async () => {
        await testDb.db.delete(drafts).where(eq(drafts.id, "creation"));
        return "orphan";
      }).pipe(Effect.mapError((cause) => new MediaFailure({ operation: "test-write", message: "test write failed", cause }))),
      claimDraftImage: () => Effect.die("not used"),
      removeImage: () => Effect.die("not used"),
      removeDraftImage: () => Effect.fail(cleanupFailure),
    } });
    const result = await Effect.runPromise(Effect.either(workflow.runAttempt(work)));
    expect(result).toMatchObject({ _tag: "Left", left: cleanupFailure });
  });

  it.each(["retry", "cancel", "delete"] as const)("removes a late disk write after %s changes its owner", async (change) => {
    await seedAttempt();
    const { media, files } = harness();
    let replacement: string | undefined;
    const { workflow } = harness({ media: {
      ...media,
      writeDraftImage: (owner, bytes) => Effect.gen(function* () {
        const id = yield* media.writeDraftImage(owner, bytes);
        if (change === "retry") replacement = yield* workflow.retry({ creationId: "creation", userId: "ada" });
        if (change === "cancel") yield* workflow.cancel(transferInput("unused"));
        if (change === "delete") yield* Effect.promise(() => testDb.db.delete(drafts).where(eq(drafts.id, "creation")));
        return id;
      }).pipe(Effect.mapError((cause) => new MediaFailure({ operation: "test-write", message: "test write failed", cause }))),
    } });
    await Effect.runPromise(workflow.stop());
    await Effect.runPromise(workflow.runAttempt(work));
    expect(files.size).toBe(0);
    if (change === "retry") expect(await readCreation()).toMatchObject({ imageAttemptId: replacement, imageStatus: "queued", draftImageId: null });
    if (change === "cancel") expect(await readCreation()).toMatchObject({ imageAttemptId: null, imageStatus: "none", draftImageId: null });
    if (change === "delete") expect(await readCreation()).toBeUndefined();
  });

  it.each(["owner", "user", "status"] as const)("does no provider or media work for a stale %s fence", async (field) => {
    await seedAttempt();
    const { workflow, calls } = harness();
    if (field === "status") await testDb.db.update(creationImageAttempts).set({ status: "canceled" }).where(eq(creationImageAttempts.id, "attempt"));
    await Effect.runPromise(workflow.runAttempt({ ...work, ...(field === "owner" ? { leaseOwner: "stale" } : field === "user" ? { userId: "bob" } : {}) }));
    expect(calls).toEqual([]);
    expect((await readCreation()).imageStatus).toBe("generating");
  });

  it.each([false, true])("rejects a provider result after retry, including failure=%s", async (failed) => {
    await seedAttempt();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { workflow, files, calls } = harness({ provider: { generateImageBytes: () => Effect.gen(function* () {
      started.resolve();
      yield* Effect.promise(() => release.promise);
      return yield* failed ? Effect.fail(new ProviderFailure({ provider: "test", operation: "image", message: "failed" })) : Effect.succeed(new Uint8Array([1]));
    }) } });
    await Effect.runPromise(workflow.stop());
    const running = Effect.runPromiseExit(workflow.runAttempt(work));
    await started.promise;
    const replacement = await Effect.runPromise(workflow.retry({ creationId: "creation", userId: "ada" }));
    release.resolve();
    await running;
    expect(await readCreation()).toMatchObject({ imageAttemptId: replacement, imageStatus: "queued", draftImageId: null, error: null });
    expect((await readAttempt()).status).toBe("canceled");
    expect(calls).toEqual([]);
    expect(files.size).toBe(0);
  });

  it.each(["retry", "cancel"] as const)("deletes superseded ready media on %s", async (operation) => {
    await seedAttempt("ready");
    const { workflow, files } = harness();
    files.add("draft-image"); files.add("unrelated-image");
    await Effect.runPromise(workflow.stop());
    if (operation === "retry") await Effect.runPromise(workflow.retry({ creationId: "creation", userId: "ada" }));
    else await Effect.runPromise(workflow.cancel(transferInput("unused")));
    expect([...files]).toEqual(["unrelated-image"]);
    expect((await readAttempt()).status).toBe("canceled");
    expect((await readCreation()).draftImageId).toBeNull();
  });

  it.each(["provider", "write", "claim"] as const)("settles a %s failure behind its matching attempt fence", async (source) => {
    await seedAttempt();
    const note = source === "claim" ? await seedNote() : undefined;
    const { media, files } = harness();
    const published: string[] = [];
    const { workflow } = harness({
      provider: { generateImageBytes: () => source === "provider" ? Effect.fail(new ProviderFailure({ provider: "test", operation: "image", message: "private detail" })) : Effect.succeed(new Uint8Array([1])) },
      media: { ...media,
        writeDraftImage: (owner, bytes) => source === "write" ? Effect.fail(new MediaFailure({ operation: "write", message: "disk failed" })) : media.writeDraftImage(owner, bytes),
        claimDraftImage: () => Effect.fail(new MediaFailure({ operation: "claim", message: "disk failed" })),
      },
      events: { publish: (creation) => Effect.promise(async () => {
        expect((await readAttempt()).status).toBe("failed");
        expect((await readCreation()).imageStatus).toBe("failed");
        published.push(creation.id);
      }) },
    });
    if (note) await Effect.runPromise(workflow.transfer(transferInput(note.id)));
    const exit = await Effect.runPromiseExit(workflow.runAttempt(work));
    expect(exit._tag).toBe("Failure");
    expect(await readAttempt()).toMatchObject({ status: "failed", leaseOwner: null, leaseExpiresAt: null, error: "We couldn't create the image. You can retry it." });
    expect(files.size).toBe(0);
    if (note) {
      expect((await readNote(note.id)).metadata).toEqual({ partOfSpeech: "noun", imageFailed: true });
      expect(published).toEqual([]);
    } else {
      expect(await readCreation()).toMatchObject({ status: "ready", imageStatus: "failed", errorCategory: "image_failed", errorStage: "image" });
      expect((await readCreation()).cards).toHaveLength(1);
      expect(published).toEqual(["creation"]);
    }
  });

  it.each(["queued", "generating", "failed", "ready", "canceled"] as const)("transfers %s state without losing note metadata", async (status) => {
    await seedAttempt(status);
    const note = await seedNote();
    const { workflow, files } = harness();
    if (status === "ready") files.add("draft-image");
    const result = await Effect.runPromise(workflow.transfer(transferInput(note.id)));
    if (status === "queued" || status === "generating") {
      expect(result).toEqual({ kind: "pending" });
      expect(await readAttempt()).toMatchObject({ creationId: null, noteId: note.id, status, leaseOwner: status === "generating" ? "worker" : null });
    } else if (status === "failed") {
      expect(result).toEqual({ kind: "failed" });
      expect((await readNote(note.id)).metadata).toEqual({ partOfSpeech: "noun", imageFailed: true });
      expect(await readAttempt()).toMatchObject({ creationId: null, noteId: note.id, status });
    } else if (status === "ready") {
      expect(result).toEqual({ kind: "ready", imagePath: `ada/${note.id}.png` });
      expect((await readNote(note.id)).metadata).toEqual({ partOfSpeech: "noun" });
      expect(await readCreation()).toMatchObject({ imageAttemptId: null, imageStatus: "none", draftImageId: null });
      expect(await readAttempt()).toMatchObject({ creationId: null, noteId: note.id, draftImageId: null });
      expect([...files]).toEqual([`ada/${note.id}.png`]);
    } else expect(result).toEqual({ kind: "none" });
  });

  it("transfers while the provider runs and settles after the creation is deleted", async () => {
    await seedAttempt();
    const note = await seedNote();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Uint8Array>();
    const { workflow, files } = harness({ provider: { generateImageBytes: () => Effect.promise(() => { started.resolve(); return release.promise; }) } });
    const running = Effect.runPromise(workflow.runAttempt(work));
    await started.promise;
    expect(await Effect.runPromise(workflow.transfer(transferInput(note.id)))).toEqual({ kind: "pending" });
    await testDb.db.delete(drafts).where(eq(drafts.id, "creation"));
    release.resolve(new Uint8Array([1]));
    await running;
    expect(await readNote(note.id)).toMatchObject({ imagePath: `ada/${note.id}.png`, metadata: { partOfSpeech: "noun" } });
    expect(await readAttempt()).toMatchObject({ status: "ready", leaseOwner: null, draftImageId: null });
    expect([...files]).toEqual([`ada/${note.id}.png`]);
  });

  it.each(["attempt", "ready-transfer"] as const)("removes a claimed path if its note disappears during %s", async (operation) => {
    await seedAttempt(operation === "attempt" ? "generating" : "ready");
    const note = await seedNote();
    const { media, files } = harness();
    if (operation === "ready-transfer") files.add("draft-image");
    const { workflow } = harness({ media: { ...media, claimDraftImage: (owner, id, noteId) => Effect.gen(function* () {
      const path = yield* media.claimDraftImage(owner, id, noteId);
      yield* Effect.promise(() => testDb.db.delete(notes).where(eq(notes.id, noteId)));
      return path;
    }) } });
    if (operation === "attempt") {
      await Effect.runPromise(workflow.transfer(transferInput(note.id)));
      await Effect.runPromise(workflow.runAttempt(work));
    } else {
      await Effect.runPromiseExit(workflow.transfer(transferInput(note.id)));
    }
    expect(files.size).toBe(0);
  });
});

describe("direct durable image scheduling", () => {
  it("does not dispatch image claims whose transaction result arrives after stop", async () => {
    await seedAttempt("queued", "first");
    await seedAttempt("queued", "second");
    const database = databaseFor(testDb.db);
    const committed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
    const events: string[] = [];
    const { workflow } = harness({
      database: { ...database, transaction: (operation, callback) => database.transaction(operation, callback).pipe(
        Effect.tap(() => Effect.promise(() => { committed.resolve(); return release.promise; })),
        Effect.ensuring(Effect.sync(() => finished.resolve())),
      ) },
      runAttempt: (claim) => Effect.promise(async () => {
        events.push(`worker:${claim.attemptId}`);
        await testDb.db.update(creationImageAttempts).set({ status: "ready", leaseOwner: null })
          .where(eq(creationImageAttempts.id, claim.attemptId));
      }),
    });
    try {
      await Effect.runPromise(workflow.start());
      await committed.promise;
      await Effect.runPromise(workflow.stop());
      events.push("stopped");
      release.resolve(); await finished.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(["stopped"]);
      const attempts = await testDb.db.select().from(creationImageAttempts);
      expect(attempts.map((attempt) => attempt.status)).toEqual(["generating", "generating"]);
    } finally {
      release.resolve();
      await Effect.runPromise(workflow.stop());
    }
  });
  it("lets an active disk write reach compensation after stop while a second attempt stays queued", async () => {
    await seedAttempt("generating", "occupied");
    await seedAttempt("queued");
    await seedAttempt("queued", "second");
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { media, files, calls } = harness();
    const { workflow } = harness({ media: { ...media, writeDraftImage: (owner, bytes) => Effect.gen(function* () {
      const id = yield* media.writeDraftImage(owner, bytes);
      writing.resolve(); yield* Effect.promise(() => release.promise);
      return id;
    }) } });
    await Effect.runPromise(workflow.start());
    await writing.promise;
    expect((await readAttempt("second")).status).toBe("queued");
    await Effect.runPromise(workflow.stop());
    await testDb.db.delete(drafts).where(eq(drafts.id, "creation"));
    release.resolve();
    await expect.poll(() => calls.includes("remove-draft:draft-image")).toBe(true);
    await Effect.runPromise(workflow.kick());
    expect(files.size).toBe(0);
    expect(await readAttempt("second")).toMatchObject({ status: "queued", leaseOwner: null });
    expect((await readAttempt("occupied")).status).toBe("generating");
  });

  it("does not admit a claim waiting on the database after stop", async () => {
    await seedAttempt("queued");
    const database = databaseFor(testDb.db);
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const drainFinished = Promise.withResolvers<void>();
    const { workflow } = harness({ database: {
      ...database,
      transaction: (operation, callback) => Effect.gen(function* () {
        waiting.resolve();
        yield* Effect.promise(() => release.promise);
        return yield* database.transaction(operation, callback);
      }).pipe(Effect.ensuring(Effect.sync(() => drainFinished.resolve()))),
    } });
    await Effect.runPromise(workflow.start());
    await waiting.promise;
    await Effect.runPromise(workflow.stop());
    release.resolve();
    await drainFinished.promise;
    const afterStop = await readAttempt();
    // Let an incorrectly admitted worker finish before closing its database.
    if ((await readAttempt()).status !== "queued") await expect.poll(async () => (await readAttempt()).status).toBe("ready");
    expect(afterStop).toMatchObject({ status: "queued", leaseOwner: null });
  });

  it("claims exactly two image slots globally while text leases remain independent", async () => {
    await testDb.db.insert(user).values({ id: "bob", name: "Bob", email: "bob@example.com" });
    await testDb.db.insert(decks).values({ id: "bob-deck", userId: "bob", name: "Bob deck" });
    await seedAttempt("queued", "one");
    await seedAttempt("queued", "two", "bob");
    await seedAttempt("queued", "three");
    await testDb.db.insert(drafts).values({ id: "text", userId: "ada", clientRequestId: "text", sourceText: "text", status: "generating", operation: "generate", activeAttemptId: "text-attempt", leaseOwner: "text-worker", leaseExpiresAt: new Date(90_000) });
    const release = Promise.withResolvers<void>();
    const database = databaseFor(testDb.db);
    const runAttempt = (item: typeof work) => Effect.promise(async () => {
      await release.promise;
      await testDb.db.update(creationImageAttempts).set({ status: "ready", leaseOwner: null }).where(eq(creationImageAttempts.id, item.attemptId));
    });
    const a = harness({ database, runAttempt, leaseOwner: "a" }).workflow;
    const b = harness({ database, runAttempt, leaseOwner: "b" }).workflow;
    try {
      await Promise.all([Effect.runPromise(a.start()), Effect.runPromise(b.start())]);
      await expect.poll(async () => (await testDb.db.select().from(creationImageAttempts).where(eq(creationImageAttempts.status, "generating"))).length).toBe(2);
      const attempts = await testDb.db.select().from(creationImageAttempts);
      expect(attempts.filter((attempt) => attempt.status === "queued")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "generating").map((attempt) => attempt.leaseExpiresAt?.getTime())).toEqual([121_000, 121_000]);
      expect((await testDb.db.select().from(drafts).where(eq(drafts.id, "text")))[0]).toMatchObject({ status: "generating", leaseOwner: "text-worker" });
    } finally {
      await Effect.runPromise(a.stop()); await Effect.runPromise(b.stop());
      release.resolve();
      await expect.poll(async () => (await testDb.db.select().from(creationImageAttempts).where(eq(creationImageAttempts.status, "ready"))).length).toBe(2);
    }
  });

  it("recovers expired and missing leases, then fences every remaining lease at boot", async () => {
    await seedAttempt("generating", "expired");
    await seedAttempt("generating", "missing");
    await seedAttempt("generating", "fresh");
    await seedAttempt("queued", "queued");
    await testDb.db.update(creationImageAttempts).set({ leaseExpiresAt: new Date(2_000) }).where(eq(creationImageAttempts.id, "expired"));
    await testDb.db.update(creationImageAttempts).set({ leaseExpiresAt: null }).where(eq(creationImageAttempts.id, "missing"));
    const { workflow } = harness();
    expect(await Effect.runPromise(workflow.recover(new Date(2_000), {}))).toBe(2);
    expect(await readAttempt("expired")).toMatchObject({ status: "queued", leaseOwner: null, leaseExpiresAt: null });
    expect(await readAttempt("missing")).toMatchObject({ status: "queued", leaseOwner: null, leaseExpiresAt: null });
    expect((await readAttempt("fresh")).status).toBe("generating");
    expect(await Effect.runPromise(workflow.recover(new Date(2_000), { allLeases: true }))).toBe(1);
    expect(await readAttempt("fresh")).toMatchObject({ status: "queued", leaseOwner: null, leaseExpiresAt: null });
    expect(await Effect.runPromise(workflow.recover(new Date(2_000), { allLeases: true }))).toBe(0);
  });

  it("polls immediately and coalesces completion kicks without duplicate dispatch", async () => {
    await seedAttempt("queued", "one"); await seedAttempt("queued", "two"); await seedAttempt("queued", "three");
    const releases = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    const dispatches: string[] = [];
    const database = databaseFor(testDb.db);
    const { workflow } = harness({
      database,
      intervalMs: 60_000,
      runAttempt: (item) => Effect.promise(async () => {
        dispatches.push(item.attemptId);
        const release = Promise.withResolvers<void>(); releases.set(item.attemptId, release);
        await release.promise;
        await Effect.runPromise(database.withWriteLock("test-complete", Effect.promise(() => testDb.db.update(creationImageAttempts).set({ status: "ready", leaseOwner: null }).where(eq(creationImageAttempts.id, item.attemptId)))));
      }),
    });
    try {
      await Effect.runPromise(workflow.start());
      await expect.poll(() => dispatches.length).toBe(2);
      await Promise.all(Array.from({ length: 20 }, () => Effect.runPromise(workflow.kick())));
      expect(dispatches).toHaveLength(2);
      for (const release of releases.values()) release.resolve();
      await expect.poll(() => dispatches.length).toBe(3);
      expect(new Set(dispatches)).toEqual(new Set(["one", "two", "three"]));
    } finally {
      await Effect.runPromise(workflow.stop());
      for (const release of releases.values()) release.resolve();
      await expect.poll(async () => (await testDb.db.select().from(creationImageAttempts).where(eq(creationImageAttempts.status, "ready"))).length).toBe(3);
    }
  });

  it.each(["success", "provider-failure", "stale"] as const)("renews at 40 seconds for a 120 second lease and finalizes on %s", async (outcome) => {
    await seedAttempt();
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let current = 1_000;
    const { workflow } = harness({ now: () => new Date(current), provider: { generateImageBytes: () => Effect.gen(function* () {
      started.resolve(); yield* Effect.promise(() => release.promise);
      return yield* outcome === "provider-failure" ? Effect.fail(new ProviderFailure({ provider: "test", operation: "image", message: "failed" })) : Effect.succeed(new Uint8Array([1]));
    }) } });
    const running = Effect.runPromiseExit(workflow.runAttempt(work));
    await started.promise;
    expect(vi.getTimerCount()).toBe(1);
    current = 40_999;
    await vi.advanceTimersByTimeAsync(39_999);
    expect((await readAttempt()).leaseExpiresAt?.getTime()).toBe(121_000);
    current = 41_000;
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(async () => expect((await readAttempt()).leaseExpiresAt?.getTime()).toBe(161_000));
    if (outcome === "stale") {
      await testDb.db.update(creationImageAttempts).set({ leaseOwner: "replacement", leaseExpiresAt: new Date(200_000) }).where(eq(creationImageAttempts.id, "attempt"));
      current = 81_000;
      await vi.advanceTimersByTimeAsync(40_000);
      expect((await readAttempt()).leaseExpiresAt?.getTime()).toBe(200_000);
    }
    release.resolve(); await running;
    expect(vi.getTimerCount()).toBe(0);
    expect((await readAttempt()).status).toBe(outcome === "success" ? "ready" : outcome === "provider-failure" ? "failed" : "generating");
  });

  it("waits for a heartbeat already admitted when the workflow stops", async () => {
    const renewalStarted = Promise.withResolvers<void>();
    const releaseRenewal = Promise.withResolvers<boolean>();
    const releaseAttempt = Promise.withResolvers<void>();
    const baseDatabase = databaseFor(testDb.db);
    const { workflow } = harness({
      heartbeatMs: 1,
      database: {
        ...baseDatabase,
        withWriteLock: <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) => operation === "durable-images.renew-lease"
          ? Effect.promise(() => {
            renewalStarted.resolve();
            return releaseRenewal.promise;
          }) as unknown as Effect.Effect<A, DatabaseFailure | E, R>
          : baseDatabase.withWriteLock(operation, effect),
      },
      runAttempt: () => Effect.promise(() => releaseAttempt.promise),
    });
    const running = Effect.runPromise(workflow.runAttempt(work));

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

  it("continues polling after recovery fails", async () => {
    await seedAttempt("queued");
    vi.useFakeTimers();
    const database = databaseFor(testDb.db);
    let failNext = true;
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const { workflow } = harness({ intervalMs: 5_000, database: {
      ...database,
      withWriteLock: (operation, effect) => operation === "durable-images.recover" && failNext
        ? (failNext = false, Effect.fail(new DatabaseFailure({ operation, cause: "failed poll" })))
        : database.withWriteLock(operation, effect),
    } });
    try {
      await Effect.runPromise(workflow.start());
      expect(report).toHaveBeenCalledOnce();
      expect((await readAttempt()).status).toBe("queued");
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(async () => expect((await readAttempt()).status).toBe("ready"));
    } finally { await Effect.runPromise(workflow.stop()); }
  });
});

describe("DurableImageWorkflow", () => {
  it("finishes a claimed attempt after stop without admitting queued work", async () => {
    await testDb.db.insert(drafts).values({
      id: "creation-1",
      userId: "ada",
      clientRequestId: "request-1",
      deckId: "ada-deck",
      sourceText: "hello",
      status: "ready",
    });
    await testDb.db.insert(creationImageAttempts).values([
      {
        id: "active",
        userId: "ada",
        creationId: "creation-1",
        prompt: "active image",
        status: "generating",
        leaseOwner: "other-worker",
        leaseExpiresAt: new Date(60_000),
      },
      {
        id: "queued",
        userId: "ada",
        creationId: "creation-1",
        prompt: "queued image",
        status: "queued",
      },
      {
        id: "queued-second", userId: "ada", creationId: "creation-1", prompt: "must stay queued", status: "queued",
      },
    ]);
    const release = Promise.withResolvers<void>();
    const { workflow } = harness({
      database: databaseFor(testDb.db),
      leaseOwner: "test-worker",
      runAttempt: (work) => Effect.promise(async () => {
        await release.promise;
        await testDb.db.update(creationImageAttempts).set({
          status: "ready",
          leaseOwner: null,
          leaseExpiresAt: null,
        }).where(eq(creationImageAttempts.id, work.attemptId));
      }),
    });

    await Effect.runPromise(workflow.start());
    await expect.poll(async () => (await testDb.db.select().from(creationImageAttempts)
      .where(eq(creationImageAttempts.id, "queued")))[0]?.status).toBe("generating");

    await Effect.runPromise(workflow.stop());
    release.resolve();

    await expect.poll(async () => (await testDb.db.select().from(creationImageAttempts)
      .where(eq(creationImageAttempts.id, "queued")))[0]?.status).toBe("ready");
    expect((await testDb.db.select().from(creationImageAttempts)
      .where(eq(creationImageAttempts.id, "active")))[0]?.status).toBe("generating");
    await Effect.runPromise(workflow.kick());
    expect((await readAttempt("queued-second"))).toMatchObject({ status: "queued", leaseOwner: null });
  });

  it("claims a ready draft image while transferring it to a note", async () => {
    await testDb.db.insert(drafts).values({
      id: "creation-transfer", userId: "ada", clientRequestId: "request-transfer",
      deckId: "ada-deck", sourceText: "hello", status: "ready",
      imageAttemptId: "ready-attempt", imageStatus: "ready", draftImageId: "draft-image",
    });
    await testDb.db.insert(creationImageAttempts).values({
      id: "ready-attempt", userId: "ada", creationId: "creation-transfer", prompt: "image",
      status: "ready", draftImageId: "draft-image",
    });
    const [note] = await testDb.db.insert(notes).values({
      userId: "ada", deckId: "ada-deck", sourceText: "saved", domain: "concept", metadata: {},
    }).returning();
    const { workflow } = harness({
      database: databaseFor(testDb.db),
      media: {
        writeDraftImage: () => Effect.die("not used"),
        claimDraftImage: (_userId, _draftImageId, noteId) => Effect.succeed(`ada/${noteId}.png`),
        removeDraftImage: () => Effect.void,
        removeImage: () => Effect.void,
      },
    });

    await expect(Effect.runPromise(workflow.transfer({
      creationId: "creation-transfer", imageAttemptId: "ready-attempt", noteId: note.id, userId: "ada",
    }))).resolves.toEqual({ kind: "ready", imagePath: `ada/${note.id}.png` });
  });

  it("settles generated bytes as a ready draft image", async () => {
    await testDb.db.insert(drafts).values({
      id: "creation-settle", userId: "ada", clientRequestId: "request-settle",
      deckId: "ada-deck", sourceText: "hello", status: "ready", imageAttemptId: "settle-attempt", imageStatus: "queued",
    });
    await testDb.db.insert(creationImageAttempts).values({
      id: "settle-attempt", userId: "ada", creationId: "creation-settle", prompt: "image", status: "generating", leaseOwner: "worker",
    });
    const { workflow } = harness({
      database: databaseFor(testDb.db),
      provider: { generateImageBytes: () => Effect.succeed(new Uint8Array([1, 2, 3])) },
      media: {
        writeDraftImage: () => Effect.succeed("draft-image"),
        claimDraftImage: () => Effect.die("not used"),
        removeDraftImage: () => Effect.void,
        removeImage: () => Effect.void,
      },
    });
    await Effect.runPromise(workflow.runAttempt({ attemptId: "settle-attempt", userId: "ada", leaseOwner: "worker" }));
    expect((await testDb.db.select().from(drafts).where(eq(drafts.id, "creation-settle")))[0])
      .toMatchObject({ imageStatus: "ready", draftImageId: "draft-image" });
  });

  it("marks only the image failed when its provider fails", async () => {
    await testDb.db.insert(drafts).values({
      id: "creation-fail", userId: "ada", clientRequestId: "request-fail", deckId: "ada-deck",
      sourceText: "hello", status: "ready", imageAttemptId: "fail-attempt", imageStatus: "queued",
    });
    await testDb.db.insert(creationImageAttempts).values({
      id: "fail-attempt", userId: "ada", creationId: "creation-fail", prompt: "image", status: "generating", leaseOwner: "worker",
    });
    const { workflow } = harness({
      database: databaseFor(testDb.db),
      provider: { generateImageBytes: () => Effect.fail({ _tag: "ProviderFailure", provider: "test", operation: "image", message: "nope" } as never) },
      media: { writeDraftImage: () => Effect.die("not used"), claimDraftImage: () => Effect.die("not used"), removeDraftImage: () => Effect.void, removeImage: () => Effect.void },
    });
    await Effect.runPromise(Effect.catchAll(workflow.runAttempt({ attemptId: "fail-attempt", userId: "ada", leaseOwner: "worker" }), () => Effect.void));
    expect((await testDb.db.select().from(drafts).where(eq(drafts.id, "creation-fail")))[0])
      .toMatchObject({ status: "ready", imageStatus: "failed", errorCategory: "image_failed" });
    expect((await testDb.db.select().from(creationImageAttempts).where(eq(creationImageAttempts.id, "fail-attempt")))[0])
      .toMatchObject({ status: "failed", leaseOwner: null });
  });

  it("settles an in-flight transferred attempt on its note", async () => {
    await testDb.db.insert(drafts).values({ id: "creation-flight", userId: "ada", clientRequestId: "request-flight", deckId: "ada-deck", sourceText: "hello", status: "ready" });
    const [note] = await testDb.db.insert(notes).values({ userId: "ada", deckId: "ada-deck", sourceText: "saved", domain: "concept", metadata: {} }).returning();
    await testDb.db.insert(creationImageAttempts).values({ id: "flight-attempt", userId: "ada", noteId: note.id, prompt: "image", status: "generating", leaseOwner: "worker" });
    const { workflow } = harness({
      database: databaseFor(testDb.db), provider: { generateImageBytes: () => Effect.succeed(new Uint8Array([1])) },
      media: { writeDraftImage: () => Effect.succeed("draft-image"), claimDraftImage: (_user, _draft, noteId) => Effect.succeed(`ada/${noteId}.png`), removeDraftImage: () => Effect.void, removeImage: () => Effect.void },
    });
    await Effect.runPromise(workflow.runAttempt({ attemptId: "flight-attempt", userId: "ada", leaseOwner: "worker" }));
    expect((await testDb.db.select().from(notes).where(eq(notes.id, note.id)))[0]?.imagePath).toBe(`ada/${note.id}.png`);
    expect((await testDb.db.select().from(creationImageAttempts).where(eq(creationImageAttempts.id, "flight-attempt")))[0])
      .toMatchObject({ status: "ready", leaseOwner: null, draftImageId: null });
  });
});
