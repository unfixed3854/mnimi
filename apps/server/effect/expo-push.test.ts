import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ProviderFailure } from "./errors.ts";
import {
  ExpoPush,
  makeExpoPush,
  makeExpoPushLayer,
  type ExpoPushMessage,
} from "./expo-push.ts";

const messages: ExpoPushMessage[] = [
  {
    token: "ExponentPushToken[valid-one]",
    title: "Mnimi",
    body: "Ready",
    data: { creationId: "creation-1" },
  },
  {
    token: "ExpoPushToken[invalid-two]",
    title: "Mnimi",
    body: "Attention",
    data: { route: "/add" },
  },
];

describe("ExpoPush", () => {
  it("constructs without fetching and skips fetch for an empty batch", async () => {
    const fetcher = vi.fn();
    const service = makeExpoPush(fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    await expect(Effect.runPromise(service.send([]))).resolves.toEqual({
      invalidTokens: [],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("posts the exact ordered payload and maps invalid tickets by position", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { status: "ok" },
        { status: "error", details: { error: "DeviceNotRegistered" } },
      ],
    }), { status: 200 }));
    const service = makeExpoPush(fetcher);

    await expect(Effect.runPromise(service.send(messages))).resolves.toEqual({
      invalidTokens: ["ExpoPushToken[invalid-two]"],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
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
  });

  it("returns a typed status failure with the exact compatibility cause", async () => {
    const service = makeExpoPush(async () => new Response(null, { status: 503 }));

    const failure = await Effect.runPromise(Effect.flip(service.send(messages)));
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure).toMatchObject({
      provider: "expo-push",
      operation: "expo-push.send",
      message: "Expo Push request failed with status 503",
    });
    expect(failure.cause).toEqual(
      new Error("Expo Push request failed with status 503"),
    );
  });

  it("retains fetch rejection identity and never retries", async () => {
    const primary = new Error("offline");
    const fetcher = vi.fn(async () => {
      throw primary;
    });
    const service = makeExpoPush(fetcher);

    const failure = await Effect.runPromise(Effect.flip(service.send(messages)));
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.cause).toBe(primary);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("provides the same service through its Layer", async () => {
    const fetcher = vi.fn();
    const result = await Effect.runPromise(
      Effect.flatMap(ExpoPush, (service) => service.send([])).pipe(
        Effect.provide(makeExpoPushLayer(fetcher)),
      ),
    );

    expect(result).toEqual({ invalidTokens: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
