import { and, desc, eq, ne } from "drizzle-orm";
import { Cause, Context, Deferred, Effect, Exit, FiberId } from "effect";
import { drafts } from "../db/schema.ts";
import { makeAudioJobs, type AudioJobsService } from "./audio-jobs.ts";
import type { BackgroundProviderService } from "./background-provider.ts";
import { makeCreationEvents, type CreationEventsService } from "./creation-events.ts";
import { makeDraftMaintenance } from "./draft-maintenance.ts";
import { makeDurableImageWorkflow, type DurableImageWorkflowService } from "./durable-images.ts";
import { makeDurableTextWorkflow, type DurableTextDatabase, type DurableTextWorkflowService } from "./durable-text.ts";
import { runDurableTextAttempt } from "./durable-text-attempt.ts";
import type { ElevenLabsService } from "./elevenlabs.ts";
import type { DatabaseFailure } from "./errors.ts";
import type { ExpoPushService } from "./expo-push.ts";
import { makeLegacyCreationWorkflow, type LegacyCreationWorkflowService } from "./legacy-creation.ts";
import type { MediaStoreService } from "./media.ts";
import { makeNotifications, type NotificationsService } from "./notifications.ts";

export type BackgroundWorkflowsService = Readonly<{
  recoverAndStart(): Effect.Effect<void, DatabaseFailure>;
  kickText(userId: string): Effect.Effect<void>;
  kickImages(): Effect.Effect<void>;
  stop(): Effect.Effect<void>;
  settle(): Effect.Effect<void>;
  events: CreationEventsService;
  notifications: NotificationsService;
  legacy: LegacyCreationWorkflowService;
  text: DurableTextWorkflowService;
  images: DurableImageWorkflowService;
  audio: AudioJobsService;
}>;

export class BackgroundWorkflows extends Context.Tag("@mnimi/server/BackgroundWorkflows")<BackgroundWorkflows, BackgroundWorkflowsService>() {}

export type BackgroundWorkflowsOptions = Readonly<{
  database: DurableTextDatabase;
  provider: BackgroundProviderService;
  media: MediaStoreService;
  elevenLabs: ElevenLabsService;
  push: ExpoPushService;
  now?: () => Date;
  reportSweepError?: (error: unknown) => void;
  reportNotificationError?: (error: unknown) => void;
  /** Bootstrap retains the database once claims can outlive scheduler shutdown. */
  onTextAdmission?: () => void;
}>;

export type BackgroundWorkflowFactories = Readonly<{
  events: typeof makeCreationEvents;
  notifications: typeof makeNotifications;
  legacy: typeof makeLegacyCreationWorkflow;
  text: typeof makeDurableTextWorkflow;
  images: typeof makeDurableImageWorkflow;
  audio: typeof makeAudioJobs;
  maintenance: typeof makeDraftMaintenance;
}>;

