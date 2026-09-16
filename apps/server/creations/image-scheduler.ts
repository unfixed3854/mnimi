import {
  and,
  asc,
  count,
  eq,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../db/index.ts";
import {
  creationImageAttempts,
  drafts,
  notes,
} from "../db/schema.ts";
import type { CreationImageAttempt, Draft } from "../db/schema.ts";
import { withWriteLock } from "../db/write-lock.ts";
import { setNoteImageFailed } from "../images.ts";

export const MAX_ACTIVE_IMAGE_WORK = 2;
export const IMAGE_LEASE_MS = 120_000;
export const IMAGE_HEARTBEAT_MS = 40_000;

export type ClaimedCreationImageWork = {
  attemptId: string;
  userId: string;
  leaseOwner: string;
};

export type ImageWorkerDeps = {
  db: Db;
  generateImageBytes(prompt: string): Promise<Uint8Array>;
  writeDraftImage(userId: string, bytes: Uint8Array): Promise<string>;
  claimDraftImage(userId: string, draftImageId: string, noteId: string): Promise<string>;
  removeDraftImage(userId: string, draftImageId: string): Promise<void>;
  removeImage(relativePath: string): Promise<void>;
  publish?: (db: Db, creation: Draft, attemptId: string | null) => Promise<void>;
  kick?: () => void;
};

type EnqueueInput = {
  creationId: string;
  userId: string;
  prompt: string;
};

type CleanupDeps = {
  removeDraftImage?(userId: string, draftImageId: string): Promise<void>;
};

export async function enqueueCreationImage(
  db: Db,
  input: EnqueueInput,
  cleanup: CleanupDeps = {},
): Promise<string> {
  const attemptId = uuidv7();
  let superseded: string | null = null;
  await withWriteLock(() =>
    db.transaction(async (tx) => {
      const [creation] = await tx.select().from(drafts).where(and(
        eq(drafts.id, input.creationId),
        eq(drafts.userId, input.userId),
      )).limit(1);
      if (!creation) throw new Error("Creation not found");

      if (creation.imageAttemptId) {
        const [previous] = await tx.select().from(creationImageAttempts)
          .where(and(
            eq(creationImageAttempts.id, creation.imageAttemptId),
            eq(creationImageAttempts.userId, input.userId),
          )).limit(1);
        superseded = previous?.draftImageId ?? creation.draftImageId;
        await tx.update(creationImageAttempts).set({
          status: "canceled",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(creationImageAttempts.id, creation.imageAttemptId),
          eq(creationImageAttempts.userId, input.userId),
        ));
      }

      await tx.insert(creationImageAttempts).values({
        id: attemptId,
        userId: input.userId,
        creationId: input.creationId,
        prompt: input.prompt,
        status: "queued",
      });
      await tx.update(drafts).set({
        imageAttemptId: attemptId,
        imagePrompt: input.prompt,
        imageStatus: "queued",
        draftImageId: null,
        updatedAt: new Date(),
      }).where(and(
        eq(drafts.id, input.creationId),
        eq(drafts.userId, input.userId),
      ));
    })
  );
  if (superseded && cleanup.removeDraftImage) {
    await cleanup.removeDraftImage(input.userId, superseded);
  }
  return attemptId;
}

export async function cancelCreationImage(
  db: Db,
  input: { creationId: string; userId: string; imageAttemptId: string },
  cleanup: CleanupDeps = {},
): Promise<boolean> {
  let draftImageId: string | null = null;
  const canceled = await withWriteLock(() =>
    db.transaction(async (tx) => {
      const [attempt] = await tx.select().from(creationImageAttempts).where(and(
        eq(creationImageAttempts.id, input.imageAttemptId),
        eq(creationImageAttempts.userId, input.userId),
        eq(creationImageAttempts.creationId, input.creationId),
      )).limit(1);
      if (!attempt) return false;
      draftImageId = attempt.draftImageId;
      await tx.update(creationImageAttempts).set({
        status: "canceled",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      }).where(eq(creationImageAttempts.id, attempt.id));
      await tx.update(drafts).set({
        imageAttemptId: null,
        imagePrompt: null,
        imageStatus: "none",
        draftImageId: null,
        updatedAt: new Date(),
      }).where(and(
        eq(drafts.id, input.creationId),
        eq(drafts.userId, input.userId),
        eq(drafts.imageAttemptId, input.imageAttemptId),
      ));
      return true;
    })
  );
  if (draftImageId && cleanup.removeDraftImage) {
    await cleanup.removeDraftImage(input.userId, draftImageId);
  }
  return canceled;
}

export async function retryCreationImage(
  db: Db,
  input: { creationId: string; userId: string },
  cleanup: CleanupDeps = {},
): Promise<string> {
  const [creation] = await db.select({ prompt: drafts.imagePrompt }).from(drafts)
    .where(and(eq(drafts.id, input.creationId), eq(drafts.userId, input.userId)))
    .limit(1);
  if (!creation?.prompt) throw new Error("Creation has no image prompt");
  return await enqueueCreationImage(db, { ...input, prompt: creation.prompt }, cleanup);
}

export async function claimCreationImageWork(
  db: Db,
  options: { leaseOwner?: string; now?: Date; leaseMs?: number } = {},
): Promise<ClaimedCreationImageWork[]> {
  const now = options.now ?? new Date();
  const leaseOwner = options.leaseOwner ?? uuidv7();
  const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? IMAGE_LEASE_MS));
  return await withWriteLock(() =>
    db.transaction(async (tx) => {
      const [active] = await tx.select({ value: count() })
        .from(creationImageAttempts)
        .where(and(
          eq(creationImageAttempts.status, "generating"),
          isNotNull(creationImageAttempts.leaseOwner),
        ));
      const available = Math.max(0, MAX_ACTIVE_IMAGE_WORK - Number(active?.value ?? 0));
      if (available === 0) return [];

      const queued = await tx.select().from(creationImageAttempts)
        .where(and(
          eq(creationImageAttempts.status, "queued"),
          isNull(creationImageAttempts.leaseOwner),
        ))
        .orderBy(asc(creationImageAttempts.createdAt), asc(creationImageAttempts.id))
        .limit(available);
      const claimed: ClaimedCreationImageWork[] = [];
      for (const attempt of queued) {
        const rows = await tx.update(creationImageAttempts).set({
          status: "generating",
          leaseOwner,
          leaseExpiresAt,
          updatedAt: now,
        }).where(and(
          eq(creationImageAttempts.id, attempt.id),
          eq(creationImageAttempts.status, "queued"),
          isNull(creationImageAttempts.leaseOwner),
        )).returning({ id: creationImageAttempts.id });
        if (rows.length === 1) claimed.push({
          attemptId: attempt.id,
          userId: attempt.userId,
          leaseOwner,
        });
      }
      return claimed;
    })
  );
}

