import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { ProviderFailure } from "./errors.ts";

export type ExpoPushMessage = {
  token: string;
  title: string;
  body: string;
  data: { creationId: string } | { route: "/add" };
};

export type ExpoPushResult = { invalidTokens: string[] };

export type PushFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type ExpoPushService = Readonly<{
  send(
    messages: readonly ExpoPushMessage[],
  ): Effect.Effect<ExpoPushResult, ProviderFailure>;
}>;

export class ExpoPush extends Context.Tag("@mnimi/server/ExpoPush")<
  ExpoPush,
  ExpoPushService
>() {}

const failure = (cause: unknown) => new ProviderFailure({
  provider: "expo-push",
  operation: "expo-push.send",
  message: cause instanceof Error ? cause.message : String(cause),
  cause,
});

export function makeExpoPush(fetcher: PushFetch = fetch): ExpoPushService {
  return {
    send: (messages) => {
      if (messages.length === 0) {
        return Effect.succeed({ invalidTokens: [] });
      }

      return Effect.tryPromise({
        try: async () => {
          const response = await fetcher(
            "https://exp.host/--/api/v2/push/send",
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
              },
              body: JSON.stringify(messages.map((message) => ({
                to: message.token,
                title: message.title,
                body: message.body,
                data: message.data,
                sound: "default",
              }))),
            },
          );
          if (!response.ok) {
            throw new Error(
              `Expo Push request failed with status ${response.status}`,
            );
          }
          const payload = await response.json() as {
            data?: Array<{
              status?: string;
              details?: { error?: string };
            }>;
          };
          const tickets = Array.isArray(payload.data) ? payload.data : [];
          return {
            invalidTokens: messages.flatMap((message, index) =>
              tickets[index]?.status === "error" &&
                tickets[index]?.details?.error === "DeviceNotRegistered"
                ? [message.token]
                : []
            ),
          };
        },
        catch: failure,
      });
    },
  };
}

export function makeExpoPushLayer(
  fetcher: PushFetch = fetch,
): Layer.Layer<ExpoPush> {
  return Layer.succeed(ExpoPush, makeExpoPush(fetcher));
}

export const ExpoPushLive = makeExpoPushLayer();

function compatibilityCause(error: unknown): unknown {
  return error instanceof ProviderFailure && error.cause !== undefined
    ? error.cause
    : error;
}

/** Removed when the notification transport consumes ExpoPush Effects. */
export function makeExpoPushPromiseFacade(service: ExpoPushService) {
  return async (
    messages: readonly ExpoPushMessage[],
  ): Promise<ExpoPushResult> => {
    const exit = await Effect.runPromiseExit(service.send(messages));
    if (Exit.isSuccess(exit)) return exit.value;

    const typedFailure = Cause.failureOption(exit.cause);
    if (Option.isSome(typedFailure)) {
      throw compatibilityCause(typedFailure.value);
    }
    throw Cause.squash(exit.cause);
  };
}
