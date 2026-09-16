const mockStorage = new Map<string, string>();
const mockFetch = jest.fn();

jest.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(mockStorage.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    mockStorage.delete(key);
    return Promise.resolve();
  },
}));

describe("authenticated auth endpoints", () => {
  beforeEach(() => {
    jest.resetModules();
    mockStorage.clear();
    mockStorage.set("mnimi.bearer", "old-token");
    mockFetch.mockReset();
    process.env.EXPO_PUBLIC_API_URL = "https://api.example.com";
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it("persists a token rotated by a preference update", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, { headers: { "set-auth-token": "rotated-token" } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(null)));
    const { updateNativeLanguage } = await import("@/auth/auth");
    const { getToken } = await import("@/auth/token-store");

    await updateNativeLanguage("pl");

    expect(await getToken()).toBe("rotated-token");
  });

  it("omits cookies from native bearer requests", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null));
    const { sessionAwareFetch } = await import(
      "@/api/session-rejection"
    );

    await sessionAwareFetch("https://api.example.com/api/auth/update-user");

    const [, requestOptions] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(requestOptions.credentials).toBe("omit");
  });

  it.each(["other-account", null])("attaches the current %s bearer even if a caller supplies a stale header", async (currentToken) => {
    if (currentToken) mockStorage.set("mnimi.bearer", currentToken);
    else mockStorage.clear();
    mockFetch.mockResolvedValueOnce(new Response(null));
    const { sessionAwareFetch } = await import("@/api/session-rejection");
    await sessionAwareFetch("https://api.example.com/rpc/decks/list", {
      headers: { authorization: "Bearer old-token" },
    });
    const [, requestOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(new Headers(requestOptions.headers).get("authorization")).toBe(
      currentToken ? "Bearer other-account" : null,
    );
  });

  it.each([200, 401])("ignores a stale %s after another tab changes the bearer", async (status) => {
    let finish!: (response: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const { onSessionRejected, sessionAwareFetch } = await import("@/api/session-rejection");
    const reject = jest.fn();
    const remove = onSessionRejected(reject);
    const request = sessionAwareFetch("https://api.example.com/api/auth/get-session");
    await Promise.resolve();
    mockStorage.set("mnimi.bearer", "other-account");
    finish(new Response(null, { status, headers: { "set-auth-token": "old-account-rotation" } }));
    await expect(request).rejects.toThrow("Your session changed");
    expect(mockStorage.get("mnimi.bearer")).toBe("other-account");
    expect(reject).not.toHaveBeenCalled();
    remove();
  });

  it("clears the session and cache when a preference update is rejected", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 401 }));
    const { onSessionRejected, sessionAwareFetch } = await import(
      "@/api/session-rejection"
    );
    const { clearRejectedSession, setCurrentSession } = await import(
      "@/auth/session-store"
    );
    const { getToken } = await import("@/auth/token-store");
    const clearCache = jest.fn();
    setCurrentSession({
      user: {
        id: "user-1",
        email: "ada@example.com",
        name: "Ada",
        nativeLanguage: "en",
        uiLanguage: "en",
        ttsAutoplay: true,
        aiInstructions: "",
      },
    });
    const unregister = onSessionRejected(async () => {
      if (await clearRejectedSession()) clearCache();
    });

    await sessionAwareFetch("https://api.example.com/api/auth/update-user");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await getToken()).toBeNull();
    expect(clearCache).toHaveBeenCalledTimes(1);

    unregister();
  });

  it("leaves an unrelated valid session intact when a sign-in attempt fails", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 401 }));
    const { onSessionRejected, sessionAwareFetch } = await import(
      "@/api/session-rejection"
    );
    const { clearRejectedSession, getSession, setCurrentSession } =
      await import("@/auth/session-store");
    const { getToken } = await import("@/auth/token-store");
    const session = {
      user: {
        id: "user-1",
        email: "ada@example.com",
        name: "Ada",
        nativeLanguage: "en",
        uiLanguage: "en",
        ttsAutoplay: true,
        aiInstructions: "",
      },
    };
    const clearCache = jest.fn();
    setCurrentSession(session);
    const unregister = onSessionRejected(async () => {
      if (await clearRejectedSession()) clearCache();
    });

    await sessionAwareFetch("https://api.example.com/api/auth/sign-in/email");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(getSession()).toEqual(session);
    expect(await getToken()).toBe("old-token");
    expect(clearCache).not.toHaveBeenCalled();
    unregister();
  });
});
