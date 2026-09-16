import { Hono } from "hono";
import { cors } from "hono/cors";
import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { router } from "./router/index.ts";
import { createImagesRoute } from "./images.ts";
import { createAudioRoute } from "./audio.ts";
import type { Auth } from "./auth.ts";
import type { Db } from "./db/index.ts";
import { browserOrigins } from "./browser-origins.ts";
import { cookieOnlyResponse, isBrowserRequest } from "./browser-auth.ts";
import type { AppContext } from "./router/base.ts";
import { captureAppConfig } from "./effect/config.ts";
import { Effect } from "effect";
import { runTransport } from "./effect/transport.ts";

/**
 * TCP binding is intentionally independent of the browser origin allowlist:
 * Android development devices need a LAN-reachable listener, while CORS still
 * restricts the browser clients that may read credentialed responses.
 */
export function serverOptions(env: Record<string, string | undefined>) {
  return captureAppConfig({ env }).server;
}

export function createApp(
  {
    db,
    auth,
    corsOrigin,
    devtoolsEnabled = false,
    registrationEnabled = false,
    runtime,
    media,
    events,
    isShuttingDown = () => false,
    modelCalls,
    generateImageBytes,
  }: {
    db: Db;
    auth: Auth;
    corsOrigin?: string;
    devtoolsEnabled?: boolean;
    registrationEnabled?: boolean;
    runtime?: AppContext["runtime"];
    media?: import("./effect/media.ts").MediaStoreService;
    /** Direct test seam. Live requests resolve this from workflows. */
    events?: AppContext["events"];
    /** Rejects new work once shutdown has fenced admissions. */
    isShuttingDown?: () => boolean;
    modelCalls?: AppContext["modelCalls"];
    generateImageBytes?: AppContext["generateImageBytes"];
  },
) {
  const app = new Hono();
  const allowedOrigins = browserOrigins(corsOrigin);

  // Browsers use HttpOnly cookies. Native clients read the bearer response
  // header directly and do not need it exposed through CORS.
  app.use(
    "*",
    cors({
      // CORS_ORIGIN may list several allowed origins (comma-separated) — e.g.
      // localhost and 127.0.0.1 both need to work against the same server.
      origin: allowedOrigins,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["POST", "GET", "OPTIONS"],
      credentials: true,
    }),
  );

  app.use("*", async (c, next) => {
    if (isShuttingDown()) {
      return c.json({ message: "Server is shutting down" }, 503);
    }
    await next();
  });

  // CORS controls response visibility, not whether a mutation executes.
  // Better Auth checks its own endpoints; cookie-authenticated RPC calls need
  // the same protection. Originless, cookie-free native bearers still work.
  app.use("*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (isBrowserRequest(c.req.raw) && (!origin || !allowedOrigins.includes(origin))) {
        return c.json({ message: "Untrusted request origin" }, 403);
      }
    }
    await next();
  });

  app.get("/api/registration", (c) => c.json({ enabled: registrationEnabled }));

  app.on(["POST", "GET"], "/api/auth/*", async (c) => {
    const response = await auth.handler(c.req.raw);
    return isBrowserRequest(c.req.raw) ? cookieOnlyResponse(response) : response;
  });

  app.route("/images", createImagesRoute({ db, auth, media }));
  app.route("/audio", createAudioRoute({ db, auth, media }));

  // RequestHeadersPlugin is what puts `reqHeaders` in procedure context, which
  // is how the authed middleware sees either the cookie or the bearer token.
  const handler = new RPCHandler(router, {
    plugins: [new RequestHeadersPlugin()],
    interceptors: [onError((error) => console.error(error))],
  });

  app.use("/rpc/*", async (c, next) => {
    const request = runtime
      ? {
        headers: c.req.raw.headers,
        requestId: crypto.randomUUID(),
        signal: c.req.raw.signal,
      }
      : undefined;
    // `AppContext` retains the direct-call test contract. In a live request
    // these two legacy fields deliberately are not present: requireAuth
    // resolves auth and database from the scoped Application service before a
    // procedure can run.
    const context: AppContext = runtime
      ? {
        devtoolsEnabled,
        runtime,
        request,
        events,
      } as AppContext
      : {
        db,
        auth,
        devtoolsEnabled,
        modelCalls,
        generateImageBytes,
        events,
      };
    const handle = () => handler.handle(c.req.raw, {
      prefix: "/rpc",
      context,
    });
    const { matched, response } = runtime && request
      ? await runTransport(
        runtime,
        request,
        Effect.tryPromise({ try: handle, catch: (cause) => cause }),
      )
      : await handle();
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  return app;
}
