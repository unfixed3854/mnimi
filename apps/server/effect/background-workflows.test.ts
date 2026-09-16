import { Cause, Effect, Exit, Fiber, FiberId } from "effect";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../db/testing.ts";
import { creationImageAttempts, decks, drafts, user } from "../db/schema.ts";
import { makeMediaStore } from "./media.ts";
import { makeCreationEvents } from "./creation-events.ts";
import { makeNotifications } from "./notifications.ts";
import { makeLegacyCreationWorkflow } from "./legacy-creation.ts";
import { makeDurableTextWorkflow } from "./durable-text.ts";
import { makeDurableImageWorkflow } from "./durable-images.ts";
import { makeAudioJobs } from "./audio-jobs.ts";
import { makeDraftMaintenance } from "./draft-maintenance.ts";
import { DatabaseFailure } from "./errors.ts";
import { makeBackgroundWorkflows, type BackgroundWorkflowFactories, type BackgroundWorkflowsOptions } from "./background-workflows.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  testDb.close();
});

function options(): BackgroundWorkflowsOptions {
  return {
    database: { db: testDb.db, withWriteLock: (_operation, work) => work, transaction: (_operation, work) => work(testDb.db) },
    provider: {
      classify: () => Effect.succeed({}), route: () => Effect.succeed({}), adjust: () => Effect.succeed({}),
      generate: () => Effect.succeed({ next: () => Effect.succeed({ done: true, value: {} }) }),
      generateImageBytes: () => Effect.succeed(new Uint8Array([1])),
    },
    media: { ...makeMediaStore({ imagesDir: "/unused-images", audioDir: "/unused-audio" }), sweepDrafts: () => Effect.succeed(0) },
    elevenLabs: { synthesizeSpeech: () => Effect.succeed(new Uint8Array([1])) },
    push: { send: () => Effect.succeed({ invalidTokens: [] }) },
  };
}