/** Construct once after provider acquisition and retain it for app lifetime. */
export function makeBackgroundWorkflows(
  options: BackgroundWorkflowsOptions,
  overrides: Partial<BackgroundWorkflowFactories> = {},
): BackgroundWorkflowsService {
  const factories: BackgroundWorkflowFactories = {
    events: makeCreationEvents, notifications: makeNotifications, legacy: makeLegacyCreationWorkflow,
    text: makeDurableTextWorkflow, images: makeDurableImageWorkflow, audio: makeAudioJobs,
    maintenance: makeDraftMaintenance, ...overrides,
  };
  let stopped = false;
  let textAdmitted = false;
  let imagesAdmitted = false;
  let starting: Deferred.Deferred<void, DatabaseFailure> | undefined;
  let stopping: Deferred.Deferred<void> | undefined;
  const { db } = options.database;
  const now = options.now ?? (() => new Date());
  const events = factories.events({
    readDetail: async (userId, creationId) => {
      const [creation] = await db.select().from(drafts).where(and(eq(drafts.id, creationId), eq(drafts.userId, userId))).limit(1);
      return creation ?? null;
    },
    readInbox: (userId) => db.select().from(drafts).where(and(eq(drafts.userId, userId), ne(drafts.status, "removed")))
      .orderBy(desc(drafts.updatedAt), desc(drafts.id)),
  });
  const notificationChild = factories.notifications({ db, send: options.push.send, reportError: options.reportNotificationError });
  const notifications: NotificationsService = {
    ...notificationChild,
    queue: (userId, creationId) => Effect.suspend(() => stopped || !textAdmitted ? Effect.void : notificationChild.queue(userId, creationId)),
  };
  const legacy = factories.legacy({ db, database: options.database, media: options.media, provider: options.provider });
  const images = factories.images({ database: options.database, media: options.media, provider: options.provider, events, now });
  const kickImages = () => Effect.suspend(() => stopped || !imagesAdmitted ? Effect.void : images.kick());
  const text = factories.text({
    database: options.database, now,
    runAttempt: (work, lease) => runDurableTextAttempt(work, {
      database: options.database, provider: options.provider, lease,
      publishEffect: events.publish,
      removeDraftImageEffect: options.media.removeDraftImage,
      notifyEffect: notifications.queue,
      kickImagesEffect: kickImages,
      // The text workflow's attempt finalizer already kicks its own scheduler.
      kickEffect: () => Effect.void,
    }),
  });
  const audio = factories.audio({ database: options.database, media: options.media, elevenLabs: options.elevenLabs });
  const maintenance = factories.maintenance({
    database: options.database, media: options.media, now: () => now().getTime(), reportError: options.reportSweepError,
  });

  const recoverAndStart = (): Effect.Effect<void, DatabaseFailure> => Effect.suspend(() => {
    if (stopped) return Effect.void;
    if (starting) return Deferred.await(starting);
    const completion = Deferred.unsafeMake<void, DatabaseFailure>(FiberId.none);
    starting = completion;
    const start = Effect.gen(function* () {
      yield* text.recover(now(), { allLeases: true, includeUnleased: true });
      if (stopped) return;
      textAdmitted = true;
      options.onTextAdmission?.();
      yield* text.start();
      if (stopped) return;
      yield* images.recover(now(), { allLeases: true });
      if (stopped) return;
      imagesAdmitted = true;
      yield* images.start();
      if (stopped) return;
      yield* maintenance.start();
    });
    return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const result = yield* Effect.exit(restore(start));
      yield* Deferred.done(completion, result);
      return yield* result;
    }));
  });

  const stop = (): Effect.Effect<void> => Effect.suspend(() => {
    if (stopping) return Deferred.await(stopping);
    stopped = true;
    const completion = Deferred.unsafeMake<void>(FiberId.none);
    stopping = completion;
    return Effect.uninterruptible(Effect.gen(function* () {
      // Capture exits so one defective finalizer never skips another cleanup.
      const results = yield* Effect.all([
        legacy.stop, maintenance.stop, text.stop, images.stop, audio.stop, notificationChild.stop,
      ].map((cleanup) => Effect.exit(Effect.suspend(cleanup))), { concurrency: "unbounded" });
      const cause = results.reduce<Cause.Cause<never>>((combined, result) =>
        Exit.isFailure(result) ? Cause.parallel(combined, result.cause) : combined, Cause.empty);
      const result = Cause.isEmpty(cause) ? Exit.void : Exit.failCause(cause);
      yield* Deferred.done(completion, result);
      return yield* result;
    }));
  });

  return {
    recoverAndStart,
    kickText: (userId) => Effect.suspend(() => stopped || !textAdmitted ? Effect.void : text.kick(userId)),
    kickImages,
    stop,
    settle: () => Effect.all([
      legacy.settle(), text.settle(), images.settle(), audio.settle(),
      notificationChild.settle(),
    ], { discard: true }),
    events, notifications, legacy, text, images, audio,
  };
}
