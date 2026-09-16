import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { Effect, SynchronizedRef } from "effect";
import { uuidv7 } from "uuidv7";
import type { CreationModelCalls } from "../ai/model-calls.ts";
import { drafts } from "../db/schema.ts";
import type { DraftOperation, DraftStatus } from "../db/schema.ts";
import type { DatabaseService } from "./database.ts";
import { runDurableTextAttempt } from "./durable-text-attempt.ts";
import { DatabaseFailure, MediaFailure, ProviderFailure } from "./errors.ts";
import { makeBackgroundFibers } from "./background-fibers.ts";

const ACTIVE_STATUSES: DraftStatus[] = [
  "routing",
  "generating",
  "adjusting",
  "regenerating",
];

export type DurableTextWorkflowService = Readonly<{
  readonly recover: (
    now: Date,
    options: { readonly allLeases?: boolean; readonly includeUnleased?: boolean },
  ) => Effect.Effect<number, DatabaseFailure>;
  readonly start: () => Effect.Effect<void>;
  readonly kick: (userId: string) => Effect.Effect<void, never>;
  readonly runAttempt: (
    work: ClaimedCreationWork,
  ) => Effect.Effect<void, DatabaseFailure | ProviderFailure | MediaFailure>;
  readonly stop: () => Effect.Effect<void>;
  readonly settle: () => Effect.Effect<void>;
}>;

export type ClaimedCreationWork = Readonly<{
  creationId: string;
  userId: string;
  attemptId: string;
  leaseOwner: string;
  operation: DraftOperation;
}>;

/** One executing attempt's identity, serialized with lease renewal and retry rotation. */
export type DurableTextAttemptLease = SynchronizedRef.SynchronizedRef<ClaimedCreationWork>;

/** The direct database boundary consumed by the durable text workflow. */
export type DurableTextDatabase = Pick<
  DatabaseService,
  "db" | "withWriteLock" | "transaction"
>;

type DurableTextWorkflowOptions = Readonly<{
  database: DurableTextDatabase;
  models?: CreationModelCalls;
  nextId?: () => string;
  notify?: (userId: string, creationId: string) => void;
  renewLease?: (work: ClaimedCreationWork) => Effect.Effect<boolean, DatabaseFailure>;
  runAttempt?: (
    work: ClaimedCreationWork,
    lease: DurableTextAttemptLease,
  ) => Effect.Effect<void, DatabaseFailure | ProviderFailure | MediaFailure>;
  intervalMs?: number;
  heartbeatMs?: number;
  leaseOwner?: string;
  now?: () => Date;
}>;

function databaseEffect<A>(
  operation: string,
  work: () => Promise<A>,
): Effect.Effect<A, DatabaseFailure> {
  return Effect.tryPromise({
    try: work,
    catch: (cause) => new DatabaseFailure({ operation, cause }),
  });
}

