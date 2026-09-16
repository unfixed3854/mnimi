const mockFetch = jest.fn();
const mockSetCurrentSession = jest.fn();
const mockStorage = new Map<string, string>();

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
jest.mock("@/auth/session-store", () => ({
  refreshSession: jest.fn(),
  setCurrentSession: mockSetCurrentSession,
}));

describe("signOut", () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockReset();
    mockSetCurrentSession.mockReset();
    mockStorage.clear();
    process.env.EXPO_PUBLIC_API_URL = "https://api.example.com";
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it("does not clear a newer login when an older sign-out finishes", async () => {
    mockStorage.set("mnimi.bearer", "account-a");
    let finish!: (response: Response) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    mockFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finish = resolve;
      started();
    }));
    const { onSignedOut, signOut } = await import("@/auth/auth");
    const clearCache = jest.fn();
    const unregister = onSignedOut(clearCache);

    const pending = signOut();
    await requestStarted;
    mockStorage.set("mnimi.bearer", "account-b");
    finish(new Response(null));

    await expect(pending).rejects.toThrow("Your session changed");
    expect(mockStorage.get("mnimi.bearer")).toBe("account-b");
    expect(clearCache).not.toHaveBeenCalled();
    expect(mockSetCurrentSession).not.toHaveBeenCalled();
    unregister();
  });

  it("clears registered query data before publishing the signed-out session", async () => {
    const order: string[] = [];
    mockFetch.mockResolvedValue(new Response(null));
    mockSetCurrentSession.mockImplementation(() => order.push("session"));
    const { onSignedOut, signOut } = await import("@/auth/auth");
    const unregister = onSignedOut(() => {
      order.push("cache");
    });

    await signOut();

    expect(order).toEqual(["cache", "session"]);
    unregister();
  });
});
