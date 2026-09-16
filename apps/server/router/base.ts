import { and, eq } from "drizzle-orm";
import { AsyncIteratorClass, os } from "@orpc/server";
import { Cause, Effect, Exit, Option, Runtime, Scope, Stream } from "effect";
import type { Auth } from "../auth.ts";
import type { Db } from "../db/index.ts";
import type { ModelCalls } from "../ai/generate-note.ts";
import { withWriteLock as legacyWithWriteLock } from "../db/write-lock.ts";
import { decks } from "../db/schema.ts";
import {
  Application,
  type ApplicationRuntime,
  type ApplicationServices,
} from "../effect/application.ts";
import type { BackgroundWorkflowsService } from "../effect/background-workflows.ts";
import type { BackgroundProviderService } from "../effect/background-provider.ts";
import type { CreationEventsService } from "../effect/creation-events.ts";
import {
  Conflict,
  DependencyUnavailable,
  DatabaseFailure,
  Forbidden,
  InfrastructureFailure,
  NotFound,
  Unauthorized,
  Validation,
} from "../effect/errors.ts";
import type { RequestContextValue } from "../effect/request-context.ts";
import { runRequest } from "../effect/runtime.ts";
import {
  runTransport,
  toOrpcError,
  unwrapEffectFailure,
} from "../effect/transport.ts";

export type AppContext = {
  /** The production transport supplies one application-owned runtime. */
  runtime?: ApplicationRuntime;
  /** Request values are scoped by the transport runner and never retained. */
  request?: RequestContextValue;
  /** Existing application-owned workflows; never selected from a registry. */
  workflows?: BackgroundWorkflowsService;
  /** Explicit event service for direct-call tests. Live requests use workflows.events. */
  events?: CreationEventsService;
  /** Existing selected provider for direct request operations. */
  provider?: BackgroundProviderService;
  /** Legacy direct-test database override. Live requests resolve it from Application. */
  db: Db;
  /** Legacy direct-test auth override. Live requests resolve it from Application. */
  auth: Auth;
  /** Explicit server-startup capability for destructive development tools. */
  devtoolsEnabled?: boolean;
  /** Supplied by oRPC's RequestHeadersPlugin. Optional: a direct server-side
   *  call has no HTTP request behind it. */
  reqHeaders?: Headers;
  /** Selected once at startup; required by image-generating procedures. */
  generateImageBytes?: (prompt: string) => Promise<Uint8Array>;
  /** Overridden in tests so no bytes ever reach the disk. */
  writeImage?: (
    userId: string,
    noteId: string,
    bytes: Uint8Array,
  ) => Promise<string>;
  /** Overridden in tests so no seed audio bytes ever reach the disk. */
  writeAudio?: (
    userId: string,
    cardId: string,
    bytes: Uint8Array,
  ) => Promise<string>;
  /** Overridden in tests so seed-image cleanup never touches the disk. */
  removeImage?: (relativePath: string) => Promise<void>;
  /** Overridden in tests so seed-audio cleanup never touches the disk. */
  removeAudio?: (relativePath: string) => Promise<void>;
  /** Overridden in tests so no bytes ever reach the disk. */
  writeDraftImage?: (userId: string, bytes: Uint8Array) => Promise<string>;
  /** Overridden in tests so no file is ever moved on disk. */
  claimDraftImage?: (
    userId: string,
    draftId: string,
    noteId: string,
  ) => Promise<string>;
  /** Overridden in tests so no file is ever removed from disk. */
  removeDraftImage?: (userId: string, draftId: string) => Promise<void>;
  /** Selected once at startup; required by text-generating procedures. */
  modelCalls?: ModelCalls;
};

export function requireAiDependency<T>(dependency: T | undefined): T {
  if (dependency === undefined) {
    throw new DependencyUnavailable({
      dependency: "AI provider",
      message: "AI provider is not configured",
    });
  }
  return dependency;
}

function isDomainFailure(cause: unknown): boolean {
  return cause instanceof Unauthorized ||
    cause instanceof NotFound ||
    cause instanceof Conflict ||
    cause instanceof Forbidden ||
    cause instanceof Validation ||
    cause instanceof DependencyUnavailable ||
    cause instanceof InfrastructureFailure;
}

export type AuthedContext = AppContext & { userId: string };

export const pub = os.$context<AppContext>();

/**
 * The whole authorization boundary. Row Level Security used to guarantee that
 * a query could only ever touch its owner's rows; nothing does that
 * automatically any more, so this middleware establishes the one fact every
 * procedure relies on — `context.userId` is a user the auth server just
 * vouched for — and each procedure is responsible for filtering on it.
 *
 * No procedure may take a userId from its input. There is deliberately no
 * other way to obtain one.
 */
