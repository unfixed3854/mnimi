import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { Application, acquireApplication, makeApplicationRuntime } from "./application.ts";
import { AppConfig, type AppConfigValue } from "./config.ts";
import { Auth } from "./auth.ts";
import { Database } from "./database.ts";
import { Logging } from "./logging.ts";
import type { BackgroundWorkflowsService } from "./background-workflows.ts";

const config = {
  media: { imagesDir: "images", audioDir: "audio" },
  elevenLabs: {},
} as AppConfigValue;

describe("application runtime", () => {
  it("releases workflows before the selected provider", async () => {
    const events: string[] = [];
    const core = Layer.mergeAll(
      Layer.succeed(AppConfig, config),
      Layer.succeed(Database, { db: {} } as never),
      Layer.succeed(Auth, { instance: {} } as never),
      Layer.succeed(Logging, {} as never),
    );
    const runtime = makeApplicationRuntime({
      core,
      acquireProvider: () => Effect.acquireRelease(
        Effect.sync(() => {
          events.push("provider.acquire");
          return {} as never;
        }),
        () => Effect.sync(() => { events.push("provider.release"); }),
      ),
      makeWorkflows: () => ({
        stop: () => Effect.sync(() => { events.push("workflows.release"); }),
        settle: () => Effect.void,
      }) as unknown as BackgroundWorkflowsService,
      makeMedia: () => ({} as never),
      makeElevenLabs: () => ({} as never),
      makeExpoPush: () => ({} as never),
    });

    try {
      const application = await acquireApplication(runtime);
      expect(application).toMatchObject({
        config,
        provider: expect.anything(),
        workflows: expect.anything(),
      });
      expect(events).toEqual(["provider.acquire"]);
    } finally {
      await runtime.dispose();
    }

    expect(events).toEqual([
      "provider.acquire",
      "workflows.release",
      "provider.release",
    ]);
  });

  it("settles admitted workflow work before releasing the provider", async () => {
    const events: string[] = [];
    const core = Layer.mergeAll(
      Layer.succeed(AppConfig, config),
      Layer.succeed(Database, { db: {} } as never),
      Layer.succeed(Auth, { instance: {} } as never),
      Layer.succeed(Logging, {} as never),
    );
    const runtime = makeApplicationRuntime({
      core,
      acquireProvider: () => Effect.acquireRelease(
        Effect.succeed({} as never),
        () => Effect.sync(() => { events.push("provider.release"); }),
      ),
      makeWorkflows: () => ({
        stop: () => Effect.sync(() => { events.push("workflows.stop"); }),
        settle: () => Effect.sync(() => { events.push("workflows.settle"); }),
      }) as BackgroundWorkflowsService,
      makeMedia: () => ({} as never),
      makeElevenLabs: () => ({} as never),
      makeExpoPush: () => ({} as never),
    });

    await acquireApplication(runtime);
    await runtime.dispose();

    expect(events).toEqual([
      "workflows.stop",
      "workflows.settle",
      "provider.release",
    ]);
  });

  it("settles admitted work even when admission fencing reports a failure", async () => {
    const events: string[] = [];
    const runtime = makeApplicationRuntime({
      core: Layer.mergeAll(
        Layer.succeed(AppConfig, config),
        Layer.succeed(Database, { db: {} } as never),
        Layer.succeed(Auth, { instance: {} } as never),
        Layer.succeed(Logging, {} as never),
      ),
      acquireProvider: () => Effect.acquireRelease(
        Effect.succeed({} as never),
        () => Effect.sync(() => { events.push("provider.release"); }),
      ),
      makeWorkflows: () => ({
        stop: () => Effect.zipRight(
          Effect.sync(() => { events.push("workflows.stop"); }),
          Effect.fail(new Error("stop failed")),
        ),
        settle: () => Effect.sync(() => { events.push("workflows.settle"); }),
      }) as unknown as BackgroundWorkflowsService,
      makeMedia: () => ({} as never),
      makeElevenLabs: () => ({} as never),
      makeExpoPush: () => ({} as never),
    });

    await acquireApplication(runtime);
    await expect(runtime.dispose()).rejects.toThrow("stop failed");

    expect(events).toEqual([
      "workflows.stop",
      "workflows.settle",
      "provider.release",
    ]);
  });

  it("publishes the acquired services under the Application tag", async () => {
    const runtime = makeApplicationRuntime({
      core: Layer.mergeAll(
        Layer.succeed(AppConfig, config),
        Layer.succeed(Database, { db: {} } as never),
        Layer.succeed(Auth, { instance: {} } as never),
        Layer.succeed(Logging, {} as never),
      ),
      acquireProvider: () => Effect.succeed({} as never),
      makeWorkflows: () => ({ stop: () => Effect.void, settle: () => Effect.void }) as BackgroundWorkflowsService,
      makeMedia: () => ({} as never),
      makeElevenLabs: () => ({} as never),
      makeExpoPush: () => ({} as never),
    });

    try {
      const application = await runtime.runPromise(Effect.gen(function* () {
        return yield* Application;
      }));
      expect(application.config).toBe(config);
    } finally {
      await runtime.dispose();
    }
  });
});
