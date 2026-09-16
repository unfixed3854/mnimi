import { getLogger } from "../logging.ts";
import {
  OPENROUTER_DEFAULTS,
  makeOpenRouter,
  type ImageGenerationRoute,
  type OpenRouterConfig,
  type OpenRouterService,
  runOpenRouterPromise,
} from "../effect/openrouter.ts";

/**
 * Legacy direct exports intentionally use a dynamic configuration source:
 * older jobs call them without AppConfig, so their invocation-time environment
 * behaviour remains observable until those jobs migrate.
 */
function legacyConfig(): OpenRouterConfig {
  return {
    apiKey: process.env.OPENROUTER_API_KEY,
    classifyModel: process.env.CLASSIFY_MODEL,
    generateModel: process.env.GENERATE_MODEL,
    imageModel: process.env.IMAGE_MODEL,
    classifyEffort: process.env.CLASSIFY_EFFORT,
    generateEffort: process.env.GENERATE_EFFORT,
  };
}

export const legacyOpenRouterService: OpenRouterService = makeOpenRouter(
  legacyConfig,
  { logger: getLogger(["mnimi", "ai"]) },
);

export const classifyModel = () => legacyOpenRouterService.classifyModel();
export const generateModel = () => legacyOpenRouterService.generateModel();
export const imageModel = () => legacyOpenRouterService.imageModel();
export const classifyReasoning = () => legacyOpenRouterService.classifyReasoning();
export const generateReasoning = () => legacyOpenRouterService.generateReasoning();

export const textAdapter = (model: string) =>
  legacyOpenRouterService.textAdapter(model);

export const imagesClient = () => legacyOpenRouterService.imagesClient();
export const imageChatClient = () => legacyOpenRouterService.imageChatClient();

export function imageGenerationRoute(model: string): Promise<ImageGenerationRoute> {
  return runOpenRouterPromise(legacyOpenRouterService.imageGenerationRoute(model));
}

export { OPENROUTER_DEFAULTS };
export type { ImageGenerationRoute };
