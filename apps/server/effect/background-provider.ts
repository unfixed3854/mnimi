import { Context, Effect, Layer, type Scope } from "effect";
import { getLogger } from "../logging.ts";
import { selectAiProvider } from "../ai/provider.ts";
import { makeEffectPull, type EffectPull, type ModelPrompts } from "./ai-generation.ts";
import {
  CodexRuntime,
  makeCodexRuntimeLayerFromConfig,
  type CodexRuntimeService,
} from "./codex-runtime.ts";
import type { AppConfigValue } from "./config.ts";
import { materializeLegacyEnvironment } from "./config.ts";
import { ProviderFailure } from "./errors.ts";
import {
  makeOpenRouter,
  type OpenRouterLogger,
  type OpenRouterService,
} from "./openrouter.ts";
import { readCodexRoleConfig } from "../ai/codex/config.ts";

export type BackgroundProviderService = Readonly<{
  classify(
    prompts: ModelPrompts,
  ): Effect.Effect<unknown, ProviderFailure>;
  route(
    prompts: ModelPrompts,
  ): Effect.Effect<unknown, ProviderFailure>;
  adjust(
    prompts: ModelPrompts,
  ): Effect.Effect<unknown, ProviderFailure>;
  generate(
    prompts: ModelPrompts,
  ): Effect.Effect<EffectPull<string, unknown, ProviderFailure>, ProviderFailure>;
  generateImageBytes(
    prompt: string,
  ): Effect.Effect<Uint8Array, ProviderFailure>;
}>;

export class BackgroundProvider extends Context.Tag(
  "@mnimi/server/BackgroundProvider",
)<BackgroundProvider, BackgroundProviderService>() {}

export type BackgroundProviderDependencies = BackgroundProviderService;

export type BackgroundProviderFactoryInput = Readonly<{
  config: AppConfigValue;
  env: NodeJS.ProcessEnv;
  logger: OpenRouterLogger;
}>;

export type BackgroundProviderFactories = Readonly<{
  openrouter(
    input: BackgroundProviderFactoryInput,
  ): Effect.Effect<BackgroundProviderService, ProviderFailure, Scope.Scope>;
  codex(
    input: BackgroundProviderFactoryInput,
  ): Effect.Effect<BackgroundProviderService, ProviderFailure, Scope.Scope>;
}>;

function selectionFailure(cause: unknown): ProviderFailure {
  return new ProviderFailure({
    provider: "ai",
    operation: "provider.select",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function openRouterConfig(env: NodeJS.ProcessEnv) {
  return {
    apiKey: env.OPENROUTER_API_KEY,
    classifyModel: env.CLASSIFY_MODEL,
    generateModel: env.GENERATE_MODEL,
    imageModel: env.IMAGE_MODEL,
    classifyEffort: env.CLASSIFY_EFFORT,
    generateEffort: env.GENERATE_EFFORT,
  };
}

const defaultBackgroundProviderFactories: BackgroundProviderFactories = {
  openrouter: ({ env, logger }) => Effect.acquireRelease(
    Effect.sync(() => fromOpenRouter(makeOpenRouter(openRouterConfig(env), { logger }))),
    () => Effect.void,
  ),
  codex: ({ env }) => Effect.flatMap(
    Effect.try({
      try: () => makeCodexRuntimeLayerFromConfig(readCodexRoleConfig(env), { env }),
      catch: selectionFailure,
    }),
    // Build in the caller's application Scope. Effect.provide would close its
    // temporary Layer scope as soon as it returned the service.
    (layer) => Effect.map(Layer.build(layer), (context) =>
      fromCodexRuntime(Context.get(context, CodexRuntime))),
  ),
};

/**
 * Acquire exactly one configured provider for background workflows. The
 * resulting service stays direct-Effect; routers retain their Promise facade.
 */
export function acquireBackgroundProvider({
  config,
  env = materializeLegacyEnvironment(config),
  logger = getLogger(["mnimi", "ai"]),
  factories = defaultBackgroundProviderFactories,
}: Readonly<{
  config: AppConfigValue;
  env?: NodeJS.ProcessEnv;
  logger?: OpenRouterLogger;
  factories?: BackgroundProviderFactories;
}>): Effect.Effect<BackgroundProviderService, ProviderFailure, Scope.Scope> {
  return Effect.flatMap(
    Effect.try({
      try: () => selectAiProvider(env),
      catch: selectionFailure,
    }),
    (selected) => Effect.suspend(() =>
      selected === "openrouter"
        ? factories.openrouter({ config, env, logger })
        : factories.codex({ config, env, logger })
    ),
  );
}

/** Wrap one already selected adapter without evaluating an operation early. */
export function makeBackgroundProvider(
  dependencies: BackgroundProviderDependencies,
): BackgroundProviderService {
  return {
    classify: (prompts) => Effect.suspend(() => dependencies.classify(prompts)),
    route: (prompts) => Effect.suspend(() => dependencies.route(prompts)),
    adjust: (prompts) => Effect.suspend(() => dependencies.adjust(prompts)),
    generate: (prompts) => Effect.suspend(() => dependencies.generate(prompts)),
    generateImageBytes: (prompt) =>
      Effect.suspend(() => dependencies.generateImageBytes(prompt)),
  };
}

/** Use OpenRouter's Effect operations directly in background workflows. */
export function fromOpenRouter(
  service: OpenRouterService,
): BackgroundProviderService {
  return makeBackgroundProvider({
    classify: service.classify,
    route: service.route,
    adjust: service.adjust,
    generate: service.generate,
    generateImageBytes: service.generateImageBytes,
  });
}

/** Use the scoped Codex runtime's Effect operations directly in background workflows. */
export function fromCodexRuntime(
  service: CodexRuntimeService,
): BackgroundProviderService {
  return makeBackgroundProvider({
    classify: service.modelCalls.classify,
    route: service.modelCalls.route,
    adjust: service.modelCalls.adjust,
    generate: (prompts) =>
      Effect.map(service.modelCalls.generate(prompts), (generator) =>
        makeEffectPull(generator, (cause) =>
          cause instanceof ProviderFailure
            ? cause
            : new ProviderFailure({
                provider: "codex",
                operation: "codex.generate",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Codex generate failed",
                cause,
              }),
        ),
      ),
    generateImageBytes: service.generateImageBytes,
  });
}

export function makeBackgroundProviderLayer(
  dependencies: BackgroundProviderDependencies,
): Layer.Layer<BackgroundProvider> {
  return Layer.succeed(BackgroundProvider, makeBackgroundProvider(dependencies));
}
