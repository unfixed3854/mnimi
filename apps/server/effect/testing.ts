import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { makeAppRuntime } from "./runtime.ts";

export function testService<I, S>(
  tag: Context.Tag<I, S>,
  service: S,
): Layer.Layer<I> {
  return Layer.succeed(tag, service);
}

export function testScopedService<I, S, E, R>(
  tag: Context.Tag<I, S>,
  acquire: Effect.Effect<S, E, R>,
  release: (
    service: S,
    exit: Exit.Exit<unknown, unknown>,
  ) => Effect.Effect<void>,
): Layer.Layer<I, E, Exclude<R, Scope.Scope>> {
  return Layer.scoped(
    tag,
    Effect.acquireRelease(acquire, release),
  );
}

export function makeTestRuntime<R, E>(
  layer: Layer.Layer<R, E, never>,
): ManagedRuntime.ManagedRuntime<R, E> {
  return makeAppRuntime(layer);
}
