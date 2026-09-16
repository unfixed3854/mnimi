import type { Db } from "../db/index.ts";
import {
  makeNotificationDispatcherPromiseFacade,
  makeNotificationSendFromPromise,
  makeNotifications,
  type NotificationDispatcher,
} from "../effect/notifications.ts";
import type { ExpoPushMessage, ExpoPushResult } from "./expo-push.ts";

type DispatcherDeps = {
  db: Db;
  send?: (messages: ExpoPushMessage[]) => Promise<ExpoPushResult>;
  delayMs?: number;
};

export type { NotificationDispatcher };

export function createNotificationDispatcher(
  deps: DispatcherDeps,
): NotificationDispatcher {
  if (deps.send === undefined) throw new Error("A notification delivery dependency is required");
  const send = makeNotificationSendFromPromise(deps.send);
  const service = makeNotifications({
    db: deps.db,
    send,
    delayMs: deps.delayMs,
  });

  // Explicit delivery injection remains available to isolated compatibility tests.
  return makeNotificationDispatcherPromiseFacade(service);
}
