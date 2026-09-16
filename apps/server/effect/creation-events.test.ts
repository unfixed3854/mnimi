import { Deferred, Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  makeCreationEvents,
} from "./creation-events.ts";
import { DatabaseFailure } from "./errors.ts";
import type { Draft } from "../db/schema.ts";

function draft({
  id = "creation-1",
  userId = "ada",
  revision = 0,
}: Partial<Pick<Draft, "id" | "userId" | "revision">> = {}): Draft {
  return { id, userId, revision, activeAttemptId: null } as Draft;
}

async function* iterator<A, E>(stream: Stream.Stream<A, E>): AsyncGenerator<A> {
  const scope = Effect.runSync(Scope.make());
  try {
    const pull = await Effect.runPromise(Scope.extend(Stream.toPull(stream), scope));
    while (true) {
      const chunk = await Effect.runPromise(Effect.matchEffect(pull, {
        onSuccess: (value) => Effect.succeed(Option.some(value)),
        onFailure: (error) => Option.isSome(error)
          ? Effect.fail(error.value)
          : Effect.succeed(Option.none()),
      }));
      if (Option.isNone(chunk)) return;
      yield* chunk.value;
    }
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("creation events Effect service", () => {
  it("still honors external publisher interruption during broadcast", async () => {
    let inboxReads = 0;
    const service = makeCreationEvents({
      readDetail: async () => draft(),
      readInbox: async () => { inboxReads++; return []; },
    });
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      for (let index = 0; index < 4_000; index++) {
        const stream = yield* service.subscribeDetail("ada", "creation-1");
        const pull = yield* Stream.toPull(stream);
        yield* pull;
      }
      const publisher = yield* Effect.fork(service.publish(draft({ revision: 1 }), "attempt-1"));
      yield* Effect.yieldNow();
      const result = yield* Fiber.interrupt(publisher);
      expect(Exit.isInterrupted(result)).toBe(true);
      expect(inboxReads).toBe(0);
    })));
    expect(service.detailSubscriberCount("ada", "creation-1")).toBe(0);
  });

  it("continues publication and inbox refresh when a captured subscriber closes during broadcast", async () => {
    const latest = draft({ revision: 1 });
    let inboxReads = 0;
    const service = makeCreationEvents({
      readDetail: async () => draft(),
      readInbox: async () => { inboxReads++; return [latest]; },
    });
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      // Cross a scheduler quantum after broadcast captures the subscriber list,
      // before it reaches the closing subscriber.
      for (let index = 0; index < 4_000; index++) {
        const stream = yield* service.subscribeDetail("ada", "creation-1");
        const pull = yield* Stream.toPull(stream);
        yield* pull;
      }
      const closingScope = yield* Scope.make();
      const closing = yield* service.subscribeDetail("ada", "creation-1");
      const closingPull = yield* Scope.extend(Stream.toPull(closing), closingScope);
      yield* closingPull;
      const remaining = yield* service.subscribeDetail("ada", "creation-1");
      const remainingPull = yield* Stream.toPull(remaining);
      yield* remainingPull;
      const inbox = yield* service.subscribeInbox("ada");
      const inboxPull = yield* Stream.toPull(inbox);
      yield* inboxPull;

      const publisher = yield* Effect.fork(service.publish(latest, "attempt-1"));
      yield* Effect.yieldNow();
      yield* Scope.close(closingScope, Exit.void);
      const result = yield* Fiber.await(publisher);
      expect(Exit.isSuccess(result)).toBe(true);
      expect(inboxReads).toBe(2);
      expect(Array.from(yield* remainingPull)).toMatchObject([{ revision: 1, attemptId: "attempt-1" }]);
      expect(Array.from(yield* inboxPull)).toMatchObject([{
        changedCreationId: "creation-1", attemptId: "attempt-1", creations: [{ revision: 1 }],
      }]);
    })));
    expect(service.detailSubscriberCount("ada", "creation-1")).toBe(0);
  });

  it("orders the initial snapshot before publications queued prior to the first Effect pull", async () => {
    const service = makeCreationEvents({
      readDetail: async () => draft(),
      readInbox: async () => [],
    });
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const stream = yield* service.subscribeDetail("ada", "creation-1");
      yield* service.publish(draft({ revision: 1 }), "attempt-1");
      yield* service.publish(draft({ revision: 2 }), "attempt-2");
      const pull = yield* Stream.toPull(stream);
      expect(Array.from(yield* pull)).toMatchObject([{ revision: 0, attemptId: null }]);
      expect(Array.from(yield* pull)).toMatchObject([{ revision: 2, attemptId: "attempt-2" }]);
    })));
    expect(service.detailSubscriberCount("ada", "creation-1")).toBe(0);
  });

  it("releases the registered subscriber when its Effect stream is interrupted during the initial read", async () => {
    const reading = Effect.runSync(Deferred.make<void>());
    const service = makeCreationEvents({
      readDetail: () => {
        Effect.runSync(Deferred.succeed(reading, undefined));
        return new Promise<Draft | null>(() => {});
      },
      readInbox: async () => [],
    });
    const stream = Effect.runSync(service.subscribeDetail("ada", "creation-1"));
    expect(service.detailSubscriberCount("ada", "creation-1")).toBe(1);
    // Native stream evaluation owns the read and subscription finalizer.
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(Stream.runDrain(stream));
      yield* Effect.raceFirst(Deferred.await(reading), Fiber.join(fiber));
      yield* Fiber.interrupt(fiber);
    }));
    expect(service.detailSubscriberCount("ada", "creation-1")).toBe(0);
  });

  it("registers before the initial detail snapshot read", async () => {
    const readDetail = vi.fn(async () => draft());
    const service = makeCreationEvents({
      readDetail,
      readInbox: async () => [],
    });

    const stream = iterator(Effect.runSync(service.subscribeDetail("ada", "creation-1")));

    expect(service.detailSubscriberCount("ada", "creation-1")).toBe(1);
    expect(readDetail).not.toHaveBeenCalled();
    await expect(stream.next()).resolves.toMatchObject({
      value: { creationId: "creation-1", revision: 0 },
    });
    await stream.return(undefined);
  });

  it("replaces a stalled detail subscriber's queued snapshot tail", async () => {
    const initial = draft();
    const revised = draft({ revision: 1 });
    const latest = draft({ revision: 2 });
    const service = makeCreationEvents({
      readDetail: async () => initial,
      readInbox: async () => [],
    });
    const stream = iterator(Effect.runSync(service.subscribeDetail("ada", "creation-1")));
    await stream.next();

    await Effect.runPromise(service.publish(revised, "attempt-1"));
    await Effect.runPromise(service.publish(latest, "attempt-2"));

    await expect(stream.next()).resolves.toMatchObject({
      value: { revision: 2, attemptId: "attempt-2", creation: latest },
    });
    await stream.return(undefined);
  });

  it("isolates detail streams and removes a returned subscriber", async () => {
    const service = makeCreationEvents({
      readDetail: async (userId, creationId) => draft({ userId, id: creationId }),
      readInbox: async () => [],
    });
    const ada = iterator(Effect.runSync(service.subscribeDetail("ada", "creation-1")));
    const grace = iterator(Effect.runSync(service.subscribeDetail("grace", "creation-1")));
    await ada.next();
    await grace.next();

    await Effect.runPromise(service.publish(draft({ revision: 1 }), "attempt-1"));

    await expect(ada.next()).resolves.toMatchObject({
      value: { creation: { userId: "ada" }, revision: 1 },
    });
    expect(service.detailSubscriberCount("grace", "creation-1")).toBe(1);

    await grace.return(undefined);
    expect(service.detailSubscriberCount("grace", "creation-1")).toBe(0);
    await ada.return(undefined);
  });

  it("replaces a stalled inbox snapshot tail", async () => {
    const first = draft({ revision: 1 });
    const latest = draft({ revision: 2 });
    const readInbox = vi
      .fn<() => Promise<Draft[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([latest]);
    const service = makeCreationEvents({
      readDetail: async () => null,
      readInbox,
    });
    const stream = iterator(Effect.runSync(service.subscribeInbox("ada")));
    await stream.next();

    await Effect.runPromise(service.publishInbox("ada", "creation-1", "attempt-1"));
    await Effect.runPromise(service.publishInbox("ada", "creation-1", "attempt-2"));

    await expect(stream.next()).resolves.toMatchObject({
      value: { attemptId: "attempt-2", creations: [latest] },
    });
    await stream.return(undefined);
  });

  it("maps an initial snapshot reader failure to DatabaseFailure", async () => {
    const cause = new Error("database unavailable");
    const service = makeCreationEvents({
      readDetail: async () => { throw cause; },
      readInbox: async () => [],
    });
    const stream = Effect.runSync(service.subscribeDetail("ada", "creation-1"));

    await expect(Effect.runPromise(Effect.flip(Stream.runHead(stream)))).resolves.toMatchObject({
      _tag: "DatabaseFailure",
      operation: "creation-events.detail-snapshot",
      cause,
    } satisfies Partial<DatabaseFailure>);
    expect(service.detailSubscriberCount("ada", "creation-1")).toBe(0);
  });
});
