import { isNotNull } from "drizzle-orm";
import { Cause, Context, Effect, Fiber, Option } from "effect";
import { creationImageAttempts, drafts } from "../db/schema.ts";
import type { DatabaseService } from "./database.ts";
import { DatabaseFailure } from "./errors.ts";
import type { MediaStoreService } from "./media.ts";

const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type DraftMaintenanceService = Readonly<{
  start(): Effect.Effect<void>;
  stop(): Effect.Effect<void>;
}>;

export class DraftMaintenance extends Context.Tag("@mnimi/server/DraftMaintenance")<DraftMaintenance, DraftMaintenanceService>() {}

export type DraftMaintenanceOptions = Readonly<{
  database: Pick<DatabaseService, "db">;
  media: Pick<MediaStoreService, "sweepDrafts">;
  now?: () => number;
  reportError?: (error: unknown) => void;
}>;

/** The application owns one maintenance timer and at most one sweeping fiber. */
export function makeDraftMaintenance(options: DraftMaintenanceOptions): DraftMaintenanceService {
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Fiber.RuntimeFiber<void> | undefined;
  const reportError = options.reportError ?? ((error) => console.error("draft sweep failed", error));
  const reportFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> => {
    if (Cause.isInterruptedOnly(cause)) return Effect.void;
    const failure = Cause.failureOption(cause);
    return Effect.sync(() => reportError(Option.isSome(failure) ? failure.value : Cause.squash(cause)));
  };
  const { db } = options.database;
  const sweep = Effect.gen(function* () {
    const [creationRows, attemptRows] = yield* Effect.tryPromise({
      try: () => Promise.all([
        db.select({ draftImageId: drafts.draftImageId }).from(drafts).where(isNotNull(drafts.draftImageId)),
        db.select({ draftImageId: creationImageAttempts.draftImageId }).from(creationImageAttempts)
          .where(isNotNull(creationImageAttempts.draftImageId)),
      ]),
      catch: (cause) => new DatabaseFailure({ operation: "draft-maintenance.references", cause }),
    });
    if (stopped) return;
    const referenced = new Set([...creationRows, ...attemptRows].flatMap((row) => row.draftImageId === null ? [] : [row.draftImageId]));
    // The filesystem Promise cannot be canceled once it has started. Fence
    // before admission, then observe its settlement (including error reporting)
    // before interruption can finalize this fiber or let stop resolve.
    yield* Effect.uninterruptible(Effect.suspend(() => stopped ? Effect.void :
      options.media.sweepDrafts(DRAFT_MAX_AGE_MS, referenced, (options.now ?? Date.now)()).pipe(
        Effect.asVoid,
        Effect.catchAllCause(reportFailure),
      )));
  }).pipe(
    Effect.catchAllCause(reportFailure),
    Effect.ensuring(Effect.sync(() => { active = undefined; })),
  );

  const launch = (): Effect.Effect<Fiber.RuntimeFiber<void> | undefined> => Effect.suspend(() => {
    if (stopped || active) return Effect.succeed(undefined);
    return Effect.forkDaemon(sweep).pipe(Effect.tap((fiber) => Effect.sync(() => { active = fiber; })));
  });

  return {
    start: () => Effect.suspend(() => {
      if (stopped || started) return Effect.void;
      started = true;
      return Effect.gen(function* () {
        const first = yield* launch();
        if (first) yield* Fiber.join(first);
        if (stopped) return;
        timer = setInterval(() => { Effect.runFork(launch()); }, SWEEP_INTERVAL_MS);
        timer.unref?.();
      });
    }),
    stop: () => Effect.suspend(() => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      return active ? Effect.asVoid(Fiber.interrupt(active)) : Effect.void;
    }),
  };
}
