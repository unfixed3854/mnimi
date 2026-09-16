type AsyncCleanup = void | Promise<void>;

type DisposableProvider = {
  [Symbol.asyncDispose](): Promise<void>;
};

type StoppableServer = {
  stop(force?: boolean): AsyncCleanup;
};

type StoppableScheduler = {
  stop(): AsyncCleanup;
};

export type ServerResources = {
  server?: StoppableServer;
  background?: StoppableScheduler;
  creationScheduler?: StoppableScheduler;
  imageScheduler?: StoppableScheduler;
  sweepInterval?: ReturnType<typeof setInterval>;
};

export function createShutdown({
  aiProvider,
  disposeApplication,
  resources,
  clearSweep,
  markShuttingDown,
}: {
  /** Transitional provider cleanup for callers that do not yet own an app scope. */
  aiProvider?: DisposableProvider;
  /** The scoped application graph owns workflows, provider, and core services. */
  disposeApplication?: () => Promise<void>;
  resources: ServerResources;
  clearSweep: (interval: ReturnType<typeof setInterval>) => void;
  markShuttingDown: () => void;
}): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    if (shutdownPromise) return shutdownPromise;
    markShuttingDown();
    return shutdownPromise = (async () => {
      const errors: unknown[] = [];
      const attempt = async (cleanup: () => AsyncCleanup) => {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      };

      // Closing admissions is synchronous. Await Bun's stop before releasing
      // the application scope so an in-flight request never observes closed
      // database, provider, or workflow resources.
      await attempt(() => resources.server?.stop(true));

      // Continue trying every independent cleanup after a failed HTTP stop.
      const stopped = await Promise.allSettled([
        Promise.resolve().then(() => resources.background?.stop()),
        Promise.resolve().then(() => resources.creationScheduler?.stop()),
        Promise.resolve().then(() => resources.imageScheduler?.stop()),
        Promise.resolve().then(() => {
          if (resources.sweepInterval !== undefined) clearSweep(resources.sweepInterval);
        }),
      ]);
      errors.push(...stopped
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason));

      // Workflow finalizers run before provider/database finalizers inside the
      // owned application scope; dispose only after every admission source has
      // been stopped.
      await attempt(() => disposeApplication
        ? disposeApplication()
        : aiProvider?.[Symbol.asyncDispose]());
      if (errors.length) {
        throw new AggregateError(errors, "Server shutdown failed");
      }
    })();
  };
}
