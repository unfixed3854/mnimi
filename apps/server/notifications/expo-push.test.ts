import { describe, expect, it, vi } from "vitest";
import { isExpoPushToken, sendExpoPush } from "./expo-push.ts";

describe("sendExpoPush", () => {
  it("accepts only the two supported Expo token forms", () => {
    expect(isExpoPushToken("ExponentPushToken[abc_123-Z]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abc_123-Z]")).toBe(true);
    expect(isExpoPushToken("ExponentPushToken[]")).toBe(false);
    expect(isExpoPushToken("prefix ExpoPushToken[abc]")).toBe(false);
    expect(isExpoPushToken("fcm-token")).toBe(false);
  });

  it("does not fetch an empty batch", async () => {
    const fetchMock = vi.fn();

    await expect(sendExpoPush([], fetchMock)).resolves.toEqual({
      invalidTokens: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts learner-safe messages and reports only invalid tokens", async () => {
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) =>
      new Response(JSON.stringify({
      data: [
        { status: "ok", id: "ticket-1" },
        {
          status: "error",
          message: "provider detail",
          details: { error: "DeviceNotRegistered" },
        },
      ],
      }), { status: 200 }));
    const messages = [
      {
        token: "ExponentPushToken[valid-one]",
        title: "Mnimi",
        body: "Your creation is ready to review",
        data: { creationId: "creation-1" },
      },
      {
        token: "ExpoPushToken[invalid-two]",
        title: "Mnimi",
        body: "Your creation is ready to review",
        data: { creationId: "creation-2" },
      },
    ];

    await expect(sendExpoPush(messages, fetchMock)).resolves.toEqual({
      invalidTokens: ["ExpoPushToken[invalid-two]"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://exp.host/--/api/v2/push/send",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual(messages.map((message) => ({
      to: message.token,
      title: message.title,
      body: message.body,
      data: message.data,
      sound: "default",
    })));
  });

  it("keeps non-registration ticket errors valid and tolerates absent tickets", async () => {
    const messages = [{
      token: "ExponentPushToken[valid-one]",
      title: "Mnimi",
      body: "Ready",
      data: { route: "/add" as const },
    }];
    const providerError = vi.fn(async () => new Response(JSON.stringify({
      data: [{ status: "error", details: { error: "MessageTooBig" } }],
    }), { status: 200 }));
    const absent = vi.fn(async () => new Response("{}", { status: 200 }));
    const malformed = vi.fn(async () => new Response(
      JSON.stringify({ data: "not-an-array" }),
      { status: 200 },
    ));

    await expect(sendExpoPush(messages, providerError)).resolves.toEqual({
      invalidTokens: [],
    });
    await expect(sendExpoPush(messages, absent)).resolves.toEqual({
      invalidTokens: [],
    });
    await expect(sendExpoPush(messages, malformed)).resolves.toEqual({
      invalidTokens: [],
    });
  });

  it("preserves the exact non-success error and fetch rejection identity", async () => {
    const messages = [{
      token: "ExponentPushToken[valid-one]",
      title: "Mnimi",
      body: "Ready",
      data: { route: "/add" as const },
    }];
    await expect(sendExpoPush(
      messages,
      async () => new Response(null, { status: 429 }),
    )).rejects.toThrow("Expo Push request failed with status 429");

    const primary = new Error("offline");
    const fetchMock = vi.fn(async () => {
      throw primary;
    });
    await expect(sendExpoPush(messages, fetchMock)).rejects.toBe(primary);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("resolves the default fetcher at invocation time", async () => {
    const currentFetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", currentFetcher);
    try {
      await expect(sendExpoPush([{
        token: "ExponentPushToken[valid-one]",
        title: "Mnimi",
        body: "Ready",
        data: { route: "/add" },
      }])).resolves.toEqual({ invalidTokens: [] });
      expect(currentFetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