export function makeDurableTextWorkflow(
  options: DurableTextWorkflowOptions,
): DurableTextWorkflowService {
  const { db } = options.database;
  const leaseOwner = options.leaseOwner ?? uuidv7();
  const models = options.models;
  const runAttempt = options.runAttempt ?? ((work: ClaimedCreationWork, lease: DurableTextAttemptLease) =>
    models === undefined
      ? Effect.die("DurableTextWorkflow has no attempt executor")
      : runDurableTextAttempt(work, {
        database: options.database,
        models,
        lease,
        nextId: options.nextId,
        notify: options.notify,
        // The workflow's tracked fiber schedules the next drain exactly once.
        kick: () => {},
      }));
  const draining = new Set<string>();
  const pending = new Set<string>();
  const fibers = makeBackgroundFibers();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const now = () => options.now?.() ?? new Date();

  const claim = (userId: string): Effect.Effect<ReadonlyArray<ClaimedCreationWork>, DatabaseFailure> =>
    options.database.transaction("durable-text.claim", (tx) => databaseEffect(
      "durable-text.claim",
      async () => {
      if (stopped) return [];
      const current = now();
      const leaseExpiresAt = new Date(current.getTime() + 90_000);
      const [active] = await tx
        .select({ value: count() })
        .from(drafts)
        .where(and(
          eq(drafts.userId, userId),
          inArray(drafts.status, ACTIVE_STATUSES),
          isNotNull(drafts.leaseOwner),
        ));
      const available = Math.max(0, 2 - Number(active?.value ?? 0));
      if (stopped || available === 0) return [];

      const candidates = await tx
        .select({ id: drafts.id, operation: drafts.operation })
        .from(drafts)
        .where(and(
          eq(drafts.userId, userId),
          eq(drafts.status, "queued"),
          isNull(drafts.activeAttemptId),
          isNull(drafts.leaseOwner),
          isNotNull(drafts.operation),
        ))
        .orderBy(asc(drafts.queuedAt), asc(drafts.id))
        .limit(available);

      const claimed: ClaimedCreationWork[] = [];
      for (const candidate of candidates) {
        if (stopped) break;
        const operation = candidate.operation as DraftOperation;
        const attemptId = uuidv7();
        const status = operation === "route_generate"
          ? "routing"
          : operation === "adjust"
          ? "adjusting"
          : operation === "regenerate"
          ? "regenerating"
          : "generating";
        const rows = await tx.update(drafts).set({
          status,
          activeAttemptId: attemptId,
          leaseOwner,
          leaseExpiresAt,
          updatedAt: current,
        }).where(and(
          eq(drafts.id, candidate.id),
          eq(drafts.userId, userId),
          eq(drafts.status, "queued"),
          isNull(drafts.activeAttemptId),
          isNull(drafts.leaseOwner),
        )).returning({ id: drafts.id });
        if (rows.length === 1) {
          claimed.push({
            creationId: candidate.id,
            userId,
            attemptId,
            leaseOwner,
            operation,
          });
        }
      }
      return claimed;
    },
  ));

  const renewLease = options.renewLease ?? ((
    work: ClaimedCreationWork,
  ): Effect.Effect<boolean, DatabaseFailure> => options.database.withWriteLock(
    "durable-text.renew-lease",
    databaseEffect("durable-text.renew-lease", async () => {
      const current = now();
      const rows = await db.update(drafts).set({
        leaseExpiresAt: new Date(current.getTime() + 90_000),
        updatedAt: current,
      }).where(and(
        eq(drafts.id, work.creationId),
        eq(drafts.userId, work.userId),
        eq(drafts.activeAttemptId, work.attemptId),
        eq(drafts.leaseOwner, work.leaseOwner),
      )).returning({ id: drafts.id });
      return rows.length === 1;
    }),
  ));

  const runAttemptWithHeartbeat = (
    work: ClaimedCreationWork,
  ): Effect.Effect<void, DatabaseFailure | ProviderFailure | MediaFailure> => Effect.gen(function* () {
    const lease = yield* SynchronizedRef.make(work);
    let heartbeatStopped = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (heartbeatStopped || renewing) return;
      renewing = true;
      Effect.runSync(fibers.fork(
        SynchronizedRef.modifyEffect(lease, (current) =>
          renewLease(current).pipe(Effect.map((renewed) => [renewed, current] as const)),
        ).pipe(
          Effect.tap((renewed) => Effect.sync(() => {
            if (!renewed) heartbeatStopped = true;
          })),
          Effect.catchAll((error) => Effect.sync(() => {
            console.error("creation lease heartbeat failed", error);
            heartbeatStopped = true;
          })),
          Effect.ensuring(Effect.sync(() => { renewing = false; })),
        ),
      ));
    }, options.heartbeatMs ?? 30_000);
    heartbeat.unref?.();
    return yield* runAttempt(work, lease).pipe(
      Effect.ensuring(Effect.sync(() => {
        heartbeatStopped = true;
        clearInterval(heartbeat);
      })),
    );
  });

  const kick = (userId: string): Effect.Effect<void, never> => Effect.suspend(() => {
    if (stopped) return Effect.void;
    if (draining.has(userId)) {
      pending.add(userId);
      return Effect.void;
    }
    draining.add(userId);
    const drain = Effect.flatMap(
      Effect.catchAll(claim(userId), (error) =>
        Effect.sync(() => console.error("creation scheduler failed", error)).pipe(
          Effect.as([] as ReadonlyArray<ClaimedCreationWork>),
        )),
      (claims) => stopped ? Effect.void : Effect.forEach(claims, (work) => Effect.as(
        fibers.fork(
          runAttemptWithHeartbeat(work).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => console.error("creation worker failed", error))),
            Effect.ensuring(kick(userId)),
          ),
        ),
        undefined,
      )),
    ).pipe(
      Effect.asVoid,
      Effect.ensuring(Effect.suspend(() => {
        draining.delete(userId);
        return pending.delete(userId) ? kick(userId) : Effect.void;
      })),
    );
    return Effect.as(fibers.fork(drain), undefined);
  });

  const recover = (
    now: Date,
    recoveryOptions: {
      readonly allLeases?: boolean;
      readonly includeUnleased?: boolean;
    },
  ): Effect.Effect<number, DatabaseFailure> => options.database.withWriteLock(
    "durable-text.recover",
    databaseEffect("durable-text.recover", async () => {
      const rows = await db.update(drafts).set({
          status: "queued",
          activeAttemptId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCategory: "interrupted",
          errorStage: "cards",
          error: "Creation was interrupted. Try again.",
          queuedAt: now,
          updatedAt: now,
        }).where(and(
          inArray(drafts.status, ACTIVE_STATUSES),
          recoveryOptions.includeUnleased ? undefined : isNotNull(drafts.leaseOwner),
          recoveryOptions.allLeases
            ? undefined
            : or(isNull(drafts.leaseExpiresAt), lte(drafts.leaseExpiresAt, now)),
        )).returning({ id: drafts.id });
      return rows.length;
    }),
  );

  const purge = (): Effect.Effect<number, DatabaseFailure> => options.database.withWriteLock(
    "durable-text.purge-removed",
    databaseEffect("durable-text.purge-removed", async () => {
      const rows = await db.delete(drafts).where(and(
        eq(drafts.status, "removed"),
        isNotNull(drafts.undoUntil),
        lte(drafts.undoUntil, now()),
      )).returning({ id: drafts.id });
      return rows.length;
    }),
  );

  const poll = (): Effect.Effect<void, DatabaseFailure> => Effect.gen(function* () {
    yield* purge();
    yield* recover(now(), {});
    const owners = yield* databaseEffect("durable-text.poll-owners", () =>
      db.selectDistinct({ userId: drafts.userId }).from(drafts)
        .where(eq(drafts.status, "queued")));
    yield* Effect.forEach(owners, (owner) => kick(owner.userId));
  });

  const safelyPoll = (): Effect.Effect<void> => Effect.suspend(() => stopped
    ? Effect.void
    : poll().pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => console.error("creation scheduler failed", error))),
    ),
  );

  const start = (): Effect.Effect<void> => Effect.suspend(() => {
    if (stopped || timer) return Effect.void;
    timer = setInterval(() => {
      Effect.runSync(fibers.fork(safelyPoll()));
    }, options.intervalMs ?? 5_000);
    timer.unref?.();
    return safelyPoll();
  });

  const stop = (): Effect.Effect<void> => Effect.sync(() => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  return { recover, start, kick, runAttempt: runAttemptWithHeartbeat, stop, settle: fibers.settle };
}
