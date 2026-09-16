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

const session = {
  user: {
    id: "user-1",
    email: "ada@example.com",
    name: "Ada",
    nativeLanguage: "en",
    uiLanguage: "en",
    ttsAutoplay: true,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("session store", () => {
  beforeEach(() => {
    jest.resetModules();
    mockStorage.clear();
    mockFetch.mockReset();
    process.env.EXPO_PUBLIC_API_URL = "https://api.example.com";
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("loads the session with the stored bearer token and captures a rotated token", async () => {
    mockStorage.set("mnimi.bearer", "old-token");
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(session), {
        headers: { "set-auth-token": "rotated-token" },
      }),
    );

    const { getSession, initializeSession } = await import(
      "@/auth/session-store"
    );
    const { getToken } = await import("@/auth/token-store");

    await initializeSession();

    expect(getSession()).toEqual(session);
    expect((await import("@/auth/session-store")).getSessionState().status)
      .toBe("ready");
    expect(await getToken()).toBe("rotated-token");
    const [requestUrl, requestOptions] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(requestUrl).toBe("https://api.example.com/api/auth/get-session");
    expect(new Headers(requestOptions.headers).get("authorization")).toBe(
      "Bearer old-token",
    );
  });

  it("reports a connection error without treating the visitor as signed out", async () => {
    mockFetch.mockRejectedValue(new TypeError("Network request failed"));
    const { getSessionState, initializeSession } = await import(
      "@/auth/session-store"
    );

    await initializeSession();

    expect(getSessionState()).toEqual({ session: null, status: "error" });
  });

  it("stops waiting for an unresponsive server after ten seconds", async () => {
    jest.useFakeTimers();
    const pendingResponse = deferred<Response>();
    mockFetch.mockReturnValue(pendingResponse.promise);
    const { getSessionState, initializeSession } = await import(
      "@/auth/session-store"
    );

    const initialization = initializeSession();
    await jest.advanceTimersByTimeAsync(10_000);

    try {
      expect(getSessionState()).toEqual({ session: null, status: "error" });
    } finally {
      pendingResponse.resolve(new Response(null, { status: 401 }));
      await initialization;
    }
  });

  it("returns to loading and becomes ready when startup is retried", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const { getSessionState, initializeSession, reloadSession } = await import(
      "@/auth/session-store"
    );

    await initializeSession();
    expect(getSessionState().status).toBe("error");

    const retry = reloadSession();
    expect(getSessionState().status).toBe("loading");
    await retry;

    expect(getSessionState()).toEqual({ session: null, status: "ready" });
  });

  it("drops a rejected session and notifies subscribers", async () => {
    mockStorage.set("mnimi.bearer", "token");
    mockFetch.mockResolvedValue(new Response(JSON.stringify(session)));
    const {
      clearRejectedSession,
      getSession,
      initializeSession,
      subscribeAuth,
    } = await import("@/auth/session-store");
    const { getToken } = await import("@/auth/token-store");
    const listener = jest.fn();
    const unsubscribe = subscribeAuth(listener);

    await initializeSession();
    listener.mockClear();
    await clearRejectedSession();

    expect(getSession()).toBeNull();
    expect(await getToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(await clearRejectedSession()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not restore a boot session that finished after rejection", async () => {
    mockStorage.set("mnimi.bearer", "token");
    const initialResponse = deferred<Response>();
    mockFetch.mockReturnValue(initialResponse.promise);
    const { clearRejectedSession, getSession, initializeSession } =
      await import(
        "@/auth/session-store"
      );
    const { getToken } = await import("@/auth/token-store");

    const initialization = initializeSession();
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await clearRejectedSession();
    initialResponse.resolve(
      new Response(JSON.stringify(session), {
        headers: { "set-auth-token": "rotated-token" },
      }),
    );
    await initialization;

    expect(getSession()).toBeNull();
    expect(await getToken()).toBeNull();
  });

  it("coalesces concurrent RPC 401 cleanup into one cache clear", async () => {
    mockStorage.set("mnimi.bearer", "token");
    mockFetch.mockResolvedValue(new Response(null, { status: 401 }));
    const { clearRejectedSession } = await import("@/auth/session-store");
    const { onSessionRejected, sessionAwareFetch } = await import(
      "@/api/session-rejection"
    );
    const clearCache = jest.fn();
    const unregister = onSessionRejected(async () => {
      if (await clearRejectedSession()) clearCache();
    });

    await Promise.all([
      sessionAwareFetch("https://api.example.com/rpc/decks/list"),
      sessionAwareFetch("https://api.example.com/rpc/decks/list"),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(await (await import("@/auth/token-store")).getToken())
      .toBeNull();
    unregister();
  });
});
