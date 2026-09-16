import { Effect, Exit, Runtime } from "effect";
import type { Db } from "../db/index.ts";
import { withWriteLock } from "../db/write-lock.ts";
import type { ClaimedCreationWork } from "./scheduler.ts";
import {
  runDurableTextAttempt,
  type DurableTextAttemptDeps,
} from "../effect/durable-text-attempt.ts";
import {
  makeDurableTextWorkflow,
  type DurableTextDatabase,
} from "../effect/durable-text.ts";
import { DatabaseFailure } from "../effect/errors.ts";

type LegacyDurableTextAttemptDeps = Omit<DurableTextAttemptDeps, "database"> & {
  db: Db;
};

/** Adapts the pre-Effect global lock for the remaining Promise worker facade. */
function makeLegacyDatabase(db: Db): DurableTextDatabase {
  const queued = <A, E, R>(
    operation: string,
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DatabaseFailure, R> => Effect.gen(function* () {
    const runtime = yield* Effect.runtime<R>();
    const exit = yield* Effect.tryPromise({
      try: () => withWriteLock(() => Runtime.runPromiseExit(runtime, work)),
      catch: (cause) => new DatabaseFailure({ operation, cause }),
    });
    return yield* Exit.matchEffect(exit, {
      onFailure: Effect.failCause,
      onSuccess: Effect.succeed,
    });
  });

  const transaction = <A, E, R>(
    operation: string,
    work: (tx: Db) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DatabaseFailure, R> => Effect.gen(function* () {
    const runtime = yield* Effect.runtime<R>();
    const exit = yield* Effect.tryPromise({
      try: () => withWriteLock(() => db.transaction(async (tx) =>
        await Runtime.runPromiseExit(runtime, work(tx as unknown as Db)))),
      catch: (cause) => new DatabaseFailure({ operation, cause }),
    });
    return yield* Exit.matchEffect(exit, {
      onFailure: Effect.failCause,
      onSuccess: Effect.succeed,
    });
  });

  return {
    db,
    withWriteLock: queued,
    transaction,
  };
}

/**
 * Promise compatibility facade for callers that have not yet crossed the
 * durable-text Effect boundary. Production owns one workflow in `main.ts`.
 */
export async function runCreationAttempt(
  work: ClaimedCreationWork,
  deps: LegacyDurableTextAttemptDeps,
): Promise<void> {
  const database = makeLegacyDatabase(deps.db);
  const workflow = makeDurableTextWorkflow({
    database,
    heartbeatMs: deps.heartbeatMs,
    renewLease: deps.renewLease === undefined
      ? undefined
      : (claimed) => Effect.tryPromise({
        try: () => deps.renewLease!(deps.db, claimed),
        catch: (cause) => new DatabaseFailure({
          operation: "durable-text.renew-lease",
          cause,
        }),
      }),
    runAttempt: (claimed, lease) => runDurableTextAttempt(claimed, {
      ...deps,
      database,
      lease,
    }),
  });
  await Effect.runPromise(workflow.runAttempt(work));
}
