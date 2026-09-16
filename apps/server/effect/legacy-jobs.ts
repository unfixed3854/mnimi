import { Effect, Fiber } from "effect";
import { and, eq } from "drizzle-orm";
import { channel, type Channel } from "../ai/channel.ts";
import type { DraftEvent } from "../ai/jobs.ts";
import { drafts, notes, type Draft } from "../db/schema.ts";
import { setNoteImageFailed } from "../images.ts";
import type { DatabaseService } from "./database.ts";
import type { MediaStoreService } from "./media.ts";
import type { BackgroundProviderService } from "./background-provider.ts";
import type { LegacyCreationInput } from "./legacy-creation.ts";
import { DatabaseFailure, DependencyUnavailable } from "./errors.ts";
import { makeBackgroundFibers } from "./background-fibers.ts";

export type LegacyJobDependencies = Readonly<{
  database?: Pick<DatabaseService, "db" | "withWriteLock">;
  media?: Pick<MediaStoreService, "writeDraftImage" | "claimDraftImage" | "removeImage" | "removeDraftImage">;
  provider: BackgroundProviderService;
  run: (input: LegacyCreationInput) => Effect.Effect<void, unknown>;
}>;

type Job = {
  draft: Draft;
  subscribers: Set<Channel<DraftEvent>>;
  aborted: boolean;
  attempt: number;
  stages: Fiber.RuntimeFiber<void, never>[];
  pendingStages: number;
  noteId: string | null;
};

