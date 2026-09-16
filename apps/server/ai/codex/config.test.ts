import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./app-server-client.ts";
import {
  readCodexRoleConfig,
  validateCodexStartup,
  type CodexRoleConfig,
} from "./config.ts";
import { CodexProviderError } from "./protocol.ts";

type RequestClient = Pick<CodexAppServerClient, "request">;
type Model = {
  model: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
};

const configured: CodexRoleConfig = {
  classify: { model: "classify-model", effort: "classify-effort" },
  generate: { model: "generate-model", effort: "generate-effort" },
  codexHome: "",
};

function model(modelName: string, effort: string): Model {
  return {
    model: modelName,
    supportedReasoningEfforts: [{ reasoningEffort: effort, description: "Available" }],
  };
}

function validModelPages() {
  return [
    { data: [model("generate-model", "generate-effort")], nextCursor: "page-two" },
    { data: [model("classify-model", "classify-effort")], nextCursor: null },
  ];
}

function fakeClient(
  respond: (method: string, params: unknown) => unknown | Promise<unknown>,
): { client: RequestClient; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    client: {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push([method, params]);
        return await respond(method, params) as T;
      },
    },
    calls,
  };
}

async function providerError(promise: Promise<void>, category: CodexProviderError["category"]) {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(CodexProviderError);
  expect(error).toMatchObject({ category });
  return error as CodexProviderError;
}

