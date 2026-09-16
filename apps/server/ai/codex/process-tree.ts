import { spawn, type ChildProcess } from "node:child_process";

export type ScheduleDeadline = (callback: () => void, milliseconds: number) => () => void;
export const TERMINATION_GRACE_MS = 250;
export const SUPERVISOR_GRACE_MS = 250;
export const WINDOWS_TREE_KILLER_TIMEOUT_MS = 250;

type OwnedProcessTree = {
  terminateTree(): void | Promise<void>;
  destroyOutput(): void;
  exited: Promise<unknown>;
  killDirect(): void;
};

type SupervisedProcessTree = Omit<OwnedProcessTree, "exited"> & {
  exited: Promise<number>;
  requestStop(): void;
};

export function scheduleDeadline(callback: () => void, milliseconds: number): () => void {
  const timeout = setTimeout(callback, milliseconds);
  return () => clearTimeout(timeout);
}

export async function settlesWithin(promise: Promise<unknown>, milliseconds: number, schedule: ScheduleDeadline = scheduleDeadline): Promise<boolean> {
  let resolveDeadline!: () => void;
  const deadline = new Promise<false>((resolve) => { resolveDeadline = () => resolve(false); });
  const cancel = schedule(resolveDeadline, milliseconds);
  try { return await Promise.race([promise.then(() => true, () => true), deadline]); }
  finally { cancel(); }
}

function startWindowsTreeKiller(pid: number): ChildProcess {
  return spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
}

async function terminateWindowsTree(pid: number, start: (pid: number) => ChildProcess, schedule: ScheduleDeadline): Promise<void> {
  let treeKiller: ChildProcess;
  try { treeKiller = start(pid); } catch { return; }
  try { treeKiller.unref(); } catch { /* The helper is bounded below. */ }
  const exited = new Promise<void>((resolve) => {
    treeKiller.once("error", () => resolve());
    treeKiller.once("exit", () => resolve());
  });
  if (await settlesWithin(exited, WINDOWS_TREE_KILLER_TIMEOUT_MS, schedule)) return;
  try { treeKiller.kill("SIGKILL"); } catch { /* It may already have exited. */ }
  await settlesWithin(exited, WINDOWS_TREE_KILLER_TIMEOUT_MS, schedule);
}

/** The child must have been spawned in its own POSIX session/process group. */
export async function terminateProcessTree(
  child: { pid?: number; kill(signal: "SIGKILL"): unknown },
  options: { platform?: NodeJS.Platform; startWindowsTreeKiller?: (pid: number) => ChildProcess; scheduleDeadline?: ScheduleDeadline } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const pid = child.pid;
  if (pid !== undefined && pid > 0 && pid !== process.pid) {
    if (platform === "win32") {
      // The helper must finish (or exhaust both bounds) BEFORE direct fallback:
      // killing the launcher first would lose Windows' descendant relationship.
      await terminateWindowsTree(pid, options.startWindowsTreeKiller ?? startWindowsTreeKiller,
        options.scheduleDeadline ?? scheduleDeadline);
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Direct fallback below. */ }
    }
  }
  try { child.kill("SIGKILL"); } catch { /* Completion may already be queued. */ }
}

export async function terminateAndReap(
  owned: OwnedProcessTree,
  schedule: ScheduleDeadline = scheduleDeadline,
): Promise<void> {
  try { await owned.terminateTree(); } catch { /* Keep errors local and sanitized. */ }
  owned.destroyOutput();
  if (await settlesWithin(owned.exited, TERMINATION_GRACE_MS, schedule)) return;
  owned.killDirect();
  await settlesWithin(owned.exited, TERMINATION_GRACE_MS, schedule);
}

export async function terminateSupervisedTree(
  owned: SupervisedProcessTree,
  schedule: ScheduleDeadline = scheduleDeadline,
): Promise<void> {
  try { owned.requestStop(); } catch { /* Hard tree fallback remains available. */ }
  let resolveDeadline!: () => void;
  const deadline = new Promise<false>((resolve) => { resolveDeadline = () => resolve(false); });
  const cancel = schedule(resolveDeadline, SUPERVISOR_GRACE_MS);
  let stoppedCleanly: boolean;
  try {
    stoppedCleanly = await Promise.race([
      owned.exited.then((code) => code === 0, () => false),
      deadline,
    ]);
  } finally {
    cancel();
  }
  if (stoppedCleanly) return;
  await terminateAndReap(owned, schedule);
}
