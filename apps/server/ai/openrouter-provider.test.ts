import { describe, expect, it } from "vitest";
import { openRouterCalls } from "./model-calls.ts";
import { generateOpenRouterImageBytes } from "./openrouter-image.ts";
import { createOpenRouterProvider } from "./openrouter-provider.ts";

describe("createOpenRouterProvider", () => {
  it("supports ECMAScript async disposal", async () => {
    const provider = await createOpenRouterProvider();
    expect(provider[Symbol.asyncDispose]).toBeTypeOf("function");
    await provider[Symbol.asyncDispose]();
  });

  it("returns the existing text and image implementation as one bundle", async () => {
    const provider = await createOpenRouterProvider();

    expect(provider.modelCalls).toBe(openRouterCalls);
    expect(provider.generateImageBytes).toBe(generateOpenRouterImageBytes);
    await expect(provider[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
