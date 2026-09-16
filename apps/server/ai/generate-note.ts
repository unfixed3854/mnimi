import { generationPromiseFacade } from "./generate.ts";

export type {
  GenerationEvent,
  GenerationInput,
  ModelCalls,
  ModelPrompts,
} from "../effect/ai-generation.ts";

/**
 * Temporary compatibility facade. Creation jobs retain the current
 * async-iterable event contract while the durable generation path is migrated.
 */
export const generateNote = generationPromiseFacade.generateNote;