function imageFence(work: ClaimedCreationImageWork) {
  return and(
    eq(creationImageAttempts.id, work.attemptId),
    eq(creationImageAttempts.userId, work.userId),
    eq(creationImageAttempts.status, "generating"),
    eq(creationImageAttempts.leaseOwner, work.leaseOwner),
  );
}

export async function renewCreationImageLease(
  db: Db,
  work: ClaimedCreationImageWork,
  now = new Date(),
  leaseMs = IMAGE_LEASE_MS,
): Promise<boolean> {
  const rows = await withWriteLock(() =>
    db.update(creationImageAttempts).set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    }).where(imageFence(work)).returning({ id: creationImageAttempts.id })
  );
  return rows.length === 1;
}

export async function runCreationImageAttempt(
  work: ClaimedCreationImageWork,
  deps: ImageWorkerDeps,
): Promise<void> {
  let initial: CreationImageAttempt | null = null;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewCreationImageLease(deps.db, work)
      .catch((error) => console.error("image lease heartbeat failed", error))
      .finally(() => renewing = false);
  }, IMAGE_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const initialRows = await deps.db.select().from(creationImageAttempts)
      .where(imageFence(work)).limit(1);
    initial = initialRows[0] ?? null;
    if (!initial) return;
    const bytes = await deps.generateImageBytes(initial.prompt);

    const [stillOwned] = await deps.db.select().from(creationImageAttempts)
      .where(imageFence(work)).limit(1);
    if (!stillOwned) return;

    const draftImageId = await deps.writeDraftImage(work.userId, bytes);
    const creation = await settleWrittenImage(work, draftImageId, deps);
    if (creation) {
      await deps.publish?.(
        deps.db,
        creation,
        creation.activeAttemptId,
      );
    }
  } catch (error) {
    console.error("creation image attempt failed", error);
    const creation = await failImageAttempt(work, deps.db);
    if (creation) {
      await deps.publish?.(
        deps.db,
        creation,
        creation.activeAttemptId,
      );
    }
  } finally {
    clearInterval(heartbeat);
    deps.kick?.();
  }
}

