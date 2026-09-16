const mockFetch = jest.fn();

describe("registration availability", () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockReset();
    process.env.EXPO_PUBLIC_API_URL = "https://api.example.com";
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it("queries the public registration endpoint", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ enabled: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const auth = await import("@/auth/auth");

    await expect(auth.getRegistrationEnabled()).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/api/registration",
    );
  });

  it("rejects malformed or unsuccessful responses", async () => {
    const auth = await import("@/auth/auth");
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(auth.getRegistrationEnabled()).rejects.toThrow();

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ enabled: "yes" }), { status: 200 }),
    );
    await expect(auth.getRegistrationEnabled()).rejects.toThrow();
  });
});
