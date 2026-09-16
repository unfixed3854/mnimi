import { readFile } from "node:fs/promises";

// Keep this process free of dotenv values: every backend launch must read them anew.
async function readEnv() {
  try { return await readFile(".env", "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function run() {
  let child;
  let stopping = false;
  let exitCode = 0;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      stopping = true;
      exitCode = signal === "SIGINT" ? 130 : 143;
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  async function stop() {
    if (!child) return;
    child.kill("SIGTERM");
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(500).then(() => false),
    ]);
    if (!exited) child.kill("SIGKILL");
    await child.exited;
    child = undefined;
  }
  function spawn(args) {
    return Bun.spawn([process.execPath, "--env-file=.env", ...args], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
  }
  try {
    let environment = await readEnv();
    while (!stopping) {
      child = spawn(["scripts/validate-runtime-config.ts"]);
      while (!stopping && child.exitCode === null) await Bun.sleep(25);
      if (stopping) break;
      const validation = await child.exited;
      if (validation !== 0) return validation;
      child = spawn(["--watch", "main.ts", "--devtools"]);
      while (!stopping) {
        await Bun.sleep(100);
        if (child.exitCode !== null) return await child.exited;
        const next = await readEnv();
        if (next !== environment) {
          environment = next;
          console.log("Server .env changed; restarting backend.");
          await stop();
          break;
        }
      }
    }
    return exitCode;
  } finally {
    await stop();
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

process.exitCode = await run();