describe("BackgroundWorkflows", () => {
  it("keeps graph-owned heartbeat renewal attached to a validation retry's replacement attempt", async () => {
    const dependencies = options();
    const release = Promise.withResolvers<void>();
    let generations = 0;
    const workflows = makeBackgroundWorkflows({ ...dependencies, now: () => new Date(1_000),
      provider: { ...dependencies.provider,
        classify: () => Effect.succeed({ domain: "concept", language: null, partOfSpeech: null }),
        generate: () => Effect.sync(() => {
          generations++;
          return generations === 1
            ? { next: () => Effect.succeed({ done: true as const, value: {} }) }
            : { next: () => Effect.promise(async () => {
              await release.promise;
              return {
                done: true as const,
                value: {
                  imagePrompt: null,
                  generationSummary: "Practise the meaning of banana.",
                  cards: [{ aspect: "meaning", front: "banana", back: "fruit", imageCue: false }],
                },
              };
            }) };
        }),
      },
    }, { text: (input) => makeDurableTextWorkflow({ ...input, heartbeatMs: 10 }) });
    cleanups.push(async () => { release.resolve(); await Effect.runPromise(workflows.stop()); });
    await testDb.db.insert(decks).values({ id: "retry-deck", userId: "ada", name: "Retry" });
    await testDb.db.insert(drafts).values({ id: "retry", userId: "ada", sourceText: "banana", deckId: "retry-deck", learningGoal: "Learn",
      status: "generating", operation: "generate", activeAttemptId: "initial", leaseOwner: "worker", leaseExpiresAt: new Date(5_000) });
    const run = Effect.runPromise(workflows.text.runAttempt({ creationId: "retry", userId: "ada", attemptId: "initial", leaseOwner: "worker", operation: "generate" }));
    try {
      await vi.waitFor(() => expect(generations).toBe(2));
      const [replacement] = await testDb.db.select().from(drafts).where(eq(drafts.id, "retry"));
      expect(replacement.activeAttemptId).not.toBe("initial");
      // Ignore any renewal that raced before rotation: a subsequent tick must
      // use the replacement identity to extend this freshly reset expiry.
      await testDb.db.update(drafts).set({ leaseExpiresAt: new Date(5_000) }).where(eq(drafts.id, "retry"));
      await vi.waitFor(async () => expect((await testDb.db.select().from(drafts).where(eq(drafts.id, "retry")))[0]!.leaseExpiresAt?.getTime()).toBe(91_000));
    } finally { release.resolve(); await run; }
    expect((await testDb.db.select().from(drafts).where(eq(drafts.id, "retry")))[0]).toMatchObject({ status: "ready", leaseOwner: null });
  });
  it("executes text attempts through direct provider, publication, media, notification, and image seams in one fiber", async () => {
    const observed = new Map<string, FiberId.FiberId>();
    const observe = (name: string) => Effect.fiberIdWith((id) => Effect.sync(() => { observed.set(name, id); }));
    const dependencies = options();
    const classification = { domain: "concept", language: null, partOfSpeech: null };
    const card = { aspect: "meaning", front: "banana", back: "fruit", imageCue: false };
    const workflows = makeBackgroundWorkflows({
      ...dependencies,
      provider: { ...dependencies.provider,
        classify: () => observe("provider").pipe(Effect.as(classification)),
        generate: () => Effect.succeed({ next: () => Effect.succeed({
          done: true as const,
          value: {
            imagePrompt: "new image",
            generationSummary: "Practise the meaning of banana.",
            cards: [card],
          },
        }) }),
      },
      media: { ...dependencies.media, removeDraftImage: (_owner, id) => {
        expect(id).toBe("old-image");
        return observe("media");
      } },
    }, {
      events: (input) => {
        const service = makeCreationEvents(input);
        return { ...service, publish: (creation, attempt) => observe("events").pipe(Effect.zipRight(service.publish(creation, attempt))) };
      },
      notifications: (input) => {
        const service = makeNotifications(input);
        return { ...service, queue: (owner, id) => observe("notifications").pipe(Effect.zipRight(service.queue(owner, id))) };
      },
      images: (input) => ({ ...makeDurableImageWorkflow(input), kick: () => observe("images") }),
    });
    cleanups.push(() => Effect.runPromise(workflows.stop()));
    await Effect.runPromise(workflows.recoverAndStart());
    await testDb.db.insert(decks).values({ id: "direct-deck", userId: "ada", name: "Direct" });
    await testDb.db.insert(drafts).values({ id: "direct", userId: "ada", deckId: "direct-deck", sourceText: "banana", learningGoal: "Learn",
      status: "generating", operation: "generate", activeAttemptId: "direct-attempt", leaseOwner: "worker",
      draftImageId: "old-image", imageAttemptId: "old-attempt" });
    await testDb.db.insert(creationImageAttempts).values({ id: "old-attempt", userId: "ada", creationId: "direct", prompt: "old",
      status: "ready", draftImageId: "old-image" });
    await Effect.runPromise(workflows.text.runAttempt({ creationId: "direct", userId: "ada", attemptId: "direct-attempt", leaseOwner: "worker", operation: "generate" }));
    const [creation] = await testDb.db.select().from(drafts).where(eq(drafts.id, "direct"));
    expect(creation).toMatchObject({ status: "ready", classification, cards: [expect.objectContaining(card)], imageStatus: "queued" });
    expect([...observed.keys()].sort()).toEqual(["events", "images", "media", "notifications", "provider"]);
    for (const id of observed.values()) expect(id).toEqual(observed.get("provider"));
  });

  it("gives legacy work direct database/media ownership and fences new starts without interrupting active image settlement", async () => {
    const dependencies = options();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const writes: string[] = [];
    const workflows = makeBackgroundWorkflows({ ...dependencies,
      provider: { ...dependencies.provider, generateImageBytes: () => Effect.promise(async () => {
        entered.resolve(); await release.promise; return new Uint8Array([1]);
      }) },
      media: { ...dependencies.media, writeDraftImage: () => Effect.sync(() => { writes.push("image"); return "legacy-image"; }) },
    });
    cleanups.push(async () => { release.resolve(); await Effect.runPromise(workflows.stop()); });
    const [draft] = await testDb.db.insert(drafts).values({ id: "legacy", userId: "ada", sourceText: "image", imagePrompt: "image", status: "ready" }).returning();
    const active = await Effect.runPromise(workflows.legacy.startImage(draft));
    await entered.promise;
    await Effect.runPromise(workflows.stop());
    await Effect.runPromise(workflows.stop());
    const ignored = await Effect.runPromise(workflows.legacy.startImage(draft));
    await Effect.runPromise(Fiber.join(ignored));
    expect(writes).toEqual([]);
    release.resolve();
    await Effect.runPromise(Fiber.join(active));
    expect(writes).toEqual(["image"]);
    expect((await testDb.db.select().from(drafts).where(eq(drafts.id, "legacy")))[0]).toMatchObject({ imageStatus: "ready", draftImageId: "legacy-image" });
  });
  it("keeps text-enqueued images queued through delayed image boot recovery", async () => {
    const recovering = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const generated: string[] = [];
    const admittedKicks: boolean[] = [];
    let recovered = false;
    const dependencies = options();
    const workflows = makeBackgroundWorkflows({
      ...dependencies,
      provider: { ...dependencies.provider,
        classify: () => Effect.succeed({ domain: "concept", language: null, partOfSpeech: null }),
        generate: () => Effect.succeed({ next: () => Effect.succeed({ done: true as const,
          value: {
            imagePrompt: "startup image",
            generationSummary: "Practise the meaning of hello.",
            cards: [{ aspect: "meaning", front: "hello", back: "greeting", imageCue: false }],
          },
        }) }),
        generateImageBytes: (prompt) => Effect.sync(() => { generated.push(prompt); return new Uint8Array([1]); }),
      },
      media: { ...dependencies.media, writeDraftImage: () => Effect.succeed("generated-image") },
    }, {
      images: (input) => {
        const service = makeDurableImageWorkflow(input);
        return { ...service, recover: (now, recovery) => recovery.allLeases
          ? Effect.promise(() => { recovering.resolve(); return resume.promise; }).pipe(
            Effect.zipRight(service.recover(now, recovery)),
            Effect.tap(() => Effect.sync(() => { recovered = true; })),
          )
          : service.recover(now, recovery),
          kick: () => Effect.sync(() => { admittedKicks.push(recovered); }).pipe(Effect.zipRight(service.kick())),
        };
      },
    });
    cleanups.push(async () => { resume.resolve(); await Effect.runPromise(workflows.stop()); });
    await testDb.db.insert(decks).values({ id: "startup-deck", userId: "ada", name: "Startup" });
    await testDb.db.insert(drafts).values({ id: "startup", userId: "ada", sourceText: "hello", deckId: "startup-deck", learningGoal: "Learn",
      status: "queued", operation: "generate" });
    const boot = Effect.runPromise(workflows.recoverAndStart());
    await recovering.promise;
    await vi.waitFor(async () => expect((await testDb.db.select().from(drafts).where(eq(drafts.id, "startup")))[0]!.status).toBe("ready"));
    const id = (await testDb.db.select().from(drafts).where(eq(drafts.id, "startup")))[0]!.imageAttemptId!;
    expect((await testDb.db.select().from(creationImageAttempts).where(eq(creationImageAttempts.id, id)))[0]).toMatchObject({ status: "queued", leaseOwner: null });
    expect(generated).toEqual([]);
    expect(admittedKicks).toEqual([]);
    resume.resolve(); await boot;
    await vi.waitFor(async () => expect((await testDb.db.select().from(creationImageAttempts).where(eq(creationImageAttempts.id, id)))[0]!.status).toBe("ready"));
    expect(generated).toEqual(["startup image"]);
    await Effect.runPromise(workflows.kickImages());
    expect(admittedKicks).toEqual([true]);
  });
  it("constructs each child once and starts recovery and admission in the existing order", async () => {
    const order: string[] = [];
    const observe = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
      Effect.sync(() => { order.push(name); }).pipe(Effect.zipRight(effect));
    const factories = {
      events: vi.fn(makeCreationEvents), notifications: vi.fn(makeNotifications), legacy: vi.fn(makeLegacyCreationWorkflow), audio: vi.fn(makeAudioJobs),
      text: vi.fn((input): ReturnType<BackgroundWorkflowFactories["text"]> => {
        const child = makeDurableTextWorkflow(input);
        return { ...child, recover: (now, recovery) => {
          expect(recovery).toEqual({ allLeases: true, includeUnleased: true });
          return observe("text.recover", child.recover(now, recovery));
        }, start: () => observe("text.start", child.start()) };
      }),
      images: vi.fn((input): ReturnType<BackgroundWorkflowFactories["images"]> => {
        const child = makeDurableImageWorkflow(input);
        return { ...child, recover: (now, recovery) => {
          expect(recovery).toEqual({ allLeases: true });
          return observe("images.recover", child.recover(now, recovery));
        }, start: () => observe("images.start", child.start()) };
      }),
      maintenance: vi.fn((input) => {
        const child = makeDraftMaintenance(input);
        return { ...child, start: () => observe("maintenance.start", child.start()) };
      }),
    } satisfies BackgroundWorkflowFactories;
    const dependencies = { ...options(), onTextAdmission: () => { order.push("text.admitted"); } };
    const workflows = makeBackgroundWorkflows(dependencies, factories);
    cleanups.push(() => Effect.runPromise(workflows.stop()));
    expect(order).toEqual([]);
    await Effect.runPromise(workflows.recoverAndStart());
    await Effect.runPromise(workflows.recoverAndStart());
    await Effect.runPromise(workflows.kickText("ada"));
    await Effect.runPromise(workflows.kickImages());
    expect(order).toEqual(["text.recover", "text.admitted", "text.start", "images.recover", "images.start", "maintenance.start"]);
    for (const factory of Object.values(factories)) expect(factory).toHaveBeenCalledTimes(1);
    expect(factories.legacy.mock.calls[0]![0].provider).toBe(dependencies.provider);
    expect(factories.legacy.mock.calls[0]![0].database).toBe(dependencies.database);
    expect(factories.legacy.mock.calls[0]![0].media).toBe(dependencies.media);
    expect(factories.text.mock.calls[0]![0]).not.toHaveProperty("models");
    expect(factories.text.mock.calls[0]![0]).not.toHaveProperty("notify");
    expect(factories.images.mock.calls[0]![0].provider).toBe(dependencies.provider);
    expect(factories.images.mock.calls[0]![0].events).toBe(workflows.events);
  });

  it("stops admission and notification timers while a claimed attempt settles its fence", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const running = Promise.withResolvers<void>();
    const claimed = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<boolean>();
    const dependencies = options();
    const workflows = makeBackgroundWorkflows(dependencies, {
      text: (input) => makeDurableTextWorkflow({ ...input, runAttempt: (work) => Effect.promise(async () => {
        claimed.resolve();
        await running.promise;
        const rows = await testDb.db.update(drafts).set({ status: "ready", activeAttemptId: null, leaseOwner: null }).where(and(
          eq(drafts.id, work.creationId), eq(drafts.activeAttemptId, work.attemptId), eq(drafts.leaseOwner, work.leaseOwner),
        )).returning({ id: drafts.id });
        await Effect.runPromise(workflows.notifications.queue("ada", work.creationId));
        settled.resolve(rows.length === 1);
      }) }),
    });
    cleanups.push(async () => { running.resolve(); await Effect.runPromise(workflows.stop()); });
    await Effect.runPromise(workflows.recoverAndStart());
    await testDb.db.insert(drafts).values({ id: "first", userId: "ada", sourceText: "hello", status: "queued", operation: "generate" });
    await Effect.runPromise(workflows.kickText("ada"));
    await claimed.promise;
    await Effect.runPromise(workflows.notifications.queue("ada", "first"));
    expect(vi.getTimerCount()).toBeGreaterThan(1);
    await Effect.runPromise(workflows.stop());
    // Only the admitted attempt heartbeat remains until its guarded settlement.
    expect(vi.getTimerCount()).toBe(1);
    await testDb.db.insert(drafts).values({ id: "after-stop", userId: "ada", sourceText: "later", status: "queued", operation: "generate" });
    await Effect.runPromise(workflows.kickText("ada"));
    await Effect.runPromise(workflows.notifications.queue("ada", "after-stop"));
    await Effect.runPromise(workflows.recoverAndStart());
    const [queued] = await testDb.db.select().from(drafts).where(eq(drafts.id, "after-stop"));
    expect(queued).toMatchObject({ status: "queued", activeAttemptId: null, leaseOwner: null });
    running.resolve();
    await expect(settled.promise).resolves.toBe(true);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
  });

  it("attempts every cleanup once and preserves multiple cleanup defects", async () => {
    const stopped: string[] = [];
    const failStop = (name: string) => () => Effect.sync(() => { stopped.push(name); throw new Error(name); });
    const workflows = makeBackgroundWorkflows(options(), {
      maintenance: (input) => ({ ...makeDraftMaintenance(input), stop: failStop("maintenance") }),
      text: (input) => ({ ...makeDurableTextWorkflow(input), stop: failStop("text") }),
      images: (input) => ({ ...makeDurableImageWorkflow(input), stop: failStop("images") }),
      notifications: (input) => ({ ...makeNotifications(input), stop: failStop("notifications") }),
      legacy: (input) => ({ ...makeLegacyCreationWorkflow(input), stop: failStop("legacy") }),
    });
    const result = await Effect.runPromiseExit(workflows.stop());
    expect(stopped.sort()).toEqual(["images", "legacy", "maintenance", "notifications", "text"]);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Array.from(Cause.defects(result.cause))).toHaveLength(5);
    await Effect.runPromiseExit(workflows.stop());
    expect(stopped).toHaveLength(5);
  });

  it("does not start admission after a failed boot recovery", async () => {
    const started = vi.fn();
    const workflows = makeBackgroundWorkflows(options(), {
      text: (input) => ({ ...makeDurableTextWorkflow(input), recover: () => Effect.fail(new DatabaseFailure({ operation: "boot", cause: new Error("offline") })), start: () => Effect.sync(started) }),
    });
    cleanups.push(() => Effect.runPromise(workflows.stop()));
    await expect(Effect.runPromise(workflows.recoverAndStart())).rejects.toThrow();
    expect(started).not.toHaveBeenCalled();
  });

  it("does not resume startup if shutdown finishes during text recovery", async () => {
    const recovery = Promise.withResolvers<number>();
    const entered = Promise.withResolvers<void>();
    const started = vi.fn();
    const workflows = makeBackgroundWorkflows(options(), {
      text: (input) => ({ ...makeDurableTextWorkflow(input),
        recover: () => Effect.promise(() => { entered.resolve(); return recovery.promise; }),
        start: () => Effect.sync(started),
      }),
    });
    const starting = Effect.runPromise(workflows.recoverAndStart());
    await entered.promise;
    await Effect.runPromise(workflows.stop());
    recovery.resolve(0);
    await starting;
    expect(started).not.toHaveBeenCalled();
  });
});
