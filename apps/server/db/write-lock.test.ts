import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./testing.ts";
import { decks, user } from "./schema.ts";
import {
  createWriteLock,
  type WriteLock,
  withWriteLock,
  withWriteLockContext,
} from "./write-lock.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  t = await createTestDb();
  await t.db.insert(user).values({
    id: "u1",
    name: "Ada",
    email: "ada@example.com",
  });
});

afterEach(() => t.close());

// Each transaction below signals once it is open and stays open until
// released. That is the only reliable way to make two of them genuinely
// overlap: firing two procedures with `Promise.all` does not do it — their
// transactions are short enough that the second reliably starts after the
// first has committed, so such a test passes with or without the lock.
describe("withWriteLock", () => {
  it("lets a second write transaction succeed while the first is open", async () => {
    let signalOpen!: () => void;
    const firstIsOpen = new Promise<void>((resolve) => (signalOpen = resolve));
    let release!: () => void;
    const firstIsHeld = new Promise<void>((resolve) => (release = resolve));

    const first = withWriteLock(() =>
      t.db.transaction(async (tx) => {
        await tx.insert(decks).values({ userId: "u1", name: "first" });
        signalOpen();
        await firstIsHeld;
      })
    );

    await firstIsOpen;

    // Queued behind `first`, so it cannot start until `first` commits — which
    // is why the release has to be scheduled independently rather than after
    // awaiting `second`.
    const second = withWriteLock(() =>
      t.db.transaction(async (tx) => {
        await tx.insert(decks).values({ userId: "u1", name: "second" });
      })
    );
    setTimeout(release, 20);

    await expect(Promise.all([first, second])).resolves.toBeDefined();

    const rows = await t.db.select().from(decks);
    expect(rows.map((row) => row.name).sort()).toEqual(["first", "second"]);
  });

  it("is what makes that work — the same overlap without it fails SQLITE_BUSY", async () => {
    // The control for the test above. Without it, that test would still pass
    // against a `withWriteLock` that did nothing at all, and the contention it
    // exists to rule out would go unmeasured.
    let signalOpen!: () => void;
    const firstIsOpen = new Promise<void>((resolve) => (signalOpen = resolve));
    let release!: () => void;
    const firstIsHeld = new Promise<void>((resolve) => (release = resolve));

    const first = t.db.transaction(async (tx) => {
      await tx.insert(decks).values({ userId: "u1", name: "first" });
      signalOpen();
      await firstIsHeld;
    });

    await firstIsOpen;

    const started = Date.now();
    const outcome = await t.db
      .transaction(async (tx) => {
        await tx.insert(decks).values({ userId: "u1", name: "second" });
      })
      .then(() => null, (error: unknown) => error);
    const elapsed = Date.now() - started;

    release();
    await first;

    expect(String(outcome)).toContain("SQLITE_BUSY");
    // Immediately, not after the 5000 ms `PRAGMA busy_timeout` in db/index.ts
    // appears to promise: that pragma never reached this connection.
    expect(elapsed).toBeLessThan(1000);
  });

  it("keeps running queued work after one job rejects", async () => {
    const failed = withWriteLock(() => Promise.reject(new Error("boom")));
    const after = withWriteLock(() =>
      t.db.transaction(async (tx) => {
        await tx.insert(decks).values({ userId: "u1", name: "after" });
      })
    );

    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBeUndefined();
    expect(await t.db.select().from(decks)).toHaveLength(1);
  });

  it("keeps running queued work after a synchronous callback throw", async () => {
    const failure = new Error("sync boom");
    let ranAfterFailure = false;
    const failed = withWriteLock(() => {
      throw failure;
    });
    const after = withWriteLock(async () => {
      ranAfterFailure = true;
    });

    await expect(failed).rejects.toBe(failure);
    await expect(after).resolves.toBeUndefined();
    expect(ranAfterFailure).toBe(true);
  });

  it("runs queued work in call order", async () => {
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2].map((n) =>
        withWriteLock(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10 - n * 4));
          order.push(n);
        })
      ),
    );
    expect(order).toEqual([0, 1, 2]);
  });

  it("closes once, fences new work, and waits for admitted work", async () => {
    const lock = createWriteLock();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted = lock.withWriteLock(async () => held);
    await Promise.resolve();
    const closing = lock.close();
    await expect(lock.withWriteLock(async () => undefined)).rejects.toThrow(
      "database write lock is closing",
    );
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await admitted;
    await closing;
    await expect(lock.close()).resolves.toBeUndefined();
  });

  it("uses the request-local lock without changing fallback callers", async () => {
    const calls: string[] = [];
    const lock = (name: string): WriteLock => ({
      withWriteLock: async (work) => {
        calls.push(`${name}.delegate`);
        return work();
      },
      close: async () => undefined,
    });
    await withWriteLockContext(lock("outer"), async () => {
      await withWriteLock(async () => undefined);
      await withWriteLockContext(lock("inner"), async () => {
        await withWriteLock(async () => undefined);
      });
      await withWriteLock(async () => undefined); // inner
    });
    await withWriteLock(async () => { calls.push("fallback.delegate"); });
    expect(calls).toEqual(["outer.delegate", "inner.delegate", "outer.delegate", "fallback.delegate"]);
  });

  it("keeps request-local lock through asynchronous callbacks", async () => {
    const calls: string[] = [];
    const lock = (name: string): WriteLock => ({
      withWriteLock: async (work) => {
        calls.push(`${name}.delegate`);
        return work();
      },
      close: async () => undefined,
    });
    await withWriteLockContext(lock("request"), async () => {
      await Promise.resolve();
      await withWriteLock(async () => undefined);
    });
    expect(calls).toEqual(["request.delegate"]);
  });
});