async function settleWrittenImage(
  work: ClaimedCreationImageWork,
  draftImageId: string,
  deps: ImageWorkerDeps,
): Promise<Draft | null> {
  let claimedPath: string | null = null;
  let result: { keep: boolean; creation: Draft | null };
  try {
    result = await withWriteLock(async () => {
      const [attempt] = await deps.db.select().from(creationImageAttempts)
        .where(imageFence(work)).limit(1);
      if (!attempt) return { keep: false, creation: null };

      if (attempt.noteId) {
        claimedPath = await deps.claimDraftImage(
          work.userId,
          draftImageId,
          attempt.noteId,
        );
        const updated = await deps.db.update(notes).set({ imagePath: claimedPath })
          .where(and(eq(notes.id, attempt.noteId), eq(notes.userId, work.userId)))
          .returning({ id: notes.id });
        if (updated.length === 0) return { keep: false, creation: null };
        await setNoteImageFailed(deps.db, work.userId, attempt.noteId, false);
        await deps.db.update(creationImageAttempts).set({
          status: "ready",
          leaseOwner: null,
          leaseExpiresAt: null,
          draftImageId: null,
          updatedAt: new Date(),
        }).where(imageFence(work));
        return { keep: true, creation: null };
      }

      if (!attempt.creationId) return { keep: false, creation: null };
      const rows = await deps.db.update(drafts).set({
        imageStatus: "ready",
        draftImageId,
        errorCategory: null,
        errorStage: null,
        error: null,
        updatedAt: new Date(),
      }).where(and(
        eq(drafts.id, attempt.creationId),
        eq(drafts.userId, work.userId),
        eq(drafts.imageAttemptId, attempt.id),
      )).returning();
      if (rows.length === 0) return { keep: false, creation: null };
      await deps.db.update(creationImageAttempts).set({
        status: "ready",
        leaseOwner: null,
        leaseExpiresAt: null,
        draftImageId,
        updatedAt: new Date(),
      }).where(imageFence(work));
      return { keep: true, creation: rows[0] };
    });
  } catch (error) {
    if (claimedPath) await deps.removeImage(claimedPath);
    else await deps.removeDraftImage(work.userId, draftImageId);
    throw error;
  }

  if (!result.keep) {
    if (claimedPath) await deps.removeImage(claimedPath);
    else await deps.removeDraftImage(work.userId, draftImageId);
  }
  return result.creation;
}

async function failImageAttempt(
  work: ClaimedCreationImageWork,
  db: Db,
): Promise<Draft | null> {
  return await withWriteLock(async () => {
    const [attempt] = await db.select().from(creationImageAttempts)
      .where(imageFence(work)).limit(1);
    if (!attempt) return null;
    await db.update(creationImageAttempts).set({
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      error: "We couldn't create the image. You can retry it.",
      updatedAt: new Date(),
    }).where(imageFence(work));
    if (attempt.noteId) {
      await setNoteImageFailed(db, work.userId, attempt.noteId, true);
      return null;
    }
    if (!attempt.creationId) return null;
    const rows = await db.update(drafts).set({
      imageStatus: "failed",
      errorCategory: "image_failed",
      errorStage: "image",
      error: "We couldn't create the image. You can retry it.",
      updatedAt: new Date(),
    }).where(and(
      eq(drafts.id, attempt.creationId),
      eq(drafts.userId, work.userId),
      eq(drafts.imageAttemptId, attempt.id),
    )).returning();
    return rows[0] ?? null;
  });
}

type TransferDeps = Pick<
  ImageWorkerDeps,
  "claimDraftImage" | "removeImage" | "removeDraftImage"
>;

export type TransferCreationImageResult =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "ready"; imagePath: string };

