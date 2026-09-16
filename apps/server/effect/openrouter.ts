import { Cause, Context, Effect, Layer, Option, Runtime } from "effect";
import * as Redacted from "effect/Redacted";
import { chat } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { HTTPClient, OpenRouter as OpenRouterSdk } from "@openrouter/sdk";
import type { Fetcher } from "@openrouter/sdk";
import type { Logger } from "@logtape/logtape";
import { makeEffectPull, type EffectPull } from "./ai-generation.ts";
import { adjustedCardsOutputSchema } from "../ai/creation-adjustment.ts";
import {
  deckRoutingResponseSchema,
  unwrapDeckRoutingResponse,
} from "../ai/provider-schemas.ts";
import { classificationSchema, generatedNoteSchema } from "../ai/schemas.ts";
import type { CreationModelCalls } from "../ai/model-calls.ts";
import type { AiProvider } from "../ai/provider-types.ts";
import { AppConfig } from "./config.ts";
import { ProviderFailure } from "./errors.ts";
import { Logging } from "./logging.ts";

export const OPENROUTER_DEFAULTS = {
  classifyModel: "google/gemini-2.5-flash",
  generateModel: "anthropic/claude-sonnet-4.5",
  imageModel: "black-forest-labs/flux.2-klein-4b",
} as const;

export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type ReasoningOption = { effort: ReasoningEffort };

export type OpenRouterConfig = Readonly<{
  apiKey?: string | Redacted.Redacted<string>;
  classifyModel?: string;
  generateModel?: string;
  imageModel?: string;
  classifyEffort?: string;
  generateEffort?: string;
}>;

export type OpenRouterConfigSource = OpenRouterConfig | (() => OpenRouterConfig);

export type OpenRouterLogger = Pick<Logger, "warn"> | Readonly<{
  warn(...args: readonly unknown[]): void;
}>;

export type OpenRouterClient = {
  images: {
    listModels(): Promise<{ data: Array<{ id: string }> }>;
    generate(request: unknown): Promise<unknown>;
  };
  chat: {
    send(request: unknown): Promise<unknown>;
  };
  models: {
    get(request: { author: string; slug: string }): Promise<unknown>;
  };
};

export type ImageGenerationRoute =
  | { endpoint: "images" }
  | { endpoint: "chat"; modalities: Array<"text" | "image"> };

type ChatFunction = (options: Record<string, unknown>) => unknown;
type TextAdapterFactory = (model: string, apiKey: string, fetcher?: Fetcher) => AnyTextAdapter;
type ClientFactory = (apiKey: string, fetcher?: Fetcher) => OpenRouterClient;

export type OpenRouterDependencies = Readonly<{
  chat?: ChatFunction;
  chatCall?: ChatFunction;
  createTextAdapter?: TextAdapterFactory;
  textAdapterFactory?: TextAdapterFactory;
  createClient?: ClientFactory;
  clientFactory?: ClientFactory;
  sdkFactory?: ClientFactory;
  fetcher?: Fetcher;
  cache?: Map<string, Promise<ImageGenerationRoute>>;
  logger?: OpenRouterLogger;
}>;

/** Options accepted by the deterministic constructor and its AppConfig/legacy
 * adapters. `getConfig` is used by direct legacy exports; an explicit object
 * is captured once by provider construction. */
export type OpenRouterOptions = OpenRouterConfig & OpenRouterDependencies & Readonly<{
  getConfig?: () => OpenRouterConfig;
  client?: OpenRouterClient;
  sdk?: OpenRouterClient;
}>;

const noopLogger: OpenRouterLogger = { warn() {} };

function configValue(source: OpenRouterConfigSource): OpenRouterConfig {
  return typeof source === "function" ? source() : source;
}

