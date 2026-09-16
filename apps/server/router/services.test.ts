import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { Application } from "../effect/application.ts";
import { makeAppRuntime, runRequest } from "../effect/runtime.ts";
import { routerServices } from "./services.ts";

describe("router services", () => {
  it("uses the application workflow directly instead of an installed facade", async () => {
    const kickText = vi.fn(() => Effect.void);
    const runtime = makeAppRuntime(Layer.succeed(Application, {
      workflows: { kickText },
    } as never));

    try {
      const services = await runRequest(
        runtime,
        routerServices,
        {
          headers: new Headers(),
          requestId: "router-services",
          signal: new AbortController().signal,
        },
      );
      await Effect.runPromise(services.kickText("user-1"));

      expect(kickText).toHaveBeenCalledWith("user-1");
    } finally {
      await runtime.dispose();
    }
  });
});
