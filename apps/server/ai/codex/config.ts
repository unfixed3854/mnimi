import type { CodexAppServerClient } from "./app-server-client.ts";
import { CodexProviderError, isRecord } from "./protocol.ts";
import { assertPrivateCodexCredentials, resolveCodexHome } from "./runtime.ts";

export type CodexRoleConfig = {
  classify: { model: string; effort: string };
  generate: { model: string; effort: string };
  codexHome: string;
};

type RequestClient = Pick<CodexAppServerClient, "request">;
type CatalogModel = {
  model: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
};

const DEFAULTS = {
  classify: { model: "gpt-5.6-luna", effort: "low" },
  generate: { model: "gpt-5.6-sol", effort: "high" },
};

function configuredValue(
  env: NodeJS.ProcessEnv,
  variable: "CLASSIFY_MODEL" | "CLASSIFY_EFFORT" | "GENERATE_MODEL" | "GENERATE_EFFORT",
  fallback: string,
): string {
  const raw = env[variable];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!value) {
    throw new CodexProviderError("model-unavailable", `${variable} must not be empty`);
  }
  return value;
}

export function readCodexRoleConfig(env: NodeJS.ProcessEnv = process.env): CodexRoleConfig {
  return {
    classify: {
      model: configuredValue(env, "CLASSIFY_MODEL", DEFAULTS.classify.model),
      effort: configuredValue(env, "CLASSIFY_EFFORT", DEFAULTS.classify.effort),
    },
    generate: {
      model: configuredValue(env, "GENERATE_MODEL", DEFAULTS.generate.model),
      effort: configuredValue(env, "GENERATE_EFFORT", DEFAULTS.generate.effort),
    },
    codexHome: resolveCodexHome(env),
  };
}

function readCatalogModel(value: unknown): CatalogModel | undefined {
  if (!isRecord(value) || typeof value.model !== "string"
    || !Array.isArray(value.supportedReasoningEfforts)) return undefined;
  const efforts = value.supportedReasoningEfforts.flatMap((effort) => {
    if (!isRecord(effort) || typeof effort.reasoningEffort !== "string") return [];
    return [{ reasoningEffort: effort.reasoningEffort }];
  });
  return { model: value.model, supportedReasoningEfforts: efforts };
}

async function readModels(client: RequestClient): Promise<CatalogModel[]> {
  const models: CatalogModel[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    let response: unknown;
    try {
      response = await client.request("model/list", { cursor, includeHidden: true });
    } catch {
      throw new CodexProviderError("model-unavailable", "Could not read the Codex model catalog");
    }
    if (!isRecord(response) || !Array.isArray(response.data)
      || (response.nextCursor !== null && typeof response.nextCursor !== "string")) {
      throw new CodexProviderError("model-unavailable", "Could not read the Codex model catalog");
    }
    const nextCursor = response.nextCursor;
    if (nextCursor !== null && (!nextCursor || seenCursors.has(nextCursor))) {
      throw new CodexProviderError("model-unavailable", "Could not read the Codex model catalog");
    }
    for (const entry of response.data) {
      const model = readCatalogModel(entry);
      if (model) models.push(model);
    }
    if (nextCursor !== null) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== null);

  return models;
}

function assertConfiguredRole(
  models: CatalogModel[],
  role: { model: string; effort: string },
): void {
  const matchingModels = models.filter((entry) => entry.model === role.model);
  if (!matchingModels.length) {
    throw new CodexProviderError(
      "model-unavailable",
      `Configured Codex model "${role.model}" is unavailable`,
    );
  }
  if (!matchingModels.some((entry) => entry.supportedReasoningEfforts.some(
    (effort) => effort.reasoningEffort === role.effort,
  ))) {
    throw new CodexProviderError(
      "model-unavailable",
      `Configured Codex effort "${role.effort}" is unavailable for model "${role.model}"`,
    );
  }
}

export async function validateCodexStartup(
  client: RequestClient,
  config: CodexRoleConfig,
): Promise<void> {
  try {
    await assertPrivateCodexCredentials(config.codexHome);
  } catch {
    throw new CodexProviderError(
      "unauthenticated",
      "Codex credentials are unavailable; run bun run codex:login",
    );
  }

  let accountResponse: unknown;
  try {
    accountResponse = await client.request("account/read", { refreshToken: true });
  } catch {
    throw new CodexProviderError(
      "unauthenticated",
      "Codex subscription authentication failed; run bun run codex:login",
    );
  }
  if (!isRecord(accountResponse) || !isRecord(accountResponse.account)
    || accountResponse.account.type !== "chatgpt") {
    throw new CodexProviderError(
      "unauthenticated",
      "Codex requires ChatGPT authentication; run bun run codex:login",
    );
  }

  const models = await readModels(client);
  assertConfiguredRole(models, config.classify);
  assertConfiguredRole(models, config.generate);

  let capabilities: unknown;
  try {
    capabilities = await client.request("modelProvider/capabilities/read", {});
  } catch {
    throw new CodexProviderError("image", "Could not verify Codex image generation capability");
  }
  if (!isRecord(capabilities) || capabilities.imageGeneration !== true) {
    throw new CodexProviderError("image", "Codex image generation is unavailable for this account");
  }
}
