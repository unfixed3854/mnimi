import { Cause, Context, Effect, Exit, FiberRef, Layer, Runtime } from "effect";
import type * as CauseTypes from "effect/Cause";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../db/schema.ts";
import { ensureDatabaseDir } from "../db/url.ts";
import type { Db } from "../db/index.ts";
import type { ReadDb } from "../db/read-transaction.ts";
import { AppConfig } from "./config.ts";
import { DatabaseFailure } from "./errors.ts";
import { Logging } from "./logging.ts";
import {
  createWriteLock,
  withWriteLockContext,
  type WriteLock,
} from "../db/write-lock.ts";

export type DatabaseService = Readonly<{
  client: Client;
  db: Db;
  withWriteLock<A, E, R>(operation: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseFailure, R>;
  withWriteLockContext<A>(work: () => Promise<A>): Promise<A>;
  transaction<A, E, R>(operation: string, work: (tx: Db) => Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseFailure, R>;
  readSnapshot<A, E, R>(operation: string, read: (tx: ReadDb) => Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseFailure, R>;
}>;

export class Database extends Context.Tag("@mnimi/server/Database")<Database, DatabaseService>() {}

export type DatabaseLayerDependencies = Readonly<{
  createClient: (options: { url: string }) => Client;
  ensureDatabaseDir: (url: string) => void;
}>;

type DatabaseResource = {
  readonly client: Client;
  lock?: WriteLock;
};

const releaseDatabase = (resource: DatabaseResource) =>
  Effect.promise(async () => {
    const failures: DatabaseFailure[] = [];
    if (resource.lock) {
      try {
        await resource.lock.close();
      } catch (cause) {
        failures.push(new DatabaseFailure({ operation: "database.close", cause }));
      }
    }
    try {
      await resource.client.close();
    } catch (cause) {
      failures.push(new DatabaseFailure({ operation: "database.close", cause }));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Database close failed");
  });

const lockOwner = FiberRef.unsafeMake<WriteLock | undefined>(undefined);

const runQueued = <A, E, R>(
  operation: string,
  lock: WriteLock,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseFailure, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const owner = yield* FiberRef.get(lockOwner);
      if (owner === lock) {
        return yield* Effect.fail(new DatabaseFailure({
          operation,
          cause: new Error("nested database write lock acquisition"),
        }));
      }
      const runInLock = Effect.gen(function* () {
        const runtime = yield* Effect.runtime<R>();
        const exit = yield* Effect.tryPromise({
          try: () => lock.withWriteLock(() => Runtime.runPromiseExit(runtime, restore(work))),
          catch: (cause) => new DatabaseFailure({ operation, cause }),
        });
        return yield* Exit.matchEffect(exit, {
          onFailure: Effect.failCause,
          onSuccess: Effect.succeed,
        });
      });
      return yield* Effect.locally(runInLock, lockOwner, lock);
    }),
  );

type CallbackFailure = {
  readonly _tag: typeof callbackFailureTag;
  readonly cause: CauseTypes.Cause<unknown>;
};

const callbackFailureTag = Symbol("DatabaseCallbackFailure");

const isCallbackFailure = (cause: unknown): cause is CallbackFailure =>
  typeof cause === "object" && cause !== null &&
  (cause as { readonly _tag?: unknown })._tag === callbackFailureTag;

type TransactionSuccess<A> = {
  readonly _tag: "success";
  readonly value: A;
};

const runTransaction = <A, E, R>(
  operation: string,
  service: Pick<DatabaseService, "db">,
  lock: WriteLock,
  work: (tx: Db) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseFailure, R> =>
  runQueued(operation, lock, Effect.gen(function* () {
    const runtime = yield* Effect.runtime<R>();
    const result = yield* Effect.either(Effect.tryPromise({
      try: async (): Promise<TransactionSuccess<A>> => ({
        _tag: "success",
        value: await service.db.transaction(async (tx) => {
          const exit = await Runtime.runPromiseExit(runtime, work(tx as unknown as Db));
          if (Exit.isFailure(exit)) {
            throw {
              _tag: callbackFailureTag,
              cause: exit.cause,
            } satisfies CallbackFailure;
          }
          return exit.value;
        }),
      }),
      catch: (cause) => new DatabaseFailure({ operation, cause }),
    }));
    if (result._tag === "Left") {
      const failure = result.left;
      if (isCallbackFailure(failure.cause)) {
        return yield* Effect.failCause(failure.cause.cause as CauseTypes.Cause<E>);
      }
      return yield* Effect.fail(failure);
    }
    return result.right.value;
  }));

const readSnapshot = <A, E, R>(
  operation: string,
  service: Pick<DatabaseService, "client">,
  read: (tx: ReadDb) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseFailure, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const transaction = yield* Effect.tryPromise({
        try: () => service.client.transaction("read"),
        catch: (cause) => new DatabaseFailure({ operation, cause }),
      });
      const close = Effect.tryPromise({
        try: async () => { await transaction.close(); },
        catch: (cause) => new DatabaseFailure({ operation, cause }),
      });
      const use = Effect.gen(function* () {
        const transactionDb = yield* Effect.try({
          try: () => drizzle({
            client: transaction as unknown as Client,
            schema,
          }) as unknown as ReadDb,
          catch: (cause) => new DatabaseFailure({ operation, cause }),
        });
        const runtime = yield* Effect.runtime<R>();
        const exit = yield* Effect.tryPromise({
          try: () => Runtime.runPromiseExit(runtime, restore(read(transactionDb))),
          catch: (cause) => new DatabaseFailure({ operation, cause }),
        });
        return yield* Exit.matchEffect(exit, {
          onFailure: Effect.failCause,
          onSuccess: (value) => Effect.zipRight(
            restore(Effect.yieldNow()),
            Effect.as(
              Effect.tryPromise({
                try: () => transaction.commit(),
                catch: (cause) => new DatabaseFailure({ operation, cause }),
              }),
              value,
            ),
          ),
        });
      });
      const useExit = yield* Effect.exit(use);
      const closeExit = yield* Effect.exit(close);
      if (Exit.isFailure(useExit) && Exit.isFailure(closeExit)) {
        return yield* Effect.failCause(Cause.sequential(useExit.cause, closeExit.cause));
      }
      if (Exit.isFailure(closeExit)) {
        return yield* Effect.failCause(closeExit.cause);
      }
      return yield* Exit.matchEffect(useExit, {
        onFailure: Effect.failCause,
        onSuccess: Effect.succeed,
      });
    }),
  );

export function makeDatabaseLayer(
  dependencies: Partial<DatabaseLayerDependencies> = {},
): Layer.Layer<Database, DatabaseFailure, AppConfig | Logging> {
  const resolved: DatabaseLayerDependencies = {
    createClient: (options) => createClient(options),
    ensureDatabaseDir,
    ...dependencies,
  };

  const acquireDatabase = Effect.gen(function* () {
    const config = yield* AppConfig;
    yield* Logging;
    const url = config.database.url;
    yield* Effect.try({
      try: () => resolved.ensureDatabaseDir(url),
      catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
    });
    const resource = yield* Effect.acquireRelease(
      Effect.try({
        try: (): DatabaseResource => ({ client: resolved.createClient({ url }) }),
        catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
      }),
      releaseDatabase,
    );
    for (const pragma of [
      "PRAGMA journal_mode = WAL",
      "PRAGMA busy_timeout = 5000",
      "PRAGMA foreign_keys = ON",
    ]) {
      yield* Effect.tryPromise({
        try: () => resource.client.execute(pragma),
        catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
      });
    }
    const db = yield* Effect.try({
      try: () => drizzle({ client: resource.client, schema }),
      catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
    });
    const lock = yield* Effect.try({
      try: () => createWriteLock(),
      catch: (cause) => new DatabaseFailure({ operation: "database.acquire", cause }),
    });
    resource.lock = lock;
    const service: DatabaseService = {
      client: resource.client,
      db,
      withWriteLock: (operation, work) => runQueued(operation, lock, work),
      withWriteLockContext: (work) => withWriteLockContext(lock, work),
      transaction: (operation, work) => runTransaction(operation, { db }, lock, work),
      readSnapshot: (operation, read) => readSnapshot(operation, { client: resource.client }, read),
    };
    return service;
  });

  return Layer.scoped(Database, acquireDatabase);
}

export const DatabaseLive: Layer.Layer<Database, DatabaseFailure, AppConfig | Logging> =
  makeDatabaseLayer();