/** All detached state belongs to this constructed instance. Transport owns iteration. */
export function makeLegacyJobs(options: LegacyJobDependencies) {
  const jobs = new Map<string, Job>();
  const fibers = makeBackgroundFibers();
  let stopped = false;
  const dbEffect = <A>(operation: string, work: () => Promise<A>) => Effect.tryPromise({
    try: work, catch: (cause) => new DatabaseFailure({ operation, cause }),
  });
  const publish = (job: Job, event: DraftEvent) => Effect.sync(() => {
    for (const subscriber of job.subscribers) subscriber.push(event);
  });
  const create = (draft: Draft): Job => ({ draft, subscribers: new Set(), aborted: false,
    attempt: 0, stages: [], pendingStages: 0, noteId: null });
  const cleanup = (job: Job) => Effect.sync(() => {
    if (jobs.get(job.draft.id) === job) jobs.delete(job.draft.id);
    for (const subscriber of job.subscribers) subscriber.close();
    job.subscribers.clear();
  });
  const report = (message: string) => (error: unknown) => Effect.sync(() => console.error(message, error));
  const drain = (job: Job): Effect.Effect<void> => Effect.suspend(() => {
    if (job.stages.length === 0) return job.pendingStages > 0
      ? Effect.zipRight(Effect.sleep(1), drain(job)) : Effect.void;
    const stages = [...job.stages];
    return Effect.all(stages.map(Fiber.await), { concurrency: "unbounded" }).pipe(
      Effect.zipRight(Effect.sync(() => { job.stages = job.stages.filter((stage) => !stages.includes(stage)); })),
      Effect.zipRight(drain(job)),
    );
  });
  const patch = (job: Job, values: Partial<Draft>) => Effect.gen(function* () {
    if (!options.database) return yield* Effect.fail(new DependencyUnavailable({ dependency: "Database", message: "Legacy image work requires the selected database" }));
    const database = options.database;
    yield* database.withWriteLock("legacy.image-patch", dbEffect("legacy.image-patch", () =>
      database.db.update(drafts).set(values).where(eq(drafts.id, job.draft.id))));
    job.draft = { ...job.draft, ...values };
  });
  const runImage = (job: Job, prompt: string, attempt: number) => Effect.suspend(() => {
    let noteFailureTarget: string | undefined;
    return Effect.gen(function* () {
    const { database, media } = options;
    if (!database || !media) return yield* Effect.fail(new DependencyUnavailable({ dependency: "Legacy image dependencies", message: "Legacy image work requires the selected database and media store" }));
    const owned = () => !job.aborted && attempt === job.attempt;
    if (!owned()) return;
    const bytes = yield* options.provider.generateImageBytes(prompt);
    if (!owned()) return;
    // Once bytes reach disk, finish settlement or compensation before interruption.
    yield* Effect.uninterruptible(Effect.gen(function* () {
      const imageId = yield* media.writeDraftImage(job.draft.userId, bytes);
      let kept = false;
      let claimed: string | undefined;
      const settle = database.withWriteLock("legacy.image-settle", Effect.gen(function* () {
        if (!owned()) return;
        const [row] = yield* dbEffect("legacy.image-read", () => database.db.select().from(drafts)
          .where(eq(drafts.id, job.draft.id)).limit(1));
        if (!owned()) return;
        if (row) {
          yield* dbEffect("legacy.image-ready", () => database.db.update(drafts).set({ imageStatus: "ready", draftImageId: imageId })
            .where(eq(drafts.id, job.draft.id)));
          kept = true;
          job.draft = { ...job.draft, imageStatus: "ready", draftImageId: imageId };
          yield* publish(job, { type: "image", status: "ready", draftImageId: imageId });
        } else if (job.noteId) {
          const noteId = job.noteId;
          noteFailureTarget = noteId;
          claimed = yield* media.claimDraftImage(job.draft.userId, imageId, noteId);
          const attached = yield* dbEffect("legacy.image-attach", () => database.db.update(notes).set({ imagePath: claimed! })
            .where(and(eq(notes.id, noteId), eq(notes.userId, job.draft.userId))).returning({ id: notes.id }));
          kept = attached.length > 0;
        }
      }));
      yield* settle.pipe(Effect.ensuring(Effect.suspend(() => kept ? Effect.void :
        (claimed ? media.removeImage(claimed) : media.removeDraftImage(job.draft.userId, imageId)).pipe(
          Effect.catchAll(report("draft image cleanup failed"))))));
    }));
  }).pipe(Effect.catchAll((error) => Effect.gen(function* () {
    yield* report("draft image generation failed")(error);
    if (job.aborted || attempt !== job.attempt) return;
    const database = options.database;
    if (!database) return yield* Effect.fail(new DependencyUnavailable({ dependency: "Database", message: "Legacy image work requires the selected database" }));
    yield* database.withWriteLock("legacy.image-failed", Effect.gen(function* () {
      // A retry can supersede this attempt while its failure waits in the
      // write queue. Both persisted state and the watch snapshot are fenced.
      if (job.aborted || attempt !== job.attempt) return;
      if (noteFailureTarget) {
        yield* dbEffect("legacy.image-note-failed", () =>
          setNoteImageFailed(database.db, job.draft.userId, noteFailureTarget!, true));
      } else {
        yield* dbEffect("legacy.image-failed", () => database.db.update(drafts).set({ imageStatus: "failed" })
          .where(eq(drafts.id, job.draft.id)));
        if (job.aborted || attempt !== job.attempt) return;
        job.draft = { ...job.draft, imageStatus: "failed" };
        yield* publish(job, { type: "image", status: "failed", draftImageId: null });
      }
    }));
    })));
  });
  const startStage = (job: Job, prompt: string, reservedAttempt?: number) => Effect.suspend(() => {
    if (stopped || job.aborted) return Effect.void;
    const attempt = reservedAttempt ?? ++job.attempt;
    if (attempt !== job.attempt) return Effect.void;
    return Effect.flatMap(fibers.fork(runImage(job, prompt, attempt).pipe(
      Effect.catchAllCause(report("draft image stage failed")))), (fiber) => Effect.sync(() => { job.stages.push(fiber); }));
  });
  const start = (input: LegacyCreationInput) => Effect.suspend(() => {
    if (stopped) return fibers.fork(Effect.void);
    const { draft, nativeLanguage } = input;
    const job = create(draft);
    jobs.set(draft.id, job);
    const generation = options.run({ draft, nativeLanguage, isAborted: () => job.aborted || input.isAborted?.() === true,
      currentSnapshot: () => job.draft,
      publish: (event) => Effect.zipRight(publish(job, event), input.publish(event)),
      updateSnapshot: (value) => Effect.sync(() => { job.draft = value; }).pipe(
        Effect.zipRight(Effect.suspend(() => input.updateSnapshot?.(value) ?? Effect.void))),
      startImage: (current, prompt) => options.media ? startStage(job, prompt) : input.startImage?.(current, prompt) ?? Effect.void,
      retryImage: () => Effect.sync(() => { job.attempt++; }).pipe(
        Effect.zipRight(Effect.suspend(() => input.retryImage?.() ?? Effect.void))),
    });
    return fibers.fork(generation.pipe(
      Effect.catchAllCause(report("draft generation job crashed")),
      Effect.ensuring(drain(job).pipe(Effect.ensuring(cleanup(job)))),
    ));
  });
  const startGeneration = (draft: Draft, nativeLanguage: string) => start({ draft, nativeLanguage, publish: () => Effect.void });
  const startImage = (draft: Draft) => Effect.suspend(() => {
    if (stopped) return fibers.fork(Effect.void);
    const existing = jobs.get(draft.id);
    const job = existing ?? create(draft);
    if (!job.draft.imagePrompt || job.aborted) return fibers.fork(Effect.void);
    // Admission supersedes the old attempt synchronously. Waiting until its
    // patch resolves would let a queued old failure overwrite the re-armed row.
    const attempt = ++job.attempt;
    job.pendingStages++;
    job.draft = { ...job.draft, imageStatus: "generating" };
    if (!existing) jobs.set(draft.id, job);
    const retry = patch(job, { imageStatus: "generating" }).pipe(
      Effect.zipRight(startStage(job, job.draft.imagePrompt!, attempt)),
      Effect.ensuring(Effect.sync(() => { job.pendingStages--; })),
      Effect.catchAllCause(report("image retry job crashed")),
      Effect.ensuring(drain(job)),
    );
    return fibers.fork(existing ? retry : retry.pipe(Effect.ensuring(cleanup(job))));
  });
  return {
    start, startGeneration, startImage,
    stop: () => Effect.sync(() => { stopped = true; }),
    settle: fibers.settle,
    hasJob: (id: string) => Effect.sync(() => jobs.has(id)),
    abortJob: (id: string) => Effect.sync(() => { const job = jobs.get(id); if (job) { job.aborted = true; job.attempt++; } }),
    subscriberCount: (id: string) => Effect.sync(() => jobs.get(id)?.subscribers.size ?? 0),
    claimJobForNote: (id: string, noteId: string) => Effect.sync(() => {
      const job = jobs.get(id);
      if (!job || job.aborted || job.draft.imageStatus !== "generating") return false;
      job.noteId = noteId;
      return true;
    }),
    hasJobForNote: (noteId: string) => Effect.sync(() => [...jobs.values()].some((job) => job.noteId === noteId)),
    openSubscription: (id: string) => Effect.sync(() => {
      const job = jobs.get(id);
      if (!job) return null;
      const events = channel<DraftEvent>((previous, next) => previous.type === "cards" && next.type === "cards");
      job.subscribers.add(events);
      return { snapshot: job.draft, events, close: Effect.sync(() => { job.subscribers.delete(events); events.close(); }) };
    }),
  };
}
