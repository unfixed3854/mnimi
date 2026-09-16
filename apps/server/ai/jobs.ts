import { Effect, Fiber } from "effect";
import { and, eq, or } from "drizzle-orm";
import { channel } from "./channel.ts";
import type { Channel } from "./channel.ts";
import type { ModelCalls } from "./generate-note.ts";
import type { Classification, GeneratedCard, GeneratedNote } from "./schemas.ts";
import { decks, drafts, notes } from "../db/schema.ts";
import type { Draft, DraftImageStatus } from "../db/schema.ts";
import type { Db } from "../db/index.ts";
import { withWriteLock } from "../db/write-lock.ts";
import { setNoteImageFailed } from "../images.ts";
import { makeEffectPull } from "../effect/ai-generation.ts";
import {
  makeBackgroundProvider,
  type BackgroundProviderService,
} from "../effect/background-provider.ts";
import { ProviderFailure } from "../effect/errors.ts";
import { makeLegacyCreationWorkflow } from "../effect/legacy-creation.ts";

/**
 * What a watcher sees. `snapshot` is the whole row, so a late joiner never
 * replays; everything after it is a delta on that.
 *
 * `failed` is an EVENT, deliberately reversing the 2026-08-07 spec's decision
 * to throw instead. That spec was right when the iterator *was* the
 * generation. `subscribe` observes a job that may have failed before this
 * request existed, so a throw would assert "watching failed" — a different
 * fact, and the one the client's reconnect logic keys on. A thrown error out
 * of a watch now means exactly one thing: the connection broke.
 */
export type DraftEvent =
  | { type: "snapshot"; draft: Draft }
  | { type: "classified"; classification: Classification }
  | { type: "image-prompt"; prompt: string | null }
  | { type: "cards"; cards: GeneratedCard[] }
  | { type: "retry" }
  | { type: "done"; classification: Classification; generation: GeneratedNote }
  | { type: "image"; status: DraftImageStatus; draftImageId: string | null }
  | { type: "failed"; message: string };

/** Every seam that reaches a model or the disk, injected so a test drives a
 *  whole job without either. */
export type JobDeps = {
  db: Db;
  modelCalls: ModelCalls;
  generateImageBytes: (prompt: string) => Promise<Uint8Array>;
  writeDraftImage: (userId: string, bytes: Uint8Array) => Promise<string>;
  claimDraftImage: (
    userId: string,
    draftId: string,
    noteId: string,
  ) => Promise<string>;
  removeImage: (relativePath: string) => Promise<void>;
  removeDraftImage: (userId: string, draftId: string) => Promise<void>;
};

type Job = {
  /** The job's own view of the row, kept current so a subscriber can be
   *  handed a snapshot without a database round trip. */
  draft: Draft;
  subscribers: Set<Channel<DraftEvent>>;
  abort: AbortController;
  /** Bumped whenever an image attempt is superseded. A result carrying an
   *  older number is discarded rather than written. */
  imageAttempt: number;
  /** Every image attempt ever started, awaited before the job is dropped. */
  imageStages: Promise<void>[];
  /** Attempts that have been DECIDED ON but not yet pushed onto
   *  `imageStages`. Claimed synchronously by `startImageJob`'s attach branch,
   *  in the same block as the `jobs.get` that decided to attach, and released
   *  once the stage is pushed. Without it the two are separated by a `patch` —
   *  a write-lock acquisition and a round trip — and a drain that empties
   *  inside that gap tears the job down under a stage that is about to
   *  start. */
  pendingStages: number;
  /** Set synchronously by `claimJobForNote` when a note is saved while the
   *  picture is still rendering. */
  noteId: string | null;
};

/**
 * Explicit-dependency compatibility path for callers without an installed
 * workflow. Production operations below delegate to the installed instance,
 * whose registry, image stages and subscribers are owned by that instance.
 */
const jobs = new Map<string, Job>();

/** Full snapshots supersede each other, so a queued one may be replaced. */
const coalesceCards = (previous: DraftEvent, next: DraftEvent) =>
  previous.type === "cards" && next.type === "cards";

export function hasJob(draftId: string): boolean { return jobs.has(draftId); }

