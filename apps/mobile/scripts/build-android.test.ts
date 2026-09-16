import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildAndroid } from "./build-android.ts";

describe("buildAndroid", () => {
  it("runs installed Expo prebuild before the Gradle release build", async () => {
    const calls: Array<{
      command: string[];
      cwd: string;
      env: Record<string, string | undefined>;
    }> = [];
    const removed: Array<{ path: string; force: boolean }> = [];
    await buildAndroid({
      env: { EXPO_PUBLIC_API_URL: "https://api.example.com" },
      remove: async (path, options) => {
        removed.push({ path, ...options });
      },
      run: async (command, options) => {
        calls.push({ command, ...options });
      },
    });

    expect(calls[0].command).toEqual([
      "bun",
      "run",
      "--no-install",
      "expo",
      "prebuild",
      "--platform",
      "android",
      "--no-clean",
      "--no-install",
      "--skip-dependency-update",
      "expo,react,react-native",
    ]);
    expect(calls[0].env).toMatchObject({ CI: "1" });
    const androidDir = join(calls[1].cwd, "android");
    expect(removed).toEqual([{
      path: join(
        androidDir,
        "app",
        "build",
        "outputs",
        "apk",
        "release",
        "app-release.apk",
      ),
      force: true,
    }]);
    expect(calls[1].command).toEqual([
      join(androidDir, "gradlew"),
      "-p",
      androidDir,
      "assembleRelease",
      "--no-daemon",
    ]);
  });

  it("rejects a release build that would use an insecure API origin", async () => {
    expect(
      buildAndroid({
        env: { EXPO_PUBLIC_API_URL: "http://localhost:8787" },
        run: async () => {
          throw new Error("build command must not run");
        },
      }),
    ).rejects.toThrow("EXPO_PUBLIC_API_URL must use HTTPS outside development");
  });
});
