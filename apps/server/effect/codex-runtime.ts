import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Option, Runtime } from "effect";
import { z } from "zod";
import type { AppConfigValue } from "./config.ts";
import { AppConfig, materializeLegacyEnvironment } from "./config.ts";
import { ProviderFailure } from "./errors.ts";
import type { CreationModelCalls } from "../ai/model-calls.ts";
import {
  adjustedCardsOutputSchema,
} from "../ai/creation-adjustment.ts";
import { channel } from "../ai/channel.ts";
import type { AiProvider } from "../ai/provider-types.ts";
import {
  deckRoutingResponseSchema,
  unwrapDeckRoutingResponse,
} from "../ai/provider-schemas.ts";
import { classificationSchema, generatedNoteSchema } from "../ai/schemas.ts";
import {
  CodexAppServerClient,
  spawnCodexAppServer,
  type ConnectionValidator,
} from "../ai/codex/app-server-client.ts";
import {
  type CodexRoleConfig,
  readCodexRoleConfig,
  validateCodexStartup,
} from "../ai/codex/config.ts";
import {
  type CodexClient,
  type CodexCompletedTurn,
  runCodexTurn,
} from "../ai/codex/operation.ts";
import { CodexProviderError, isRecord } from "../ai/codex/protocol.ts";
import {
  codexAppServerCommand,
  codexChildEnv,
} from "../ai/codex/runtime.ts";
import { readGeneratedImage } from "../ai/codex/image-result.ts";
import { openCodexImageWorkspace } from "../ai/codex/workspace-files.ts";

type Prompts = { system: string; user: string };

export type CodexRuntimeClient = CodexClient & {
  [Symbol.asyncDispose](): Promise<void>;
};

export type CodexRuntimeModelCalls = Readonly<{
  classify(prompts: Prompts): Effect.Effect<unknown, ProviderFailure>;
  route(prompts: Prompts): Effect.Effect<unknown, ProviderFailure>;
  adjust(prompts: Prompts): Effect.Effect<unknown, ProviderFailure>;
  generate(prompts: Prompts): Effect.Effect<AsyncGenerator<string, unknown>, ProviderFailure>;
}>;

export type CodexRuntimeService = Readonly<{
  modelCalls: CodexRuntimeModelCalls;
  generateImageBytes(prompt: string): Effect.Effect<Uint8Array, ProviderFailure>;
}>;

export class CodexRuntime extends Context.Tag("@mnimi/server/CodexRuntime")<
  CodexRuntime,
  CodexRuntimeService
>() {}

type CodexModelCallDependencies = {
  client: CodexClient;
  config: CodexRoleConfig;
  runTurn?: typeof runCodexTurn;
};

function outputSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, {
    io: "input",
    reused: "inline",
    override: ({ jsonSchema }) => {
      if (jsonSchema.type !== "object" || !jsonSchema.properties) return;
      jsonSchema.required = Object.keys(jsonSchema.properties);
      jsonSchema.additionalProperties = false;
    },
  });
}

function completedAgentText(turn: CodexCompletedTurn): string {
  const item = [...turn.items].reverse().find(
    (candidate) => isRecord(candidate) && candidate.type === "agentMessage",
  );
  if (!isRecord(item) || typeof item.text !== "string") {
    throw new CodexProviderError(
      "protocol",
      "Codex returned no completed message",
    );
  }
  return item.text;
}

