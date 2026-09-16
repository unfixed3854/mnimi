import { Effect, ManagedRuntime } from "effect";
import type * as Layer from "effect/Layer";
import {
  RequestContext,
  type RequestContextValue,
} from "./request-context.ts";

export type AppRuntime<R, E = never> =
  ManagedRuntime.ManagedRuntime<R, E>;

export function makeAppRuntime<R, E>(
  layer: Layer.Layer<R, E, never>,
): AppRuntime<R, E> {
  return ManagedRuntime.make(layer);
}

export function runRequest<R, RuntimeError, A, E>(
  runtime: ManagedRuntime.ManagedRuntime<R, RuntimeError>,
  program: Effect.Effect<A, E, R | RequestContext>,
  request: RequestContextValue,
): Promise<A> {
  return runtime.runPromise(
    Effect.provideService(program, RequestContext, request),
    { signal: request.signal },
  );
}
