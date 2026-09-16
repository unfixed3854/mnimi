import { and, eq, inArray } from "drizzle-orm";
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import type { Db } from "../db/index.ts";
import { drafts, pushInstallations } from "../db/schema.ts";
import { Database } from "./database.ts";
import {
  ExpoPush,
  type ExpoPushMessage,
  type ExpoPushResult,
} from "./expo-push.ts";
import { InfrastructureFailure, ProviderFailure } from "./errors.ts";
import { Logging } from "./logging.ts";

type TimerHandle = number | { unref?: () => void };
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;

export type NotificationSend = (
  messages: readonly ExpoPushMessage[],
) => Effect.Effect<ExpoPushResult, ProviderFailure>;

export type NotificationFailure = InfrastructureFailure | ProviderFailure;

export type NotificationsService = Readonly<{
  queue(userId: string, creationId: string): Effect.Effect<void>;
  flush(userId: string): Effect.Effect<void, NotificationFailure>;
  stop(): Effect.Effect<void>;
  settle(): Effect.Effect<void>;
}>;

export class Notifications extends Context.Tag("@mnimi/server/Notifications")<
  Notifications,
  NotificationsService
>() {}

export type NotificationsDependencies = Readonly<{
  db: Db;
  send: NotificationSend;
  delayMs?: number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
  reportError?: (error: unknown) => void;
}>;

export type NotificationDispatcher = {
  queue(userId: string, creationId: string): void;
  flush(userId: string): Promise<void>;
  stop(): void;
};

function originalCause(error: unknown): unknown {
  return (error instanceof InfrastructureFailure ||
      error instanceof ProviderFailure) && error.cause !== undefined
    ? error.cause
    : error;
}

function isSwallowedDeliveryFailure(
  error: NotificationFailure,
): boolean {
  return error instanceof ProviderFailure ||
    (error instanceof InfrastructureFailure &&
      error.operation === "notifications.delete-invalid-installations");
}

function reportDeliveryFailure(
  effect: Effect.Effect<void, NotificationFailure>,
  reportError: (error: unknown) => void,
): Effect.Effect<void, NotificationFailure> {
  return effect.pipe(Effect.catchAll((error) =>
    isSwallowedDeliveryFailure(error)
      ? Effect.sync(() => reportError(originalCause(error)))
      : Effect.fail(error)
  ));
}

