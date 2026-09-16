import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "./lifecycle.ts";

describe("server shutdown lifecycle", () => {
  it("fences first and attempts background cleanup even when server and provider cleanup fail", async () => {
    const events: string[] = [];
    const server = new Error("server"), background = new Error("background"), provider = new Error("provider");
    const shutdown = createShutdown({
      resources: {
        server: { stop: () => { events.push("server"); throw server; } },
        background: { stop: () => { events.push("background"); throw background; } },
      },
      aiProvider: { [Symbol.asyncDispose]: async () => { events.push("provider"); throw provider; } },
      clearSweep: vi.fn(), markShuttingDown: () => { events.push("fence"); },
    });
    await expect(shutdown()).rejects.toMatchObject({ errors: [server, background, provider] });
    await expect(shutdown()).rejects.toMatchObject({ errors: [server, background, provider] });
    expect(events).toEqual(["fence", "server", "background", "provider"]);
  });
  it("returns an idempotent cleanup function for its resources", async () => {
    const events: string[] = [];
    const aiProvider = {
      [Symbol.asyncDispose]: vi.fn(async () => { events.push("provider.dispose"); }),
    };
    const resources = {
      server: { stop: vi.fn(async () => { events.push("server.stop"); }) },
      creationScheduler: { stop: vi.fn(() => { events.push("text.stop"); }) },
      imageScheduler: { stop: vi.fn(() => { events.push("image.stop"); }) },
      sweepInterval: 123 as unknown as ReturnType<typeof setInterval>,
    };
    const clearSweep = vi.fn(() => { events.push("sweep.stop"); });
    const markShuttingDown = vi.fn();
    const shutdown = createShutdown({ aiProvider, resources, clearSweep, markShuttingDown });

    await Promise.all([shutdown(), shutdown()]);

    expect(markShuttingDown).toHaveBeenCalledTimes(1);
    expect(resources.server.stop).toHaveBeenCalledWith(true);
    expect(resources.creationScheduler.stop).toHaveBeenCalledTimes(1);
    expect(resources.imageScheduler.stop).toHaveBeenCalledTimes(1);
    expect(clearSweep).toHaveBeenCalledWith(resources.sweepInterval);
    expect(aiProvider[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "server.stop",
      "text.stop",
      "image.stop",
      "sweep.stop",
      "provider.dispose",
    ]);
  });

  it("stops HTTP before disposing the owned application scope exactly once", async () => {
    const events: string[] = [];
    const disposeApplication = vi.fn(async () => { events.push("application.dispose"); });
    const shutdown = createShutdown({
      resources: {
        server: { stop: () => { events.push("server.stop"); } },
      },
      aiProvider: { [Symbol.asyncDispose]: async () => { events.push("legacy-provider.dispose"); } },
      disposeApplication,
      clearSweep: vi.fn(),
      markShuttingDown: () => { events.push("admissions.closed"); },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(disposeApplication).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "admissions.closed",
      "server.stop",
      "application.dispose",
    ]);
  });

  it("awaits asynchronous HTTP shutdown before disposing the application scope", async () => {
    const events: string[] = [];
    const stopped = Promise.withResolvers<void>();
    const disposeApplication = vi.fn(async () => { events.push("application.dispose"); });
    const shutdown = createShutdown({
      resources: {
        server: {
          stop: async () => {
            events.push("server.stop");
            await stopped.promise;
            events.push("server.stopped");
          },
        },
      },
      disposeApplication,
      clearSweep: vi.fn(),
      markShuttingDown: () => { events.push("admissions.closed"); },
    });

    const closing = shutdown();
    await vi.waitFor(() => expect(events).toContain("server.stop"));
    expect(disposeApplication).not.toHaveBeenCalled();

    stopped.resolve();
    await closing;
    expect(events).toEqual([
      "admissions.closed",
      "server.stop",
      "server.stopped",
      "application.dispose",
    ]);
  });

  it("attempts every cleanup and aggregates a resource failure", async () => {
    const failure = new Error("HTTP stop failed");
    const resources = {
      server: { stop: vi.fn(async () => { throw failure; }) },
      creationScheduler: { stop: vi.fn() },
      imageScheduler: { stop: vi.fn() },
      sweepInterval: 123 as unknown as ReturnType<typeof setInterval>,
    };
    const aiProvider = {
      [Symbol.asyncDispose]: vi.fn(async () => {}),
    };
    const clearSweep = vi.fn();
    const markShuttingDown = vi.fn();
    const shutdown = createShutdown({
      aiProvider,
      resources,
      clearSweep,
      markShuttingDown,
    });

    await expect(shutdown()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [failure],
    });
    expect(markShuttingDown).toHaveBeenCalledOnce();
    expect(resources.server.stop).toHaveBeenCalledWith(true);
    expect(resources.creationScheduler.stop).toHaveBeenCalledOnce();
    expect(resources.imageScheduler.stop).toHaveBeenCalledOnce();
    expect(clearSweep).toHaveBeenCalledWith(resources.sweepInterval);
    expect(aiProvider[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });
});