export function abortJob(draftId: string): void {
  jobs.get(draftId)?.abort.abort();
}

/**
 * How many live subscriptions a job currently has.
 *
 * Exported for tests, and only for them. A channel that `subscribe` failed to
 * unregister is invisible from outside this module — `push` onto it is a
 * no-op nobody reads, `close` on it is a no-op too — so the leak has no
 * consequence any black-box assertion can reach, and looking is the only
 * honest way to pin the cleanup that prevents it.
 */
export function subscriberCount(draftId: string): number {
  return jobs.get(draftId)?.subscribers.size ?? 0;
}

/**
 * Redirects a running image stage from its draft onto a note.
 *
 * Synchronous, and called by `notes.save` from inside its write-lock section,
 * so the stage's own locked settle cannot interleave: see the spec's §3.3.
 * Returns true when there was something to redirect, which is how `save`
 * knows not to mark the note `imageFailed`.
 */
export function claimJobForNote(draftId: string, noteId: string): boolean {
  const job = jobs.get(draftId);
  if (!job || job.draft.imageStatus !== "generating") return false;
  job.noteId = noteId;
  return true;
}

/**
 * Whether some job still holds the picture destined for this note — the note
 * was saved (`claimJobForNote`) while the image was still rendering, and the
 * render hasn't settled yet. A job is removed from `jobs` the moment it
 * settles (see `runGeneration`'s and `startImageJob`'s `finally` blocks), so
 * this is exactly "still generating in the background" and nothing more.
 */
export function hasJobForNote(noteId: string): boolean {
  for (const job of jobs.values()) {
    if (job.noteId === noteId) return true;
  }
  return false;
}

/**
 * Attaches to a running job, or returns null if there is none.
 *
 * Registration and the snapshot read happen in the same synchronous block
 * before the generator is returned, which is what makes "subscribe" atomic:
 * nothing can be published between the two, so no event is ever lost to the
 * gap, and the caller's `hasJob`-then-`subscribe` race disappears because the
 * lookup is in here.
 */
export function subscribe(draftId: string): AsyncGenerator<DraftEvent> | null {
  const job = jobs.get(draftId);
  if (!job) return null;

  const ch = channel<DraftEvent>(coalesceCards);
  job.subscribers.add(ch);
  const snapshot = job.draft;

  return (async function* () {
    try {
      yield { type: "snapshot", draft: snapshot };
      yield* ch;
    } finally {
      // A closed tab must not leave a channel accumulating events forever.
      job.subscribers.delete(ch);
    }
  })();
}

function publish(job: Job, event: DraftEvent) {
  for (const ch of job.subscribers) ch.push(event);
}