describe("Codex startup configuration", () => {
  let fixturePath: string;
  let codexHome: string;

  beforeEach(async () => {
    fixturePath = await mkdtemp(join(tmpdir(), "mnimi-codex-config-"));
    codexHome = join(fixturePath, "codex");
    await mkdir(codexHome, { mode: 0o700 });
    const auth = join(codexHome, "auth.json");
    await writeFile(auth, "{}", { mode: 0o600 });
    await chmod(codexHome, 0o700);
    await chmod(auth, 0o600);
  });

  afterEach(async () => {
    await rm(fixturePath, { recursive: true, force: true });
  });

  it("uses the approved role defaults when the environment has no role variables", () => {
    expect(readCodexRoleConfig({})).toEqual({
      classify: { model: "gpt-5.6-luna", effort: "low" },
      generate: { model: "gpt-5.6-sol", effort: "high" },
      codexHome: expect.stringMatching(/\/data\/codex$/),
    });
  });

  it("trims and preserves explicit role model and effort overrides", () => {
    expect(readCodexRoleConfig({
      CLASSIFY_MODEL: "  classify-custom  ",
      CLASSIFY_EFFORT: "  classify-effort  ",
      GENERATE_MODEL: "  generate-custom  ",
      GENERATE_EFFORT: "  generate-effort  ",
      CODEX_HOME: "/private/codex",
    })).toEqual({
      classify: { model: "classify-custom", effort: "classify-effort" },
      generate: { model: "generate-custom", effort: "generate-effort" },
      codexHome: "/private/codex",
    });
  });

  it.each([
    ["CLASSIFY_MODEL"],
    ["CLASSIFY_EFFORT"],
    ["GENERATE_MODEL"],
    ["GENERATE_EFFORT"],
  ])("rejects an explicitly blank %s override", (variable) => {
    const error = (() => {
      try {
        readCodexRoleConfig({ [variable]: "  \t " });
      } catch (reason) {
        return reason;
      }
      throw new Error("expected readCodexRoleConfig to reject a blank override");
    })();
    expect(error).toBeInstanceOf(CodexProviderError);
    expect(error).toMatchObject({ category: "model-unavailable" });
    expect(error).toHaveProperty("message", expect.stringContaining(variable));
  });

  it("validates the account, all paged models, efforts, and image capability in order", async () => {
    const pages = validModelPages();
    const { client, calls } = fakeClient((method) => {
      if (method === "account/read") return { account: { type: "chatgpt", email: "operator@example.com" } };
      if (method === "model/list") return pages.shift();
      if (method === "modelProvider/capabilities/read") {
        return { imageGeneration: true, namespaceTools: false, webSearch: false };
      }
      throw new Error("unexpected request");
    });

    await expect(validateCodexStartup(client, { ...configured, codexHome })).resolves.toBeUndefined();

    expect(calls).toEqual([
      ["account/read", { refreshToken: true }],
      ["model/list", { cursor: null, includeHidden: true }],
      ["model/list", { cursor: "page-two", includeHidden: true }],
      ["modelProvider/capabilities/read", {}],
    ]);
  });

  it.each([
    [
      "empty",
      [{ data: [model("catalog-secret-empty", "secret-effort")], nextCursor: "" }],
      [["model/list", { cursor: null, includeHidden: true }]],
      "catalog-secret-empty",
    ],
    [
      "repeated",
      [
        { data: [model("classify-model", "classify-effort")], nextCursor: "cursor-secret-repeat" },
        { data: [model("generate-model", "generate-effort")], nextCursor: "cursor-secret-repeat" },
      ],
      [
        ["model/list", { cursor: null, includeHidden: true }],
        ["model/list", { cursor: "cursor-secret-repeat", includeHidden: true }],
      ],
      "cursor-secret-repeat",
    ],
  ])("rejects a %s model cursor without continuing pagination", async (_kind, pages, expectedModelCalls, secret) => {
    const { client, calls } = fakeClient((method) => {
      if (method === "account/read") return { account: { type: "chatgpt", email: "operator@example.com" } };
      if (method === "model/list") return pages.shift();
      throw new Error("requests after invalid cursor are not allowed");
    });

    const error = await providerError(
      validateCodexStartup(client, { ...configured, codexHome }),
      "model-unavailable",
    );

    expect(error.message).not.toContain(secret);
    expect(calls.filter(([method]) => method === "model/list")).toEqual(expectedModelCalls);
    expect(calls.at(-1)?.[0]).toBe("model/list");
  });

  it.each([
    ["missing account", null],
    ["API-key account", { type: "apiKey", email: "operator@example.com" }],
  ])("rejects a %s with a sanitized login remedy", async (_name, account) => {
    const { client, calls } = fakeClient((method) => {
      if (method === "account/read") return { account };
      throw new Error("requests after failed authentication are not allowed");
    });

    const error = await providerError(
      validateCodexStartup(client, { ...configured, codexHome }),
      "unauthenticated",
    );

    expect(error.message).toContain("bun run codex:login");
    expect(error.message).not.toContain("operator@example.com");
    expect(calls).toEqual([["account/read", { refreshToken: true }]]);
  });

  it("rejects a missing configured model without exposing catalog models", async () => {
    const { client } = fakeClient((method) => {
      if (method === "account/read") return { account: { type: "chatgpt", email: "operator@example.com" } };
      if (method === "model/list") return { data: [model("catalog-secret-model", "catalog-secret-effort")], nextCursor: null };
      throw new Error("requests after failed model validation are not allowed");
    });

    const error = await providerError(
      validateCodexStartup(client, { ...configured, codexHome }),
      "model-unavailable",
    );

    expect(error.message).toContain("classify-model");
    expect(error.message).not.toMatch(/catalog-secret|operator@example\.com/);
  });

  it("rejects a configured effort absent from its exact model", async () => {
    const { client } = fakeClient((method) => {
      if (method === "account/read") return { account: { type: "chatgpt", email: "operator@example.com" } };
      if (method === "model/list") {
        return {
          data: [model("classify-model", "other-effort"), model("generate-model", "generate-effort")],
          nextCursor: null,
        };
      }
      throw new Error("requests after failed effort validation are not allowed");
    });

    const error = await providerError(
      validateCodexStartup(client, { ...configured, codexHome }),
      "model-unavailable",
    );

    expect(error.message).toContain("classify-model");
    expect(error.message).toContain("classify-effort");
    expect(error.message).not.toMatch(/other-effort|operator@example\.com/);
  });

  it("rejects unavailable image generation after validating configured models", async () => {
    const pages = validModelPages();
    const { client, calls } = fakeClient((method) => {
      if (method === "account/read") return { account: { type: "chatgpt", email: "operator@example.com" } };
      if (method === "model/list") return pages.shift();
      if (method === "modelProvider/capabilities/read") {
        return { imageGeneration: false, namespaceTools: false, webSearch: false };
      }
      throw new Error("unexpected request");
    });

    const error = await providerError(
      validateCodexStartup(client, { ...configured, codexHome }),
      "image",
    );

    expect(error.message).not.toContain("operator@example.com");
    expect(calls.at(-1)).toEqual(["modelProvider/capabilities/read", {}]);
  });
});
