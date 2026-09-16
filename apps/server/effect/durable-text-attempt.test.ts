import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { creationImageAttempts, decks, drafts, user } from "../db/schema.ts";
import { claimCreationWork } from "../creations/scheduler.ts";
import { runDurableTextAttempt } from "./durable-text-attempt.ts";
import type { BackgroundProviderService } from "./background-provider.ts";
import { makeDurableTextWorkflow, type DurableTextDatabase } from "./durable-text.ts";
import { ProviderFailure } from "./errors.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
  await testDb.db.insert(decks).values({ id: "german", userId: "ada", name: "German" });
});
afterEach(() => testDb.close());

const classification = { domain: "concept", language: null, partOfSpeech: null };
const card = { aspect: "meaning", front: "banana", back: "fruit", imageCue: false };
const provider = (): BackgroundProviderService => ({
  route: () => Effect.succeed({ outcome: { kind: "matched", deckId: "german", learningGoal: "Learn" } }),
  adjust: () => Effect.succeed({
    generationSummary: "Practise the meaning of Banane.",
    cards: [card],
  }),
  classify: () => Effect.succeed(classification),
  generate: () => Effect.succeed({ next: () => Effect.succeed({
    done: true as const,
    value: {
      imagePrompt: null,
      generationSummary: "Practise the meaning of Banane.",
      cards: [card],
    },
  }) }),
  generateImageBytes: () => Effect.succeed(new Uint8Array()),
});
function database(): DurableTextDatabase {
  return { db: testDb.db, withWriteLock: (_name, work) => work, transaction: (_name, work) => work(testDb.db) };
}
async function claim() {
  await testDb.db.insert(drafts).values({ id: "creation", userId: "ada", clientRequestId: "request", sourceText: "banana", status: "queued", operation: "route_generate" });
  return (await claimCreationWork(testDb.db, "ada", { leaseOwner: "worker" }))[0];
}
async function row() { return (await testDb.db.select().from(drafts).where(eq(drafts.id, "creation")))[0]; }

it("executes routing and generation through the selected Effect provider and publishes committed snapshots", async () => {
  const work = await claim();
  const published: string[] = [];
  await Effect.runPromise(runDurableTextAttempt(work, {
    database: database(), provider: provider(), nextId: () => "card",
    publishEffect: (creation) => Effect.promise(async () => {
      expect((await row()).status).toBe(creation.status);
      published.push(creation.status);
    }), kickEffect: () => Effect.void,
  }));
  expect(await row()).toMatchObject({ status: "ready", leaseOwner: null, cards: [{ key: "card", ...card }] });
  expect(published.at(-1)).toBe("ready");
});

it("sends saved AI instructions with the generation request", async () => {
  await testDb.db.update(user).set({
    aiInstructions: "Use short, everyday example sentences.",
  }).where(eq(user.id, "ada"));
  const work = await claim();
  const generationPrompts: Array<{ system: string; user: string }> = [];
  const selected: BackgroundProviderService = {
    ...provider(),
    generate: (prompts) => {
      generationPrompts.push(prompts);
      return Effect.succeed({
        next: () => Effect.succeed({
          done: true as const,
          value: {
            imagePrompt: null,
            generationSummary: "Practise the meaning of Banane.",
            cards: [card],
          },
        }),
      });
    },
  };

  await Effect.runPromise(runDurableTextAttempt(work, {
    database: database(),
    provider: selected,
    publishEffect: () => Effect.void,
    kickEffect: () => Effect.void,
  }));

  expect(generationPrompts).toHaveLength(1);
  expect(generationPrompts[0]?.user).toContain(
    "Use short, everyday example sentences.",
  );
});

it("interrupts a model pull, awaits its cleanup, and leaves the claim recoverable without a late settlement", async () => {
  const work = await claim();
  const entered = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>();
  const cleanupRelease = Promise.withResolvers<void>();
  let kicked = false;
  const selected: BackgroundProviderService = { ...provider(), generate: () => Effect.succeed({
    next: () => Effect.sync(() => entered.resolve()).pipe(Effect.zipRight(Effect.never)),
    return: () => Effect.promise(async () => { cleanupEntered.resolve(); await cleanupRelease.promise; return { done: true as const, value: undefined }; }),
  }) };
  const fiber = Effect.runFork(runDurableTextAttempt(work, { database: database(), provider: selected, publishEffect: () => Effect.void, kickEffect: () => Effect.sync(() => { kicked = true; }) }));
  await entered.promise;
  let settled = false;
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { settled = true; });
  await cleanupEntered.promise;
  expect(settled).toBe(false);
  cleanupRelease.resolve(); await interrupted;
  expect(kicked).toBe(true);
  expect(await row()).toMatchObject({ status: "generating", activeAttemptId: work.attemptId, leaseOwner: "worker" });
});

