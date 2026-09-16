import { Effect, Exit, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  acquireBackgroundProvider,
  fromCodexRuntime,
  fromOpenRouter,
  makeBackgroundProvider,
  type BackgroundProviderService,
  type BackgroundProviderDependencies,
} from "./background-provider.ts";
import type { CodexRuntimeService } from "./codex-runtime.ts";
import { captureAppConfig } from "./config.ts";
import type { OpenRouterService } from "./openrouter.ts";
import { CodexAppServerClient, type AppServerConnection } from "../ai/codex/app-server-client.ts";

function providerFixture(): BackgroundProviderService {
  return makeBackgroundProvider({
    classify: () => Effect.die("not run"),
    route: () => Effect.die("not run"),
    adjust: () => Effect.die("not run"),
    generate: () => Effect.die("not run"),
    generateImageBytes: () => Effect.die("not run"),
  });
}

describe("background provider", () => {
  it("keeps the default Codex factory's real scoped layer alive until the application scope closes", async () => {
    const events: string[] = [];
    const connect = vi.spyOn(CodexAppServerClient.prototype, "connect").mockImplementation(async () => {
      events.push("connect");
      return {} as AppServerConnection;
    });
    const dispose = vi.spyOn(CodexAppServerClient.prototype, Symbol.asyncDispose).mockImplementation(async () => {
      events.push("dispose");
    });
    const outer = Effect.runSync(Scope.make());
    try {
      const env = { AI_PROVIDER: "codex", REGISTRATION_ENABLED: "false", CODEX_HOME: "/unused-codex-home" };
      // No factory or Layer override: only the external process boundary is stubbed.
      const provider = await Effect.runPromise(Scope.extend(acquireBackgroundProvider({
        config: captureAppConfig({ env }), env,
      }), outer));
      events.push("returned");
      expect(events).toEqual(["connect", "returned"]);
      expect(provider.classify).toBeTypeOf("function");
      expect(connect).toHaveBeenCalledOnce();
      await Effect.runPromise(Scope.close(outer, Exit.void));
      await Effect.runPromise(Scope.close(outer, Exit.void));
      expect(events).toEqual(["connect", "returned", "dispose"]);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await Effect.runPromise(Scope.close(outer, Exit.void));
      connect.mockRestore(); dispose.mockRestore();
    }
  });
  it("exposes the selected provider's Effect operations without invoking them at construction", async () => {
    const classify = vi.fn(() => Effect.succeed({ domain: "concept" }));
    const route = vi.fn(() => Effect.succeed({ kind: "newDeck" }));
    const adjust = vi.fn(() => Effect.succeed({ cards: [] }));
    const generate = vi.fn(() => Effect.die("not run"));
    const generateImageBytes = vi.fn(() => Effect.succeed(new Uint8Array([1])));
    const dependencies: BackgroundProviderDependencies = {
      classify,
      route,
      adjust,
      generate,
      generateImageBytes,
    };

    const provider = makeBackgroundProvider(dependencies);

    expect(classify).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(adjust).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(generateImageBytes).not.toHaveBeenCalled();

    await expect(Effect.runPromise(provider.classify({ system: "s", user: "u" })))
      .resolves.toEqual({ domain: "concept" });
    await expect(Effect.runPromise(provider.generateImageBytes("image")))
      .resolves.toEqual(new Uint8Array([1]));

    expect(classify).toHaveBeenCalledWith({ system: "s", user: "u" });
    expect(generateImageBytes).toHaveBeenCalledWith("image");
    expect(route).not.toHaveBeenCalled();
    expect(adjust).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("adapts existing OpenRouter and Codex Effect services without a Promise facade", async () => {
    const openRouterClassify = vi.fn(() => Effect.succeed("openrouter"));
    const codexClassify = vi.fn(() => Effect.succeed("codex"));
    const openRouter = {
      classify: openRouterClassify,
      route: () => Effect.die("not run"),
      adjust: () => Effect.die("not run"),
      generate: () => Effect.die("not run"),
      generateImageBytes: () => Effect.die("not run"),
    } as unknown as OpenRouterService;
    const codex = {
      modelCalls: {
        classify: codexClassify,
        route: () => Effect.die("not run"),
        adjust: () => Effect.die("not run"),
        generate: () => Effect.die("not run"),
      },
      generateImageBytes: () => Effect.die("not run"),
    } as unknown as CodexRuntimeService;

    await expect(Effect.runPromise(
      fromOpenRouter(openRouter).classify({ system: "s", user: "u" }),
    )).resolves.toBe("openrouter");
    await expect(Effect.runPromise(
      fromCodexRuntime(codex).classify({ system: "s", user: "u" }),
    )).resolves.toBe("codex");

    expect(openRouterClassify).toHaveBeenCalledOnce();
    expect(codexClassify).toHaveBeenCalledOnce();
  });

  it("normalizes a Codex async generator into the shared Effect pull", async () => {
    const stream = (async function* () {
      yield "first";
      return { complete: true };
    })();
    const codex = {
      modelCalls: {
        classify: () => Effect.die("not run"),
        route: () => Effect.die("not run"),
        adjust: () => Effect.die("not run"),
        generate: () => Effect.succeed(stream),
      },
      generateImageBytes: () => Effect.die("not run"),
    } as unknown as CodexRuntimeService;

    const pull = await Effect.runPromise(
      fromCodexRuntime(codex).generate({ system: "s", user: "u" }),
    );

    await expect(Effect.runPromise(pull.next())).resolves.toEqual({
      done: false,
      value: "first",
    });
    await expect(Effect.runPromise(pull.next())).resolves.toEqual({
      done: true,
      value: { complete: true },
    });
  });

  it("uses the injected environment to acquire only the selected provider", async () => {
    const openRouter = vi.fn(() => Effect.succeed(providerFixture()));
    const codex = vi.fn(() => Effect.die("unselected Codex factory"));
    const config = captureAppConfig({ env: { AI_PROVIDER: "codex" } });

    const provider = await Effect.runPromise(Effect.scoped(
      acquireBackgroundProvider({
        config,
        env: { AI_PROVIDER: "openrouter" },
        factories: { openrouter: openRouter, codex },
      }),
    ));

    expect(provider).toBe(await Effect.runPromise(openRouter.mock.results[0]!.value));
    expect(openRouter).toHaveBeenCalledOnce();
    expect(codex).not.toHaveBeenCalled();
  });

  it("rejects public registration before it acquires Codex", async () => {
    const codex = vi.fn(() => Effect.succeed(providerFixture()));
    const openRouter = vi.fn(() => Effect.die("unselected OpenRouter factory"));

    await expect(Effect.runPromise(Effect.scoped(
      acquireBackgroundProvider({
        config: captureAppConfig({ env: { AI_PROVIDER: "codex" } }),
        env: { AI_PROVIDER: "codex", REGISTRATION_ENABLED: "true" },
        factories: { openrouter: openRouter, codex },
      }),
    ))).rejects.toThrow("Codex provider requires REGISTRATION_ENABLED=false");

    expect(codex).not.toHaveBeenCalled();
    expect(openRouter).not.toHaveBeenCalled();
  });

  it("keeps missing OpenRouter configuration lazy until an operation runs", async () => {
    const env = { AI_PROVIDER: "openrouter" };
    const provider = await Effect.runPromise(Effect.scoped(
      acquireBackgroundProvider({ config: captureAppConfig({ env }), env }),
    ));

    await expect(Effect.runPromise(provider.classify({ system: "s", user: "u" })))
      .rejects.toThrow("OPENROUTER_API_KEY is not set");
  });

  it("releases the selected Codex resource once when its scope closes", async () => {
    const release = vi.fn();
    const codex = vi.fn(() => Effect.acquireRelease(
      Effect.succeed(providerFixture()),
      () => Effect.sync(release),
    ));

    await Effect.runPromise(Effect.scoped(
      acquireBackgroundProvider({
        config: captureAppConfig({ env: { AI_PROVIDER: "codex" } }),
        env: { AI_PROVIDER: "codex", REGISTRATION_ENABLED: "false" },
        factories: {
          openrouter: () => Effect.die("unselected OpenRouter factory"),
          codex,
        },
      }),
    ));

    expect(codex).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