function redactedValue(value: string | Redacted.Redacted<string> | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : Redacted.value(value);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function providerFailure(operation: string, cause: unknown): ProviderFailure {
  if (cause instanceof ProviderFailure) return cause;
  return new ProviderFailure({
    provider: "openrouter",
    operation,
    message: errorMessage(cause),
    cause,
  });
}

function validReasoning(
  value: string | undefined,
  envVar: string,
  logger: OpenRouterLogger,
): ReasoningOption | undefined {
  if (!value) return undefined;
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    logger.warn(
      `{envVar} is set to {value}, which is not a valid reasoning effort. Valid values are: ${REASONING_EFFORTS.join(", ")}. Ignoring it.`,
      { envVar, value },
    );
    return undefined;
  }
  return { effort: value as ReasoningEffort };
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type TextModel = Parameters<typeof createOpenRouterText>[0];

function defaultTextAdapter(model: string, apiKey: string, fetcher?: Fetcher): AnyTextAdapter {
  return createOpenRouterText(
    model as TextModel,
    apiKey,
    fetcher ? { httpClient: new HTTPClient({ fetcher }) } : undefined,
  );
}

function defaultClient(apiKey: string, fetcher?: Fetcher): OpenRouterClient {
  return new OpenRouterSdk({
    apiKey,
    ...(fetcher ? { httpClient: new HTTPClient({ fetcher }) } : {}),
  }) as unknown as OpenRouterClient;
}

function imagePrompt(prompt: string): string {
  return `${prompt}. Photographic, plain background, no text, no letters, no words anywhere in the image.`;
}

export type OpenRouterService = Readonly<{
  classifyModel(): string;
  generateModel(): string;
  imageModel(): string;
  classifyReasoning(): ReasoningOption | undefined;
  generateReasoning(): ReasoningOption | undefined;
  textAdapter(model: string): AnyTextAdapter;
  imagesClient(): OpenRouterClient["images"];
  imageChatClient(): OpenRouterClient["chat"];
  classify(prompts: { system: string; user: string }): Effect.Effect<unknown, ProviderFailure>;
  route(prompts: { system: string; user: string }): Effect.Effect<unknown, ProviderFailure>;
  adjust(prompts: { system: string; user: string }): Effect.Effect<unknown, ProviderFailure>;
  generate(prompts: { system: string; user: string }): Effect.Effect<EffectPull<string, unknown, ProviderFailure>, ProviderFailure>;
  imageGenerationRoute(model?: string): Effect.Effect<ImageGenerationRoute, ProviderFailure>;
  generateImageBytes(prompt: string): Effect.Effect<Uint8Array, ProviderFailure>;
}>;

export class OpenRouter extends Context.Tag("@mnimi/server/OpenRouter")<
  OpenRouter,
  OpenRouterService
>() {}

/** Run an OpenRouter operation at a Promise compatibility boundary. Effect's
 * FiberFailure wrapper is removed so adapter errors retain their original
 * code/cause. This is important for the generation validation retry policy. */
export function runOpenRouterPromise<A>(
  effect: Effect.Effect<A, ProviderFailure>,
): Promise<A> {
  return Effect.runPromise(effect).catch((error: unknown) => {
    if (Runtime.isFiberFailure(error)) {
      const failure = Cause.failureOption(error[Runtime.FiberFailureCauseId]);
      if (Option.isSome(failure) && failure.value instanceof ProviderFailure) {
        throw failure.value.cause ?? failure.value;
      }
    }
    throw error;
  });
}

export function makeOpenRouter(
  input: OpenRouterConfigSource | OpenRouterOptions,
  dependencies: OpenRouterDependencies = {},
): OpenRouterService {
  const inlineOptions = typeof input === "object"
    ? input as OpenRouterOptions
    : undefined;
  const source: OpenRouterConfigSource = typeof input === "function"
    ? input
    : (input as OpenRouterOptions).getConfig ?? input;
  const optionsDependencies: OpenRouterDependencies = inlineOptions ?? {};
  const resolvedDependencies = { ...optionsDependencies, ...dependencies };
  const staticClient = inlineOptions?.client ?? inlineOptions?.sdk;
  if (staticClient !== undefined && resolvedDependencies.createClient === undefined &&
    resolvedDependencies.clientFactory === undefined && resolvedDependencies.sdkFactory === undefined) {
    (resolvedDependencies as { createClient: ClientFactory }).createClient = () => staticClient;
  }
  const chatCall = resolvedDependencies.chat ?? resolvedDependencies.chatCall ?? (chat as unknown as ChatFunction);
  const createTextAdapter = resolvedDependencies.createTextAdapter ?? resolvedDependencies.textAdapterFactory ?? defaultTextAdapter;
  const createClient = resolvedDependencies.createClient ?? resolvedDependencies.clientFactory ?? resolvedDependencies.sdkFactory ?? defaultClient;
  const logger = resolvedDependencies.logger ?? noopLogger;
  const routes = resolvedDependencies.cache ?? new Map<string, Promise<ImageGenerationRoute>>();

  function current(): OpenRouterConfig {
    return configValue(source);
  }

  function model(value: string | undefined, fallback: string): string {
    return value === undefined ? fallback : value;
  }

  function keyOrThrow(): string {
    const key = redactedValue(current().apiKey);
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    return key;
  }

  function adapterFor(modelId: string): AnyTextAdapter {
    // Credentials are checked at the operation boundary, after construction.
    const fetcher = resolvedDependencies.fetcher;
    const key = keyOrThrow();
    return fetcher === undefined
      ? createTextAdapter(modelId, key)
      : createTextAdapter(modelId, key, fetcher);
  }

  function clientFor(): OpenRouterClient {
    const key = keyOrThrow();
    return resolvedDependencies.fetcher === undefined
      ? createClient(key)
      : createClient(key, resolvedDependencies.fetcher);
  }

  function call(
    operation: string,
    modelId: string,
    reasoning: ReasoningOption | undefined,
    schema: unknown,
    prompts: { system: string; user: string },
  ): Effect.Effect<unknown, ProviderFailure> {
    return Effect.tryPromise({
      try: async () => {
        const result = await Promise.resolve(chatCall({
          adapter: adapterFor(modelId),
          systemPrompts: [prompts.system],
          messages: [{ role: "user", content: prompts.user }],
          outputSchema: schema,
          stream: false,
          ...(reasoning === undefined ? {} : { modelOptions: { reasoning } }),
        }));
        return result;
      },
      catch: (cause) => providerFailure(operation, cause),
    });
  }

  async function discover(modelId: string): Promise<ImageGenerationRoute> {
    const separator = modelId.indexOf("/");
    if (separator < 1 || separator === modelId.length - 1) {
      throw new Error("IMAGE_MODEL must be an OpenRouter author/model ID");
    }
    const client = clientFor();
    const imageModels = await client.images.listModels();
    if (imageModels.data.some((entry) => entry.id === modelId)) {
      return { endpoint: "images" };
    }

    const data = await client.models.get({
      author: modelId.slice(0, separator),
      slug: modelId.slice(separator + 1),
    });
    const outputs = (data as { data?: { architecture?: { outputModalities?: unknown } } }).data
      ?.architecture?.outputModalities;
    if (!Array.isArray(outputs) || !outputs.includes("image")) {
      throw new Error(`Model ${modelId} does not support image output`);
    }
    return {
      endpoint: "chat",
      modalities: outputs.includes("text") ? ["text", "image"] : ["image"],
    };
  }

  function routeFor(modelId: string): Promise<ImageGenerationRoute> {
    const cached = routes.get(modelId);
    if (cached) return cached;
    const route = discover(modelId).catch((cause) => {
      routes.delete(modelId);
      throw cause;
    });
    routes.set(modelId, route);
    return route;
  }

  function imageGenerationRoute(modelId = model(current().imageModel, OPENROUTER_DEFAULTS.imageModel)) {
    return Effect.tryPromise({
      try: () => routeFor(modelId),
      catch: (cause) => providerFailure("openrouter.imageGenerationRoute", cause),
    });
  }

  const service: OpenRouterService = {
    classifyModel: () => model(current().classifyModel, OPENROUTER_DEFAULTS.classifyModel),
    generateModel: () => model(current().generateModel, OPENROUTER_DEFAULTS.generateModel),
    imageModel: () => model(current().imageModel, OPENROUTER_DEFAULTS.imageModel),
    classifyReasoning: () => validReasoning(current().classifyEffort, "CLASSIFY_EFFORT", logger),
    generateReasoning: () => validReasoning(current().generateEffort, "GENERATE_EFFORT", logger),
    textAdapter: adapterFor,
    imagesClient: () => clientFor().images,
    imageChatClient: () => clientFor().chat,
    classify: (prompts) => call(
      "openrouter.classify",
      service.classifyModel(),
      service.classifyReasoning(),
      classificationSchema,
      prompts,
    ),
    route: (prompts) => Effect.map(call(
      "openrouter.route",
      service.classifyModel(),
      service.classifyReasoning(),
      deckRoutingResponseSchema,
      prompts,
    ), (response) => {
      const outcome = (response as { outcome?: { kind?: string } }).outcome;
      if (outcome?.kind === "proposed") {
        logger.warn("Normalized proposed deck-routing outcome to newDeck");
      }
      return response;
    }),
    adjust: (prompts) => call(
      "openrouter.adjust",
      service.generateModel(),
      service.generateReasoning(),
      adjustedCardsOutputSchema,
      prompts,
    ),
    generate: (prompts) => Effect.map(
      Effect.tryPromise({
        try: async () => {
          const reasoning = service.generateReasoning();
          return await Promise.resolve(chatCall({
            adapter: adapterFor(service.generateModel()),
            systemPrompts: [prompts.system],
            messages: [{ role: "user", content: prompts.user }],
            outputSchema: generatedNoteSchema,
            stream: true,
            ...(reasoning === undefined ? {} : { modelOptions: { reasoning } }),
          }));
        },
        catch: (cause) => providerFailure("openrouter.generate", cause),
      }),
      (stream) => {
        const mapped = (async function* () {
          let object: unknown;
          for await (const chunk of stream as AsyncIterable<unknown>) {
            const value = chunk as {
              type?: string;
              delta?: unknown;
              name?: string;
              value?: { object?: unknown };
              message?: string;
            };
            if (value.type === "TEXT_MESSAGE_CONTENT" && typeof value.delta === "string") {
              yield value.delta;
            }
            if (value.type === "CUSTOM" && value.name === "structured-output.complete") {
              object = value.value?.object;
            }
            if (value.type === "RUN_ERROR") {
              throw providerFailure("openrouter.generate", new Error(value.message ?? "OpenRouter stream failed"));
            }
          }
          return object;
        })();
        return makeEffectPull(mapped, (cause) => providerFailure("openrouter.generate", cause));
      },
    ),
    imageGenerationRoute,
    generateImageBytes: (prompt) => {
      const modelId = service.imageModel();
      return Effect.flatMap(
        imageGenerationRoute(modelId),
        (route) => Effect.tryPromise({
          try: async () => {
            const content = imagePrompt(prompt);
            if (route.endpoint === "chat") {
              const response = await clientFor().chat.send({ chatRequest: {
                model: modelId,
                stream: false,
                modalities: route.modalities,
                messages: [{ role: "user", content }],
              } });
              const url = (response as {
                choices?: Array<{ message?: { images?: Array<{ imageUrl?: { url?: string } }> } }>;
              }).choices?.[0]?.message?.images?.[0]?.imageUrl?.url;
              if (!url) throw new Error("Model returned no image");
              const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
              if (!match) throw new Error("Model returned an unsupported image format");
              return decodeBase64(match[1]!);
            }

            const response = await clientFor().images.generate({ imageGenerationRequest: {
              model: modelId,
              prompt: content,
              size: "1024x1024",
            } });
            const b64Json = (response as { data?: Array<{ b64Json?: string }> }).data?.[0]?.b64Json;
            if (!b64Json) throw new Error("Model returned no image");
            return decodeBase64(b64Json);
          },
          catch: (cause) => providerFailure("openrouter.generateImageBytes", cause),
        }),
      );
    },
  };
  return service;
}

export function makeOpenRouterModelCalls(service: OpenRouterService): CreationModelCalls {
  return {
    classify: (prompts) => runOpenRouterPromise(service.classify(prompts)),
    route: async (prompts) => unwrapDeckRoutingResponse(await runOpenRouterPromise(service.route(prompts))),
    adjust: (prompts) => runOpenRouterPromise(service.adjust(prompts)),
    generate: async function* (prompts) {
      const pull = await runOpenRouterPromise(service.generate(prompts));
      return yield* openRouterPullToAsyncGenerator(pull);
    },
  };
}

async function* openRouterPullToAsyncGenerator(
  pull: EffectPull<string, unknown, ProviderFailure>,
): AsyncGenerator<string, unknown> {
  let completed = false;
  let primaryFailure = false;
  try {
    const next = async () => {
      try {
        return await runOpenRouterPromise(pull.next());
      } catch (cause) {
        primaryFailure = true;
        throw cause;
      }
    };
    let step = await next();
    while (!step.done) {
      yield step.value;
      step = await next();
    }
    completed = true;
    return step.value;
  } finally {
    if (!completed && pull.return !== undefined) {
      try {
        await runOpenRouterPromise(pull.return());
      } catch (cause) {
        if (!primaryFailure) throw cause;
      }
    }
  }
}

export function makeOpenRouterProvider(service: OpenRouterService): AiProvider {
  const modelCalls = makeOpenRouterModelCalls(service);
  let disposed = false;
  return {
    modelCalls,
    generateImageBytes: (prompt) => runOpenRouterPromise(service.generateImageBytes(prompt)),
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
    },
  };
}

export function makeOpenRouterLayer(
  dependencies: OpenRouterDependencies = {},
): Layer.Layer<OpenRouter, never, AppConfig | Logging> {
  return Layer.effect(
    OpenRouter,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const logging = yield* Logging;
      return makeOpenRouter({
        apiKey: config.ai.openRouter.apiKey,
        classifyModel: config.ai.openRouter.classifyModel,
        generateModel: config.ai.openRouter.generateModel,
        imageModel: config.ai.openRouter.imageModel,
        classifyEffort: config.ai.openRouter.classifyEffort,
        generateEffort: config.ai.openRouter.generateEffort,
      }, {
        ...dependencies,
        logger: dependencies.logger ?? logging.getLogger(["mnimi", "ai"]),
      });
    }),
  );
}

export const OpenRouterLive = makeOpenRouterLayer();