const requireAuth = pub.middleware(async ({ context, next }) => {
  const headers = context.reqHeaders ?? context.request?.headers;
  if (!headers) {
    if (context.runtime) throw new Unauthorized({});
    throw toOrpcError(new Unauthorized({}));
  }

  if (context.runtime) {
    const request: RequestContextValue = context.request ?? {
      headers,
      requestId: crypto.randomUUID(),
      signal: new AbortController().signal,
    };
    return await runTransport(context.runtime, request, Effect.gen(function* () {
      const application = yield* Application;
      const session = yield* Effect.tryPromise({
        try: () => application.auth.instance.api.getSession({ headers }),
        catch: (cause) => new InfrastructureFailure({
          operation: "auth.get-session",
          message: cause instanceof Error ? cause.message : "Authentication failed",
          cause,
        }),
      });
      if (!session) return yield* Effect.fail(new Unauthorized({}));
      return yield* Effect.tryPromise({
        try: () => (application.database.withWriteLockContext ?? ((work) => work()))(() =>
          Promise.resolve(next({
            context: {
              userId: session.user.id,
              db: application.database.db,
              workflows: application.workflows,
              provider: application.provider,
            },
          })),
        ),
        catch: (cause) => cause,
      });
    }));
  }

  if (!context.auth || !context.db) {
    throw new InfrastructureFailure({
      operation: "router.require-auth",
      message: "Application runtime is not configured",
    });
  }
  try {
    const session = await context.auth.api.getSession({ headers });
    if (!session) throw new Unauthorized({});
    return await next({ context: { userId: session.user.id } });
  } catch (cause) {
    // Direct `call(...)` tests intentionally expose injected Drizzle and
    // filesystem faults. HTTP dispatch is always inside runTransport, which
    // maps all failures. Domain failures are the shared public contract, so
    // preserve their oRPC shape for direct calls as well.
    if (isDomainFailure(cause)) throw toOrpcError(cause);
    throw cause;
  }
});

export const authed = pub.use(requireAuth);

/** Run direct workflow work through the existing application runtime. */
export async function runWorkflow<A, E>(
  context: AppContext,
  program: Effect.Effect<A, E, Application>,
): Promise<A> {
  if (!context.runtime) {
    try {
      return await Effect.runPromise(program as Effect.Effect<A, E, never>);
    } catch (cause) {
      throw unwrapEffectFailure(cause);
    }
  }
  const request = context.request ?? {
    headers: context.reqHeaders ?? new Headers(),
    requestId: crypto.randomUUID(),
    signal: new AbortController().signal,
  };
  try {
    return await runRequest(context.runtime, program, request);
  } catch (cause) {
    throw unwrapEffectFailure(cause);
  }
}

/**
 * Starts work which must outlive the HTTP request that admitted it. Unlike
 * `runWorkflow`, this deliberately does not supply the request abort signal.
 */
export async function runDetachedWorkflow<A, E>(
  context: AppContext,
  program: Effect.Effect<A, E, Application>,
): Promise<A> {
  try {
    return context.runtime
      ? await context.runtime.runPromise(program)
      : await Effect.runPromise(program as Effect.Effect<A, E, never>);
  } catch (cause) {
    throw unwrapEffectFailure(cause);
  }
}

/**
 * Runs a router use case against the application graph. Direct `call(...)`
 * tests provide an explicit legacy database seam; production always uses the
 * scoped Application service acquired in main.
 */
