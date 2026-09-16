import { getLogger } from "../logging.ts";
import {
  makeOpenRouter,
  makeOpenRouterProvider,
} from "../effect/openrouter.ts";
import type { AiProvider } from "./provider-types.ts";
import { openRouterCalls } from "./model-calls.ts";
import { generateOpenRouterImageBytes } from "./openrouter-image.ts";
import { legacyOpenRouterService } from "./openrouter.ts";

function configFromEnvironment(env: NodeJS.ProcessEnv) {
  return {
    apiKey: env.OPENROUTER_API_KEY,
    classifyModel: env.CLASSIFY_MODEL,
    generateModel: env.GENERATE_MODEL,
    imageModel: env.IMAGE_MODEL,
    classifyEffort: env.CLASSIFY_EFFORT,
    generateEffort: env.GENERATE_EFFORT,
  };
}

/**
 * Compatibility provider factory. The no-argument path deliberately retains
 * the exported-object identities used by existing consumers. Explicit env
 * input captures all values once for provider selection (Task 6).
 */
export async function createOpenRouterProvider(options?: {
  env?: NodeJS.ProcessEnv;
}): Promise<AiProvider> {
  if (options?.env === undefined) {
    let disposed = false;
    return {
      modelCalls: openRouterCalls,
      generateImageBytes: generateOpenRouterImageBytes,
      async [Symbol.asyncDispose]() {
        if (disposed) return;
        disposed = true;
      },
    };
  }

  const service = makeOpenRouter(configFromEnvironment(options.env), {
    logger: getLogger(["mnimi", "ai"]),
  });
  return makeOpenRouterProvider(service);
}

export { legacyOpenRouterService };
