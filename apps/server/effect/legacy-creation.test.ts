import { Effect, Fiber, Runtime, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { decks, drafts, notes, user } from "../db/schema.ts";
import { makeEffectPull } from "./ai-generation.ts";
import { makeBackgroundProvider } from "./background-provider.ts";
import { ProviderFailure, MediaFailure } from "./errors.ts";
import { makeLegacyCreationWorkflow } from "./legacy-creation.ts";
import { createWriteLock } from "../db/write-lock.ts";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => void;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values({
    id: "ada",
    name: "Ada",
    email: "ada@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterEach(() => close());

const CLASSIFICATION = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};

const CARD = {
  aspect: "meaning",
  front: "die Banane",
  back: "banana",
  imageCue: false,
};
const SUMMARY = "Practise the meaning of Banane.";

async function seedDraft() {
  const [deck] = await db.insert(decks).values({
    userId: "ada",
    name: "German",
  }).returning();
  const [draft] = await db.insert(drafts).values({
    userId: "ada",
    deckId: deck.id,
    sourceText: "die Banane",
    status: "generating",
    operation: "generate",
    learningGoal: "die Banane",
  }).returning();
  return draft;
}

describe("LegacyCreationWorkflow", () => {
  it.each(["retry-first", "failure-first"])("fences the old failure under the real write lock with %s queue order", async (order) => {
    const draft = { ...await seedDraft(), imagePrompt: "banana", imageStatus: "failed" as const };
    const lock = createWriteLock();
    const firstBytes = Promise.withResolvers<Uint8Array>();
    const secondBytes = Promise.withResolvers<Uint8Array>();
    const unblock = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const queued: string[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const workflow = makeLegacyCreationWorkflow({
      db, database: { db, withWriteLock: <A, E, R>(operation: string, work: Effect.Effect<A, E, R>) => Effect.gen(function* () {
        const runtime = yield* Effect.runtime<R>();
        const result = yield* Effect.promise(() => {
          queued.push(operation);
          return lock.withWriteLock(() => Runtime.runPromiseExit(runtime)(work));
        });
        return yield* Exit.matchEffect(result, { onSuccess: Effect.succeed, onFailure: Effect.failCause });
      }) },
      provider: makeBackgroundProvider({ classify: () => Effect.die("unused"), generate: () => Effect.die("unused"), route: () => Effect.die("unused"), adjust: () => Effect.die("unused"),
        generateImageBytes: () => Effect.tryPromise({ try: () => ++calls === 1 ? firstBytes.promise : secondBytes.promise,
          catch: (cause) => new ProviderFailure({ provider: "test", operation: "image", message: "failed", cause }) }),
      }),
      media: { writeDraftImage: () => Effect.succeed("current"), claimDraftImage: () => Effect.succeed("note.png"), removeImage: () => Effect.void, removeDraftImage: () => Effect.void },
    });
    const first = Effect.runSync(workflow.startImage(draft));
    await expect.poll(() => calls).toBe(1);
    const watch = Effect.runSync(workflow.openSubscription(draft.id))!;
    const blocker = lock.withWriteLock(async () => { entered.resolve(); await unblock.promise; });
    await entered.promise;
    let second: Fiber.RuntimeFiber<void, never>;
    if (order === "retry-first") {
      second = Effect.runSync(workflow.startImage(draft));
      await expect.poll(() => queued.length).toBe(2);
      firstBytes.reject(new Error("old image failed"));
      await expect.poll(() => logged.mock.calls.length).toBe(1);
    } else {
      firstBytes.reject(new Error("old image failed"));
      await expect.poll(() => queued.length).toBe(2);
      second = Effect.runSync(workflow.startImage(draft));
      await expect.poll(() => queued.length).toBe(3);
    }
    unblock.resolve();
    await blocker;
    await expect.poll(() => calls).toBe(2);
    // Wait for the late failure to pass through the queue before observing state.
    await lock.withWriteLock(async () => {});
    const [current] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    const canTransfer = Effect.runSync(workflow.claimJobForNote(draft.id, "saved-note"));
    secondBytes.resolve(new Uint8Array([2]));
    await Effect.runPromise(Effect.all([Fiber.join(first), Fiber.join(second)]));
    await lock.close();
    const events = [];
    for await (const event of watch.events) events.push(event);
    Effect.runSync(watch.close);
    logged.mockRestore();
    expect({ calls, imageStatus: current.imageStatus, canTransfer }).toEqual({ calls: 2, imageStatus: "generating", canTransfer: true });
    expect(events).not.toContainEqual({ type: "image", status: "failed", draftImageId: null });
  });

  it("fences a queued note attachment failure after a retry takes ownership", async () => {
    const draft = { ...await seedDraft(), imagePrompt: "banana", imageStatus: "failed" as const };
    const [note] = await db.insert(notes).values({ userId: "ada", deckId: draft.deckId!, sourceText: "saved", domain: "concept", metadata: { imageFailed: false } }).returning();
    const lock = createWriteLock();
    const firstBytes = Promise.withResolvers<Uint8Array>();
    const secondBytes = Promise.withResolvers<Uint8Array>();
    const cleanupEntered = Promise.withResolvers<void>();
    const cleanupFinished = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const queued: string[] = [];
    let calls = 0;
    let claims = 0;
    const workflow = makeLegacyCreationWorkflow({
      db, database: { db, withWriteLock: <A, E, R>(operation: string, work: Effect.Effect<A, E, R>) => Effect.gen(function* () {
        const runtime = yield* Effect.runtime<R>();
        const result = yield* Effect.promise(() => {
          queued.push(operation);
          return lock.withWriteLock(() => Runtime.runPromiseExit(runtime)(work));
        });
        return yield* Exit.matchEffect(result, { onSuccess: Effect.succeed, onFailure: Effect.failCause });
      }) },
      provider: makeBackgroundProvider({ classify: () => Effect.die("unused"), generate: () => Effect.die("unused"), route: () => Effect.die("unused"), adjust: () => Effect.die("unused"),
        generateImageBytes: () => Effect.promise(() => ++calls === 1 ? firstBytes.promise : secondBytes.promise),
      }),
      media: { writeDraftImage: () => Effect.succeed("current"), claimDraftImage: () => Effect.suspend(() => ++claims === 1
        ? Effect.fail(new MediaFailure({ operation: "claim", message: "claim failed" })) : Effect.succeed("note.png")),
        removeImage: () => Effect.void, removeDraftImage: () => Effect.promise(async () => { cleanupEntered.resolve(); await cleanupFinished.promise; }) },
    });
    const first = Effect.runSync(workflow.startImage(draft));
    await expect.poll(() => calls).toBe(1);
    expect(Effect.runSync(workflow.claimJobForNote(draft.id, note.id))).toBe(true);
    await db.delete(drafts).where(eq(drafts.id, draft.id));
    firstBytes.resolve(new Uint8Array([1]));
    await cleanupEntered.promise;
    const blocker = lock.withWriteLock(async () => { entered.resolve(); await unblock.promise; });
    await entered.promise;
    cleanupFinished.resolve();
    await expect.poll(() => queued).toContain("legacy.image-failed");
    const second = Effect.runSync(workflow.startImage(draft));
    await expect.poll(() => queued.filter((operation) => operation === "legacy.image-patch").length).toBe(2);
    unblock.resolve();
    await blocker;
    await expect.poll(() => calls).toBe(2);
    await lock.withWriteLock(async () => {});
    const [current] = await db.select().from(notes).where(eq(notes.id, note.id));
    secondBytes.resolve(new Uint8Array([2]));
    await Effect.runPromise(Effect.all([Fiber.join(first), Fiber.join(second)]));
    await lock.close();
    expect(current.metadata.imageFailed).toBe(false);
    expect((await db.select().from(notes).where(eq(notes.id, note.id)))[0].imagePath).toBe("note.png");
  });

  it("runs the detached image stage directly and keeps its ready snapshot while text finishes", async () => {
    const draft = await seedDraft();
    const finishText = Promise.withResolvers<void>();
    const callback = vi.fn(() => Effect.void);
    const images = vi.fn(() => Effect.succeed(new Uint8Array([1])));
    const workflow = makeLegacyCreationWorkflow({
      db, database: { db, withWriteLock: (_operation, work) => work },
      provider: makeBackgroundProvider({
        classify: () => Effect.succeed(CLASSIFICATION),
        generate: () => Effect.succeed(makeEffectPull((async function* () {
          yield '{"imagePrompt":"banana","generationSummary":"Practise the meaning of Banane.","cards":[';
          await finishText.promise;
          yield '{"aspect":"meaning","front":"die Banane","back":"banana","imageCue":false}]}';
          return { imagePrompt: "banana", generationSummary: SUMMARY, cards: [CARD] };
        })())),
        route: () => Effect.die("unused"), adjust: () => Effect.die("unused"), generateImageBytes: images,
      }),
      media: { writeDraftImage: () => Effect.succeed("direct-image"), claimDraftImage: () => Effect.succeed("note.png"), removeImage: () => Effect.void, removeDraftImage: () => Effect.void },
    });
    const fiber = Effect.runSync(workflow.start({ draft, nativeLanguage: "en", publish: () => Effect.void, startImage: callback }));
    await expect.poll(async () => (await db.select().from(drafts).where(eq(drafts.id, draft.id)))[0].imageStatus).toBe("ready");
    const watch = Effect.runSync(workflow.openSubscription(draft.id))!;
    expect(watch.snapshot).toMatchObject({ imageStatus: "ready", draftImageId: "direct-image" });
    expect(images).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    finishText.resolve();
    await Effect.runPromise(Fiber.join(fiber));
    const events = [];
    for await (const event of watch.events) events.push(event.type);
    expect(events).toEqual(["cards", "done"]);
    const [stored] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(stored).toMatchObject({ status: "ready", imageStatus: "ready", draftImageId: "direct-image" });
    Effect.runSync(watch.close);
  });

  it("owns detached jobs and subscribers per instance and aborts late image bytes", async () => {
    const draft = { ...await seedDraft(), imagePrompt: "banana", imageStatus: "failed" as const };
    const bytes = Promise.withResolvers<Uint8Array>();
    const write = vi.fn(() => Effect.succeed("picture"));
    const options = {
      db,
      database: { db, withWriteLock: <A, E, R>(_operation: string, work: Effect.Effect<A, E, R>) => work },
      provider: makeBackgroundProvider({
        classify: () => Effect.succeed(CLASSIFICATION),
        generate: () => Effect.die("unused"), route: () => Effect.die("unused"), adjust: () => Effect.die("unused"),
        generateImageBytes: () => Effect.promise(() => bytes.promise),
      }),
      media: { writeDraftImage: write, claimDraftImage: () => Effect.succeed("note.png"), removeImage: () => Effect.void, removeDraftImage: () => Effect.void },
    };
    const first = makeLegacyCreationWorkflow(options);
    const second = makeLegacyCreationWorkflow(options);
    const fiber = Effect.runSync(first.startImage(draft));
    expect(Effect.runSync(first.hasJob(draft.id))).toBe(true);
    expect(Effect.runSync(second.hasJob(draft.id))).toBe(false);
    const subscription = Effect.runSync(first.openSubscription(draft.id))!;
    expect(Effect.runSync(first.subscriberCount(draft.id))).toBe(1);
    expect(Effect.runSync(second.subscriberCount(draft.id))).toBe(0);
    Effect.runSync(first.abortJob(draft.id));
    bytes.resolve(new Uint8Array([1]));
    await Effect.runPromise(Fiber.join(fiber));
    expect(write).not.toHaveBeenCalled();
    expect(Effect.runSync(first.hasJob(draft.id))).toBe(false);
    Effect.runSync(subscription.close);
  });

  it("compensates a file written after abort and fences new image work after stop", async () => {
    const draft = { ...await seedDraft(), imagePrompt: "banana", imageStatus: "failed" as const };
    const written = Promise.withResolvers<string>();
    const write = vi.fn(() => Effect.promise(() => written.promise));
    const remove = vi.fn(() => Effect.void);
    const generate = vi.fn(() => Effect.succeed(new Uint8Array([1])));
    const workflow = makeLegacyCreationWorkflow({
      db, database: { db, withWriteLock: (_operation, work) => work },
      provider: makeBackgroundProvider({ classify: () => Effect.die("unused"), generate: () => Effect.die("unused"), route: () => Effect.die("unused"), adjust: () => Effect.die("unused"), generateImageBytes: generate }),
      media: { writeDraftImage: write, claimDraftImage: () => Effect.succeed("note.png"), removeImage: () => Effect.void, removeDraftImage: remove },
    });
    const fiber = Effect.runSync(workflow.startImage(draft));
    await expect.poll(() => write.mock.calls.length).toBe(1);
    Effect.runSync(workflow.abortJob(draft.id));
    written.resolve("late-file");
    await Effect.runPromise(Fiber.join(fiber));
    expect(remove).toHaveBeenCalledWith("ada", "late-file");
    await Effect.runPromise(workflow.stop());
    await Effect.runPromise(Fiber.join(Effect.runSync(workflow.startImage(draft))));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("settles the image transfer with destination exists=%s", async (destinationExists) => {
    const draft = { ...await seedDraft(), imagePrompt: "banana", imageStatus: "failed" as const };
    const noteId = destinationExists
      ? (await db.insert(notes).values({ userId: "ada", deckId: draft.deckId!, sourceText: "saved", domain: "concept", metadata: {} }).returning())[0].id
      : "vanished-note";
    const bytes = Promise.withResolvers<Uint8Array>();
    const removed: string[] = [];
    const claimed: string[] = [];
    const workflow = makeLegacyCreationWorkflow({
      db, database: { db, withWriteLock: (_operation, work) => work },
      provider: makeBackgroundProvider({ classify: () => Effect.die("unused"), generate: () => Effect.die("unused"), route: () => Effect.die("unused"), adjust: () => Effect.die("unused"), generateImageBytes: () => Effect.promise(() => bytes.promise) }),
      media: { writeDraftImage: () => Effect.succeed("picture"), claimDraftImage: (_user, id, noteId) => Effect.sync(() => { claimed.push(`${id}:${noteId}`); return "ada/saved.png"; }), removeImage: (path) => Effect.sync(() => { removed.push(path); }), removeDraftImage: () => Effect.void },
    });
    const fiber = Effect.runSync(workflow.startImage(draft));
    expect(Effect.runSync(workflow.claimJobForNote(draft.id, noteId))).toBe(true);
    expect(Effect.runSync(workflow.hasJobForNote(noteId))).toBe(true);
    await db.delete(drafts).where(eq(drafts.id, draft.id));
    bytes.resolve(new Uint8Array([1]));
    await Effect.runPromise(Fiber.join(fiber));
    expect(claimed).toEqual([`picture:${noteId}`]);
    expect(removed).toEqual(destinationExists ? [] : ["ada/saved.png"]);
    if (destinationExists) {
      const [stored] = await db.select().from(notes).where(eq(notes.id, noteId));
      expect(stored.imagePath).toBe("ada/saved.png");
    }
    expect(Effect.runSync(workflow.hasJobForNote(noteId))).toBe(false);
  });

  it("compensates a failed note attachment and marks only the note image failed", async () => {
    const draft = { ...await seedDraft(), imagePrompt: "banana", imageStatus: "failed" as const };
    const [note] = await db.insert(notes).values({ userId: "ada", deckId: draft.deckId!, sourceText: "saved", domain: "concept", metadata: { imageFailed: false } }).returning();
    const bytes = Promise.withResolvers<Uint8Array>();
    const removed = vi.fn(() => Effect.void);
    // The selected database seam fails the guarded settlement after promotion.
    const brokenDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "update") return Reflect.get(target, key, receiver);
      return (table: unknown) => {
        const update = target.update(table as typeof notes);
        if (table !== notes) return update;
        return { set(values: Record<string, unknown>) {
          if ("imagePath" in values) return { where: () => ({ returning: () => Promise.reject(new Error("attachment failed")) }) };
          return update.set(values);
        } };
      };
    } });
    const workflow = makeLegacyCreationWorkflow({
      db, database: { db: brokenDb, withWriteLock: (_operation, work) => work },
      provider: makeBackgroundProvider({ classify: () => Effect.die("unused"), generate: () => Effect.die("unused"), route: () => Effect.die("unused"), adjust: () => Effect.die("unused"), generateImageBytes: () => Effect.promise(() => bytes.promise) }),
      media: { writeDraftImage: () => Effect.succeed("picture"), claimDraftImage: () => Effect.succeed("ada/saved.png"), removeImage: removed, removeDraftImage: () => Effect.void },
    });
    const fiber = Effect.runSync(workflow.startImage(draft));
    Effect.runSync(workflow.claimJobForNote(draft.id, note.id));
    await db.delete(drafts).where(eq(drafts.id, draft.id));
    bytes.resolve(new Uint8Array([1]));
    await Effect.runPromise(Fiber.join(fiber));
    expect(removed).toHaveBeenCalledWith("ada/saved.png");
    const [stored] = await db.select().from(notes).where(eq(notes.id, note.id));
    expect(stored.metadata).toMatchObject({ imageFailed: true });
    expect(stored.imagePath).toBeNull();
  });

  it("keeps subscribers and note transfer alive across overlapping direct image retries", async () => {
    const draft = { ...await seedDraft(), imagePrompt: "banana", imageStatus: "failed" as const };
    const firstWrite = Promise.withResolvers<string>();
    const secondBytes = Promise.withResolvers<Uint8Array>();
    const written = vi.fn(() => Effect.promise(() => firstWrite.promise));
    const removed: string[] = [];
    let attempts = 0;
    const workflow = makeLegacyCreationWorkflow({
      db, database: { db, withWriteLock: (_operation, work) => work },
      provider: makeBackgroundProvider({ classify: () => Effect.die("unused"), generate: () => Effect.die("unused"), route: () => Effect.die("unused"), adjust: () => Effect.die("unused"), generateImageBytes: () => Effect.suspend(() => ++attempts === 1 ? Effect.succeed(new Uint8Array([1])) : Effect.promise(() => secondBytes.promise)) }),
      media: { writeDraftImage: written, claimDraftImage: () => Effect.succeed("note.png"), removeImage: () => Effect.void, removeDraftImage: (_user, id) => Effect.sync(() => { removed.push(id); }) },
    });
    const first = Effect.runSync(workflow.startImage(draft));
    await expect.poll(() => written.mock.calls.length).toBe(1);
    const second = Effect.runSync(workflow.startImage(draft));
    const subscription = Effect.runSync(workflow.openSubscription(draft.id))!;
    await expect.poll(() => attempts).toBe(2);
    firstWrite.resolve("superseded");
    await expect.poll(() => removed).toEqual(["superseded"]);
    expect(Effect.runSync(workflow.hasJob(draft.id))).toBe(true);
    expect(Effect.runSync(workflow.subscriberCount(draft.id))).toBe(1);
    written.mockImplementation(() => Effect.succeed("current"));
    secondBytes.resolve(new Uint8Array([2]));
    await Effect.runPromise(Effect.all([Fiber.join(first), Fiber.join(second)]));
    const [stored] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(stored).toMatchObject({ imageStatus: "ready", draftImageId: "current" });
    expect(Effect.runSync(workflow.subscriberCount(draft.id))).toBe(0);
    Effect.runSync(subscription.close);
  });
  it("returns a detached fiber before a gated provider settles", async () => {
    const draft = await seedDraft();
    const classification = Promise.withResolvers<typeof CLASSIFICATION>();
    const provider = makeBackgroundProvider({
      classify: () => Effect.promise(() => classification.promise),
      generate: () => Effect.succeed(makeEffectPull((async function* () {
        yield '{"imagePrompt":null,"generationSummary":"Practise the meaning of Banane.","cards":[';
        yield '{"aspect":"meaning","front":"die Banane","back":"banana","imageCue":false}]}';
        return { imagePrompt: null, generationSummary: SUMMARY, cards: [CARD] };
      })())),
      route: () => Effect.die("not used"),
      adjust: () => Effect.die("not used"),
      generateImageBytes: () => Effect.die("not used"),
    });
    const workflow = makeLegacyCreationWorkflow({ db, provider });
    const events: string[] = [];

    const fiber = Effect.runSync(workflow.start({
      draft,
      nativeLanguage: "en",
      publish: (event) => Effect.sync(() => { events.push(event.type); }),
    }));

    expect(Fiber.isFiber(fiber)).toBe(true);
    const [pending] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(pending.status).toBe("generating");

    classification.resolve(CLASSIFICATION);
    await Effect.runPromise(Fiber.join(fiber));

    const [completed] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(completed.status).toBe("ready");
    expect(completed.classification).toEqual(CLASSIFICATION);
    expect(completed.cards).toEqual([CARD]);
    expect(events).toEqual(["classified", "image-prompt", "cards", "done"]);
  });

  it("persists an emitted image prompt before the text stream completes", async () => {
    const draft = await seedDraft();
    const complete = Promise.withResolvers<void>();
    const imageStarts: string[] = [];
    const provider = makeBackgroundProvider({
      classify: () => Effect.succeed(CLASSIFICATION),
      generate: () => Effect.succeed(makeEffectPull((async function* () {
        yield '{"imagePrompt":"a ripe banana","generationSummary":"Practise the meaning of Banane.","cards":[';
        await complete.promise;
        yield '{"aspect":"meaning","front":"die Banane","back":"banana","imageCue":false}]}';
        return { imagePrompt: "a ripe banana", generationSummary: SUMMARY, cards: [CARD] };
      })())),
      route: () => Effect.die("not used"),
      adjust: () => Effect.die("not used"),
      generateImageBytes: () => Effect.die("not used"),
    });
    const workflow = makeLegacyCreationWorkflow({ db, provider });

    const fiber = Effect.runSync(workflow.start({
      draft,
      nativeLanguage: "en",
      publish: () => Effect.void,
      startImage: (_current, prompt) => Effect.sync(() => { imageStarts.push(prompt); }),
    }));

    await expect.poll(async () => {
      const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
      return { imagePrompt: row.imagePrompt, imageStatus: row.imageStatus };
    }).toEqual({ imagePrompt: "a ripe banana", imageStatus: "generating" });
    expect(imageStarts).toEqual(["a ripe banana"]);

    complete.resolve();
    await Effect.runPromise(Fiber.join(fiber));
  });

  it("stores the learner-safe failure when the provider rejects", async () => {
    const draft = await seedDraft();
    const provider = makeBackgroundProvider({
      classify: () => Effect.fail(new ProviderFailure({
        provider: "test",
        operation: "classify",
        message: "provider secret detail",
        cause: new Error("provider secret detail"),
      })),
      generate: () => Effect.die("not used"),
      route: () => Effect.die("not used"),
      adjust: () => Effect.die("not used"),
      generateImageBytes: () => Effect.die("not used"),
    });
    const workflow = makeLegacyCreationWorkflow({ db, provider });
    const events: string[] = [];

    const fiber = Effect.runSync(workflow.start({
      draft,
      nativeLanguage: "en",
      publish: (event) => Effect.sync(() => { events.push(event.type); }),
    }));

    await Effect.runPromise(Fiber.join(fiber));

    const [failed] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Generation failed");
    expect(events).toEqual(["failed"]);
  });

  it("retries structured-output classification failures with validation feedback", async () => {
    const draft = await seedDraft();
    const prompts: string[] = [];
    let attempt = 0;
    const provider = makeBackgroundProvider({
      classify: (prompt) => Effect.suspend(() => {
        prompts.push(prompt.user);
        attempt++;
        if (attempt === 1) {
          const failure = Object.assign(new Error("invalid classification"), {
            code: "structured-output-validation-failed",
            cause: {
              issues: [{ path: ["domain"], message: "domain is required" }],
            },
          });
          return Effect.fail(new ProviderFailure({
            provider: "test",
            operation: "classify",
            message: failure.message,
            cause: failure,
          }));
        }
        return Effect.succeed(CLASSIFICATION);
      }),
      generate: () => Effect.succeed(makeEffectPull((async function* () {
        return { imagePrompt: null, generationSummary: SUMMARY, cards: [CARD] };
      })())),
      route: () => Effect.die("not used"),
      adjust: () => Effect.die("not used"),
      generateImageBytes: () => Effect.die("not used"),
    });
    const workflow = makeLegacyCreationWorkflow({ db, provider });

    await Effect.runPromise(Fiber.join(Effect.runSync(workflow.start({
      draft,
      nativeLanguage: "en",
      publish: () => Effect.void,
    }))));

    const [completed] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(completed.status).toBe("ready");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("domain is required");
  });

  it("retries invalid streamed output with the validation feedback", async () => {
    const draft = await seedDraft();
    const prompts: string[] = [];
    let attempt = 0;
    const provider = makeBackgroundProvider({
      classify: () => Effect.succeed(CLASSIFICATION),
      generate: (prompt) => Effect.sync(() => {
        prompts.push(prompt.user);
        attempt++;
        return makeEffectPull((async function* () {
          return attempt === 1
            ? {}
            : { imagePrompt: null, generationSummary: SUMMARY, cards: [CARD] };
        })());
      }),
      route: () => Effect.die("not used"),
      adjust: () => Effect.die("not used"),
      generateImageBytes: () => Effect.die("not used"),
    });
    const workflow = makeLegacyCreationWorkflow({ db, provider });
    const events: string[] = [];

    const fiber = Effect.runSync(workflow.start({
      draft,
      nativeLanguage: "en",
      publish: (event) => Effect.sync(() => { events.push(event.type); }),
    }));
    await Effect.runPromise(Fiber.join(fiber));

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('"cards"');
    expect(events).toEqual(["classified", "retry", "cards", "done"]);
  });

  it("stores the learner-safe failure when the selected deck is gone", async () => {
    const [draft] = await db.insert(drafts).values({
      userId: "ada",
      deckId: null,
      sourceText: "die Banane",
      status: "generating",
      operation: "generate",
      learningGoal: "die Banane",
    }).returning();
    const provider = makeBackgroundProvider({
      classify: () => Effect.die("not used"),
      generate: () => Effect.die("not used"),
      route: () => Effect.die("not used"),
      adjust: () => Effect.die("not used"),
      generateImageBytes: () => Effect.die("not used"),
    });
    const workflow = makeLegacyCreationWorkflow({ db, provider });
    const events: string[] = [];

    const fiber = Effect.runSync(workflow.start({
      draft,
      nativeLanguage: "en",
      publish: (event) => Effect.sync(() => { events.push(event.type); }),
    }));
    await Effect.runPromise(Fiber.join(fiber));

    const [failed] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Generation failed");
    expect(events).toEqual(["failed"]);
  });
});
