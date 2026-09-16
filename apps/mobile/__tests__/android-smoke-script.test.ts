import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "e2e", "android-smoke.sh");
const CHECKLIST = join(__dirname, "..", "e2e", "android-smoke.md");

function runCheck(apiUrl?: string) {
  const env = { ...process.env };
  delete env.EXPO_PUBLIC_API_URL;
  if (apiUrl !== undefined) env.EXPO_PUBLIC_API_URL = apiUrl;
  return spawnSync("bash", [SCRIPT, "--check"], {
    encoding: "utf8",
    env,
  });
}

describe("Android smoke launcher", () => {
  test("rejects a missing API URL before starting services", () => {
    const result = runCheck();

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("EXPO_PUBLIC_API_URL is required");
  });

  test("rejects loopback because a physical device cannot reach it", () => {
    const result = runCheck("http://127.0.0.1:8787");

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("LAN host");
  });

  test("accepts a LAN HTTP API URL for a development build", () => {
    const result = runCheck("http://192.168.1.20:8787");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("API URL validated");
  });

  test("accepts the Android emulator host over development HTTP", () => {
    expect(runCheck("http://10.0.2.2:8787").status).toBe(0);
  });

  test("accepts a valid HTTPS origin", () => {
    expect(runCheck("https://api.example.com").status).toBe(0);
  });

  test("rejects public HTTP hosts", () => {
    const result = runCheck("http://example.com:8787");

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("private LAN");
  });

  test.each([
    "not-a-url",
    "http://192.168.1.20:8787/rpc",
    "http://0.0.0.0:8787",
  ])("rejects malformed or unreachable device input: %s", (apiUrl) => {
    expect(runCheck(apiUrl).status).toBe(64);
  });

  test("anchors the complete native creation acceptance path", () => {
    const coverage = `${readFileSync(SCRIPT, "utf8")}\n${
      readFileSync(CHECKLIST, "utf8")
    }`;
    for (const anchor of [
      "Create tab",
      "What do you want to learn?",
      "Creation inbox",
      "creation detail",
      "focused card editor",
      "notification deep link",
    ]) expect(coverage).toContain(anchor);
  });
});
