import { ORPCError } from "@orpc/server";
import { Cause, Option, Runtime } from "effect";
import type { Effect, ManagedRuntime } from "effect";
import {
  Conflict,
  DatabaseFailure,
  DependencyUnavailable,
  Forbidden,
  InfrastructureFailure,
  Interrupted,
  MediaFailure,
  NotFound,
  ProviderFailure,
  Unauthorized,
  Validation,
} from "./errors.ts";
import type { RequestContextValue } from "./request-context.ts";
import { RequestContext } from "./request-context.ts";
import { runRequest } from "./runtime.ts";

export function unwrapEffectFailure(cause: unknown): unknown {
  if (!Runtime.isFiberFailure(cause)) return cause;
  const failure = Cause.failureOption(cause[Runtime.FiberFailureCauseId]);
  return Option.getOrUndefined(failure) ?? cause;
}

function isExpectedFailure(cause: unknown): boolean {
  return cause instanceof ORPCError ||
    cause instanceof Unauthorized ||
    cause instanceof NotFound ||
    cause instanceof Conflict ||
    cause instanceof Forbidden ||
    cause instanceof Validation ||
    cause instanceof DependencyUnavailable ||
    cause instanceof DatabaseFailure ||
    cause instanceof ProviderFailure ||
    cause instanceof MediaFailure ||
    cause instanceof Interrupted ||
    cause instanceof InfrastructureFailure;
}

/** Convert an Effect-domain failure into the unchanged oRPC public surface. */
export function toOrpcError(cause: unknown) {
  const failure = unwrapEffectFailure(cause);
  if (failure instanceof ORPCError) return failure;
  if (failure instanceof Unauthorized) return new ORPCError("UNAUTHORIZED");
  if (failure instanceof NotFound) {
    return new ORPCError("NOT_FOUND", { message: failure.message });
  }
  if (failure instanceof Conflict) {
    return new ORPCError("CONFLICT", { message: failure.message });
  }
  if (failure instanceof Forbidden) {
    return new ORPCError("FORBIDDEN", { message: failure.message });
  }
  if (failure instanceof Validation) {
    return new ORPCError("BAD_REQUEST", {
      message: failure.message ?? "Invalid request",
      data: failure.data,
    });
  }
  if (failure instanceof DependencyUnavailable) {
    return new ORPCError("INTERNAL_SERVER_ERROR", { message: failure.message });
  }
  return new ORPCError("INTERNAL_SERVER_ERROR");
}

/**
 * The only Promise bridge for Hono/oRPC request work. The runtime is owned by
 * application startup; this helper only supplies request-local values.
 */
export async function runTransport<R, RuntimeError, A, E>(
  runtime: ManagedRuntime.ManagedRuntime<R, RuntimeError>,
  request: RequestContextValue,
  program: Effect.Effect<A, E, R | RequestContext>,
): Promise<A> {
  try {
    return await runRequest(runtime, program, request);
  } catch (cause) {
    const failure = unwrapEffectFailure(cause);
    if (!isExpectedFailure(failure)) {
      console.error("server request failed", { requestId: request.requestId }, cause);
    }
    throw toOrpcError(cause);
  }
}