export async function runRouter<A, E>(
  context: AppContext,
  program: Effect.Effect<A, E, Application>,
): Promise<A> {
  if (context.runtime) return runWorkflow(context, program);

  const application = {
    database: {
      db: context.db,
      withWriteLock: <A, E, R>(operation: string, work: Effect.Effect<A, E, R>) => Effect.gen(function* () {
        const runtime = yield* Effect.runtime<R>();
        const exit = yield* Effect.tryPromise({
          try: () => legacyWithWriteLock(() => Runtime.runPromiseExit(runtime, work)),
          catch: (cause) => new InfrastructureFailure({
            operation,
            message: cause instanceof Error ? cause.message : "Database write failed",
            cause,
          }),
        });
        return yield* Exit.matchEffect(exit, {
          onFailure: Effect.failCause,
          onSuccess: Effect.succeed,
        });
      }),
      withWriteLockContext: <A>(work: () => Promise<A>) => work(),
    },
    workflows: context.workflows ?? {},
    provider: context.provider ?? {
      generateImageBytes: (prompt: string) => context.generateImageBytes
        ? Effect.tryPromise({
          try: () => context.generateImageBytes!(prompt),
          catch: (cause) => new DependencyUnavailable({
            dependency: "AI provider",
            message: cause instanceof Error ? cause.message : "Image generation failed",
          }),
        })
        : Effect.fail(new DependencyUnavailable({
          dependency: "AI provider",
          message: "AI provider is not configured",
        })),
    },
    media: {
      writeImage: (userId: string, noteId: string, bytes: Uint8Array) =>
        context.writeImage
          ? Effect.tryPromise({
            try: () => context.writeImage!(userId, noteId, bytes),
            catch: (cause) => cause,
          })
          : Effect.fail(new DependencyUnavailable({
            dependency: "media store",
            message: "Image storage is not configured",
          })),
      removeImage: (path: string) => context.removeImage
        ? Effect.tryPromise({
          try: () => context.removeImage!(path),
          catch: (cause) => cause,
        })
        : Effect.void,
    },
  } as unknown as ApplicationServices;
  const exit = await Effect.runPromiseExit(Effect.provideService(
    program,
    Application,
    application,
  ));
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  if (failure instanceof DatabaseFailure && failure.cause !== undefined) {
    throw failure.cause;
  }
  throw failure ?? new Error(Cause.pretty(exit.cause));
}

/**
 * Bridges an Effect Stream to oRPC's cancellable async-iterator transport.
 * `return()` closes the stream scope directly, so a disconnect cannot wait
 * for an unpublished event before releasing the subscription.
 */
export function runWorkflowStream<A, B, E>(
  context: AppContext,
  stream: Effect.Effect<Stream.Stream<A, E>>,
  map: (value: A) => Promise<B>,
  before?: () => Promise<unknown>,
): AsyncIteratorClass<Awaited<B>, void> {
  const scope = Effect.runSync(Scope.make());
  let pullNext: (() => Promise<IteratorResult<A>>) | undefined;
  let starting: Promise<void> | undefined;
  let pending: A[] = [];
  let returned = false;

  const start = () => {
    starting ??= (async () => {
      await before?.();
      if (returned) return;
      const pull = await runWorkflow(
        context,
        Effect.flatMap(stream, (source) =>
          Scope.extend(Stream.toPull(source), scope)
        ),
      );
      const takeNext = async (): Promise<IteratorResult<A>> => {
        while (pending.length === 0) {
          const chunk = await runWorkflow(context, Effect.matchEffect(pull, {
            onSuccess: (value) => Effect.succeed(Option.some(value)),
            onFailure: (cause) => Option.isSome(cause)
              ? Effect.fail(cause.value)
              : Effect.succeed(Option.none()),
          }));
          if (Option.isNone(chunk)) {
            return { done: true, value: undefined as never };
          }
          pending = Array.from(chunk.value);
        }
        return { done: false, value: pending.shift()! };
      };
      const firstPull = takeNext();
      pullNext = () => {
        pullNext = takeNext;
        return firstPull;
      };
    })();
    return starting;
  };

  return new AsyncIteratorClass<Awaited<B>, void>(
    async (): Promise<IteratorResult<Awaited<B>>> => {
      try {
        await start();
        if (returned || !pullNext) return { done: true, value: undefined as never };
        const next = await pullNext();
        if (next.done) return { done: true, value: undefined as never };
        return { done: false, value: await map(next.value) };
      } catch (cause) {
        throw toOrpcError(cause);
      }
    },
    async () => {
      returned = true;
      try {
        await starting?.catch(() => undefined);
        await runWorkflow(context, Scope.close(scope, Exit.void));
      } catch (cause) {
        throw toOrpcError(cause);
      }
    },
  );
}

/**
 * A row that does not exist and a row owned by someone else are reported
 * identically, so an id's existence never leaks.
 *
 * Throws rather than returning the error: this is called in the position where
 * a handler would otherwise fall through to returning someone else's row, and
 * a missed `throw` at the call site would be silent. `throw notFound(...)`
 * still reads naturally and stays correct.
 */
export function notFound(message: string): never {
  throw new NotFound({ message });
}

/** Throws unless this deck exists and belongs to this user. */
export async function assertOwnsDeck(
  db: Db,
  userId: string,
  deckId: string,
): Promise<void> {
  const [deck] = await db
    .select({ id: decks.id })
    .from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.userId, userId)))
    .limit(1);
  if (!deck) throw notFound("Deck not found");
}
