import { getLogger } from "../logging.ts";
import {
  makeOpenRouter,
  makeOpenRouterModelCalls,
} from "../effect/openrouter.ts";
import type { OpenRouterService } from "../effect/openrouter.ts";
import type { ModelCalls, ModelPrompts } from "./generate-note.ts";
import * as legacyOpenRouter from "./openrouter.ts";

export type CreationModelCalls = ModelCalls & {
  route(prompts: ModelPrompts): Promise<unknown>;
  adjust(prompts: ModelPrompts): Promise<unknown>;
};

function fallbackService(): OpenRouterService {
  // This branch only exists for focused legacy tests that replace the old
  // module with a tiny mock. Production uses the one shared dynamic service
  // exported above, preserving its route cache and environment semantics.
  return makeOpenRouter(
    () => ({
      // The legacy unit test replaces the adapter module entirely; give the
      // deterministic service a harmless credential so that mock calls still
      // exercise its request shape without depending on process environment.
      apiKey: process.env.OPENROUTER_API_KEY ?? "test-key",
      classifyModel: legacyOpenRouter.classifyModel(),
      generateModel: legacyOpenRouter.generateModel(),
      imageModel: "black-forest-labs/flux.2-klein-4b",
      classifyEffort: process.env.CLASSIFY_EFFORT,
      generateEffort: process.env.GENERATE_EFFORT,
    }),
    {
      createTextAdapter: (model) => legacyOpenRouter.textAdapter(model),
      logger: getLogger(["mnimi", "ai"]),
    },
  );
}

const service = ("legacyOpenRouterService" in legacyOpenRouter
  ? legacyOpenRouter.legacyOpenRouterService
  : undefined) ?? fallbackService();

/** Compatibility facade for creation jobs; remove when those workers use
 * `OpenRouter` and `AiGeneration` Effects directly. */
export const openRouterCalls: CreationModelCalls = makeOpenRouterModelCalls(service);