it("finishes guarded settlement and superseded-media cleanup before acknowledging interruption", async () => {
  const work = await claim();
  await testDb.db.update(drafts).set({ draftImageId: "old-image", imageAttemptId: "old-attempt" }).where(eq(drafts.id, work.creationId));
  await testDb.db.insert(creationImageAttempts).values({ id: "old-attempt", userId: "ada", creationId: work.creationId, prompt: "old", status: "ready", draftImageId: "old-image" });
  const committed = Promise.withResolvers<void>(), releasePublication = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>(), releaseCleanup = Promise.withResolvers<void>();
  const cleaned: string[] = [];
  const fiber = Effect.runFork(runDurableTextAttempt(work, {
    database: database(), provider: provider(), kickEffect: () => Effect.void,
    publishEffect: (creation) => creation.status === "ready" ? Effect.promise(async () => { committed.resolve(); await releasePublication.promise; }) : Effect.void,
    removeDraftImageEffect: (_userId, id) => Effect.promise(async () => { cleanupEntered.resolve(); await releaseCleanup.promise; cleaned.push(id); }),
  }));
  await committed.promise;
  let stopped = false;
  const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { stopped = true; });
  releasePublication.resolve();
  await cleanupEntered.promise;
  expect(stopped).toBe(false);
  expect(await row()).toMatchObject({ status: "ready", activeAttemptId: null, draftImageId: null, imageAttemptId: null });
  const [oldAttempt] = await testDb.db.select().from(creationImageAttempts).where(eq(creationImageAttempts.id, "old-attempt"));
  expect(oldAttempt.status).toBe("canceled");
  releaseCleanup.resolve(); await interrupted;
  expect(cleaned).toEqual(["old-image"]);
});

it("renews the rotated attempt across heartbeat intervals so a held validation retry cannot be recovered or reclaimed", async () => {
  const work = await claim();
  const original = await row();
  let now = new Date(original.leaseExpiresAt!.getTime() - 30_000);
  const secondPass = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let pass = 0, id = 0;
  const selected: BackgroundProviderService = { ...provider(), generate: () => Effect.sync(() => {
    const first = pass++ === 0;
    return { next: () => first
      ? Effect.succeed({ done: true as const, value: { cards: [] } })
      : Effect.promise(async () => {
        secondPass.resolve();
        await release.promise;
        return {
          done: true as const,
          value: {
            imagePrompt: null,
            generationSummary: "Practise the meaning of Banane.",
            cards: [card],
          },
        };
      }) };
  }) };
  const workflow = makeDurableTextWorkflow({
    database: database(), heartbeatMs: 5, now: () => now,
    runAttempt: (claimed, lease) => runDurableTextAttempt(claimed, {
      database: database(), provider: selected, lease, nextId: () => `new-${++id}`,
      publishEffect: () => Effect.void, kickEffect: () => Effect.void,
    }),
  });
  const running = Effect.runPromise(workflow.runAttempt(work));
  try {
    await secondPass.promise;
    expect((await row()).activeAttemptId).not.toBe(work.attemptId);
    for (let interval = 0; interval < 3; interval++) {
      now = new Date(now.getTime() + 60_000);
      await vi.waitFor(async () => expect((await row()).leaseExpiresAt!.getTime()).toBe(now.getTime() + 90_000));
      expect(await Effect.runPromise(workflow.recover(now, {}))).toBe(0);
      expect(await claimCreationWork(testDb.db, "ada", { now, leaseOwner: "other-worker" })).toEqual([]);
    }
  } finally {
    release.resolve();
    await running;
  }
  expect(await row()).toMatchObject({ status: "ready", activeAttemptId: null, leaseOwner: null });
});

it("retries direct structured-output validation failures with feedback", async () => {
  const work = await claim();
  const requests: string[] = [];
  const selected: BackgroundProviderService = { ...provider(), classify: (prompts) => Effect.suspend(() => {
    requests.push(prompts.user);
    return requests.length === 1 ? Effect.fail(new ProviderFailure({
      provider: "ai", operation: "classify", message: "Invalid output",
      cause: { code: "structured-output-validation-failed", cause: { issues: [{ message: "domain missing" }] } },
    })) : Effect.succeed(classification);
  }) };
  await Effect.runPromise(runDurableTextAttempt(work, { database: database(), provider: selected, publishEffect: () => Effect.void, kickEffect: () => Effect.void }));
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe("banana");
  expect(requests[1]).toContain("domain missing");
  expect(requests[1]).toContain("Return corrected JSON matching the schema exactly.");
  expect((await row()).status).toBe("ready");
});

it("persists an ordinary direct ProviderFailure without retrying the model", async () => {
  const work = await claim();
  let calls = 0;
  const selected: BackgroundProviderService = { ...provider(), classify: () => Effect.suspend(() => {
    calls++;
    return Effect.fail(new ProviderFailure({ provider: "ai", operation: "classify", message: "Unavailable", cause: new Error("Network down") }));
  }) };
  await Effect.runPromise(runDurableTextAttempt(work, { database: database(), provider: selected, publishEffect: () => Effect.void, kickEffect: () => Effect.void }));
  expect(calls).toBe(1);
  expect(await row()).toMatchObject({ status: "failed", errorCategory: "generation_failed", leaseOwner: null });
});
