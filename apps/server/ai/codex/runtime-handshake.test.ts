import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { codexAppServerCommand, codexChildEnv, ensurePrivateCodexHome } from "./runtime.ts";
import { terminateAndReap, terminateProcessTree } from "./process-tree.ts";

it("initializes the pinned local binary with the actual production arguments and no credentials", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "mnimi-codex-handshake-"));
  const home = join(fixture, "home");
  await ensurePrivateCodexHome(home);
  const [executable, ...args] = codexAppServerCommand();
  const child = spawn(executable!, args, {
    cwd: fixture,
    detached: process.platform !== "win32",
    env: codexChildEnv(home, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume(); // Never surface raw CLI diagnostics.
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("exit", resolve);
  });
  const lines = createInterface({ input: child.stdout });
  const reader = lines[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Offline initialize timed out")), 4000);
  });
  const exitFailure = exited.then((code) => { throw new Error(`Offline Codex exited before initialize (${code})`); });
  void exitFailure.catch(() => {});
  async function response(id: number): Promise<Record<string, unknown>> {
    const read = (async () => {
      while (true) {
        const line = await reader.next();
        if (line.done) throw new Error("Offline Codex output ended");
        const message = JSON.parse(line.value);
        if (message.id === id) return message;
      }
    })();
    return Promise.race([read, deadline, exitFailure]);
  }
  try {
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {
      clientInfo: { name: "mnimi", title: "mnimi", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    } }) + "\n");
    const message = await response(1);
    expect(message).toMatchObject({ id: 1, result: { userAgent: expect.stringContaining("0.154.0") } });
    await new Promise<void>((resolve, reject) => {
      child.stdin.write('{"method":"initialized","params":{}}\n', (error) => error ? reject(error) : resolve());
    });
    // This local config read confirms strict parsing retained the security
    // values, including the pinned binary's native ChatGPT-only login gate.
    child.stdin.write('{"id":2,"method":"config/read","params":{"includeLayers":false}}\n');
    expect(await response(2)).toMatchObject({ id: 2, result: { config: {
      forced_login_method: "chatgpt",
      default_permissions: "mnimi-generation",
      permissions: { "mnimi-generation": {
        filesystem: { ":minimal": "read", ":workspace_roots": { ".": "write" } },
        network: { enabled: false },
      } },
    } } });
    await expect(access(join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    clearTimeout(timer);
    lines.close();
    await terminateAndReap({
      terminateTree: () => terminateProcessTree(child), exited,
      destroyOutput() { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); },
      killDirect() { child.kill("SIGKILL"); },
    });
    await rm(fixture, { recursive: true, force: true });
  }
}, 7000);