function legacyProvider(deps: JobDeps): BackgroundProviderService {
  const failure = (operation: string, cause: unknown) =>
    cause instanceof ProviderFailure
      ? cause
      : new ProviderFailure({
        provider: "legacy",
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

  return makeBackgroundProvider({
    classify: (prompts) => Effect.tryPromise({
      try: () => deps.modelCalls.classify(prompts),
      catch: (cause) => failure("legacy.classify", cause),
    }),
    generate: (prompts) => Effect.try({
      try: () => makeEffectPull<string, unknown, ProviderFailure>(
        deps.modelCalls.generate(prompts),
        (cause) => failure("legacy.generate", cause),
      ),
      catch: (cause) => failure("legacy.generate", cause),
    }),
    route: () => Effect.die("legacy creation does not route"),
    adjust: () => Effect.die("legacy creation does not adjust"),
    generateImageBytes: (prompt) => Effect.tryPromise({
      try: () => deps.generateImageBytes(prompt),
      catch: (cause) => failure("legacy.generate-image", cause),
    }),
  });
}

/** Persists a change and mirrors it onto the job's snapshot. Never call this
 *  from inside a `withWriteLock` section — it takes the lock itself. */
async function patch(deps: JobDeps, job: Job, values: Partial<Draft>) {
  await withWriteLock(() =>
    deps.db.update(drafts).set(values).where(eq(drafts.id, job.draft.id))
  );
  job.draft = { ...job.draft, ...values };
}

function startImageStage(deps: JobDeps, job: Job, prompt: string): void {
  const attempt = ++job.imageAttempt;
  job.imageStages.push(
    runImageStage(deps, job, prompt, attempt).catch((error) => {
      // The settle already reported every failure it could classify; this
      // catch exists so an unexpected one cannot become an unhandled
      // rejection that takes the process down.
      console.error("draft image stage failed", error);
    }),
  );
}

async function runImageStage(
  deps: JobDeps,
  job: Job,
  prompt: string,
  attempt: number,
) {
  let bytes: Uint8Array;
  try {
    bytes = await deps.generateImageBytes(prompt);
  } catch (error) {
    console.error("draft image generation failed", error);
    if (attempt !== job.imageAttempt || job.abort.signal.aborted) return;
    await patch(deps, job, { imageStatus: "failed" });
    publish(job, { type: "image", status: "failed", draftImageId: null });
    return;
  }

  // A retry discarded the attempt this prompt came from. The bytes were paid
  // for the moment the request went out — OpenRouter's image endpoint takes
  // no abort signal — so discarding on arrival is the honest description of
  // what happens, and retries are rare enough not to warrant more.
  if (attempt !== job.imageAttempt) return;

  const draftImageId = await deps.writeDraftImage(job.draft.userId, bytes);

  // The settle. One locked read-then-write, which is what makes this and
  // `notes.save` unable to interleave: whichever takes the lock first, the
  // other sees a settled world. See the spec's §3.3.
  //
  // Every write in here uses `deps.db` directly. Calling `patch` would nest
  // withWriteLock inside itself and deadlock.
  await withWriteLock(async () => {
    // Re-checked as the first thing inside the lock, not just before it was
    // acquired: `writeDraftImage` and the wait for the lock itself are both
    // real awaits, during which a `retry` on the independently progressing
    // cards side can still bump `imageAttempt`. Skipping this would let a
    // discarded attempt write `imageStatus: "ready"` with a stale
    // `draftImageId` and publish a stale `image` event.
    if (attempt !== job.imageAttempt) return;

    const [row] = await deps.db
      .select()
      .from(drafts)
      .where(eq(drafts.id, job.draft.id))
      .limit(1);

    if (row) {
      try {
        await deps.db
          .update(drafts)
          .set({ imageStatus: "ready", draftImageId })
          .where(eq(drafts.id, job.draft.id));
        job.draft = { ...job.draft, imageStatus: "ready", draftImageId };
        publish(job, { type: "image", status: "ready", draftImageId });
      } catch (error) {
        // A throw here must not escape as an unhandled rejection that only a
        // reboot clears: without this, the row stays wedged at "generating"
        // forever with no "image" event, and any watcher spins.
        console.error("could not record the picture on the draft", error);
        await deps.db
          .update(drafts)
          .set({ imageStatus: "failed" })
          .where(eq(drafts.id, job.draft.id));
        job.draft = { ...job.draft, imageStatus: "failed" };
        publish(job, { type: "image", status: "failed", draftImageId: null });
      }
      return;
    }

    // The row is gone. Either it was saved — in which case `claimJobForNote`
    // left us a destination — or it was discarded and this file has no owner.
    if (job.noteId) {
      try {
        const imagePath = await deps.claimDraftImage(
          job.draft.userId,
          draftImageId,
          job.noteId,
        );
        const attached = await deps.db
          .update(notes)
          .set({ imagePath })
          .where(
            and(
              eq(notes.id, job.noteId),
              eq(notes.userId, job.draft.userId),
            ),
          )
          .returning({ id: notes.id });
        if (attached.length === 0) await deps.removeImage(imagePath);
      } catch (error) {
        // The bytes exist but could not be attached. The note is still a
        // valid note; it just has no picture, and its screen offers a retry.
        console.error("could not attach the image to its note", error);
        await setNoteImageFailed(deps.db, job.draft.userId, job.noteId, true);
      }
      return;
    }

    await deps.removeDraftImage(job.draft.userId, draftImageId);
  });
}

/**
 * A yield that reaches the MACROTASK queue.
 *
 * `await Promise.resolve()` does not, and the difference is not stylistic: an
 * await on an already-resolved promise schedules a microtask, and V8 drains
 * the microtask queue to EMPTY — including microtasks enqueued while it is
 * draining — before the event loop advances to any timer or I/O callback. A
 * poll built on one therefore never lets the round trip it is waiting for
 * complete. Measured on this runtime: 200 000 microtask spins run in 8 ms with
 * a `setTimeout(…, 0)` registered beforehand still pending, while one call to
 * this lets that same timer through on the first spin.
 *
 * The cost is a real but small one. `setTimeout(…, 0)` is clamped — measured
 * at ~2 ms here — so this is a ~2 ms poll for the duration of a single UPDATE,
 * not a busy-wait: it holds no lock and burns no CPU between turns, so the
 * write it is waiting for is free to run.
 *
 * Exported only so a test can pin the macrotask property directly, with a
 * BOUNDED spin. Its one real caller is `drainImageStages`, and a test at that
 * level is deliberately not attempted: the drain's loop is unbounded, so a
 * regression there does not go red, it starves the event loop outright —
 * verified, a drain-level probe against a `Promise.resolve()` yield outlived
 * vitest's own 20 s per-test timeout (that timeout is itself a timer, and a
 * starved one) and had to be killed from outside after 90 s. A guard that
 * wedges CI is worse than the one below, which fails in milliseconds.
 */
export function yieldToMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Awaits every image stage a job currently has queued, including ones pushed
 * WHILE this very await is in flight.
 *
 * Not `Promise.all(job.imageStages)`: that snapshots the array once, so a
 * stage started while the snapshot is still pending — retrying the picture
 * while the original is still rendering, or a second `startImageJob` call
 * attaching to a first that's already draining — would be missed entirely.
 * `jobs.delete` and the channel closes would then run while that stage is
 * still in flight: `hasJob` would lie, `claimJobForNote` could no longer
 * retarget it, and its `publish` would land on a channel already closed.
 * Each pass takes a COPY of the array and removes only what it awaited, so two
 * drains running at once still see each other's stages. Splicing instead would
 * empty the array for everyone: `startImageStage` and `drainImageStages` push
 * then splice in one synchronous block, so a second drain starting while the
 * first is in flight would take the first's stages away from it, and the first
 * would return the moment its own (superseded, instantly-bailing) stage
 * resolved — running the very cleanup this function exists to defer.
 *
 * `allSettled`, not `all`: a rejecting stage must not skip the cleanup that
 * follows this call. Each stage owns reporting its own failure to the row
 * before this ever awaits it.
 *
 * `pendingStages` extends that to attempts that have been decided on but not
 * yet pushed: a retry attaches synchronously and only pushes its stage a
 * `patch` later, so "the array is empty" is not the same question as "the job
 * is finished with".
 */
async function drainImageStages(job: Job): Promise<void> {
  while (job.imageStages.length > 0 || job.pendingStages > 0) {
    if (job.imageStages.length === 0) {
      // Nothing to await yet — a claimed stage's `patch` is still in flight,
      // and that `patch` is a write-lock acquisition plus a round trip. See
      // `yieldToMacrotask` for why the yield cannot be a bare `await`.
      await yieldToMacrotask();
      continue;
    }
    const pending = [...job.imageStages];
    await Promise.allSettled(pending);
    job.imageStages = job.imageStages.filter((p) => !pending.includes(p));
  }
}

/** Sets the row's `imageStatus` to `"generating"`, starts one image stage
 *  from the job's own prompt, and waits for every stage the job ends up
 *  with. Shared by both branches of `startImageJob` so a retry that attaches
 *  to a job whose picture just failed re-arms `imageStatus` exactly like a
 *  fresh one does — leaving it stale would disarm `claimJobForNote` and let
 *  a freshly rendered picture be deleted as ownerless.
 *
 *  `claimed` marks the call that already took a slot in `job.pendingStages`.
 *  The release is in a `finally` rather than after the push, so a `patch` that
 *  throws — the row rejecting the write, the lock chain rejecting — cannot
 *  leave the claim standing and every drain on this job waiting on a stage
 *  that will never arrive. */
async function runImageRetry(
  deps: JobDeps,
  job: Job,
  claimed = false,
): Promise<void> {
  try {
    await patch(deps, job, { imageStatus: "generating" });
    startImageStage(deps, job, job.draft.imagePrompt!);
  } finally {
    if (claimed) job.pendingStages--;
  }
  await drainImageStages(job);
}

/**
 * Restarts just the picture, for a draft whose cards are already settled.
 *
 * A full Job rather than a bare promise, so a retry is subscribable and
 * `claimJobForNote` can retarget it exactly like a first attempt.
 *
 * Never rejects: `drafts.retryImage` fires this and forgets it exactly as
 * the router does `startGenerationJob`, so an unhandled rejection here would
 * take down the whole process the same way `run`'s doc comment explains.
 */
export function startImageJob(deps: JobDeps, draft: Draft): Promise<void> {
  const existing = jobs.get(draft.id);
  if (existing) {
    if (!existing.draft.imagePrompt) return Promise.resolve();
    // Claimed HERE, synchronously, in the same block as the `jobs.get` that
    // decided to attach — that is what makes the decision and the
    // registration atomic. Everything between them is microtasks, and a
    // microtask chain cannot be interrupted by another request, so the job
    // this found cannot be torn down before the claim lands. Deferring the
    // claim to `runImageRetry` would put a `patch` in front of it and reopen
    // the very window it closes.
    //
    // `imageStatus` is re-armed on the job's own copy in the same breath, for
    // the same reason and against the same window. `runImageRetry`'s `patch`
    // does eventually mirror it, but `claimJobForNote` reads THIS field, not
    // the row — so leaving it stale until the write lands would make the job
    // registered-but-unclaimable for a whole round trip, and a `notes.save`
    // arriving in there would mark its note `imageFailed` and delete the row,
    // leaving the stage about to start with no row and no `noteId` and its
    // finished picture removed as ownerless. The fresh-job branch below has no
    // such window because its object literal is already "generating" before
    // `jobs.set`; this keeps the two symmetric.
    existing.pendingStages++;
    existing.draft = { ...existing.draft, imageStatus: "generating" };
    return runImageRetry(deps, existing, true).catch((error) => {
      console.error("image retry job crashed", error);
    });
  }

  if (!draft.imagePrompt) return Promise.resolve();

  const job: Job = {
    draft: { ...draft, imageStatus: "generating" },
    subscribers: new Set(),
    abort: new AbortController(),
    imageAttempt: 0,
    imageStages: [],
    pendingStages: 0,
    noteId: null,
  };
  jobs.set(draft.id, job);

  return runImageRetry(deps, job)
    .catch((error) => {
      console.error("image retry job crashed", error);
    })
    .finally(() => {
      jobs.delete(job.draft.id);
      for (const ch of job.subscribers) ch.close();
    });
}

export function startGenerationJob(
  deps: JobDeps,
  draft: Draft,
  nativeLanguage: string,
): Promise<void> {
  const job: Job = {
    draft,
    subscribers: new Set(),
    abort: new AbortController(),
    imageAttempt: 0,
    imageStages: [],
    pendingStages: 0,
    noteId: null,
  };
  jobs.set(draft.id, job);
  return run(deps, job, nativeLanguage);
}

/**
 * Never rejects. `startGenerationJob`'s promise is fired and forgotten by the
 * drafts router, so an unhandled rejection here would take down the whole
 * Deno process. Every error this can produce — including one raised from
 * INSIDE `runGeneration`'s own `catch` block, e.g. `patch` failing while
 * recording the very failure it is reacting to — is logged and swallowed at
 * this outer boundary rather than escaping.
 */
async function run(deps: JobDeps, job: Job, nativeLanguage: string): Promise<void> {
  try {
    await runGeneration(deps, job, nativeLanguage);
  } catch (error) {
    console.error("draft generation job crashed", error);
  }
}

async function runGeneration(deps: JobDeps, job: Job, nativeLanguage: string) {
  try {
    const workflow = makeLegacyCreationWorkflow({
      db: deps.db,
      provider: legacyProvider(deps),
    });
    const fiber = Effect.runSync(workflow.start({
      draft: job.draft,
      nativeLanguage,
      isAborted: () => job.abort.signal.aborted,
      updateSnapshot: (draft) => Effect.sync(() => { job.draft = draft; }),
      publish: (event) => Effect.sync(() => { publish(job, event); }),
      startImage: (_draft, prompt) => Effect.sync(() => {
        startImageStage(deps, job, prompt);
      }),
      retryImage: () => Effect.sync(() => { job.imageAttempt++; }),
    }));
    await Effect.runPromise(Fiber.join(fiber));
  } finally {
    // The image routinely outlives the cards now, and `claimJobForNote` has
    // to be able to find the job until it settles. See `drainImageStages`
    // for why this can't be a single `Promise.all(job.imageStages)`.
    await drainImageStages(job);
    jobs.delete(job.draft.id);
    for (const ch of job.subscribers) ch.close();
  }
}

const RESTARTED = "The server restarted while this was generating.";

/**
 * Every in-flight job died with the process. The two columns are reconciled
 * independently because the two stages are independent: a draft whose cards
 * finished and whose picture was still rendering comes back `ready` with a
 * failed image and a working retry, not failed outright.
 */
export async function reconcileOrphanedDrafts(db: Db): Promise<number> {
  const orphaned = await db
    .select()
    .from(drafts)
    .where(or(eq(drafts.status, "generating"), eq(drafts.imageStatus, "generating")));

  for (const draft of orphaned) {
    await withWriteLock(() =>
      db
        .update(drafts)
        .set({
          status: draft.status === "generating" ? "failed" : draft.status,
          error: draft.status === "generating" ? RESTARTED : draft.error,
          imageStatus: draft.imageStatus === "generating" ? "failed" : draft.imageStatus,
        })
        .where(eq(drafts.id, draft.id))
    );
  }

  return orphaned.length;
}

/**
 * Reconciles a single row read outside the boot sweep — a `generating` row
 * with no live job behind it. Returns the row as it now stands.
 *
 * The caller must ensure that precondition itself (no live job for this
 * draft) before calling this — it is not checked in here. The drafts router
 * is expected to hold that guard, e.g. by consulting `hasJob` first.
 *
 * The row handed in is only a hint. `drafts.watch` reads it, then asks
 * `subscribe`, and only then arrives here; a job that commits `done` and
 * deletes itself while that SELECT is in flight leaves the caller holding a
 * stale "generating" copy of a row that is now `ready`. Writing that copy
 * back would tell the user a generation that succeeded had been killed by a
 * server restart. So the decision is made from a re-read inside the locked
 * section, where nothing else can be mid-write.
 */
export async function reconcileDraft(db: Db, draft: Draft): Promise<Draft> {
  if (draft.status !== "generating" && draft.imageStatus !== "generating") {
    return draft;
  }

  return await withWriteLock(async () => {
    const [row] = await db
      .select()
      .from(drafts)
      .where(eq(drafts.id, draft.id))
      .limit(1);
    // Saved into a note, or discarded, while the caller was reading. There is
    // no row left to write to — but handing the caller's copy back unchanged
    // strands the page: it still says `generating`, `watch` yields it, the
    // stream ends cleanly, and `runDraftWatch` reads a clean end as "settled,
    // nothing to reconnect to". `/add`'s watch effect keys on the draft id and
    // whether anything is moving, neither of which changed, so nothing ever
    // reopens it and the skeleton stays up until a reload. Reported as failed
    // instead, which is the one shape the client turns into an editable
    // screen. The message is `RESTARTED` rather than something truer about a
    // vanished row because nothing about a vanished row is worth a second
    // string here: the client renders whatever it is given verbatim, this is
    // an unobservable race that self-heals on the next load, and the remedy
    // offered — write the card yourself — is the same either way.
    if (!row) {
      return {
        ...draft,
        status: "failed",
        error: RESTARTED,
        imageStatus: draft.imageStatus === "generating" ? "failed" : draft.imageStatus,
      };
    }
    if (row.status !== "generating" && row.imageStatus !== "generating") {
      return row;
    }

    const values = {
      status: row.status === "generating" ? ("failed" as const) : row.status,
      error: row.status === "generating" ? RESTARTED : row.error,
      imageStatus:
        row.imageStatus === "generating" ? ("failed" as const) : row.imageStatus,
    };
    await db.update(drafts).set(values).where(eq(drafts.id, row.id));
    return { ...row, ...values };
  });
}
