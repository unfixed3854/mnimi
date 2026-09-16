import { legacyOpenRouterService } from "./openrouter.ts";
import { runOpenRouterPromise } from "../effect/openrouter.ts";

/** Compatibility facade for the image scheduler; remove after it consumes
 * `OpenRouter.generateImageBytes` directly. */
export function generateOpenRouterImageBytes(prompt: string): Promise<Uint8Array> {
  return runOpenRouterPromise(legacyOpenRouterService.generateImageBytes(prompt));
}
