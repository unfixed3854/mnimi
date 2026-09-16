import type { z } from "zod";
import type { PartialCard } from "./schemas.ts";
import {
  makeAiGeneration,
  makeGenerationPromiseFacade,
  type StreamProgress,
} from "../effect/ai-generation.ts";

/**
 * Temporary compatibility facade. Generation jobs still consume these
 * Promise/async-generator exports; they are deliberately kept until those
 * jobs migrate to `AiGeneration`.
 */
export const generationPromiseFacade = makeGenerationPromiseFacade(
  makeAiGeneration(),
);

export type { StreamProgress };

export function parseWithRetry<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null) => Promise<unknown>,
): Promise<T> {
  return generationPromiseFacade.parseWithRetry(schema, attempt);
}

export function streamWithRetry<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null) => AsyncGenerator<string, unknown>,
): AsyncGenerator<StreamProgress, T> {
  return generationPromiseFacade.streamWithRetry(schema, attempt);
}

export function projectCards(parsed: unknown): PartialCard[] {
  return generationPromiseFacade.projectCards(parsed);
}
