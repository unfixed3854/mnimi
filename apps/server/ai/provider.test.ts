import { describe, expect, it, vi } from "vitest";
import type { AiProvider } from "./provider-types.ts";
import { createAiProvider } from "./provider.ts";

function fixture() {
  const provider: AiProvider = {
    modelCalls: {
      classify: async () => ({}),
      async *generate() { return {}; },
      route: async () => ({}),
      adjust: async () => ({}),
    },
    generateImageBytes: async () => new Uint8Array(),
    [Symbol.asyncDispose]: async () => {},
  };
  const createOpenRouterProvider = vi.fn(async (
    _options?: { env?: NodeJS.ProcessEnv },
  ) => provider);
  const createCodexProvider = vi.fn(async () => provider);
  const loaders = {
    openrouter: vi.fn(async () => ({ createOpenRouterProvider })),
    codex: vi.fn(async () => ({ createCodexProvider })),
  };
  return { provider, loaders, createCodexProvider, createOpenRouterProvider };
}

describe("atomic AI provider selection", () => {
  it.each([undefined, "openrouter"])("selects OpenRouter for %s without inspecting Codex", async (selected) => {
    const { provider, loaders, createOpenRouterProvider } = fixture();
    const env = { AI_PROVIDER: selected };
    Object.defineProperty(env, "CODEX_HOME", { get() { throw new Error("Codex config inspected"); } });
    expect(await createAiProvider({ env, loaders })).toBe(provider);
    expect(loaders.openrouter).toHaveBeenCalledTimes(1);
    expect(createOpenRouterProvider).toHaveBeenCalledTimes(1);
    expect(createOpenRouterProvider.mock.calls[0]?.[0]?.env).toBe(env);
    expect(loaders.codex).not.toHaveBeenCalled();
  });

  it.each([undefined, "false", "TRUE", "True", "1", "", " true "])("selects Codex with fail-closed registration %s", async (registration) => {
    const { provider, loaders, createCodexProvider } = fixture();
    const env = { AI_PROVIDER: "codex", REGISTRATION_ENABLED: registration };
    // Missing values in an injected environment must not fall back to the host.
    vi.stubEnv("REGISTRATION_ENABLED", "true");
    try {
      expect(await createAiProvider({ env, loaders })).toBe(provider);
      expect(loaders.codex).toHaveBeenCalledTimes(1);
      expect(createCodexProvider).toHaveBeenCalledWith({ env });
      expect(loaders.openrouter).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["", "CODEX", "OpenRouter", "other", " codex"])("rejects %j without loading either provider", async (selected) => {
    const { loaders } = fixture();
    await expect(createAiProvider({ env: { AI_PROVIDER: selected }, loaders })).rejects.toThrow("AI_PROVIDER must be openrouter or codex");
    expect(loaders.codex).not.toHaveBeenCalled();
    expect(loaders.openrouter).not.toHaveBeenCalled();
  });

  it("rejects public registration before importing Codex", async () => {
    const { loaders } = fixture();
    await expect(createAiProvider({ env: { AI_PROVIDER: "codex", REGISTRATION_ENABLED: "true" }, loaders })).rejects.toThrow("Codex provider requires REGISTRATION_ENABLED=false");
    expect(loaders.codex).not.toHaveBeenCalled();
    expect(loaders.openrouter).not.toHaveBeenCalled();
  });

  it("propagates Codex initialization failure without loading OpenRouter", async () => {
    const { loaders, createCodexProvider } = fixture();
    createCodexProvider.mockRejectedValueOnce(new Error("invalid credentials"));
    await expect(createAiProvider({ env: { AI_PROVIDER: "codex", REGISTRATION_ENABLED: "false" }, loaders })).rejects.toThrow("invalid credentials");
    expect(loaders.openrouter).not.toHaveBeenCalled();
  });
});
