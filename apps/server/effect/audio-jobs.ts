import { Context, Effect, Exit, Fiber, SynchronizedRef } from "effect";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { cards, notes, type Card } from "../db/schema.ts";
import { ttsTextForCard } from "../tts/eligibility.ts";
import type { DatabaseService } from "./database.ts";
import type { ElevenLabsService } from "./elevenlabs.ts";
import type { MediaStoreService } from "./media.ts";
import { DatabaseFailure, MediaFailure, ProviderFailure } from "./errors.ts";
import { makeBackgroundFibers } from "./background-fibers.ts";

export type AudioCardRow = Pick<Card, "id" | "audioStatus">;

export class AudioCardNotFoundError extends Error {
  constructor() { super("audio card not found"); this.name = "AudioCardNotFoundError"; }
}
export class AudioCardIneligibleError extends Error {
  constructor() { super("card is not eligible for audio"); this.name = "AudioCardIneligibleError"; }
}

export type AudioJobFailure = AudioCardNotFoundError | AudioCardIneligibleError | DatabaseFailure | ProviderFailure | MediaFailure;
export type AudioJobsService = Readonly<{
  generateCard(userId: string, cardId: string): Effect.Effect<void, AudioJobFailure>;
  generateNote(userId: string, cardIds: readonly string[], concurrency?: number): Effect.Effect<void>;
  resumeOrphaned(userId: string, cards: readonly AudioCardRow[]): Effect.Effect<void>;
  invalidate(cardId: string): Effect.Effect<void>;
  hasLiveJob(cardId: string): Effect.Effect<boolean>;
  stop(): Effect.Effect<void>;
  settle(): Effect.Effect<void>;
}>;
export class AudioJobs extends Context.Tag("@mnimi/server/AudioJobs")<AudioJobs, AudioJobsService>() {}

export type AudioJobsOptions = Readonly<{
  database: Pick<DatabaseService, "db" | "withWriteLock">;
  elevenLabs: ElevenLabsService;
  media: Pick<MediaStoreService, "writeAudio" | "audioExists" | "removeAudio">;
  uuidv7?: () => string;
}>;

type Job = Readonly<{ generation: number; token: symbol; fiber: Fiber.RuntimeFiber<void, AudioJobFailure> }>;
type State = Readonly<{ generations: ReadonlyMap<string, number>; jobs: ReadonlyMap<string, Job> }>;
const databaseEffect = <A>(operation: string, work: () => PromiseLike<A>): Effect.Effect<A, DatabaseFailure> =>
  Effect.tryPromise({ try: () => Promise.resolve(work()), catch: (cause) => new DatabaseFailure({ operation, cause }) });

