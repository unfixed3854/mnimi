import { Redacted } from "effect";
import { createApp } from "./app.ts";
import { createShutdown, type ServerResources } from "./lifecycle.ts";
import {
  acquireApplication,
  makeApplicationRuntime,
} from "./effect/application.ts";

async function start() {
  const runtime = makeApplicationRuntime();
  const resources: ServerResources = {};
  let shuttingDown = false;
  let shutdown: ReturnType<typeof createShutdown> | undefined;

  try {
    const { config, database, auth, media, workflows } = await acquireApplication(runtime);
    shutdown = createShutdown({
      resources,
      disposeApplication: () => runtime.dispose(),
      clearSweep: clearInterval,
      markShuttingDown: () => { shuttingDown = true; },
    });
    const onShutdownSignal = () => {
      void shutdown!().catch((error) => {
        console.error("server shutdown failed", error);
        process.exitCode = 1;
      });
    };
    process.on("SIGINT", onShutdownSignal);
    process.on("SIGTERM", onShutdownSignal);

    const app = createApp({
      db: database.db,
      auth: auth.instance,
      corsOrigin: config.browser.corsOrigin,
      devtoolsEnabled: config.runtime.devtoolsEnabled,
      registrationEnabled: config.registration.enabled,
      runtime,
      media,
      isShuttingDown: () => shuttingDown,
    });

    await runtime.runPromise(workflows.recoverAndStart());
    if (shuttingDown) return shutdown;
    resources.server = Bun.serve({
      hostname: config.server.hostname,
      port: config.server.port,
      fetch: app.fetch,
    });
    const readyToken = Redacted.value(config.runtime.readyToken);
    if (readyToken !== "") console.log(readyToken);
    return shutdown;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      if (shutdown) await shutdown();
      else await runtime.dispose();
    } catch (cleanupError) {
      console.error("startup cleanup failed", cleanupError);
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], "Server startup failed");
    }
    throw error;
  }
}

await start();
