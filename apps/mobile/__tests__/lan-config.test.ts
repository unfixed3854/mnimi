import appConfig from "../app.json";
import { getApiUrl } from "@/config/api-url";

type AndroidConfig = {
  usesCleartextTraffic?: boolean;
};

describe("Android LAN configuration", () => {
  it("allows a private HTTP API only for development builds", () => {
    expect(
      getApiUrl({ apiUrl: "http://192.168.1.20:8787", development: true }),
    ).toBe("http://192.168.1.20:8787");
    expect(() =>
      getApiUrl({ apiUrl: "http://192.168.1.20:8787", development: false })
    ).toThrow("EXPO_PUBLIC_API_URL must use HTTPS outside development");
  });

  it("does not opt Android release builds into cleartext traffic", () => {
    const android = appConfig.expo.android as AndroidConfig;
    expect(android.usesCleartextTraffic).toBeUndefined();
  });

  it("keeps three-button navigation free of the Android contrast scrim", () => {
    const navigationBarPlugin = appConfig.expo.plugins?.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-navigation-bar",
    );

    expect(navigationBarPlugin).toEqual([
      "expo-navigation-bar",
      { enforceContrast: false, style: "dark" },
    ]);
  });
});
