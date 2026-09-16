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
import { uuidv7 } from "uuidv7";
import type { Db } from "../db/index.ts";
import { drafts } from "../db/schema.ts";
import type { DraftOperation, DraftStatus } from "../db/schema.ts";
import { withWriteLock } from "../db/write-lock.ts";

export const MAX_ACTIVE_TEXT_WORK_PER_USER = 2;
export const CREATION_LEASE_MS = 90_000;
export const CREATION_HEARTBEAT_MS = 30_000;

const ACTIVE_STATUSES: DraftStatus[] = [
  "routing",
  "generating",
  "adjusting",
  "regenerating",
];

export type ClaimedCreationWork = {
  creationId: string;
  userId: string;
  attemptId: string;
  leaseOwner: string;
  operation: DraftOperation;
};

type ClaimOptions = {
  leaseOwner?: string;
  now?: Date;
  leaseMs?: number;
};

function activeStatus(operation: DraftOperation): DraftStatus {
  switch (operation) {
    case "route_generate":
      return "routing";
    case "adjust":
      return "adjusting";
    case "regenerate":
      return "regenerating";
    case "generate":
    case "retry":
      return "generating";
  }
}

/**
 * Claims all currently available slots for one owner in one serialized
 * transaction. The database row, not an in-memory promise, is authoritative.
 */
export async function claimCreationWork(
  db: Db,
  userId: string,
  options: ClaimOptions = {},
): Promise<ClaimedCreationWork[]> {
  const now = options.now ?? new Date();
  const leaseOwner = options.leaseOwner ?? uuidv7();
  const leaseExpiresAt = new Date(
    now.getTime() + (options.leaseMs ?? CREATION_LEASE_MS),
  );

  return await withWriteLock(() =>
    db.transaction(async (tx) => {
      const [active] = await tx
        .select({ value: count() })
        .from(drafts)
        .where(and(
          eq(drafts.userId, userId),
          inArray(drafts.status, ACTIVE_STATUSES),
          isNotNull(drafts.leaseOwner),
        ));
      const available = Math.max(
        0,
        MAX_ACTIVE_TEXT_WORK_PER_USER - Number(active?.value ?? 0),
      );
      if (available === 0) return [];

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
        const operation = candidate.operation as DraftOperation;
        const attemptId = uuidv7();
        const rows = await tx
          .update(drafts)
          .set({
            status: activeStatus(operation),
            activeAttemptId: attemptId,
            leaseOwner,
            leaseExpiresAt,
            updatedAt: now,
          })
          .where(and(
            eq(drafts.id, candidate.id),
            eq(drafts.userId, userId),
            eq(drafts.status, "queued"),
            isNull(drafts.activeAttemptId),
            isNull(drafts.leaseOwner),
          ))
          .returning({ id: drafts.id });
        if (rows.length === 0) continue;
        claimed.push({
          creationId: candidate.id,
          userId,
          attemptId,
          leaseOwner,
          operation,
        });
      }
      return claimed;
    })
  );
}

export async function renewCreationLease(
  db: Db,
  work: ClaimedCreationWork,
  now = new Date(),
  leaseMs = CREATION_LEASE_MS,
): Promise<boolean> {
  const rows = await withWriteLock(() =>
    db.update(drafts).set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    }).where(and(
      eq(drafts.id, work.creationId),
      eq(drafts.userId, work.userId),
      eq(drafts.activeAttemptId, work.attemptId),
      eq(drafts.leaseOwner, work.leaseOwner),
    )).returning({ id: drafts.id })
  );
  return rows.length === 1;
}

/** Requeues expired leases and clears the old attempt fence. */
export async function recoverStaleCreationWork(
  db: Db,
  now = new Date(),
  options: { allLeases?: boolean; includeUnleased?: boolean } = {},
): Promise<number> {
  const rows = await withWriteLock(() =>
    db.update(drafts).set({
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
      options.includeUnleased ? undefined : isNotNull(drafts.leaseOwner),
      options.allLeases
        ? undefined
        : or(isNull(drafts.leaseExpiresAt), lte(drafts.leaseExpiresAt, now)),
    )).returning({ id: drafts.id })
  );
  return rows.length;
}

export async function purgeExpiredRemovedCreations(
  db: Db,
  now = new Date(),
): Promise<number> {
  const rows = await withWriteLock(() =>
    db.delete(drafts).where(and(
      eq(drafts.status, "removed"),
      isNotNull(drafts.undoUntil),
      lte(drafts.undoUntil, now),
    )).returning({ id: drafts.id })
  );
  return rows.length;
}

export type CreationScheduler = {
  kick(userId: string): void;
  stop(): void;
};

type SchedulerOptions = {
  db: Db;
  runWork(work: ClaimedCreationWork): Promise<void>;
  intervalMs?: number;
  leaseOwner?: string;
  now?: () => Date;
};

export function startCreationScheduler(
  options: SchedulerOptions,
): CreationScheduler {
  const leaseOwner = options.leaseOwner ?? uuidv7();
  const draining = new Set<string>();
  const pending = new Set<string>();
  let stopped = false;

  const kick = (userId: string) => {
    if (stopped) return;
    if (draining.has(userId)) {
      pending.add(userId);
      return;
    }
    draining.add(userId);
    void (async () => {
      try {
        const claims = await claimCreationWork(options.db, userId, {
          leaseOwner,
          now: options.now?.(),
        });
        for (const claim of claims) {
          void options.runWork(claim)
            .catch((error) => console.error("creation worker failed", error))
            .finally(() => kick(userId));
        }
      } finally {
        draining.delete(userId);
        if (pending.delete(userId)) kick(userId);
      }
    })();
  };

  const poll = async () => {
    if (stopped) return;
    await purgeExpiredRemovedCreations(options.db, options.now?.());
    await recoverStaleCreationWork(options.db, options.now?.());
    const owners = await options.db
      .selectDistinct({ userId: drafts.userId })
      .from(drafts)
      .where(eq(drafts.status, "queued"));
    for (const owner of owners) kick(owner.userId);
  };

  const timer = setInterval(
    () => void poll().catch((error) => console.error("creation scheduler failed", error)),
    options.intervalMs ?? 5_000,
  );
  timer.unref?.();
  const scheduler: CreationScheduler = {
    kick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
  void poll().catch((error) => console.error("creation scheduler failed", error));
  return scheduler;
}