export async function transferCreationImageToNote(
  db: Db,
  input: {
    creationId: string;
    imageAttemptId: string;
    noteId: string;
    userId: string;
  },
  deps: TransferDeps,
): Promise<TransferCreationImageResult> {
  return await withWriteLock(async () => {
    const [attempt] = await db.select().from(creationImageAttempts).where(and(
      eq(creationImageAttempts.id, input.imageAttemptId),
      eq(creationImageAttempts.userId, input.userId),
      eq(creationImageAttempts.creationId, input.creationId),
    )).limit(1);
    if (!attempt) return { kind: "none" };
    const [note] = await db.select({ id: notes.id }).from(notes).where(and(
      eq(notes.id, input.noteId),
      eq(notes.userId, input.userId),
    )).limit(1);
    if (!note) return { kind: "none" };

    if (attempt.status === "failed") {
      await db.update(creationImageAttempts).set({
        creationId: null,
        noteId: input.noteId,
        updatedAt: new Date(),
      }).where(eq(creationImageAttempts.id, attempt.id));
      await setNoteImageFailed(db, input.userId, input.noteId, true);
      return { kind: "failed" };
    }

    if (attempt.status === "ready" && attempt.draftImageId) {
      const imagePath = await deps.claimDraftImage(
        input.userId,
        attempt.draftImageId,
        input.noteId,
      );
      try {
        await db.update(notes).set({ imagePath }).where(and(
          eq(notes.id, input.noteId),
          eq(notes.userId, input.userId),
        ));
        await setNoteImageFailed(db, input.userId, input.noteId, false);
        await db.update(drafts).set({
          imageAttemptId: null,
          imagePrompt: null,
          imageStatus: "none",
          draftImageId: null,
          updatedAt: new Date(),
        }).where(and(
          eq(drafts.id, input.creationId),
          eq(drafts.userId, input.userId),
          eq(drafts.imageAttemptId, input.imageAttemptId),
        ));
        await db.update(creationImageAttempts).set({
          creationId: null,
          noteId: input.noteId,
          draftImageId: null,
          updatedAt: new Date(),
        }).where(eq(creationImageAttempts.id, attempt.id));
      } catch (error) {
        await deps.removeImage(imagePath);
        throw error;
      }
      return { kind: "ready", imagePath };
    }

    if (attempt.status === "queued" || attempt.status === "generating") {
      await db.update(creationImageAttempts).set({
        creationId: null,
        noteId: input.noteId,
        updatedAt: new Date(),
      }).where(eq(creationImageAttempts.id, attempt.id));
      return { kind: "pending" };
    }

    return { kind: "none" };
  });
}

export async function recoverStaleCreationImageWork(
  db: Db,
  now = new Date(),
  options: { allLeases?: boolean } = {},
): Promise<number> {
  const rows = await withWriteLock(() =>
    db.update(creationImageAttempts).set({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(and(
      eq(creationImageAttempts.status, "generating"),
      isNotNull(creationImageAttempts.leaseOwner),
      options.allLeases
        ? undefined
        : or(
          isNull(creationImageAttempts.leaseExpiresAt),
          lte(creationImageAttempts.leaseExpiresAt, now),
        ),
    )).returning({ id: creationImageAttempts.id })
  );
  return rows.length;
}

export type ImageScheduler = { kick(): void; stop(): void };

export function startImageScheduler(options: {
  db: Db;
  runWork(work: ClaimedCreationImageWork): Promise<void>;
  intervalMs?: number;
  leaseOwner?: string;
  now?: () => Date;
}): ImageScheduler {
  const leaseOwner = options.leaseOwner ?? uuidv7();
  let draining = false;
  let pending = false;
  let stopped = false;

  const kick = () => {
    if (stopped) return;
    if (draining) {
      pending = true;
      return;
    }
    draining = true;
    void (async () => {
      try {
        const work = await claimCreationImageWork(options.db, {
          leaseOwner,
          now: options.now?.(),
        });
        for (const item of work) {
          void options.runWork(item)
            .catch((error) => console.error("creation image worker failed", error))
            .finally(kick);
        }
      } finally {
        draining = false;
        if (pending) {
          pending = false;
          kick();
        }
      }
    })();
  };

  const poll = async () => {
    await recoverStaleCreationImageWork(options.db, options.now?.());
    kick();
  };
  const timer = setInterval(
    () => void poll().catch((error) => console.error("image scheduler failed", error)),
    options.intervalMs ?? 5_000,
  );
  timer.unref?.();
  const scheduler: ImageScheduler = {
    kick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
  void poll().catch((error) => console.error("image scheduler failed", error));
  return scheduler;
}
