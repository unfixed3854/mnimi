import { and, asc, count, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import { creationImageAttempts, drafts, notes } from "../db/schema.ts";
import type { MediaStoreService } from "./media.ts";
import { setNoteImageFailed } from "../images.ts";
import type { BackgroundProviderService } from "./background-provider.ts";
import type { CreationEventsService } from "./creation-events.ts";
import type { DatabaseService } from "./database.ts";
import { DatabaseFailure, MediaFailure, ProviderFailure } from "./errors.ts";
import { makeBackgroundFibers } from "./background-fibers.ts";

export const MAX_ACTIVE_IMAGE_WORK = 2;
export const IMAGE_LEASE_MS = 120_000;
export const IMAGE_HEARTBEAT_MS = 40_000;

export type ClaimedCreationImageWork = Readonly<{
  attemptId: string;
  userId: string;
  leaseOwner: string;
}>;

export type DurableImageDatabase = Pick<DatabaseService, "db" | "withWriteLock" | "transaction">;

export type DurableImageWorkflowService = Readonly<{
  readonly enqueue: (input: { creationId: string; userId: string; prompt: string }) => Effect.Effect<string, DatabaseFailure | MediaFailure>;
  readonly cancel: (input: { creationId: string; userId: string; imageAttemptId: string }) => Effect.Effect<boolean, DatabaseFailure | MediaFailure>;
  readonly retry: (input: { creationId: string; userId: string }) => Effect.Effect<string, DatabaseFailure | MediaFailure>;
  readonly transfer: (input: { creationId: string; imageAttemptId: string; noteId: string; userId: string }) => Effect.Effect<unknown, DatabaseFailure | MediaFailure>;
  readonly recover: (now: Date, options: { allLeases?: boolean }) => Effect.Effect<number, DatabaseFailure>;
  readonly runAttempt: (work: ClaimedCreationImageWork) => Effect.Effect<void, DatabaseFailure | ProviderFailure | MediaFailure>;
  readonly start: () => Effect.Effect<void>;
  readonly kick: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<void>;
  readonly settle: () => Effect.Effect<void>;
}>;

type Options = Readonly<{
  database: DurableImageDatabase;
  media: Pick<MediaStoreService, "writeDraftImage" | "claimDraftImage" | "removeDraftImage" | "removeImage">;
  provider: Pick<BackgroundProviderService, "generateImageBytes">;
  events: Pick<CreationEventsService, "publish">;
  runAttempt?: (work: ClaimedCreationImageWork) => Effect.Effect<void, DatabaseFailure | ProviderFailure | MediaFailure>;
  leaseOwner?: string;
  intervalMs?: number;
  heartbeatMs?: number;
  now?: () => Date;
}>;

function databaseEffect<A>(operation: string, work: () => Promise<A>): Effect.Effect<A, DatabaseFailure> {
  return Effect.tryPromise({
    try: work,
    catch: (cause) => new DatabaseFailure({ operation, cause }),
  });
}

/**
 * The durable scheduler owns polling and admission. Attempt fibers are daemon
 * fibers deliberately: stopping a scheduler halts future admission, but never
 * interrupts an attempt that is inside its guarded media-compensation path.
 */
export function makeDurableImageWorkflow(options: Options): DurableImageWorkflowService {
  const { db } = options.database;
  const leaseOwner = options.leaseOwner ?? uuidv7();
  const now = () => options.now?.() ?? new Date();
  let stopped = false;
  let draining = false;
  let pending = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const fibers = makeBackgroundFibers();

  const claim = (): Effect.Effect<ReadonlyArray<ClaimedCreationImageWork>, DatabaseFailure> =>
    options.database.transaction("durable-images.claim", (tx) => databaseEffect(
      "durable-images.claim",
      async () => {
        if (stopped) return [];
        const current = now();
        const [active] = await tx.select({ value: count() }).from(creationImageAttempts)
          .where(and(eq(creationImageAttempts.status, "generating"), isNotNull(creationImageAttempts.leaseOwner)));
        const available = Math.max(0, MAX_ACTIVE_IMAGE_WORK - Number(active?.value ?? 0));
        if (available === 0) return [];
        const candidates = await tx.select().from(creationImageAttempts)
          .where(and(eq(creationImageAttempts.status, "queued"), isNull(creationImageAttempts.leaseOwner)))
          .orderBy(asc(creationImageAttempts.createdAt), asc(creationImageAttempts.id)).limit(available);
        const claimed: ClaimedCreationImageWork[] = [];
        for (const candidate of candidates) {
          if (stopped) break;
          const rows = await tx.update(creationImageAttempts).set({
            status: "generating",
            leaseOwner,
            leaseExpiresAt: new Date(current.getTime() + IMAGE_LEASE_MS),
            updatedAt: current,
          }).where(and(eq(creationImageAttempts.id, candidate.id), eq(creationImageAttempts.status, "queued"), isNull(creationImageAttempts.leaseOwner)))
            .returning({ id: creationImageAttempts.id });
          if (rows.length === 1) claimed.push({ attemptId: candidate.id, userId: candidate.userId, leaseOwner });
        }
        return claimed;
      },
    ));

  const recover = (current: Date, recovery: { allLeases?: boolean }): Effect.Effect<number, DatabaseFailure> =>
    options.database.withWriteLock("durable-images.recover", databaseEffect("durable-images.recover", async () => {
      const rows = await db.update(creationImageAttempts).set({
        status: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: current,
      }).where(and(
        eq(creationImageAttempts.status, "generating"),
        isNotNull(creationImageAttempts.leaseOwner),
        recovery.allLeases ? undefined : or(isNull(creationImageAttempts.leaseExpiresAt), lte(creationImageAttempts.leaseExpiresAt, current)),
      )).returning({ id: creationImageAttempts.id });
      return rows.length;
    }));

  const failAttempt = (work: ClaimedCreationImageWork) => options.database.withWriteLock(
    "durable-images.fail",
    databaseEffect("durable-images.fail", async () => {
      const fence = and(eq(creationImageAttempts.id, work.attemptId), eq(creationImageAttempts.userId, work.userId), eq(creationImageAttempts.status, "generating"), eq(creationImageAttempts.leaseOwner, work.leaseOwner));
      const [attempt] = await db.select().from(creationImageAttempts).where(fence).limit(1);
      if (!attempt) return null;
      await db.update(creationImageAttempts).set({
        status: "failed", leaseOwner: null, leaseExpiresAt: null,
        error: "We couldn't create the image. You can retry it.", updatedAt: new Date(),
      }).where(fence);
      if (attempt.noteId) {
        await setNoteImageFailed(db, work.userId, attempt.noteId, true);
        return null;
      }
      if (!attempt.creationId) return null;
      const rows = await db.update(drafts).set({
        imageStatus: "failed", errorCategory: "image_failed", errorStage: "image",
        error: "We couldn't create the image. You can retry it.", updatedAt: new Date(),
      }).where(and(eq(drafts.id, attempt.creationId), eq(drafts.userId, work.userId), eq(drafts.imageAttemptId, attempt.id))).returning();
      return rows[0] ?? null;
    }),
  );

  const execute = options.runAttempt ?? ((work: ClaimedCreationImageWork) => {
    const fence = and(
      eq(creationImageAttempts.id, work.attemptId),
      eq(creationImageAttempts.userId, work.userId),
      eq(creationImageAttempts.status, "generating"),
      eq(creationImageAttempts.leaseOwner, work.leaseOwner),
    );
    const attempt = Effect.gen(function* () {
      const [attempt] = yield* databaseEffect("durable-images.attempt-read", () => db.select().from(creationImageAttempts).where(fence).limit(1));
      if (!attempt) return;
      const bytes = yield* options.provider.generateImageBytes(attempt.prompt);
      const [owned] = yield* databaseEffect("durable-images.attempt-fence", () => db.select().from(creationImageAttempts).where(fence).limit(1));
      if (!owned) return;
      // Filesystem writes/renames cannot be canceled once started. Observe their
      // result before honoring interruption so every acquired path has cleanup.
      const creation = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const draftImageId = yield* options.media.writeDraftImage(work.userId, bytes);
        let keep = false;
        let claimedPath: string | null = null;
        const settlement = options.database.withWriteLock("durable-images.settle", Effect.gen(function* () {
          const [current] = yield* databaseEffect("durable-images.settle-read", () => db.select().from(creationImageAttempts).where(fence).limit(1));
          if (!current) return undefined;
          if (current.noteId) {
            claimedPath = yield* options.media.claimDraftImage(work.userId, draftImageId, current.noteId);
            const updated = yield* databaseEffect("durable-images.settle-note", () => db.update(notes).set({ imagePath: claimedPath! })
              .where(and(eq(notes.id, current.noteId!), eq(notes.userId, work.userId))).returning({ id: notes.id }));
            if (updated.length === 0) return undefined;
            yield* databaseEffect("durable-images.settle-note-state", async () => {
              await setNoteImageFailed(db, work.userId, current.noteId!, false);
              await db.update(creationImageAttempts).set({ status: "ready", leaseOwner: null, leaseExpiresAt: null, draftImageId: null, updatedAt: new Date() }).where(fence);
            });
            keep = true;
            return undefined;
          }
          if (!current.creationId) return undefined;
          const creationId = current.creationId;
          const rows = yield* databaseEffect("durable-images.settle-write", () => db.update(drafts).set({
            imageStatus: "ready", draftImageId, errorCategory: null, errorStage: null, error: null, updatedAt: new Date(),
          }).where(and(eq(drafts.id, creationId), eq(drafts.userId, work.userId), eq(drafts.imageAttemptId, current.id))).returning());
          if (rows.length === 0) return undefined;
          yield* databaseEffect("durable-images.settle-attempt", () => db.update(creationImageAttempts).set({
            status: "ready", leaseOwner: null, leaseExpiresAt: null, draftImageId, updatedAt: new Date(),
          }).where(fence) as unknown as Promise<void>);
          keep = true;
          return rows[0];
        }));
        const settled = yield* Effect.exit(restore(Effect.yieldNow()).pipe(Effect.zipRight(settlement)));
        if (settled._tag === "Failure" || !keep) {
          yield* claimedPath ? options.media.removeImage(claimedPath) : options.media.removeDraftImage(work.userId, draftImageId);
          if (settled._tag === "Failure") return yield* Effect.failCause(settled.cause);
          return;
        }
        return settled.value;
      }));
      if (creation) yield* options.events.publish(creation, creation.activeAttemptId);
    });
    return attempt.pipe(Effect.catchAll((error) => Effect.zipRight(
      Effect.flatMap(failAttempt(work), (creation) => creation
        ? options.events.publish(creation, creation.activeAttemptId)
        : Effect.void),
      Effect.fail(error),
    )));
  });
  const runAttempt = (work: ClaimedCreationImageWork) => Effect.suspend(() => {
    let heartbeatStopped = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (heartbeatStopped || renewing) return;
      renewing = true;
      Effect.runSync(fibers.fork(
        options.database.withWriteLock("durable-images.renew-lease", databaseEffect("durable-images.renew-lease", async () => {
          const current = now();
          const rows = await db.update(creationImageAttempts).set({
            leaseExpiresAt: new Date(current.getTime() + IMAGE_LEASE_MS), updatedAt: current,
          }).where(and(eq(creationImageAttempts.id, work.attemptId), eq(creationImageAttempts.userId, work.userId), eq(creationImageAttempts.status, "generating"), eq(creationImageAttempts.leaseOwner, work.leaseOwner)))
            .returning({ id: creationImageAttempts.id });
          return rows.length === 1;
        })).pipe(
          Effect.tap((renewed) => Effect.sync(() => { if (!renewed) heartbeatStopped = true; })),
          Effect.catchAll((error) => Effect.sync(() => { console.error("image lease heartbeat failed", error); heartbeatStopped = true; })),
          Effect.ensuring(Effect.sync(() => { renewing = false; })),
        ),
      ));
    }, options.heartbeatMs ?? IMAGE_HEARTBEAT_MS);
    heartbeat.unref?.();
    return execute(work).pipe(Effect.ensuring(Effect.sync(() => {
      heartbeatStopped = true;
      clearInterval(heartbeat);
    })));
  });

  const kick = (): Effect.Effect<void> => Effect.suspend(() => {
    if (stopped || !timer) return Effect.void;
    if (draining) {
      pending = true;
      return Effect.void;
    }
    draining = true;
    const drain = Effect.flatMap(
      Effect.catchAll(claim(), (error) => Effect.sync(() => console.error("image scheduler failed", error)).pipe(Effect.as([] as ReadonlyArray<ClaimedCreationImageWork>))),
      (claims) => Effect.forEach(claims, (work) => Effect.suspend(() =>
        stopped || !timer ? Effect.void : Effect.as(fibers.fork(
          runAttempt(work).pipe(
            Effect.catchAll((error) => Effect.sync(() => console.error("creation image worker failed", error))),
            Effect.ensuring(kick()),
          ),
        ), undefined))),
    ).pipe(Effect.asVoid, Effect.ensuring(Effect.suspend(() => {
      draining = false;
      return pending ? (pending = false, kick()) : Effect.void;
    })));
    return Effect.as(fibers.fork(drain), undefined);
  });

  const poll = () => recover(now(), {}).pipe(Effect.zipRight(kick()));
  const safelyPoll = () => Effect.suspend(() => stopped
    ? Effect.void
    : poll().pipe(Effect.catchAll((error) => Effect.sync(() => console.error("image scheduler failed", error)))),
  );
  const start = (): Effect.Effect<void> => Effect.suspend(() => {
    if (stopped || timer) return Effect.void;
    timer = setInterval(() => { Effect.runSync(fibers.fork(safelyPoll())); }, options.intervalMs ?? 5_000);
    timer.unref?.();
    return safelyPoll();
  });
  const stop = (): Effect.Effect<void> => Effect.sync(() => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  const enqueue = (input: { creationId: string; userId: string; prompt: string }) => {
    const attemptId = uuidv7();
    return Effect.flatMap(
      options.database.transaction("durable-images.enqueue", (tx) => databaseEffect("durable-images.enqueue", async () => {
        const [creation] = await tx.select().from(drafts).where(and(
          eq(drafts.id, input.creationId), eq(drafts.userId, input.userId),
        )).limit(1);
        if (!creation) throw new Error("Creation not found");
        let superseded: string | null = null;
        if (creation.imageAttemptId) {
          const [previous] = await tx.select().from(creationImageAttempts).where(and(
            eq(creationImageAttempts.id, creation.imageAttemptId), eq(creationImageAttempts.userId, input.userId),
          )).limit(1);
          superseded = previous?.draftImageId ?? creation.draftImageId;
          await tx.update(creationImageAttempts).set({ status: "canceled", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
            .where(and(eq(creationImageAttempts.id, creation.imageAttemptId), eq(creationImageAttempts.userId, input.userId)));
        }
        await tx.insert(creationImageAttempts).values({ id: attemptId, userId: input.userId, creationId: input.creationId, prompt: input.prompt, status: "queued" });
        await tx.update(drafts).set({ imageAttemptId: attemptId, imagePrompt: input.prompt, imageStatus: "queued", draftImageId: null, updatedAt: new Date() })
          .where(and(eq(drafts.id, input.creationId), eq(drafts.userId, input.userId)));
        return superseded;
      })),
      (superseded) => Effect.zipRight(
        superseded ? options.media.removeDraftImage(input.userId, superseded) : Effect.void,
        Effect.zipRight(kick(), Effect.succeed(attemptId)),
      ),
    );
  };

  const cancel = (input: { creationId: string; userId: string; imageAttemptId: string }) => Effect.flatMap(
    options.database.transaction("durable-images.cancel", (tx) => databaseEffect("durable-images.cancel", async () => {
      const [attempt] = await tx.select().from(creationImageAttempts).where(and(
        eq(creationImageAttempts.id, input.imageAttemptId), eq(creationImageAttempts.userId, input.userId), eq(creationImageAttempts.creationId, input.creationId),
      )).limit(1);
      if (!attempt) return { canceled: false, draftImageId: null as string | null };
      await tx.update(creationImageAttempts).set({ status: "canceled", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(creationImageAttempts.id, attempt.id));
      await tx.update(drafts).set({ imageAttemptId: null, imagePrompt: null, imageStatus: "none", draftImageId: null, updatedAt: new Date() }).where(and(
        eq(drafts.id, input.creationId), eq(drafts.userId, input.userId), eq(drafts.imageAttemptId, input.imageAttemptId),
      ));
      return { canceled: true, draftImageId: attempt.draftImageId };
    })),
    ({ canceled, draftImageId }) => Effect.zipRight(
      draftImageId ? options.media.removeDraftImage(input.userId, draftImageId) : Effect.void,
      Effect.succeed(canceled),
    ),
  );

  const retry = (input: { creationId: string; userId: string }) => Effect.flatMap(
    databaseEffect("durable-images.retry", async () => (await db.select({ prompt: drafts.imagePrompt }).from(drafts)
      .where(and(eq(drafts.id, input.creationId), eq(drafts.userId, input.userId))).limit(1))[0]),
    (creation) => !creation?.prompt
      ? Effect.fail(new DatabaseFailure({ operation: "durable-images.retry", cause: new Error("Creation has no image prompt") }))
      : enqueue({ ...input, prompt: creation.prompt }),
  );

  const transfer = (input: { creationId: string; imageAttemptId: string; noteId: string; userId: string }) => {
    return options.database.withWriteLock("durable-images.transfer", Effect.gen(function* () {
      const result = yield* databaseEffect("durable-images.transfer", async () => {
        const [attempt] = await db.select().from(creationImageAttempts).where(and(
          eq(creationImageAttempts.id, input.imageAttemptId), eq(creationImageAttempts.userId, input.userId), eq(creationImageAttempts.creationId, input.creationId),
        )).limit(1);
        const [note] = await db.select({ id: notes.id }).from(notes).where(and(eq(notes.id, input.noteId), eq(notes.userId, input.userId))).limit(1);
        return { attempt, note };
      });
      if (!result.attempt || !result.note) return { kind: "none" } as const;
      const attempt = result.attempt;
      if (attempt.status === "failed") {
        yield* databaseEffect("durable-images.transfer-failed", async () => {
          await db.update(creationImageAttempts).set({ creationId: null, noteId: input.noteId, updatedAt: new Date() }).where(eq(creationImageAttempts.id, attempt.id));
          await setNoteImageFailed(db, input.userId, input.noteId, true);
        });
        return { kind: "failed" } as const;
      }
      if (attempt.status === "ready" && attempt.draftImageId) {
        const imagePath = yield* options.media.claimDraftImage(input.userId, attempt.draftImageId, input.noteId);
        const committed = yield* Effect.exit(databaseEffect("durable-images.transfer-ready", async () => {
          await db.update(notes).set({ imagePath }).where(and(eq(notes.id, input.noteId), eq(notes.userId, input.userId)));
          await setNoteImageFailed(db, input.userId, input.noteId, false);
          await db.update(drafts).set({ imageAttemptId: null, imagePrompt: null, imageStatus: "none", draftImageId: null, updatedAt: new Date() }).where(and(
            eq(drafts.id, input.creationId), eq(drafts.userId, input.userId), eq(drafts.imageAttemptId, input.imageAttemptId),
          ));
          await db.update(creationImageAttempts).set({ creationId: null, noteId: input.noteId, draftImageId: null, updatedAt: new Date() }).where(eq(creationImageAttempts.id, attempt.id));
        }));
        if (committed._tag === "Failure") {
          yield* options.media.removeImage(imagePath);
          return yield* Effect.failCause(committed.cause);
        }
        return { kind: "ready", imagePath } as const;
      }
      if (attempt.status === "queued" || attempt.status === "generating") {
        yield* databaseEffect("durable-images.transfer-pending", () => db.update(creationImageAttempts).set({ creationId: null, noteId: input.noteId, updatedAt: new Date() }).where(eq(creationImageAttempts.id, attempt.id)) as unknown as Promise<void>);
        return { kind: "pending" } as const;
      }
      return { kind: "none" } as const;
    })).pipe(Effect.uninterruptible);
  };

  return {
    enqueue,
    cancel,
    retry,
    transfer,
    recover,
    runAttempt,
    start,
    kick,
    stop,
    settle: fibers.settle,
  };
}
