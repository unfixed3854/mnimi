import {
  makeExpoPush,
  makeExpoPushPromiseFacade,
  type ExpoPushMessage,
  type ExpoPushResult,
  type PushFetch,
} from "../effect/expo-push.ts";

export type { ExpoPushMessage, ExpoPushResult, PushFetch };

const TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

export function isExpoPushToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

const defaultFacade = makeExpoPushPromiseFacade(
  makeExpoPush((input, init) => fetch(input, init)),
);

export async function sendExpoPush(
  messages: ExpoPushMessage[],
  fetcher: PushFetch = fetch,
): Promise<ExpoPushResult> {
  // Removed when notification transport consumes ExpoPush Effects directly.
  const facade = fetcher === fetch
    ? defaultFacade
    : makeExpoPushPromiseFacade(makeExpoPush(fetcher));
  return await facade(messages);
}
