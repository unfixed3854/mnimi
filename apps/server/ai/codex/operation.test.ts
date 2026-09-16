import { access, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { AppServerSubscription } from "./app-server-client.ts";
import { CodexProviderError, type AppServerNotification } from "./protocol.ts";
import { runCodexTurn } from "./operation.ts";
import { readGeneratedImage } from "./image-result.ts";

const request = { model: "gpt-5.6-luna", effort: "low", system: "system prompt", user: "user prompt", outputSchema: { type: "object" } };

class FakeClient {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  subscriptions = new Set<AppServerSubscription>();
  tracked = new Set<string>();
  order: string[] = [];
  onStart?: (threadId: string) => unknown | Promise<unknown>;
  onThread?: () => unknown;
  #threadCount = 0;
  async connect() { return this; }
  async unsubscribeThread(threadId: string) { await this.request("thread/unsubscribe", { threadId }); }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params: params as Record<string, unknown> });
    this.order.push(method);
    if (method === "thread/unsubscribe") return {} as T;
    if (method === "thread/start") {
      return (this.onThread ? this.onThread() : { thread: { id: `thread-${++this.#threadCount}` } }) as T;
    }
    const threadId = (params as { threadId: string }).threadId;
    return (this.onStart ? await this.onStart(threadId) : { turn: { id: threadId.replace("thread", "turn") } }) as T;
  }

  subscribe(handlers: AppServerSubscription) {
    this.order.push("subscribe");
    this.subscriptions.add(handlers);
    return () => { this.order.push("unsubscribe"); this.subscriptions.delete(handlers); };
  }

  trackTurn(threadId: string, turnId: string) {
    this.order.push("track");
    this.tracked.add(`${threadId}/${turnId}`);
    return () => { this.order.push("untrack"); this.tracked.delete(`${threadId}/${turnId}`); };
  }

  // Deliberately deliver everything: the operation must verify both identifiers
  // even if a client lacks or fails transport-level filtering.
  emit(method: string, params: unknown) {
    const event: AppServerNotification = { method, params };
    for (const handler of this.subscriptions) handler.notification(event);
  }

  complete(threadId = "thread-1", turnId = "turn-1", extra = {}) {
    this.emit("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [], ...extra } });
  }

  get workspaces() { return this.calls.filter((call) => call.method === "thread/start").map((call) => call.params.cwd as string); }
}

async function started(client: FakeClient, count = 1) {
  await vi.waitFor(() => expect(client.tracked.size).toBe(count));
}

async function removed(client: FakeClient) {
  for (const workspace of client.workspaces) await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  expect(client.subscriptions.size).toBe(0);
  expect(client.tracked.size).toBe(0);
}

