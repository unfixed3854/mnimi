import { getApiUrl } from "@/config/api-url";

describe("getApiUrl", () => {
  it("accepts a private LAN HTTP API during development", () => {
    expect(
      getApiUrl({ apiUrl: "http://192.168.1.20:8787", development: true }),
    ).toBe("http://192.168.1.20:8787");
  });

  it("normalizes one trailing slash from a private development URL", () => {
    expect(
      getApiUrl({ apiUrl: "http://10.0.2.2:8787/", development: true }),
    ).toBe("http://10.0.2.2:8787");
  });

  it("rejects public HTTP even during development", () => {
    expect(() =>
      getApiUrl({ apiUrl: "http://api.example.com", development: true })
    ).toThrow(
      "EXPO_PUBLIC_API_URL may use HTTP only for private LAN hosts in development",
    );
  });

  it("requires HTTPS outside development", () => {
    expect(() =>
      getApiUrl({ apiUrl: "http://api.example.com", development: false })
    ).toThrow("EXPO_PUBLIC_API_URL must use HTTPS outside development");
  });

  it("rejects an unset API URL", () => {
    expect(() => getApiUrl({ apiUrl: undefined, development: true })).toThrow(
      "EXPO_PUBLIC_API_URL must be set",
    );
  });
});
