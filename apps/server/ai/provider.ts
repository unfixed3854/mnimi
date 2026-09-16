import type { AiProvider } from "./provider-types.ts";
import { isRegistrationEnabled } from "../registration.ts";

type ProviderLoaders = {
  openrouter(): Promise<{
    createOpenRouterProvider(options?: { env?: NodeJS.ProcessEnv }): Promise<AiProvider>;
  }>;
  codex(): Promise<{
    createCodexProvider(options?: { env?: NodeJS.ProcessEnv }): Promise<AiProvider>;
  }>;
};

const defaultLoaders: ProviderLoaders = {
  openrouter: () => import("./openrouter-provider.ts"),
  codex: () => import("./codex/provider.ts"),
};

export type SelectedAiProvider = "openrouter" | "codex";

/** Shared selection and registration gate for Promise and Effect providers. */
export function selectAiProvider(env: NodeJS.ProcessEnv): SelectedAiProvider {
  const selected = env.AI_PROVIDER ?? "openrouter";
  if (selected === "openrouter") return selected;
  if (selected === "codex") {
    // An injected environment is authoritative even when a value is missing.
    if (isRegistrationEnabled(env.REGISTRATION_ENABLED ?? "false")) {
      throw new Error("Codex provider requires REGISTRATION_ENABLED=false");
    }
    return selected;
  }
  throw new Error("AI_PROVIDER must be openrouter or codex");
}

export async function createAiProvider({
  env = process.env,
  loaders = defaultLoaders,
}: { env?: NodeJS.ProcessEnv; loaders?: ProviderLoaders } = {}): Promise<AiProvider> {
  const selected = selectAiProvider(env);
  if (selected === "openrouter") {
    return await (await loaders.openrouter()).createOpenRouterProvider({ env });
  }
  return await (await loaders.codex()).createCodexProvider({ env });
}