describe("runCodexTurn", () => {
  it("unsubscribes the server thread only after the successful consumer finishes", async () => {
    const client = new FakeClient();
    let finish!: () => void;
    const consuming = new Promise<void>((resolve) => { finish = resolve; });
    let entered = false;
    const result = runCodexTurn(client, request, async () => { entered = true; await consuming; return "ok"; });
    await started(client);
    client.complete();
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(client.calls.filter((call) => call.method === "thread/unsubscribe")).toEqual([]);
    await expect(access(client.workspaces[0]!)).resolves.toBeUndefined();
    finish();
    expect(await result).toBe("ok");
    expect(client.calls.at(-1)).toEqual({ method: "thread/unsubscribe", params: { threadId: "thread-1" } });
    await removed(client);
  });

  it.each(["turn/start", "turn/completed", "consume"])("unsubscribes a created thread after %s fails", async (failureAt) => {
    const client = new FakeClient();
    const failure = new CodexProviderError("connection", "Expected failure");
    if (failureAt === "turn/start") client.onStart = () => { throw failure; };
    const result = runCodexTurn(client, request, () => { throw failure; }).catch((error: unknown) => error);
    if (failureAt !== "turn/start") {
      await started(client);
      client.complete("thread-1", "turn-1", failureAt === "turn/completed"
        ? { status: "failed", error: { codexErrorInfo: "unauthorized" } } : {});
    }
    expect(await result).toBeInstanceOf(CodexProviderError);
    expect(client.calls.at(-1)).toEqual({ method: "thread/unsubscribe", params: { threadId: "thread-1" } });
    await removed(client);
  });

  it("anchors image reads before generation can replace the workspace root", async () => {
    const external = await mkdtemp(join(tmpdir(), "mnimi-codex-outside-"));
    const client = new FakeClient();
    let workspace = "", moved = "";
    let bytes: Uint8Array | undefined;
    try {
      await writeFile(join(external, "image.png"), new Uint8Array([83, 69, 67, 82, 69, 84]));
      const result = runCodexTurn(client, request, async (turn, directory, anchor) => {
        bytes = await readGeneratedImage(turn, directory, anchor);
      }).catch((error: unknown) => error);
      await started(client);
      workspace = client.workspaces[0]!;
      moved = `${workspace}-original`;
      await writeFile(join(workspace, "image.png"), new Uint8Array([1, 2, 3]));
      await rename(workspace, moved);
      await symlink(external, workspace, "dir");
      client.complete("thread-1", "turn-1", { items: [{
        type: "imageGeneration", status: "completed", failure: null, savedPath: "image.png",
      }] });
      expect(await result).toMatchObject({ category: "sandbox" });
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      if (workspace) await rm(workspace, { force: true });
      if (moved) await rm(moved, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("uses an ephemeral restricted workspace and consumes files before removing it", async () => {
    const client = new FakeClient();
    const result = runCodexTurn(client, request, async (turn, workspace) => {
      expect(turn).toEqual({ id: "turn-1", status: "completed", items: [] });
      await writeFile(join(workspace, "image.bin"), "bytes");
      return readFile(join(workspace, "image.bin"), "utf8");
    });
    await started(client);
    const workspace = client.workspaces[0]!;
    expect(dirname(workspace)).toBe(tmpdir());
    expect(workspace).toMatch(/mnimi-codex-[^/]+$/);
    expect(client.calls[0]).toEqual({ method: "thread/start", params: {
      model: "gpt-5.6-luna", cwd: workspace, developerInstructions: "system prompt",
      ephemeral: true, approvalPolicy: "never", permissions: "mnimi-generation",
      runtimeWorkspaceRoots: [workspace], allowProviderModelFallback: false, serviceName: "mnimi",
    } });
    expect(client.calls[0]!.params).not.toHaveProperty("sandbox");
    expect(client.calls[1]).toEqual({ method: "turn/start", params: {
      threadId: "thread-1", input: [{ type: "text", text: "user prompt" }], effort: "low", outputSchema: { type: "object" },
    } });
    expect([...client.subscriptions][0]!.threadId).toBe("thread-1");
    expect(client.order.slice(0, 4)).toEqual(["thread/start", "subscribe", "turn/start", "track"]);
    client.complete();
    await expect(result).resolves.toBe("bytes");
    await removed(client);
    expect(client.order.slice(-2)).toEqual(["unsubscribe", "untrack"]);
  });

  it("isolates interleaved deltas, errors, reroutes, and completion by both thread and turn", async () => {
    const client = new FakeClient();
    const deltasA: string[] = [], deltasB: string[] = [];
    const a = runCodexTurn(client, request, (turn) => turn.id, (delta) => deltasA.push(delta));
    await started(client);
    const b = runCodexTurn(client, request, (turn) => turn.id, (delta) => deltasB.push(delta));
    await started(client, 2);
    for (const [threadId, turnId] of [["thread-1", "turn-2"], ["thread-2", "turn-1"], ["other", "turn-1"]]) {
      client.emit("item/agentMessage/delta", { threadId, turnId, delta: "wrong" });
      client.emit("error", { threadId, turnId, willRetry: false, error: { codexErrorInfo: "unauthorized" } });
      client.emit("model/rerouted", { threadId, turnId, toModel: "wrong-model" });
      client.complete(threadId, turnId);
    }
    client.emit("item/agentMessage/delta", { threadId: "thread-2", turnId: "turn-2", delta: "B" });
    client.emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "A" });
    client.complete("thread-2", "turn-2");
    client.complete();
    await expect(Promise.all([a, b])).resolves.toEqual(["turn-1", "turn-2"]);
    expect(deltasA).toEqual(["A"]);
    expect(deltasB).toEqual(["B"]);
    expect(new Set(client.workspaces).size).toBe(2);
    await removed(client);
  });

  it("queues notifications received before turn/start responds and ignores late events", async () => {
    const client = new FakeClient();
    client.onStart = () => {
      client.emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "other", delta: "wrong" });
      client.emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "early" });
      client.complete();
      client.emit("model/rerouted", { threadId: "thread-1", turnId: "turn-1", toModel: "late" });
      client.emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "late" });
      return { turn: { id: "turn-1" } };
    };
    const deltas: string[] = [];
    await expect(runCodexTurn(client, request, (turn) => turn.id, (delta) => deltas.push(delta))).resolves.toBe("turn-1");
    expect(deltas).toEqual(["early"]);
    await removed(client);
  });

  it.each([
    ["usageLimitExceeded", "usage-limit"], ["unauthorized", "unauthenticated"],
    ["sandboxError", "sandbox"], ["contextWindowExceeded", "protocol"], ["unknown", "protocol"],
    [{ httpConnectionFailed: { httpStatusCode: 403 } }, "connection"],
    [{ responseStreamConnectionFailed: { httpStatusCode: 500 } }, "connection"],
    [{ responseStreamDisconnected: { httpStatusCode: null } }, "connection"],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 500 } }, "connection"],
  ])("maps failed completed turn error %j to %s without exposing provider content", async (codexErrorInfo, category) => {
    const client = new FakeClient();
    client.onStart = () => {
      client.complete("thread-1", "turn-1", { status: "failed", error: { codexErrorInfo, message: "SECRET prompt /sensitive/path", additionalDetails: "SECRET" } });
      return { turn: { id: "turn-1" } };
    };
    const error = await runCodexTurn(client, request, () => { throw new Error("must not consume"); }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CodexProviderError);
    expect(error).toMatchObject({ category });
    expect(String(error)).not.toMatch(/SECRET|sensitive/);
    await removed(client);
  });

  it.each(["error", "model/rerouted", "interrupted", "disconnect"])("rejects and cleans up on %s", async (event) => {
    const client = new FakeClient();
    const consumed = vi.fn();
    const result = runCodexTurn(client, request, consumed).catch((error: unknown) => error);
    await started(client);
    const ids = { threadId: "thread-1", turnId: "turn-1" };
    if (event === "error") client.emit("error", { ...ids, willRetry: false, error: { codexErrorInfo: "usageLimitExceeded", message: "SECRET" } });
    if (event === "model/rerouted") client.emit(event, { ...ids, toModel: "SECRET" });
    if (event === "interrupted") client.complete("thread-1", "turn-1", { status: "interrupted", error: null });
    if (event === "disconnect") for (const handler of client.subscriptions) handler.disconnected(new CodexProviderError("process-exit", "Codex exited"));
    const error = await result;
    expect(error).toMatchObject({ category: { error: "usage-limit", "model/rerouted": "model-rerouted", interrupted: "protocol", disconnect: "process-exit" }[event] });
    expect(String(error)).not.toContain("SECRET");
    expect(consumed).not.toHaveBeenCalled();
    await removed(client);
  });

  it("waits through retryable errors", async () => {
    const client = new FakeClient();
    const result = runCodexTurn(client, request, (turn) => turn.id);
    await started(client);
    client.emit("error", { threadId: "thread-1", turnId: "turn-1", willRetry: true, error: { codexErrorInfo: "usageLimitExceeded" } });
    client.complete();
    await expect(result).resolves.toBe("turn-1");
    await removed(client);
  });

  it.each(["consume", "delta"])("cleans up when the %s consumer throws", async (callback) => {
    const client = new FakeClient();
    const failure = new Error("consumer failed");
    const result = runCodexTurn(client, request, () => { if (callback === "consume") throw failure; }, () => { throw failure; }).catch((error: unknown) => error);
    await started(client);
    if (callback === "delta") client.emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "text" });
    else client.complete();
    expect(await result).toBe(failure);
    await removed(client);
  });

  it.each(["thread failure", "thread malformed", "turn failure", "turn malformed"])("cleans up after partial setup: %s", async (mode) => {
    const client = new FakeClient();
    const failure = new CodexProviderError("connection", "Codex unavailable");
    if (mode === "thread failure") client.onThread = () => { throw failure; };
    if (mode === "thread malformed") client.onThread = () => ({ thread: { id: "" } });
    if (mode === "turn failure") client.onStart = () => { throw failure; };
    if (mode === "turn malformed") client.onStart = () => ({ turn: null });
    await expect(runCodexTurn(client, request, () => {})).rejects.toBeInstanceOf(CodexProviderError);
    await removed(client);
  });

  it("rejects disconnect while waiting for turn/start without waiting for its response", async () => {
    const client = new FakeClient();
    client.onStart = () => new Promise(() => {});
    const result = runCodexTurn(client, request, () => {}).catch((error: unknown) => error);
    await vi.waitFor(() => expect(client.calls.length).toBe(2));
    for (const handler of client.subscriptions) handler.disconnected(new CodexProviderError("shutdown", "Codex client is closed"));
    expect(await result).toMatchObject({ category: "shutdown" });
    await removed(client);
  });

  it("ignores provider paths when removing the workspace", async () => {
    const external = await mkdtemp(join(tmpdir(), "mnimi-operation-test-"));
    try {
      await writeFile(join(external, "keep"), "untouched");
      const client = new FakeClient();
      const result = runCodexTurn(client, request, () => "ok");
      await started(client);
      client.complete("thread-1", "turn-1", { cwd: external, workspace: external, items: [{ type: "imageGeneration", result: external }] });
      await expect(result).resolves.toBe("ok");
      expect(await readFile(join(external, "keep"), "utf8")).toBe("untouched");
      await removed(client);
    } finally { await rm(external, { recursive: true, force: true }); }
  });

  it("refuses an ordinary directory moved onto the generated workspace path", async () => {
    const replacement = await mkdtemp(join(tmpdir(), "mnimi-codex-test-"));
    const client = new FakeClient();
    let workspace = "", moved = "";
    try {
      await writeFile(join(replacement, "keep"), "unrelated replacement");
      const result = runCodexTurn(client, request, async (_turn, directory) => {
        workspace = directory;
        moved = `${directory}-original`;
        await writeFile(join(directory, "original"), "original workspace");
        await rename(directory, moved);
        await rename(replacement, directory);
      });
      await started(client);
      client.complete();
      await expect(result).rejects.toMatchObject({ category: "sandbox" });
      expect(await readFile(join(workspace, "keep"), "utf8")).toBe("unrelated replacement");
      expect(await readFile(join(moved, "original"), "utf8")).toBe("original workspace");
      expect(client.subscriptions.size).toBe(0);
      expect(client.tracked.size).toBe(0);
    } finally {
      if (workspace) await rm(workspace, { recursive: true, force: true });
      if (moved) await rm(moved, { recursive: true, force: true });
      await rm(replacement, { recursive: true, force: true });
    }
  });

  it("refuses a generated path replaced by a symlink even to another temp directory", async () => {
    const external = await mkdtemp(join(tmpdir(), "mnimi-codex-test-"));
    const client = new FakeClient();
    let workspace = "", moved = "";
    try {
      await writeFile(join(external, "keep"), "untouched");
      const result = runCodexTurn(client, request, async (_turn, directory) => {
        workspace = directory;
        moved = `${directory}-original`;
        await rename(directory, moved);
        await symlink(external, directory, "dir");
      });
      await started(client);
      client.complete();
      await expect(result).rejects.toMatchObject({ category: "sandbox" });
      expect(await readFile(join(external, "keep"), "utf8")).toBe("untouched");
      await expect(access(moved)).resolves.toBeUndefined();
      expect(client.subscriptions.size).toBe(0);
      expect(client.tracked.size).toBe(0);
    } finally {
      if (workspace) await rm(workspace, { force: true });
      if (moved) await rm(moved, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
});
