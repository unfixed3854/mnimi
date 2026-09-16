import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiProvider } from "../provider-types.ts";
import { CodexAppServerClient } from "./app-server-client.ts";
import { createCodexProvider } from "./provider.ts";
import { FakeAppServerProcess } from "./test-process.ts";

let home: string;
let provider: AiProvider | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mnimi-reconnect-"));
  await writeFile(join(home, "auth.json"), "{}", { mode: 0o600 });
});
afterEach(async () => {
  await provider?.[Symbol.asyncDispose]();
  provider = undefined;
  await rm(home, { recursive: true, force: true });
});

function server(options: { account?: unknown; models?: boolean; images?: boolean; complete?: boolean } = {}) {
  const fake = new FakeAppServerProcess();
  const write = fake.write.bind(fake);
  fake.write = (line) => {
    write(line);
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    let result: unknown = {};
    if (method === "account/read") result = { account: options.account === undefined
      ? { type: "chatgpt", email: "offline@example.com", planType: "plus" } : options.account };
    if (method === "model/list") result = { nextCursor: null, data: options.models === false ? [] : [
      { model: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }] },
      { model: "gpt-5.6-sol", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Thorough" }] },
    ] };
    if (method === "modelProvider/capabilities/read") result = { imageGeneration: options.images !== false, namespaceTools: false, webSearch: false };
    if (method === "thread/start") result = { thread: { id: "thread-1" } };
    if (method === "turn/start") result = { turn: { id: "turn-1" } };
    queueMicrotask(() => {
      fake.respond(id, result);
      if (method === "turn/start" && options.complete) fake.notify("turn/completed", {
        threadId: params.threadId, turn: { id: "turn-1", status: "completed", items: [{
          type: "agentMessage", text: '{"domain":"concept","language":null,"partOfSpeech":null}',
        }] },
      });
    });
  };
  return fake;
}

it.each([
  ["missing credential cache", {}, true, "unauthenticated"],
  ["missing account", { account: null }, false, "unauthenticated"],
  ["API-key account", { account: { type: "apiKey" } }, false, "unauthenticated"],
  ["unavailable models", { models: false }, false, "model-unavailable"],
  ["missing image capability", { images: false }, false, "image"],
] as const)("gates a replacement with %s without replaying the interrupted operation", async (_name, replacementOptions, removeCache, category) => {
  const first = server();
  const second = server({ ...replacementOptions, complete: true });
  const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  provider = await createCodexProvider({ env: { CODEX_HOME: home },
    createClient: (_home, validate) => new CodexAppServerClient({ spawn, validate }),
  });
  const interrupted = provider.modelCalls.classify({ system: "s", user: "first" }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(first.outbound().some((line) => line.method === "turn/start")).toBe(true));
  first.exit(1);
  expect(await interrupted).toMatchObject({ category: "process-exit" });
  expect(spawn).toHaveBeenCalledTimes(1); // Dead-thread cleanup cannot restart.
  expect(first.outbound().filter((line) => line.method === "thread/unsubscribe")).toEqual([]);
  if (removeCache) await rm(join(home, "auth.json"));
  const next = await Promise.all(["next", "concurrent"].map((user) =>
    provider!.modelCalls.classify({ system: "s", user }).catch((error: unknown) => error)));
  for (const error of next) {
    expect(error).toMatchObject({ category });
    expect(String(error)).not.toMatch(/offline@example|mnimi-reconnect/);
  }
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(second.outbound().filter((line) => ["thread/start", "turn/start", "thread/unsubscribe"].includes(line.method as string))).toEqual([]);
  expect(first.outbound().filter((line) => line.method === "thread/start")).toHaveLength(1);
});

it("shares the full replacement gate before admitting new operations", async () => {
  const first = server();
  const second = server({ complete: true });
  const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  provider = await createCodexProvider({ env: { CODEX_HOME: home },
    createClient: (_home, validate) => new CodexAppServerClient({ spawn, validate }),
  });
  first.exit(1);
  await Promise.resolve();
  expect(await provider.modelCalls.classify({ system: "s", user: "next" })).toMatchObject({ domain: "concept" });
  expect(second.outbound().map((line) => line.method).slice(0, 6)).toEqual([
    "initialize", "initialized", "account/read", "model/list", "modelProvider/capabilities/read", "thread/start",
  ]);
});
