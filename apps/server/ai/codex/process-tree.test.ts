import { expect, it, vi } from "vitest";
import { SUPERVISOR_GRACE_MS, terminateSupervisedTree } from "./process-tree.ts";

function deferred() {
  let resolve!: (code: number) => void;
  const promise = new Promise<number>((settle) => { resolve = settle; });
  return { promise, resolve };
}

it("lets the Linux supervisor reap detached descendants before hard tree fallback", async () => {
  const exit = deferred();
  const events: string[] = [];
  const cancel = vi.fn();
  const schedule = vi.fn(() => cancel);

  const terminating = terminateSupervisedTree({
    requestStop() { events.push("stop"); },
    terminateTree() { events.push("tree"); },
    destroyOutput() { events.push("output"); },
    exited: exit.promise,
    killDirect() { events.push("direct"); },
  }, schedule);

  expect(events).toEqual(["stop"]);
  expect(schedule).toHaveBeenCalledWith(expect.any(Function), SUPERVISOR_GRACE_MS);
  exit.resolve(0);
  await terminating;
  expect(events).toEqual(["stop"]);
  expect(cancel).toHaveBeenCalledOnce();
});

it("uses hard tree fallback when the supervisor exits without confirming cleanup", async () => {
  const events: string[] = [];
  await terminateSupervisedTree({
    requestStop() { events.push("stop"); },
    terminateTree() { events.push("tree"); },
    destroyOutput() { events.push("output"); },
    exited: Promise.resolve(1),
    killDirect() { events.push("direct"); },
  });
  expect(events).toEqual(["stop", "tree", "output"]);
});

it("bounds a stalled supervisor before hard tree fallback", async () => {
  const scheduled: Array<() => void> = [];
  const events: string[] = [];
  const terminating = terminateSupervisedTree({
    requestStop() { events.push("stop"); },
    terminateTree() { events.push("tree"); },
    destroyOutput() { events.push("output"); },
    exited: new Promise(() => {}),
    killDirect() { events.push("direct"); },
  }, (callback) => {
    scheduled.push(callback);
    return vi.fn();
  });

  expect(events).toEqual(["stop"]);
  scheduled.shift()!();
  await vi.waitFor(() => expect(events).toEqual(["stop", "tree", "output"]));
  scheduled.shift()!();
  await vi.waitFor(() => expect(events).toEqual(["stop", "tree", "output", "direct"]));
  scheduled.shift()!();
  await terminating;
});
