import { afterEach, describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
import { AppConfig, makeAppConfigLayer } from "./config.ts";
import { Database, makeDatabaseLayer } from "./database.ts";
import { DatabaseFailure } from "./errors.ts";
import { Logging } from "./logging.ts";
import { makeTestRuntime, testService } from "./testing.ts";
import * as schema from "../db/schema.ts";

const logging = testService(Logging, { getLogger: () => ({ error() {} }) as never });
const config = makeAppConfigLayer({ env: { DATABASE_URL: "file::memory:" }, argv: [] });
const fakeClient = {
  execute: async () => ({ rows: [] }),
  transaction: async () => ({
    execute: async () => ({ rows: [] }),
    commit: async () => {},
    rollback: async () => {},
    close: async () => {},
  }),
  close: () => {},
};

function makeDatabaseTestRuntime(onClientClose: () => void = () => {}) {
  const layer = makeDatabaseLayer({
    createClient: () => ({ ...fakeClient, close: onClientClose }) as never,
    ensureDatabaseDir: () => {},
  }).pipe(Layer.provide(Layer.mergeAll(config, logging)));
  return makeTestRuntime(layer);
}

afterEach(() => {
  vi.doUnmock("../db/write-lock.ts");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Database", () => {
  it("acquires one client and Drizzle handle in exact order and closes once", async () => {
    const events: string[] = [];
    const client = {
      execute: async (statement: string) => { events.push(statement); return { rows: [] }; },
      transaction: async () => { throw new Error("not a read test"); },
      close: () => { events.push("close"); },
    };
    const runtime = makeTestRuntime(makeDatabaseLayer({
      createClient: () => { events.push("client"); return client as never; },
      ensureDatabaseDir: (url) => { events.push(`dir:${url}`); },
    }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
    const service = await runtime.runPromise(Effect.gen(function* () { return yield* Database; }));
    expect(service.client).toBe(client);
    expect(events.slice(0, 5)).toEqual([
      "dir:file::memory:", "client", "PRAGMA journal_mode = WAL",
      "PRAGMA busy_timeout = 5000", "PRAGMA foreign_keys = ON",
    ]);
    await runtime.dispose();
    expect(events.at(-1)).toBe("close");
    expect(events.filter((event) => event === "close")).toHaveLength(1);
  });

  it("closes the client when the first PRAGMA rejects before lock acquisition", async () => {
    vi.resetModules();
    const events: string[] = [];
    const createWriteLock = vi.fn(() => ({
      withWriteLock: async (work: () => Promise<unknown>) => work(),
      close: async () => undefined,
    }));
    vi.doMock("../db/write-lock.ts", () => ({
      createWriteLock,
      withWriteLockContext: <A>(_lock: unknown, work: () => Promise<A>) => work(),
    }));

    const { makeAppConfigLayer: makeDynamicConfigLayer } = await import("./config.ts");
    const { DatabaseFailure: DynamicDatabaseFailure } = await import("./errors.ts");
    const { Logging: DynamicLogging } = await import("./logging.ts");
    const {
      Database: DynamicDatabase,
      makeDatabaseLayer: makeDynamicDatabaseLayer,
    } = await import("./database.ts");
    const pragmaError = new Error("journal mode failed");
    const client = {
      execute: vi.fn(async (statement: string) => { events.push(statement); throw pragmaError; }),
      transaction: vi.fn(),
      close: vi.fn(async () => { events.push("client.close"); }),
    };
    const runtime = makeTestRuntime(makeDynamicDatabaseLayer({
      createClient: () => { events.push("client.create"); return client as never; },
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(
      makeDynamicConfigLayer({ env: { DATABASE_URL: "file::memory:" }, argv: [] }),
      Layer.succeed(DynamicLogging, { getLogger: () => ({ error() {} }) as never }),
    ))));
    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      return yield* DynamicDatabase;
    }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const failure = exit.cause.error as DatabaseFailure;
      expect(failure).toBeInstanceOf(DynamicDatabaseFailure);
      expect(failure.operation).toBe("database.acquire");
      expect(failure.cause).toBe(pragmaError);
    }
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(createWriteLock).not.toHaveBeenCalled();
    expect(events).toEqual(["client.create", "PRAGMA journal_mode = WAL", "client.close"]);
    await runtime.dispose();
  });

  async function runReadCase(callback: Effect.Effect<unknown, Error>, commit: () => Promise<void>) {
    const events: string[] = [];
    const tx = {
      execute: vi.fn(async () => ({ rows: [] })),
      commit: vi.fn(async () => { events.push("commit"); await commit(); }),
      rollback: vi.fn(),
      close: vi.fn(async () => { events.push("close"); }),
    };
    const client = {
      execute: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async (mode: "read") => { events.push(mode); return tx; }),
      close: vi.fn(),
    };
    const layer = makeDatabaseLayer({
      createClient: () => client as never,
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(config, logging)));
    const runtime = makeTestRuntime(layer);
    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.readSnapshot("read.test", () => callback);
    }));
    await runtime.dispose();
    return { exit, events, tx, client };
  }

  it("commits a successful read before closing", async () => {
    const result = await runReadCase(Effect.succeed("ok"), async () => undefined);
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.events).toEqual(["read", "commit", "close"]);
    expect(result.tx.rollback).not.toHaveBeenCalled();
  });

  it("closes a callback failure without committing and preserves it", async () => {
    const error = new Error("callback failed");
    const result = await runReadCase(Effect.fail(error), async () => undefined);
    expect(Exit.isFailure(result.exit) && result.exit.cause._tag === "Fail" && result.exit.cause.error).toBe(error);
    expect(result.events).toEqual(["read", "close"]);
    expect(result.tx.commit).not.toHaveBeenCalled();
  });

  it("closes a commit failure and preserves the commit error", async () => {
    const error = new Error("commit failed");
    const result = await runReadCase(Effect.succeed("ok"), async () => { throw error; });
    expect(Exit.isFailure(result.exit)).toBe(true);
    if (Exit.isFailure(result.exit) && result.exit.cause._tag === "Fail") {
      const failure = result.exit.cause.error as DatabaseFailure;
      expect(failure).toBeInstanceOf(DatabaseFailure);
      expect(failure.operation).toBe("read.test");
      expect(failure.cause).toBe(error);
    }
    expect(result.events).toEqual(["read", "commit", "close"]);
  });

  it("interrupts a readSnapshot only after its transaction closes", async () => {
    const events: string[] = [];
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const tx = {
      commit: vi.fn(async () => { events.push("commit"); }),
      rollback: vi.fn(), close: vi.fn(async () => { events.push("close"); }),
    };
    const client = {
      execute: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async (mode: "read") => { events.push(mode); return tx; }),
      close: vi.fn(),
    };
    const runtime = makeTestRuntime(makeDatabaseLayer({
      createClient: () => client as never, ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
    const fiber = runtime.runFork(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.readSnapshot("read.interrupted", () => Effect.promise(() => {
        started.resolve();
        return gate.promise;
      }));
    }));
    await started.promise;
    const interrupted = runtime.runPromise(Fiber.interrupt(fiber));
    let settled = false;
    void interrupted.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(tx.close).not.toHaveBeenCalled();
    gate.resolve();
    await interrupted;
    const exit = await runtime.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    expect(events).toEqual(["read", "close"]);
    expect(tx.commit).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("maps read transaction open failures to the supplied operation", async () => {
    const openError = new Error("read transaction open failed");
    const client = {
      execute: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async () => { throw openError; }),
      close: vi.fn(),
    };
    const runtime = makeTestRuntime(makeDatabaseLayer({
      createClient: () => client as never,
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.readSnapshot("read.open", () => Effect.succeed("ok"));
    }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(DatabaseFailure);
      expect(exit.cause.error.operation).toBe("read.open");
      expect(exit.cause.error.cause).toBe(openError);
    }
    await runtime.dispose();
  });

  it("maps read transaction close failures after a successful callback", async () => {
    const closeError = new Error("read transaction close failed");
    const transaction = {
      execute: vi.fn(async () => ({ rows: [] })),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(),
      close: vi.fn(async () => { throw closeError; }),
    };
    const client = {
      execute: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async () => transaction),
      close: vi.fn(),
    };
    const runtime = makeTestRuntime(makeDatabaseLayer({
      createClient: () => client as never,
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.readSnapshot("read.close", () => Effect.succeed("ok"));
    }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(DatabaseFailure);
      expect(exit.cause.error.operation).toBe("read.close");
      expect(exit.cause.error.cause).toBe(closeError);
    }
    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(transaction.close).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it("serializes FIFO writes and rejects a nested acquisition", async () => {
    const runtime = makeDatabaseTestRuntime();
    const database = await runtime.runPromise(Effect.gen(function* () { return yield* Database; }));
    const order: string[] = [];
    const first = runtime.runPromise(database.withWriteLock("first", Effect.promise(async () => {
      order.push("first"); await Promise.resolve();
    })));
    const second = runtime.runPromise(database.withWriteLock("second", Effect.sync(() => { order.push("second"); })));
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    const nested = await runtime.runPromiseExit(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.withWriteLock("outer", database.withWriteLock("inner", Effect.succeed("bad")));
    }));
    expect(Exit.isFailure(nested) && nested.cause._tag === "Fail" ? nested.cause.error : undefined).toMatchObject({
      operation: "inner",
      cause: expect.objectContaining({ message: "nested database write lock acquisition" }),
    });
    await runtime.dispose();
  });

  it("fences new writes while Database disposal drains the admitted callback", async () => {
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const runtime = makeDatabaseTestRuntime(() => { events.push("client.close"); });
    const database = await runtime.runPromise(Effect.gen(function* () { return yield* Database; }));
    const admitted = Effect.runPromise(database.withWriteLock("held", Effect.promise(() => {
      started.resolve();
      return gate.promise;
    })));
    await started.promise;
    const closing = runtime.dispose();
    const late = await Effect.runPromiseExit(database.withWriteLock("late", Effect.succeed("not admitted")));
    expect(Exit.isFailure(late) && late.cause._tag === "Fail" ? late.cause.error : undefined).toMatchObject({
      operation: "late", cause: expect.objectContaining({ message: "database write lock is closing" }),
    });
    expect(events).toEqual([]);
    gate.resolve();
    await admitted;
    await closing;
    expect(events).toEqual(["client.close"]);
  });

  it("preserves a transaction callback failure and releases its queue slot", async () => {
    const events: string[] = [];
    const callbackError = new Error("transaction callback failed");
    const transaction = {
      execute: vi.fn(async () => ({ rows: [] })),
      commit: vi.fn(async () => { events.push("commit"); }),
      rollback: vi.fn(async () => { events.push("rollback"); }),
      close: vi.fn(async () => { events.push("close"); }),
    };
    const client = {
      execute: vi.fn(async (statement: unknown) => { events.push(String(statement)); return { rows: [] }; }),
      transaction: vi.fn(async () => { events.push("transaction"); return transaction; }),
      close: vi.fn(),
    };
    const runtime = makeTestRuntime(makeDatabaseLayer({
      createClient: () => client as never,
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.transaction("transaction.test", () => Effect.fail(callbackError));
    }));
    expect(Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error).toBe(callbackError);
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toEqual(["transaction", "rollback"]);

    const afterFailure = await runtime.runPromise(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.withWriteLock("after-failure", Effect.succeed("ok"));
    }));
    expect(afterFailure).toBe("ok");
    await runtime.dispose();
  });

  it("maps transaction commit failures to the supplied operation", async () => {
    const commitError = new Error("transaction commit failed");
    const transaction = {
      execute: vi.fn(async () => ({ rows: [] })),
      commit: vi.fn(async () => { throw commitError; }),
      rollback: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const client = {
      execute: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async () => transaction),
      close: vi.fn(),
    };
    const runtime = makeTestRuntime(makeDatabaseLayer({
      createClient: () => client as never,
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.transaction("transaction.commit", () => Effect.succeed("ok"));
    }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(DatabaseFailure);
      expect(exit.cause.error.operation).toBe("transaction.commit");
      expect(exit.cause.error.cause).toBe(commitError);
    }
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  it("maps transaction open failures to the supplied operation", async () => {
    const openError = new Error("write transaction open failed");
    const client = {
      execute: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async () => { throw openError; }),
      close: vi.fn(),
    };
    const runtime = makeTestRuntime(makeDatabaseLayer({
      createClient: () => client as never,
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.transaction("transaction.open", () => Effect.succeed("ok"));
    }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(DatabaseFailure);
      expect(exit.cause.error.operation).toBe("transaction.open");
      expect(exit.cause.error.cause).toBe(openError);
    }
    await runtime.dispose();
  });

  it("leaves direct Drizzle compatibility writes outside the scoped queue", async () => {
    const events: unknown[] = [];
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const client = {
      execute: vi.fn(async (statement: unknown) => { events.push(statement); return { rows: [] }; }),
      transaction: vi.fn(async () => ({
        execute: async () => ({ rows: [] }),
        commit: async () => {}, rollback: async () => {}, close: async () => {},
      })),
      close: vi.fn(),
    };
    const runtime = makeTestRuntime(makeDatabaseLayer({
      createClient: () => client as never,
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(config, logging))));
    const database = await runtime.runPromise(Effect.gen(function* () { return yield* Database; }));
    const held = Effect.runPromise(database.withWriteLock("held", Effect.promise(() => {
      started.resolve();
      return gate.promise;
    })));
    await started.promise;
    await database.db.insert(schema.user).values({
      id: "compat-user",
      name: "Compat User",
      email: "compat@example.com",
    }).run();
    expect(events.some((statement) => typeof statement === "object" && statement !== null &&
      "sql" in statement && String((statement as { sql: unknown }).sql).toLowerCase().includes("insert into"))).toBe(true);
    gate.resolve();
    await held;
    await runtime.dispose();
  });

  it("settles an interrupted waiter only after the admitted callback releases", async () => {
    const gate = Promise.withResolvers<void>();
    const admittedStarted = Promise.withResolvers<void>();
    const runtime = makeDatabaseTestRuntime();
    const admittedFiber = runtime.runFork(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.withWriteLock("held", Effect.promise(() => {
        admittedStarted.resolve();
        return gate.promise;
      }));
    }));
    await admittedStarted.promise;
    const waiterFiber = runtime.runFork(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.withWriteLock("waiter", Effect.succeed("done"));
    }));
    const interrupted = runtime.runPromise(Fiber.interrupt(waiterFiber));
    let settled = false;
    void interrupted.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await runtime.runPromise(Fiber.interrupt(admittedFiber));
    await interrupted;
    const exit = await runtime.runPromise(Fiber.await(waiterFiber));
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    await runtime.dispose();
  });

  it("interrupts an in-flight libSQL write but still closes its queue slot", async () => {
    const gate = Promise.withResolvers<void>();
    const runningStarted = Promise.withResolvers<void>();
    const runtime = makeDatabaseTestRuntime();
    const runningFiber = runtime.runFork(Effect.gen(function* () {
      const database = yield* Database;
      return yield* database.withWriteLock("write", Effect.promise(() => {
        runningStarted.resolve();
        return gate.promise;
      }));
    }));
    await runningStarted.promise;
    const running = runtime.runPromise(Fiber.interrupt(runningFiber));
    let settled = false;
    void running.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await running;
    const exit = await runtime.runPromise(Fiber.await(runningFiber));
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    await runtime.dispose();
  });

  it("reports a tagged queue-close defect and still closes the client", async () => {
    vi.resetModules();
    vi.doMock("../db/write-lock.ts", async () => {
      const actual = await vi.importActual<typeof import("../db/write-lock.ts")>("../db/write-lock.ts");
      return { ...actual, createWriteLock: () => ({
        withWriteLock: (work: () => Promise<unknown>) => work(),
        close: async () => { throw new Error("queue close failed"); },
      }) };
    });
    const { makeAppConfigLayer: makeDynamicConfigLayer } = await import("./config.ts");
    const { Logging: DynamicLogging } = await import("./logging.ts");
    const { makeDatabaseLayer: makeDynamicDatabaseLayer, Database: DynamicDatabase } = await import("./database.ts");
    const events: string[] = [];
    const runtime = makeTestRuntime(makeDynamicDatabaseLayer({
      createClient: () => ({ ...fakeClient, close: () => { events.push("client.close"); } }) as never,
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(
      makeDynamicConfigLayer({ env: { DATABASE_URL: "file::memory:" }, argv: [] }),
      Layer.succeed(DynamicLogging, { getLogger: () => ({ error() {} }) as never }),
    ))));
    await runtime.runPromise(Effect.gen(function* () { return yield* DynamicDatabase; }));
    const exit = await Effect.runPromiseExit(runtime.disposeEffect);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect([...Cause.defects(exit.cause)]).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: "database.close", cause: expect.any(Error) }),
      ]));
    }
    expect(events).toEqual(["client.close"]);
  });

  it("retains tagged client-close and queue-close defects together", async () => {
    vi.resetModules();
    vi.doMock("../db/write-lock.ts", () => ({
      createWriteLock: () => ({
        withWriteLock: (work: () => Promise<unknown>) => work(),
        close: async () => { throw new Error("queue close failed"); },
      }),
      withWriteLockContext: <A>(_lock: unknown, work: () => Promise<A>) => work(),
    }));
    const { makeAppConfigLayer: makeDynamicConfigLayer } = await import("./config.ts");
    const { Logging: DynamicLogging } = await import("./logging.ts");
    const { makeDatabaseLayer: makeDynamicDatabaseLayer, Database: DynamicDatabase } = await import("./database.ts");
    const runtime = makeTestRuntime(makeDynamicDatabaseLayer({
      createClient: () => ({ ...fakeClient, close: async () => { throw new Error("client close failed"); } }) as never,
      ensureDatabaseDir: () => {},
    }).pipe(Layer.provide(Layer.mergeAll(
      makeDynamicConfigLayer({ env: { DATABASE_URL: "file::memory:" }, argv: [] }),
      Layer.succeed(DynamicLogging, { getLogger: () => ({ error() {} }) as never }),
    ))));
    await runtime.runPromise(Effect.gen(function* () { return yield* DynamicDatabase; }));
    const exit = await Effect.runPromiseExit(runtime.disposeEffect);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defects = [...Cause.defects(exit.cause)];
      expect(defects).toHaveLength(1);
      expect(defects[0]).toBeInstanceOf(AggregateError);
      expect((defects[0] as AggregateError).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: "database.close", cause: expect.objectContaining({ message: "queue close failed" }) }),
        expect.objectContaining({ operation: "database.close", cause: expect.objectContaining({ message: "client close failed" }) }),
      ]));
    }
  });
});