function completedJson(turn: CodexCompletedTurn): unknown {
  const text = completedAgentText(turn);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Promise operations are retained as the low-level compatibility edge. The
 * Effect service below is the single owner used by both the Layer and the
 * Promise facade.
 */
export function createCodexModelCalls({
  client,
  config,
  runTurn = runCodexTurn,
}: CodexModelCallDependencies): CreationModelCalls {
  const structuredTurn = (
    role: CodexRoleConfig["classify"] | CodexRoleConfig["generate"],
    prompts: Prompts,
    schema: z.ZodType,
  ) =>
    runTurn(client, {
      ...role,
      ...prompts,
      outputSchema: outputSchema(schema),
    }, completedJson);

  return {
    classify(prompts) {
      return structuredTurn(config.classify, prompts, classificationSchema);
    },

    async route(prompts) {
      return unwrapDeckRoutingResponse(
        await structuredTurn(config.classify, prompts, deckRoutingResponseSchema),
      );
    },

    adjust(prompts) {
      return structuredTurn(
        config.generate,
        prompts,
        adjustedCardsOutputSchema,
      );
    },

    async *generate(prompts) {
      const deltas = channel<string>();
      const completion = runTurn(client, {
        ...config.generate,
        ...prompts,
        outputSchema: outputSchema(generatedNoteSchema),
      }, completedJson, (delta) => deltas.push(delta)).then(
        (value) => {
          deltas.close();
          return { ok: true as const, value };
        },
        (error: unknown) => {
          deltas.fail(error);
          return { ok: false as const, error };
        },
      );

      for await (const delta of deltas) yield delta;
      const result = await completion;
      if (!result.ok) throw result.error;
      return result.value;
    },
  };
}

export function createCodexImageGenerator({
  client,
  config,
  runTurn = runCodexTurn,
}: CodexModelCallDependencies): (prompt: string) => Promise<Uint8Array> {
  return async (prompt) => {
    const artifactAnchor = await openCodexImageWorkspace(config.codexHome);
    try {
      return await runTurn(client, {
        ...config.generate,
        system: "",
        user: `$imagegen Create this image: ${prompt}. Photographic, plain background, no text, no letters, no words anywhere in the image. Save the generated image inside the current workspace.`,
      }, (turn, workspace, anchor) =>
        readGeneratedImage(turn, workspace, anchor, artifactAnchor));
    } finally {
      await artifactAnchor.directory.close().catch(() => {});
    }
  };
}

function failureMessage(operation: string, cause: unknown): string {
  if (cause instanceof CodexProviderError) return cause.message;
  return `Codex ${operation} failed`;
}

function providerFailure(operation: string, cause: unknown): ProviderFailure {
  return new ProviderFailure({
    provider: "codex",
    operation,
    message: failureMessage(operation, cause),
    cause,
  });
}

function operation<A>(
  operationName: string,
  work: () => Promise<A>,
): Effect.Effect<A, ProviderFailure> {
  return Effect.tryPromise({
    try: work,
    catch: (cause) => providerFailure(operationName, cause),
  });
}

function mappedGenerator(
  generator: AsyncGenerator<string, unknown>,
  operationName: string,
): AsyncGenerator<string, unknown> {
  return (async function* () {
    try {
      let step = await generator.next();
      while (!step.done) {
        yield step.value;
        step = await generator.next();
      }
      return step.value;
    } catch (cause) {
      throw providerFailure(operationName, cause);
    }
  })();
}

export function makeCodexRuntime({
  client,
  config,
  runTurn,
}: CodexModelCallDependencies): CodexRuntimeService {
  const promiseCalls = createCodexModelCalls({ client, config, runTurn });
  const promiseImageGenerator = createCodexImageGenerator({ client, config, runTurn });

  return {
    modelCalls: {
      classify: (prompts) => operation("codex.classify", () => promiseCalls.classify(prompts)),
      route: (prompts) => operation("codex.route", () => promiseCalls.route(prompts)),
      adjust: (prompts) => operation("codex.adjust", () => promiseCalls.adjust(prompts)),
      generate: (prompts) => operation("codex.generate", async () =>
        mappedGenerator(promiseCalls.generate(prompts), "codex.generate")),
    },
    generateImageBytes: (prompt) => operation(
      "codex.generate-image",
      () => promiseImageGenerator(prompt),
    ),
  };
}

export type CodexRuntimeClientFactory = (
  home: string,
  validate: ConnectionValidator,
) => CodexRuntimeClient;

export type CodexRuntimeLayerDependencies = Readonly<{
  createClient?: CodexRuntimeClientFactory;
  runTurn?: typeof runCodexTurn;
}>;

export type CodexRuntimeConfiguredDependencies = CodexRuntimeLayerDependencies & Readonly<{
  env: NodeJS.ProcessEnv;
}>;

function defaultCreateClient(
  env: NodeJS.ProcessEnv,
): CodexRuntimeClientFactory {
  return (home, validate) => new CodexAppServerClient({
    spawn: () => spawnCodexAppServer(
      codexAppServerCommand(),
      codexChildEnv(home, env),
    ),
    validate,
  });
}

function acquireCodexRuntime(
  config: CodexRoleConfig,
  options: CodexRuntimeConfiguredDependencies,
): Effect.Effect<CodexRuntimeService, ProviderFailure, import("effect/Scope").Scope> {
  const createClient = options.createClient ?? defaultCreateClient(options.env);
  const runTurn = options.runTurn;
  const validate: ConnectionValidator = (connection) =>
    validateCodexStartup(connection, config);

  return Effect.gen(function* () {
    // The finalizer is registered immediately after the low-level client is
    // created. This also covers a connect/validation failure.
    const client = yield* Effect.acquireRelease(
      Effect.try({
        try: () => createClient(config.codexHome, validate),
        catch: (cause) => providerFailure("codex.acquire", cause),
      }),
      (resource, exit) => Effect.promise(async () => {
        try {
          await resource[Symbol.asyncDispose]();
        } catch (error) {
          // Preserve the startup failure if cleanup is part of a failed
          // acquisition. A normal scope close still reports disposal errors.
          if (Exit.isFailure(exit)) return;
          throw error;
        }
      }),
    );

    yield* operation("codex.connect", () => client.connect());
    return makeCodexRuntime({ client, config, runTurn });
  });
}

function roleConfigFromAppConfig(config: AppConfigValue): CodexRoleConfig {
  const codex = config.ai.codex;
  return readCodexRoleConfig({
    CODEX_HOME: codex.codexHome,
    CLASSIFY_MODEL: codex.classifyModel,
    CLASSIFY_EFFORT: codex.classifyEffort,
    GENERATE_MODEL: codex.generateModel,
    GENERATE_EFFORT: codex.generateEffort,
  });
}

export function makeCodexRuntimeLayerFromConfig(
  config: CodexRoleConfig,
  dependencies: CodexRuntimeConfiguredDependencies,
): Layer.Layer<CodexRuntime, ProviderFailure> {
  if (!dependencies.env) {
    throw new Error("Codex runtime environment is required");
  }
  return Layer.scoped(
    CodexRuntime,
    acquireCodexRuntime(config, {
      ...dependencies,
    }),
  );
}

export function makeCodexRuntimeLayer(
  dependencies: CodexRuntimeLayerDependencies = {},
): Layer.Layer<CodexRuntime, ProviderFailure, AppConfig> {
  return Layer.scoped(
    CodexRuntime,
    Effect.gen(function* () {
      const appConfig = yield* AppConfig;
      const config = yield* Effect.try({
        try: () => roleConfigFromAppConfig(appConfig),
        catch: (cause) => providerFailure("codex.config", cause),
      });
      return yield* acquireCodexRuntime(config, {
        ...dependencies,
        env: materializeLegacyEnvironment(appConfig),
      });
    }),
  );
}

export const CodexRuntimeLive: Layer.Layer<CodexRuntime, ProviderFailure, AppConfig> =
  makeCodexRuntimeLayer();

export function unwrapCodexFailure(error: unknown): unknown {
  if (Runtime.isFiberFailure(error)) {
    const cause = error[Runtime.FiberFailureCauseId];
    const failure = Cause.failureOption(cause);
    if (Option.isSome(failure)) return unwrapCodexFailure(failure.value);
    const defect = Cause.dieOption(cause);
    if (Option.isSome(defect)) return unwrapCodexFailure(defect.value);
  }
  if (error instanceof ProviderFailure && error.cause !== undefined) {
    return error.cause;
  }
  return error;
}

type EffectRunner = <A>(effect: Effect.Effect<A, ProviderFailure>) => Promise<A>;

async function* runGenerator(
  run: EffectRunner,
  effect: Effect.Effect<AsyncGenerator<string, unknown>, ProviderFailure>,
): AsyncGenerator<string, unknown> {
  let generator: AsyncGenerator<string, unknown>;
  try {
    generator = await run(effect);
  } catch (error) {
    throw unwrapCodexFailure(error);
  }
  try {
    let step = await generator.next();
    while (!step.done) {
      yield step.value;
      step = await generator.next();
    }
    return step.value;
  } catch (error) {
    throw unwrapCodexFailure(error);
  }
}

export function makeCodexPromiseFacade(
  service: CodexRuntimeService,
  options: Readonly<{
    run?: EffectRunner;
    close?: () => Promise<void>;
  }> = {},
): AiProvider {
  const run = options.run ?? ((effect) => Effect.runPromise(effect));
  let closing: Promise<void> | undefined;
  return {
    modelCalls: {
      classify: async (prompts) => {
        try {
          return await run(service.modelCalls.classify(prompts));
        } catch (error) {
          throw unwrapCodexFailure(error);
        }
      },
      route: async (prompts) => {
        try {
          return await run(service.modelCalls.route(prompts));
        } catch (error) {
          throw unwrapCodexFailure(error);
        }
      },
      adjust: async (prompts) => {
        try {
          return await run(service.modelCalls.adjust(prompts));
        } catch (error) {
          throw unwrapCodexFailure(error);
        }
      },
      generate: (prompts) => runGenerator(run, service.modelCalls.generate(prompts)),
    },
    generateImageBytes: async (prompt) => {
      try {
        return await run(service.generateImageBytes(prompt));
      } catch (error) {
        throw unwrapCodexFailure(error);
      }
    },
    [Symbol.asyncDispose]: () => closing ??= Promise.resolve().then(() => options.close?.()),
  };
}

export function makeCodexManagedRuntime(
  config: CodexRoleConfig,
  dependencies: CodexRuntimeConfiguredDependencies,
): ManagedRuntime.ManagedRuntime<CodexRuntime, ProviderFailure> {
  return ManagedRuntime.make(makeCodexRuntimeLayerFromConfig(config, dependencies));
}
