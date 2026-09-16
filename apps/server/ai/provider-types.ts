import type { CreationModelCalls } from "./model-calls.ts";

export type AiProvider = {
  modelCalls: CreationModelCalls;
  generateImageBytes(prompt: string): Promise<Uint8Array>;
  [Symbol.asyncDispose](): Promise<void>;
};