/** One application-owned instance keeps registration and generation fences together. */
export function makeAudioJobs(options: AudioJobsOptions): AudioJobsService {
  const state = SynchronizedRef.unsafeMake<State>({ generations: new Map(), jobs: new Map() });
  const fibers = makeBackgroundFibers();
  let stopped = false;
  const { db } = options.database;
  const generationOf = (snapshot: State, cardId: string) => snapshot.generations.get(cardId) ?? 0;
  const isCurrent = (cardId: string, generation: number) => SynchronizedRef.get(state).pipe(
    Effect.map((snapshot) => generationOf(snapshot, cardId) === generation),
  );
  const report = (message: string, cardId: string, error: unknown) => Effect.sync(() => console.error(message, cardId, error));
  const hasLiveJob = (cardId: string) => SynchronizedRef.get(state).pipe(
    Effect.map((snapshot) => snapshot.jobs.get(cardId)?.generation === generationOf(snapshot, cardId)),
  );
  const invalidate = (cardId: string) => SynchronizedRef.update(state, (snapshot) => {
    const generations = new Map(snapshot.generations);
    generations.set(cardId, generationOf(snapshot, cardId) + 1);
    const jobs = new Map(snapshot.jobs); jobs.delete(cardId);
    return { generations, jobs };
  });

  const generateCard: AudioJobsService["generateCard"] = (userId, cardId) => Effect.gen(function* () {
    if (stopped) return;
    // Capture before authorization: a delayed lookup must not register work for
    // an already invalidated generation or join its replacement.
    const generation = generationOf(yield* SynchronizedRef.get(state), cardId);
    const [row] = yield* databaseEffect("audio.lookup", () => db.select({
      front: cards.front, audioPath: cards.audioPath, audioStatus: cards.audioStatus,
      domain: notes.domain, language: notes.language,
    }).from(cards).innerJoin(notes, eq(cards.noteId, notes.id))
      .where(and(eq(cards.id, cardId), eq(cards.userId, userId))).limit(1));
    if (!row) return yield* Effect.fail(new AudioCardNotFoundError());
    const text = ttsTextForCard({ domain: row.domain, language: row.language }, { front: row.front });
    if (text === null) return yield* Effect.fail(new AudioCardIneligibleError());
    const current = () => isCurrent(cardId, generation);
    const fence = and(eq(cards.id, cardId), eq(cards.userId, userId));

    const work = Effect.gen(function* () {
      if (row.audioStatus === "ready" && row.audioPath !== null && (yield* options.media.audioExists(row.audioPath))) return;
      yield* options.database.withWriteLock("audio.generating", Effect.gen(function* () {
        if (!(yield* current())) return;
        yield* databaseEffect("audio.generating", () => db.update(cards).set({ audioPath: null, audioStatus: "generating" }).where(fence));
      }));
      if (!(yield* current())) return;
      const bytes = yield* options.elevenLabs.synthesizeSpeech(text).pipe(Effect.mapError((error) => error._tag === "DependencyUnavailable"
        ? new ProviderFailure({ provider: "elevenlabs", operation: "elevenlabs.synthesizeSpeech", message: error.message, cause: error })
        : error));
      if (!(yield* current())) return;

      // Observe a non-cancelable disk write before honoring interruption. Once
      // acquired, every unattached path is covered by this finalizer.
      yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const audioPath = yield* options.media.writeAudio(userId, (options.uuidv7 ?? uuidv7)(), bytes);
        let attached = false;
        let cleanupFailure: MediaFailure | undefined;
        const settle = options.database.withWriteLock("audio.ready", Effect.gen(function* () {
          if (!(yield* current())) return;
          const updated = yield* databaseEffect("audio.ready", () => db.update(cards)
            .set({ audioPath, audioStatus: "ready" }).where(fence).returning({ id: cards.id }));
          attached = updated.length > 0 && (yield* current());
        }));
        const settled = yield* Effect.exit(restore(Effect.yieldNow()).pipe(
          Effect.zipRight(settle),
          Effect.ensuring(Effect.suspend(() => attached ? Effect.void : options.media.removeAudio(audioPath).pipe(
            Effect.catchAll((error) => Effect.zipRight(
              Effect.sync(() => { cleanupFailure = error; }),
              report("failed to remove card audio", cardId, error),
            )),
          ))),
        ));
        if (Exit.isFailure(settled)) return yield* Effect.failCause(settled.cause);
        if (cleanupFailure) return yield* Effect.fail(cleanupFailure);
      }));
    }).pipe(Effect.catchAll((error) => Effect.gen(function* () {
      if (!(yield* current())) return;
      yield* options.database.withWriteLock("audio.failed", Effect.gen(function* () {
        // Recheck after waiting for the lock: replacement may have started.
        if (!(yield* current())) return;
        yield* databaseEffect("audio.failed", () => db.update(cards).set({ audioPath: null, audioStatus: "failed" }).where(fence));
      })).pipe(Effect.catchAll((statusError) => report("failed to persist card audio failure", cardId, statusError)));
      return yield* Effect.fail(error);
    })));

    const fiber = yield* SynchronizedRef.modifyEffect(state, (snapshot) => {
      if (generationOf(snapshot, cardId) !== generation) return Effect.succeed([undefined, snapshot] as const);
      const registered = snapshot.jobs.get(cardId);
      if (registered?.generation === generation) return Effect.succeed([registered.fiber, snapshot] as const);
      const token = Symbol(cardId);
      const release = SynchronizedRef.update(state, (latest) => {
        if (latest.jobs.get(cardId)?.token !== token) return latest;
        const jobs = new Map(latest.jobs); jobs.delete(cardId);
        return { ...latest, jobs };
      });
      return Effect.map(fibers.fork(Effect.interruptible(work).pipe(Effect.ensuring(release))), (fiber) => {
        const jobs = new Map(snapshot.jobs); jobs.set(cardId, { generation, token, fiber });
        return [fiber, { ...snapshot, jobs }] as const;
      });
    });
    if (fiber) yield* Fiber.join(fiber);
  });

  const generateNote: AudioJobsService["generateNote"] = (userId, cardIds, concurrency = 2) => Effect.forEach(
    cardIds,
    (cardId) => generateCard(userId, cardId).pipe(Effect.catchAll((error) => report("card audio generation failed", cardId, error))),
    { concurrency: Math.min(2, Math.max(1, Math.floor(concurrency))), discard: true },
  );
  const resumeOrphaned: AudioJobsService["resumeOrphaned"] = (userId, rows) => Effect.forEach(rows, (row) => Effect.gen(function* () {
    if ((row.audioStatus !== "pending" && row.audioStatus !== "generating") || (yield* hasLiveJob(row.id))) return;
    yield* fibers.fork(generateCard(userId, row.id).pipe(Effect.catchAll((error) => report("orphaned card audio generation failed", row.id, error))));
  }), { discard: true });
  return {
    generateCard, generateNote, resumeOrphaned, invalidate, hasLiveJob,
    stop: () => Effect.sync(() => { stopped = true; }),
    settle: fibers.settle,
  };
}
