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

import { clearToken, getToken, setToken } from "@/auth/token-store";

describe("token store", () => {
  beforeEach(() => {
    mockStorage.clear();
  });

  it("persists and clears the bearer token", async () => {
    await setToken("token");
    expect(await getToken()).toBe("token");

    await clearToken();
    expect(await getToken()).toBeNull();
  });
});
