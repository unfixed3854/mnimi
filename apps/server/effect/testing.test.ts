import { describe, expect, it } from "vitest";
import { Context, Effect } from "effect";
import {
  makeTestRuntime,
  testScopedService,
  testService,
} from "./testing.ts";

class Probe extends Context.Tag("@mnimi/server/test/LayerProbe")<
  Probe,
  { readonly value: number }
>() {}

describe("Effect test Layers", () => {
  it("provides an in-memory service", async () => {
    const runtime = makeTestRuntime(testService(Probe, { value: 42 }));
    try {
      await expect(runtime.runPromise(Effect.gen(function* () {
        return (yield* Probe).value;
      }))).resolves.toBe(42);
    } finally {
      await runtime.dispose();
    }
  });

  it("releases a scoped service when its runtime is disposed", async () => {
    const events: string[] = [];
    const layer = testScopedService(
      Probe,
      Effect.sync(() => {
        events.push("acquire");
        return { value: 7 };
      }),
      () => Effect.sync(() => { events.push("release"); }),
    );
    const runtime = makeTestRuntime(layer);

    try {
      await expect(runtime.runPromise(Effect.gen(function* () {
        return (yield* Probe).value;
      }))).resolves.toBe(7);
      expect(events).toEqual(["acquire"]);
    } finally {
      await runtime.dispose();
    }
    expect(events).toEqual(["acquire", "release"]);
  });
});
