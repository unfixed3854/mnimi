import { afterEach, describe, expect, it } from "vitest";
import { Cause, Context, Effect, Layer, Option, Runtime } from "effect";
import {
  RequestContext,
  type RequestContextValue,
} from "./request-context.ts";
import { makeAppRuntime, runRequest } from "./runtime.ts";

const runtimes: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

class Probe extends Context.Tag("@mnimi/server/test/Probe")<
  Probe,
  { readonly value: number }
>() {}

function request(
  requestId: string,
  signal = new AbortController().signal,
): RequestContextValue {
  return {
    headers: new Headers({ "x-request-id": requestId }),
    requestId,
    signal,
  };
}

describe("Effect application runtime", () => {
  it("acquires one Layer and reuses it across programs", async () => {
    let acquisitions = 0;
    const layer = Layer.effect(
      Probe,
      Effect.sync(() => ({ value: ++acquisitions })),
    );
    const runtime = makeAppRuntime(layer);
    runtimes.push(runtime);
    const read = Effect.gen(function* () {
      return (yield* Probe).value;
    });

    await expect(runtime.runPromise(read)).resolves.toBe(1);
    await expect(runtime.runPromise(read)).resolves.toBe(1);
    expect(acquisitions).toBe(1);
  });

  it("isolates request context across concurrent invocations", async () => {
    const runtime = makeAppRuntime(Layer.empty);
    runtimes.push(runtime);
    const read = Effect.gen(function* () {
      const current = yield* RequestContext;
      yield* Effect.promise(() => Promise.resolve());
      return {
        requestId: current.requestId,
        header: current.headers.get("x-request-id"),
      };
    });

    await expect(Promise.all([
      runRequest(runtime, read, request("first")),
      runRequest(runtime, read, request("second")),
    ])).resolves.toEqual([
      { requestId: "first", header: "first" },
      { requestId: "second", header: "second" },
    ]);
  });

  it("propagates request aborts and runs the Effect finalizer", async () => {
    const runtime = makeAppRuntime(Layer.empty);
    runtimes.push(runtime);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resume: ((effect: Effect.Effect<void>) => void) | undefined;
    let signalCancelled = false;
    let finalized = false;
    const running = Effect.async<void, never>((callback, signal) => {
      resume = callback;
      markStarted();
      signal.addEventListener("abort", () => {
        signalCancelled = true;
      }, { once: true });
    }).pipe(
      Effect.ensuring(Effect.sync(() => {
        finalized = true;
      })),
    );
    const controller = new AbortController();
    const pending = runRequest(
      runtime,
      running,
      request("abort", controller.signal),
    );

    await started;
    controller.abort();
    let rejection: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(() => "completed" as const).catch((error: unknown) => {
        rejection = error;
        return "rejected" as const;
      }),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 1000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome === "timeout") {
      if (resume === undefined) throw new Error("Effect did not start");
      resume(Effect.succeed(undefined));
      await pending;
    }

    expect(outcome).toBe("rejected");
    expect(Runtime.isFiberFailure(rejection)).toBe(true);
    if (Runtime.isFiberFailure(rejection)) {
      expect(Cause.isInterruptedOnly(
        rejection[Runtime.FiberFailureCauseId],
      )).toBe(true);
    }
    expect(signalCancelled).toBe(true);
    expect(finalized).toBe(true);
  });

  it("releases a scoped Layer once when the runtime is disposed", async () => {
    class ScopedProbe extends Context.Tag(
      "@mnimi/server/test/ScopedProbe",
    )<
      ScopedProbe,
      { readonly value: number }
    >() {}

    let acquisitions = 0;
    let releases = 0;
    const layer = Layer.scoped(
      ScopedProbe,
      Effect.acquireRelease(
        Effect.sync(() => {
          acquisitions += 1;
          return { value: acquisitions };
        }),
        () => Effect.sync(() => {
          releases += 1;
        }),
      ),
    );
    const runtime = makeAppRuntime(layer);
    runtimes.push(runtime);
    const read = Effect.gen(function* () {
      return (yield* ScopedProbe).value;
    });

    await expect(runtime.runPromise(read)).resolves.toBe(1);
    expect(acquisitions).toBe(1);
    expect(releases).toBe(0);

    await runtime.dispose();
    expect(releases).toBe(1);
    await runtime.dispose();
    expect(acquisitions).toBe(1);
    expect(releases).toBe(1);
  });

  it("preserves request failures and keeps the runtime usable", async () => {
    const runtime = makeAppRuntime(Layer.empty);
    runtimes.push(runtime);
    const failure = new Error("request failed");

    let rejection: unknown;
    try {
      await runRequest(
        runtime,
        Effect.fail(failure),
        request("failure"),
      );
    } catch (error) {
      rejection = error;
    }
    expect(Runtime.isFiberFailure(rejection)).toBe(true);
    if (Runtime.isFiberFailure(rejection)) {
      const cause = rejection[Runtime.FiberFailureCauseId];
      const causeFailure = Cause.failureOption(cause);
      expect(Option.isSome(causeFailure)).toBe(true);
      if (Option.isSome(causeFailure)) {
        expect(causeFailure.value).toBe(failure);
      }
    }
    await expect(runRequest(
      runtime,
      Effect.succeed("healthy"),
      request("after-failure"),
    )).resolves.toBe("healthy");
  });
});
