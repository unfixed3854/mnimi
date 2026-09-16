// Linux-only process supervisor. It runs in a separate Bun process so making
// it a child subreaper does not change how the mnimi server adopts children.
import { dlopen, ptr } from "bun:ffi";
import { readFile } from "node:fs/promises";

const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;
const CLEANUP_TIMEOUT_MS = 200;
const POLL_INTERVAL_MS = 5;

const command = process.argv.slice(2);
if (command.length === 0) process.exit(1);

const libc = dlopen("libc.so.6", {
  prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
  waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
});

if (libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) !== 0) {
  libc.close();
  process.exit(1);
}

const status = new Int32Array(1);
const childrenPath = `/proc/${process.pid}/task/${process.pid}/children`;
let child: Bun.Subprocess | undefined;
let stopRequested = false;
let finishing: Promise<number> | undefined;

function reapExitedChildren(): void {
  while (libc.symbols.waitpid(-1, ptr(status), WNOHANG) > 0) { /* Reap every adopted child. */ }
}

async function directChildren(): Promise<number[]> {
  try {
    return (await readFile(childrenPath, "utf8"))
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  } catch { throw new Error("Could not inspect supervised children"); }
}

async function terminateAdoptedChildren(): Promise<boolean> {
  const deadline = performance.now() + CLEANUP_TIMEOUT_MS;
  do {
    reapExitedChildren();
    const children = await directChildren();
    if (children.length === 0) return true;
    for (const pid of children) {
      try { process.kill(pid, "SIGKILL"); } catch { /* The child may have just exited. */ }
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  } while (performance.now() < deadline);
  reapExitedChildren();
  return (await directChildren()).length === 0;
}

function finish(terminateChild: boolean): Promise<number> {
  const ownedChild = child;
  if (ownedChild === undefined) return Promise.resolve(1);
  return finishing ??= (async () => {
    if (terminateChild) {
      try { ownedChild.kill("SIGKILL"); } catch { /* The launcher may already have exited. */ }
    }
    try { await ownedChild.exited; } catch { /* Cleanup still owns adopted descendants. */ }
    const cleaned = await terminateAdoptedChildren().catch(() => false);
    libc.close();
    return cleaned ? 0 : 1;
  })();
}

function requestStop(): void {
  stopRequested = true;
  if (child !== undefined) void finish(true).then((code) => process.exit(code));
}

// Install handlers before spawning so shutdown cannot kill the supervisor and
// orphan a launcher created in the same startup window.
process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);

try {
  // Without procfs the supervisor cannot enumerate and reap adopted children,
  // so fail before starting the app server.
  await readFile(childrenPath, "utf8");
  child = Bun.spawn(command, {
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
} catch {
  libc.close();
  process.exit(1);
}

if (stopRequested) process.exit(await finish(true));

const exitCode = await child.exited.catch(() => 1);
void exitCode;
process.exit(await finish(false));
