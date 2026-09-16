import { Cause, Context, Effect, Layer, Queue, Stream } from "effect";
import type { Draft } from "../db/schema.ts";
import { DatabaseFailure } from "./errors.ts";

export type CreationDetailSnapshot = {
  type: "snapshot";
  creationId: string;
  attemptId: string | null;
  revision: number;
  creation: Draft | null;
};

export type CreationInboxSnapshot = {
  type: "snapshot";
  userId: string;
  changedCreationId: string | null;
  attemptId: string | null;
  creations: Draft[];
};

export type CreationEventReaders = Readonly<{
  readDetail(userId: string, creationId: string): Promise<Draft | null>;
  readInbox(userId: string): Promise<Draft[]>;
}>;

export type CreationEventsService = Readonly<{
  subscribeDetail(
    userId: string,
    creationId: string,
  ): Effect.Effect<Stream.Stream<CreationDetailSnapshot, DatabaseFailure>>;
  subscribeInbox(
    userId: string,
  ): Effect.Effect<Stream.Stream<CreationInboxSnapshot, DatabaseFailure>>;
  publish(
    creation: Draft,
    attemptId: string | null,
  ): Effect.Effect<void, DatabaseFailure>;
  publishInbox(
    userId: string,
    changedCreationId: string | null,
    attemptId: string | null,
  ): Effect.Effect<void, DatabaseFailure>;
  detailSubscriberCount(userId: string, creationId: string): number;
}>;

export class CreationEvents extends Context.Tag(
  "@mnimi/server/CreationEvents",
)<CreationEvents, CreationEventsService>() {}

function detailKey(userId: string, creationId: string): string {
  return `${userId}:${creationId}`;
}

function addSubscriber<T>(
  registry: Map<string, Set<Queue.Queue<T>>>,
  key: string,
  subscriber: Queue.Queue<T>,
) {
  const subscribers = registry.get(key) ?? new Set<Queue.Queue<T>>();
  subscribers.add(subscriber);
  registry.set(key, subscribers);
}

function removeSubscriber<T>(
  registry: Map<string, Set<Queue.Queue<T>>>,
  key: string,
  subscriber: Queue.Queue<T>,
) {
  const subscribers = registry.get(key);
  subscribers?.delete(subscriber);
  if (subscribers?.size === 0) registry.delete(key);
}

function failure(operation: string, cause: unknown): DatabaseFailure {
  return cause instanceof DatabaseFailure
    ? cause
    : new DatabaseFailure({ operation, cause });
}

function subscribe<T>(
  registry: Map<string, Set<Queue.Queue<T>>>,
  key: string,
  initialSnapshot: Effect.Effect<T, DatabaseFailure>,
): Effect.Effect<Stream.Stream<T, DatabaseFailure>> {
  return Effect.gen(function* () {
    // Every event is a full snapshot, so only the newest queued tail is needed.
    const subscriber = yield* Queue.sliding<T>(1);
    addSubscriber(registry, key, subscriber);
    return Stream.concat(
      Stream.fromEffect(initialSnapshot),
      Stream.fromQueue(subscriber, { maxChunkSize: 1 }),
    ).pipe(Stream.ensuring(Effect.zipRight(
      Effect.sync(() => removeSubscriber(registry, key, subscriber)),
      Queue.shutdown(subscriber),
    )));
  });
}

function broadcast<T>(subscribers: Set<Queue.Queue<T>> | undefined, snapshot: T) {
  // A captured subscriber may close before its offer runs. Mask just this
  // nonblocking delivery so its shutdown interruption can be recovered without
  // swallowing external cancellation, which is restored between deliveries.
  return Effect.forEach(subscribers ?? [], (subscriber) => Effect.uninterruptible(
    Queue.offer(subscriber, snapshot).pipe(Effect.catchAllCause((cause) =>
      Effect.flatMap(Queue.isShutdown(subscriber), (closed) =>
        closed && Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause),
      ),
    )),
  ), {
    discard: true,
  });
}

export function makeCreationEvents(
  readers: CreationEventReaders,
): CreationEventsService {
  const detailSubscribers = new Map<string, Set<Queue.Queue<CreationDetailSnapshot>>>();
  const inboxSubscribers = new Map<string, Set<Queue.Queue<CreationInboxSnapshot>>>();

  const detailSnapshot = (userId: string, creationId: string) => Effect.map(
    Effect.tryPromise({
      try: () => readers.readDetail(userId, creationId),
      catch: (cause) => failure("creation-events.detail-snapshot", cause),
    }),
    (creation): CreationDetailSnapshot => ({
      type: "snapshot",
      creationId,
      attemptId: creation?.activeAttemptId ?? null,
      revision: creation?.revision ?? 0,
      creation,
    }),
  );

  const inboxSnapshot = (
    userId: string,
    changedCreationId: string | null,
    attemptId: string | null,
  ) => Effect.map(
    Effect.tryPromise({
      try: () => readers.readInbox(userId),
      catch: (cause) => failure("creation-events.inbox-snapshot", cause),
    }),
    (creations): CreationInboxSnapshot => ({
      type: "snapshot",
      userId,
      changedCreationId,
      attemptId,
      creations,
    }),
  );

  const publishInbox = (
    userId: string,
    changedCreationId: string | null,
    attemptId: string | null,
  ): Effect.Effect<void, DatabaseFailure> => Effect.flatMap(
    inboxSnapshot(userId, changedCreationId, attemptId),
    (snapshot) => broadcast(inboxSubscribers.get(userId), snapshot),
  );

  return {
    subscribeDetail: (userId, creationId) => subscribe(
      detailSubscribers,
      detailKey(userId, creationId),
      detailSnapshot(userId, creationId),
    ),
    subscribeInbox: (userId) => subscribe(
      inboxSubscribers,
      userId,
      inboxSnapshot(userId, null, null),
    ),
    publish: (creation, attemptId) => Effect.zipRight(
      Effect.suspend(() => {
        const snapshot: CreationDetailSnapshot = {
          type: "snapshot",
          creationId: creation.id,
          attemptId,
          revision: creation.revision,
          creation,
        };
        return broadcast(detailSubscribers.get(detailKey(creation.userId, creation.id)), snapshot);
      }),
      publishInbox(creation.userId, creation.id, attemptId),
    ),
    publishInbox,
    detailSubscriberCount: (userId, creationId) =>
      detailSubscribers.get(detailKey(userId, creationId))?.size ?? 0,
  };
}

export function makeCreationEventsLayer(
  readers: CreationEventReaders,
): Layer.Layer<CreationEvents> {
  return Layer.succeed(CreationEvents, makeCreationEvents(readers));
}
