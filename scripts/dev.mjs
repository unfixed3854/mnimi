import { open, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

async function waitForServer({ logFilePath, token, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted) {
    const log = await readFile(logFilePath, "utf8");
    if (log.includes(token)) return;
    if (log.includes("EADDRINUSE")) throw new Error("Backend port is already in use.");
    if (Date.now() >= deadline) throw new Error("Backend did not become ready before the startup timeout.");
    await Bun.sleep(25);
  }
}

export async function runDev(options = {}) {
  const {
    spawn = Bun.spawn,
    installSignals = true,
    logPath = new URL("../.dev/server.log", import.meta.url),
    waitForReady = waitForServer,
    startupTimeoutMs = 15_000,
    shutdownTimeoutMs = 1_000,
  } = options;
  const logFilePath = fileURLToPath(logPath);
  await mkdir(dirname(logFilePath), { recursive: true });
  const logFile = await open(logFilePath, "w");
  const children = [];
  const signalHandlers = new Map();
  const controller = new AbortController();
  let interrupt;
  const interrupted = new Promise((resolve) => { interrupt = resolve; });
  const token = `mnimi-ready:${crypto.randomUUID()}`;

  async function stop({ child, group }) {
    function kill(signal) {
      try {
        if (group) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    kill("SIGTERM");
    // The wrapper can exit before its descendants. Wait for the group, too.
    const deadline = Date.now() + shutdownTimeoutMs;
    while (Date.now() < deadline) {
      if (group) {
        try { process.kill(-child.pid, 0); }
        catch (error) { if (error.code === "ESRCH") break; throw error; }
      } else if (await Promise.race([child.exited.then(() => true), Bun.sleep(25).then(() => false)])) {
        break;
      }
      await Bun.sleep(25);
    }
    kill("SIGKILL");
    await child.exited;
  }

  try {
    if (installSignals) {
      for (const signal of ["SIGINT", "SIGTERM"]) {
        const handler = () => interrupt({ child: "signal", status: signal === "SIGINT" ? 130 : 143 });
        signalHandlers.set(signal, handler);
        process.on(signal, handler);
      }
    }
    const server = spawn(["bun", "run", "server:dev"], {
      stdin: "ignore",
      stdout: logFile.fd,
      stderr: logFile.fd,
      detached: true,
      env: { ...process.env, MNIMI_DEV_READY_TOKEN: token },
    });
    children.push({ child: server, group: Number.isInteger(server.pid) });
    const serverExit = server.exited.then((status) => ({ child: "server", status }));
    const startup = await Promise.race([
      serverExit,
      interrupted,
      waitForReady({ logFilePath, token, timeoutMs: startupTimeoutMs, signal: controller.signal })
        .then(() => ({ child: "ready" })),
    ]);
    if (startup.child === "signal") return startup.status;
    if (startup.child === "server") throw new Error(`Backend exited during startup (${startup.status}).`);

    const mobile = spawn(["bun", "run", "mobile:dev"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    children.push({ child: mobile, group: false });
    const winner = await Promise.race([
      serverExit,
      interrupted,
      mobile.exited.then((status) => ({ child: "mobile", status })),
    ]);
    if (winner.child === "server") throw new Error(`Backend exited (${winner.status}).`);
    return winner.status;
  } catch (error) {
    console.error(`${error.message}\nServer log: ${logFilePath}`);
    console.error((await readFile(logFilePath, "utf8")).slice(-8_000));
    return 1;
  } finally {
    controller.abort();
    await Promise.all(children.map(stop));
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    await logFile.close();
  }
}

if (import.meta.main) process.exitCode = await runDev();
