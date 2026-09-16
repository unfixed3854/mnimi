import { Effect, Fiber } from "effect";

type AnyFiber = Fiber.RuntimeFiber<unknown, unknown>;

export type BackgroundFibers = Readonly<{
  fork<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<Fiber.RuntimeFiber<A, E>, never, R>;
  settle(): Effect.Effect<void>;
}>;

/**
 * Own daemon work explicitly. A daemon keeps its parent request from waiting,
 * but the application scope must still wait for already admitted work before
 * releasing provider, database, and media resources.
 */
export function makeBackgroundFibers(): BackgroundFibers {
  const active = new Map<symbol, AnyFiber | undefined>();

  const fork: BackgroundFibers["fork"] = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const id = Symbol("background-fiber");
      active.set(id, undefined);
      return Effect.flatMap(
        Effect.forkDaemon(work.pipe(Effect.ensuring(Effect.sync(() => {
          active.delete(id);
        })))),
        (fiber) => Effect.as(
          Effect.sync(() => { active.set(id, fiber as unknown as AnyFiber); }),
          fiber,
        ),
      );
    });

  const settle = (): Effect.Effect<void> => Effect.suspend(() => {
    const fibers = [...active.values()].filter(
      (fiber): fiber is AnyFiber => fiber !== undefined,
    );
    if (fibers.length === 0) {
      return active.size === 0
        ? Effect.void
        : Effect.zipRight(Effect.yieldNow(), settle());
    }
    return Effect.zipRight(
      Effect.forEach(fibers, Fiber.await, { discard: true }),
      settle(),
    );
  });

  return { fork, settle };
}