function databaseEffect<A>(operation: string, work: () => Promise<A>) {
  return Effect.tryPromise({
    try: work,
    catch: (cause) => new InfrastructureFailure({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  });
}

export function makeNotificationSendFromPromise(
  send: (messages: ExpoPushMessage[]) => Promise<ExpoPushResult>,
): NotificationSend {
  return (messages) => Effect.tryPromise({
    try: () => send([...messages]),
    catch: (cause) => new ProviderFailure({
      provider: "expo-push",
      operation: "expo-push.send",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  });
}

export function makeNotifications(
  dependencies: NotificationsDependencies,
): NotificationsService {
  const pending = new Map<string, Set<string>>();
  const timers = new Map<string, TimerHandle>();
  const deliveries = new Set<Promise<void>>();
  let stopped = false;
  const delayMs = dependencies.delayMs ?? 2_000;
  const setTimer: SetTimer = dependencies.setTimer ??
    ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer: ClearTimer = dependencies.clearTimer ??
    ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const reportError = dependencies.reportError ??
    ((error: unknown) =>
      console.error("creation notification delivery failed", error));

  const takePending = (userId: string) => Effect.sync(() => {
    const timer = timers.get(userId);
    if (timer) clearTimer(timer);
    timers.delete(userId);
    const ids = [...(pending.get(userId) ?? [])];
    pending.delete(userId);
    return ids;
  });

  const flushWork = (userId: string) => Effect.gen(function* () {
    const ids = yield* takePending(userId);
    if (ids.length === 0) return;

    const actionable = yield* databaseEffect(
      "notifications.select-actionable",
      () => dependencies.db.select({
        id: drafts.id,
        status: drafts.status,
      }).from(drafts).where(and(
        eq(drafts.userId, userId),
        inArray(drafts.id, ids),
        inArray(drafts.status, ["needs_choice", "ready"]),
      )),
    );
    if (actionable.length === 0) return;

    const installations = yield* databaseEffect(
      "notifications.select-installations",
      () => dependencies.db.select({ token: pushInstallations.token })
        .from(pushInstallations)
        .where(eq(pushInstallations.userId, userId)),
    );
    if (installations.length === 0) return;

    const ready = actionable.filter((item) => item.status === "ready").length;
    const choices = actionable.length - ready;
    const body = actionable.length === 1
      ? ready === 1
        ? "Your creation is ready to review"
        : "Your creation needs a deck choice"
      : choices === 0
      ? `${ready} creations are ready to review`
      : ready === 0
      ? `${choices} creations need a deck choice`
      : `${actionable.length} creations need your attention`;
    const data = actionable.length === 1
      ? { creationId: actionable[0].id }
      : { route: "/add" as const };

    const result = yield* dependencies.send(installations.map(({ token }) => ({
      token,
      title: "Mnimi",
      body,
      data,
    })));
    if (result.invalidTokens.length === 0) return;

    yield* databaseEffect(
      "notifications.delete-invalid-installations",
      () => dependencies.db.delete(pushInstallations).where(and(
        eq(pushInstallations.userId, userId),
        inArray(pushInstallations.token, result.invalidTokens),
      )),
    );
  });

  const flush = (userId: string): Effect.Effect<void, NotificationFailure> =>
    Effect.suspend(() => stopped ? Effect.void : flushWork(userId));

  const startDelivery = (userId: string): void => {
    const delivery = Effect.runPromise(
      reportDeliveryFailure(flush(userId), reportError),
    );
    deliveries.add(delivery);
    void delivery.then(
      () => deliveries.delete(delivery),
      () => deliveries.delete(delivery),
    );
  };

  return {
    queue: (userId, creationId) => Effect.sync(() => {
      if (stopped) return;
      const ids = pending.get(userId) ?? new Set<string>();
      ids.add(creationId);
      pending.set(userId, ids);
      const old = timers.get(userId);
      if (old) clearTimer(old);
      const timer = setTimer(() => {
        startDelivery(userId);
      }, delayMs);
      if (typeof timer === "object") timer.unref?.();
      timers.set(userId, timer);
    }),
    flush,
    stop: () => Effect.sync(() => {
      stopped = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      pending.clear();
    }),
    settle: () => Effect.promise(async () => {
      const results = await Promise.allSettled([...deliveries]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }),
  };
}

export function makeNotificationsLayer(): Layer.Layer<
  Notifications,
  never,
  Database | ExpoPush | Logging
> {
  return Layer.effect(
    Notifications,
    Effect.gen(function* () {
      const database = yield* Database;
      const push = yield* ExpoPush;
      const logging = yield* Logging;
      const logger = logging.getLogger(["mnimi", "notifications"]);
      return makeNotifications({
        db: database.db,
        send: push.send,
        reportError: (error) => logger.error(
          "creation notification delivery failed: {error}",
          { error },
        ),
      });
    }),
  );
}

/** Removed when creation jobs and schedulers consume Notifications directly. */
export function makeNotificationDispatcherPromiseFacade(
  service: NotificationsService,
  reportError: (error: unknown) => void = (error) =>
    console.error("creation notification delivery failed", error),
): NotificationDispatcher {
  const flush = async (userId: string): Promise<void> => {
    const exit = await Effect.runPromiseExit(service.flush(userId));
    if (Exit.isSuccess(exit)) return;

    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      if (isSwallowedDeliveryFailure(failure.value)) {
        reportError(originalCause(failure.value));
        return;
      }
      throw originalCause(failure.value);
    }
    throw Cause.squash(exit.cause);
  };

  return {
    queue: (userId, creationId) => {
      Effect.runSync(service.queue(userId, creationId));
    },
    flush,
    stop: () => {
      Effect.runSync(service.stop());
    },
  };
}
