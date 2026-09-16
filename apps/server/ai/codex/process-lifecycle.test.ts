import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { terminateAndReap, terminateProcessTree } from "./process-tree.ts";

const supervisorPath = fileURLToPath(new URL("./process-supervisor.ts", import.meta.url));

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isGroupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

it.skipIf(process.platform === "win32").each([
  ["group-exit", true],
  ["group-close", false],
  ["detached-exit", true],
  ["detached-close", false],
])("reaps a real Bun launcher's %s descendant with inherited pipes", async (scenario, expectsExitError) => {
  const child = spawn("bun", [
    "--no-env-file",
    fileURLToPath(new URL("./process-lifecycle.fixture.ts", import.meta.url)),
    scenario,
  ], {
    detached: true,
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let output = "";
  child.stdout.on("data", (chunk) => { if (output.length < 65536) output += chunk.toString(); });
  child.stderr.resume();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([exited, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Offline Bun fixture timed out")), 6000);
    })]);
    expect(code).toBe(0);
    const result = JSON.parse(output);
    expect(result).toMatchObject({ scenario, spawns: 1, descendantStopped: true });
    if (expectsExitError) expect(result.error).toMatchObject({ category: "process-exit" });
    expect(result.closeMilliseconds).toBeLessThan(2000);
  } finally {
    clearTimeout(deadline);
    await terminateAndReap({
      terminateTree: () => terminateProcessTree(child), exited,
      destroyOutput() { child.stdout.destroy(); child.stderr.destroy(); },
      killDirect() { child.kill("SIGKILL"); },
    });
  }
}, 8000);

it.skipIf(process.platform !== "linux")("does not lose the launcher when shutdown races supervisor startup", async () => {
  let leaked = false;
  for (let attempt = 0; attempt < 100 && !leaked; attempt++) {
    const child = spawn("bun", [
      "--no-env-file",
      supervisorPath,
      "--",
      "bun",
      "--no-env-file",
      "-e",
      "setTimeout(() => {}, 5000)",
    ], {
      detached: true,
      env: { PATH: process.env.PATH },
      stdio: "ignore",
    });
    const pid = child.pid!;
    const exited = new Promise<void>((resolve) => {
      child.once("error", resolve);
      child.once("exit", () => resolve());
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 8 + attempt % 13));
      child.kill("SIGTERM");
      const bounded = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1));
      leaked = !bounded || (isGroupAlive(pid) && !isAlive(pid));
    } finally {
      if (isGroupAlive(pid)) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* The group may have just exited. */ }
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 250))]);
    }
  }
  expect(leaked).toBe(false);
}, 10_000);
