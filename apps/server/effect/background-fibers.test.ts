import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeBackgroundFibers } from "./background-fibers.ts";

describe("background fibers", () => {
  it("waits for admitted work to settle", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fibers = makeBackgroundFibers();
    await Effect.runPromise(fibers.fork(Effect.promise(async () => {
      started.resolve();
      await release.promise;
    })));
    await started.promise;

    let settled = false;
    const closing = Effect.runPromise(fibers.settle().pipe(
      Effect.tap(() => Effect.sync(() => { settled = true; })),
    ));

    await Effect.runPromise(Effect.yieldNow());
    expect(settled).toBe(false);
    release.resolve();
    await closing;
    expect(settled).toBe(true);
  });
});
