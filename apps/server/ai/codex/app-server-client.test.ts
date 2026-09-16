import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, spawnCodexAppServer } from "./app-server-client.ts";
import { CodexProviderError, type AppServerProcess } from "./protocol.ts";

import { FakeAppServerProcess } from "./test-process.ts";

// Drain only promise/stream microtasks; no process, credential, network or wall-clock waits.
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const clients: CodexAppServerClient[] = [];
function create() {
  const fake = new FakeAppServerProcess();
  const spawn = vi.fn(() => fake);
  const client = new CodexAppServerClient({ spawn });
  clients.push(client);
  return { fake, spawn, client };
}
async function initialized() {
  const context = create();
  const ready = context.client.request("ready", {});
  await flush();
  context.fake.respond(1, {});
  await flush();
  context.fake.respond(2, {});
  await ready;
  return context;
}
afterEach(async () => {
  const closing = Promise.all(clients.splice(0).map((client) => client[Symbol.asyncDispose]()));
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  await closing;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Codex JSONL transport", () => {
  it("keeps client implementation state as true private fields", () => {
    const { client } = create();
    expect(Object.getOwnPropertyNames(client)).toEqual([]);
  });

  it("shares one handshake and sends initialized before concurrent requests", async () => {
    const { client, fake, spawn } = create();
    const first = client.request("one", { prompt: "private" });
    const second = client.request("two", {});
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fake.outbound()).toEqual([{
      id: 1, method: "initialize", params: {
        clientInfo: { name: "mnimi", title: "mnimi", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    }]);
    fake.respond(1, {});
    await flush();
    expect(fake.outbound()[1]).toEqual({ method: "initialized", params: {} });
    expect(fake.outbound().slice(2).map((line) => line.method)).toEqual(["one", "two"]);
    fake.respond(3, "second");
    await expect(second).resolves.toBe("second");
    fake.respond(2, "first");
    await expect(first).resolves.toBe("first");
  });

  it("buffers a split response until its newline and decodes split UTF-8", async () => {
    const { client, fake } = await initialized();
    const result = client.request("read", {});
    const resolved = vi.fn();
    void result.then(resolved);
    await flush();
    fake.emitStdout('{"id":3,"result":"hello');
    await flush();
    expect(resolved).not.toHaveBeenCalled();
    const ending = new TextEncoder().encode(' 🌍"}');
    fake.emitStdoutBytes(ending.slice(0, 3));
    fake.emitStdoutBytes(ending.slice(3));
    await flush();
    expect(resolved).not.toHaveBeenCalled();
    fake.emitStdout("\n");
    await expect(result).resolves.toBe("hello 🌍");
  });

  it("dispatches multiple responses from one chunk", async () => {
    const { client, fake } = await initialized();
    const first = client.request("one", {});
    const second = client.request("two", {});
    await flush();
    fake.emitStdout('\n{"id":4,"result":"two"}\n{"id":3,"result":"one"}\n');
    await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"]);
  });

  it("isolates thread/turn subscriptions including nested completion IDs and supports unsubscribe", async () => {
    const { client, fake } = await initialized();
    const first = vi.fn();
    const second = vi.fn();
    const disconnected = vi.fn();
    const unsubscribe = client.subscribe({ threadId: "a", turnId: "1", notification: first, disconnected });
    client.subscribe({ threadId: "b", turnId: "2", notification: second, disconnected });
    fake.notify("item/agentMessage/delta", { threadId: "a", turnId: "1", delta: "one" });
    fake.notify("item/agentMessage/delta", { threadId: "a", turnId: "2", delta: "wrong turn" });
    fake.notify("turn/completed", { threadId: "b", turn: { id: "2", status: "completed" } });
    fake.notify("future/unknown", { threadId: "a", turnId: "1" });
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(disconnected).not.toHaveBeenCalled();
    unsubscribe();
    fake.notify("item/agentMessage/delta", { threadId: "a", turnId: "1", delta: "later" });
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("sanitizes server errors and rejects only their request", async () => {
    const { client, fake } = await initialized();
    const first = client.request("one", {}).catch((error: unknown) => error);
    const second = client.request("two", {});
    await flush();
    fake.emitStdout('{"id":3,"error":{"code":-1,"message":"secret-token@example.com","data":{"prompt":"private"}}}\n');
    const error = await first;
    expect(error).toBeInstanceOf(CodexProviderError);
    expect(error).toMatchObject({ category: "protocol" });
    expect(JSON.stringify(error) + String(error)).not.toMatch(/secret-token|private/);
    fake.respond(4, "ok");
    await expect(second).resolves.toBe("ok");
  });

  it.each(['{"secret-prompt":', '{"id":3}', '{"id":3,"result":{},"error":{"code":1,"message":"private"}}'])
  ("fails all work on malformed JSON or envelopes without payload diagnostics: %s", async (line) => {
    const { client, fake } = await initialized();
    const first = client.request("one", {}).catch((error: unknown) => error);
    const second = client.request("two", {}).catch((error: unknown) => error);
    const disconnected = vi.fn();
    client.subscribe({ notification: vi.fn(), disconnected });
    await flush();
    fake.emitStdout(line + "\n");
    const errors = await Promise.all([first, second]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(CodexProviderError);
      expect(error).toMatchObject({ category: "protocol" });
      expect(String(error)).not.toMatch(/secret-prompt|private/);
    }
    expect(disconnected).toHaveBeenCalledWith(errors[0]);
  });
});

describe("Codex process safety and lifecycle", () => {
  it("keeps old operation handles on their dead connection after a replacement starts", async () => {
    const { client, fake, spawn } = await initialized();
    const owner = await client.connect();
    fake.exit(1);
    await flush();
    await expect(owner.request("never-replay", {})).rejects.toMatchObject({ category: "process-exit" });
    expect(spawn).toHaveBeenCalledTimes(1);
    const replacement = new FakeAppServerProcess();
    spawn.mockReturnValue(replacement);
    const fresh = client.request("fresh", {});
    await flush();
    replacement.respond(3, {});
    await flush();
    replacement.respond(4, "new");
    expect(await fresh).toBe("new");
    const disconnected = vi.fn();
    owner.subscribe({ notification: vi.fn(), disconnected });
    await owner.unsubscribeThread("old-thread");
    await expect(owner.request("never-replay", {})).rejects.toMatchObject({ category: "process-exit" });
    expect(disconnected).toHaveBeenCalledWith(expect.objectContaining({ category: "process-exit" }));
    expect(replacement.outbound().map((line) => line.method)).toEqual(["initialize", "initialized", "fresh"]);
  });

  it("bounds a live thread unsubscribe without blocking later requests or leaking its deadline", async () => {
    vi.useFakeTimers();
    const { client, fake } = await initialized();
    const owner = await client.connect();
    const unsubscribed = owner.unsubscribeThread("thread");
    await flush();
    expect(fake.outbound().at(-1)).toEqual({ id: 3, method: "thread/unsubscribe", params: { threadId: "thread" } });
    await vi.advanceTimersByTimeAsync(1000);
    await unsubscribed;
    expect(vi.getTimerCount()).toBe(0);
    fake.respond(3, {}); // Late cleanup reply must not settle a different request.
    const next = owner.request("next", {});
    await flush();
    fake.respond(4, "ok");
    expect(await next).toBe("ok");
  });

  it.each([
    ["item/commandExecution/requestApproval", { decision: "decline" }],
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["execCommandApproval", { decision: "abort" }],
    ["applyPatchApproval", { decision: "abort" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["mcpServer/elicitation/request", { action: "cancel", content: null }],
    ["item/tool/requestUserInput", { answers: {} }],
  ])("refuses server request %s with its protocol result", async (method, result) => {
    const { client, fake } = await initialized();
    fake.requestFromServer(100, method as string, { threadId: "thread", turnId: "turn" });
    await flush();
    expect(fake.outbound()[3]).toEqual({ id: 100, result });
    if (method === "item/tool/requestUserInput") {
      expect(fake.outbound()[4]).toEqual({
        id: 3, method: "turn/interrupt", params: { threadId: "thread", turnId: "turn" },
      });
      fake.respond(3, {});
    }
    await client[Symbol.asyncDispose]();
  });

  it("replies method-not-found for an unknown request with a string ID", async () => {
    const { fake } = await initialized();
    fake.emitStdout('{"id":"opaque-id","method":"unknown/private-method","params":{"prompt":"private"}}\n');
    await flush();
    expect(fake.outbound()[3]).toEqual({
      id: "opaque-id", error: { code: -32601, message: "Method not found" },
    });
  });

  it("drains stderr beyond 64 KiB and reports only capped byte counts", async () => {
    const fake = new FakeAppServerProcess();
    const diagnostic = vi.fn();
    const client = new CodexAppServerClient({ spawn: () => fake, diagnostic });
    clients.push(client);
    const pending = client.request("prompt-secret", { email: "secret@example.com" }).catch((error: unknown) => error);
    await flush();
    fake.emitStderr(new TextEncoder().encode("secret-token ".repeat(7000)));
    fake.emitStderr(new TextEncoder().encode("still draining private stderr"));
    await flush();
    expect(diagnostic).toHaveBeenCalled();
    expect(diagnostic.mock.calls.at(-1)).toEqual([{ stderrBytes: 65536 }]);
    expect(fake.stderrQueueSize()).toBe(1);
    expect(diagnostic.mock.calls.every(([value]) => Object.keys(value).join() === "stderrBytes")).toBe(true);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/secret|prompt|email|private/);
    fake.exit(1);
    await pending;
  });

  it("fails all active work on exit, detaches before callbacks, and never replays written requests", async () => {
    const firstFake = new FakeAppServerProcess();
    const secondFake = new FakeAppServerProcess();
    const spawn = vi.fn().mockReturnValueOnce(firstFake).mockReturnValueOnce(secondFake);
    const client = new CodexAppServerClient({ spawn });
    clients.push(client);
    const first = client.request("never-replay", { prompt: "private" }).catch((error: unknown) => error);
    const second = client.request("also-fails", {}).catch((error: unknown) => error);
    await flush();
    firstFake.respond(1, {});
    await flush();
    const disconnected = vi.fn();
    let replacement!: Promise<unknown>;
    client.subscribe({ notification: vi.fn(), disconnected: (error) => {
      disconnected(error);
      replacement = client.request("fresh", {});
    } });
    firstFake.exit(9);
    await flush();
    expect(await first).toMatchObject({ category: "process-exit" });
    expect(await second).toMatchObject({ category: "process-exit" });
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(secondFake.outbound()).toHaveLength(1);
    expect(secondFake.outbound()[0]?.method).toBe("initialize");
    secondFake.respond(4, {});
    await flush();
    expect(secondFake.outbound().map((line) => line.method)).toEqual(["initialize", "initialized", "fresh"]);
    secondFake.respond(5, "new-result");
    await expect(replacement).resolves.toBe("new-result");
  });

  it("interrupts every tracked turn on close and forces exit after five seconds", async () => {
    vi.useFakeTimers();
    const { client, fake, spawn } = await initialized();
    client.trackTurn("a", "1");
    client.trackTurn("b", "2");
    client.trackTurn("c", "3")();
    const pending = client.request("waiting", {}).catch((error: unknown) => error);
    const disconnected = vi.fn();
    client.subscribe({ notification: vi.fn(), disconnected });
    await flush();
    const closing = client[Symbol.asyncDispose]();
    const closed = vi.fn();
    void closing.then(closed);
    await flush();
    expect(fake.outbound().filter((line) => line.method === "turn/interrupt").map((line) => line.params)).toEqual([
      { threadId: "a", turnId: "1" }, { threadId: "b", turnId: "2" },
    ]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(closed).not.toHaveBeenCalled();
    expect(fake.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(fake.inputClosed).toBe(true);
    expect(fake.killed).toBe(true);
    expect(await pending).toMatchObject({ category: "shutdown" });
    expect(disconnected).toHaveBeenCalledWith(expect.objectContaining({ category: "shutdown" }));
    await expect(client.request("cannot-restart", {})).rejects.toMatchObject({ category: "shutdown" });
    await client[Symbol.asyncDispose]();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("waits for tracked turn completion after the interrupt reply and clears its deadline", async () => {
    vi.useFakeTimers();
    const { client, fake } = await initialized();
    client.trackTurn("a", "1");
    const closing = client[Symbol.asyncDispose]();
    const closed = vi.fn();
    void closing.then(closed);
    await flush();
    fake.respond(3, {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.killed).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    fake.notify("turn/completed", { threadId: "a", turn: { id: "wrong", status: "interrupted" } });
    await flush();
    expect(fake.killed).toBe(false);
    fake.notify("turn/completed", { threadId: "a", turn: { id: "1", status: "interrupted" } });
    await closing;
    expect(fake.killed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds close after launcher exit with descendant-held pipes and still terminates its tree", async () => {
    vi.useFakeTimers();
    const { client, fake } = await initialized();
    const killed = vi.spyOn(fake, "kill");
    fake.exit(0, true);
    const closed = vi.fn();
    const closing = client[Symbol.asyncDispose]().then(closed);
    try {
      await vi.advanceTimersByTimeAsync(6500);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(killed).toHaveBeenCalledTimes(1);
      expect(fake.stdout.locked).toBe(false);
      expect(fake.stderr.locked).toBe(false);
    } finally {
      fake.endStdout(); fake.endStderr();
      await closing;
    }
  });

  it("bounds reader cancellation and observes a late teardown rejection", async () => {
    vi.useFakeTimers();
    const teardown = deferred<void>();
    const cancellation = deferred<void>();
    const fake = new FakeAppServerProcess();
    let errors!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    fake.stderr = new ReadableStream({ start: (controller) => { errors = controller; }, cancel: () => {
      cancelled = true;
      return cancellation.promise;
    } });
    fake.kill = () => teardown.promise;
    const client = new CodexAppServerClient({ spawn: () => fake });
    clients.push(client);
    const pending = client.request("waiting", {}).catch((error: unknown) => error);
    const closed = vi.fn();
    const closing = client[Symbol.asyncDispose]().then(closed);
    try {
      await vi.advanceTimersByTimeAsync(6500);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(await pending).toMatchObject({ category: "shutdown" });
      expect(fake.stderr.locked).toBe(false);
    } finally {
      if (closed.mock.calls.length) {
        teardown.reject(new Error("late private teardown"));
        cancellation.reject(new Error("late private cancellation"));
      } else {
        teardown.resolve(); cancellation.resolve();
      }
      if (!cancelled) errors.close();
      fake.exit(137);
      await closing;
    }
  });

  it("closes during handshake without writing the waiting user request", async () => {
    const { client, fake } = create();
    const pending = client.request("do-not-write", {}).catch((error: unknown) => error);
    await flush();
    await client[Symbol.asyncDispose]();
    expect(await pending).toMatchObject({ category: "shutdown" });
    expect(fake.outbound().map((line) => line.method)).toEqual(["initialize"]);
    expect(fake.inputClosed).toBe(true);
  });

  it("detaches a failed initialize so a later request can start a fresh handshake", async () => {
    const fake = new FakeAppServerProcess();
    const next = new FakeAppServerProcess();
    const spawn = vi.fn().mockReturnValueOnce(fake).mockReturnValueOnce(next);
    const client = new CodexAppServerClient({ spawn });
    clients.push(client);
    const failed = client.request("one", {}).catch((error: unknown) => error);
    await flush();
    fake.emitStdout('{"id":1,"error":{"code":-1,"message":"private"}}\n');
    expect(await failed).toMatchObject({ category: "protocol" });
    const fresh = client.request("two", {}).catch((error: unknown) => error);
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);
    await client[Symbol.asyncDispose]();
    await fresh;
  });

  it("wraps only the Bun process boundary and flushes JSONL writes", async () => {
    const fake = new FakeAppServerProcess();
    const write = vi.fn();
    const flushInput = vi.fn(async () => {});
    const end = vi.fn();
    const kill = vi.fn();
    const spawn = vi.fn(() => ({
      stdin: { write, flush: flushInput, end },
      stdout: fake.stdout, stderr: fake.stderr, exited: fake.exited, kill,
    }));
    vi.stubGlobal("Bun", { spawn });
    const process = spawnCodexAppServer(["runtime", "codex", "app-server"], { CODEX_HOME: "/private" });
    await process.write('{"method":"initialized","params":{}}\n');
    const expectedCommand = globalThis.process.platform === "linux"
      ? [
          globalThis.process.execPath,
          "--no-env-file",
          expect.stringMatching(/process-supervisor\.ts$/),
          "--",
          "runtime",
          "codex",
          "app-server",
        ]
      : ["runtime", "codex", "app-server"];
    expect(spawn).toHaveBeenCalledWith(expectedCommand, {
      env: { CODEX_HOME: "/private" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      detached: globalThis.process.platform !== "win32", onExit: expect.any(Function),
    });
    expect(write).toHaveBeenCalledWith('{"method":"initialized","params":{}}\n');
    expect(flushInput).toHaveBeenCalledTimes(1);
    process.closeInput();
    const killed = process.kill();
    expect(end).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(globalThis.process.platform === "linux" ? "SIGTERM" : "SIGKILL");
    fake.exit(0);
    await killed;
    await expect(process.exited).resolves.toBe(0);
  });

  it("disconnects subscriptions when closed before spawning", async () => {
    const { client, spawn } = create();
    const disconnected = vi.fn();
    client.subscribe({ notification: vi.fn(), disconnected });
    await client[Symbol.asyncDispose]();
    expect(disconnected).toHaveBeenCalledWith(expect.objectContaining({ category: "shutdown" }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("sanitizes spawn failure and disconnects subscriptions", async () => {
    const client = new CodexAppServerClient({ spawn: () => { throw new Error("private-token"); } });
    clients.push(client);
    const disconnected = vi.fn();
    client.subscribe({ notification: vi.fn(), disconnected });
    await expect(client.request("test", {})).rejects.toMatchObject({ category: "connection" });
    expect(disconnected).toHaveBeenCalledWith(expect.objectContaining({ category: "connection" }));
    expect(String(disconnected.mock.calls[0]?.[0])).not.toContain("private-token");
  });

  it.each(["", '{"id":3,"result":"secret-incomplete'])
  ("settles active work when stdout ends before the child exits: %s", async (tail) => {
    const { client, fake } = await initialized();
    const rejected = vi.fn();
    const pending = client.request("waiting", {}).catch(rejected);
    await flush();
    if (tail) fake.emitStdout(tail);
    fake.endStdout();
    await flush();
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ category: tail ? "protocol" : "process-exit" }));
    expect(String(rejected.mock.calls[0]?.[0])).not.toContain("secret-incomplete");
    await pending;
  });

  it("isolates throwing listeners and observes asynchronous callback failures", async () => {
    const { client, fake } = await initialized();
    const delivered = vi.fn();
    client.subscribe({
      notification: async () => { throw new Error("callback failure"); },
      disconnected: async () => { throw new Error("disconnect callback failure"); },
    });
    client.subscribe({ notification: () => { throw new Error("sync callback failure"); }, disconnected: vi.fn() });
    client.subscribe({ threadId: "a", notification: delivered, disconnected: vi.fn() });
    fake.notify("item/agentMessage/delta", { threadId: "a", turnId: "1", delta: "first" });
    fake.notify("item/agentMessage/delta", { threadId: "a", turnId: "2", delta: "second" });
    await flush();
    expect(delivered).toHaveBeenCalledTimes(2);
    await client[Symbol.asyncDispose]();
  });

  it("sanitizes asynchronous write failures and rejects all pending work without retry", async () => {
    const { client, fake, spawn } = await initialized();
    fake.write = async () => { throw new Error("private-prompt-and-token"); };
    const first = client.request("one", {}).catch((error: unknown) => error);
    const second = client.request("two", {}).catch((error: unknown) => error);
    for (const error of await Promise.all([first, second])) {
      expect(error).toMatchObject({ category: "connection" });
      expect(String(error)).not.toContain("private-prompt-and-token");
    }
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("observes refusal writes and interrupt failures during child exit", async () => {
    const { client, fake } = await initialized();
    const disconnected = vi.fn();
    client.subscribe({ notification: vi.fn(), disconnected });
    fake.requestFromServer(100, "item/tool/requestUserInput", { threadId: "a", turnId: "1" });
    await flush();
    expect(fake.outbound().at(-1)?.method).toBe("turn/interrupt");
    fake.exit(1);
    await flush();
    expect(disconnected).toHaveBeenCalledWith(expect.objectContaining({ category: "process-exit" }));
    await client[Symbol.asyncDispose]();
  });

  it("waits for the old child's readers during close even after detachment", async () => {
    const { client, fake } = await initialized();
    const pending = client.request("waiting", {}).catch((error: unknown) => error);
    fake.kill = () => { fake.killed = true; };
    await flush();
    fake.emitStdout("invalid JSON\n");
    await flush();
    expect(await pending).toMatchObject({ category: "protocol" });
    const settled = vi.fn();
    const closing = client[Symbol.asyncDispose]().then(settled);
    await flush();
    expect(settled).not.toHaveBeenCalled();
    fake.exit(137);
    await closing;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it.each(["exit", "close"])("rejects all initial callers when %s occurs during an initialized flush", async (ending) => {
    const { client, fake } = create();
    const initializedFlush = deferred<void>();
    const recordWrite = fake.write.bind(fake);
    fake.write = (line) => {
      recordWrite(line);
      if (JSON.parse(line).method === "initialized") return initializedFlush.promise;
    };
    const rejected = vi.fn();
    const pending = [client.request("one", {}).catch(rejected), client.request("two", {}).catch(rejected)];
    await flush();
    fake.respond(1, {});
    await flush();
    expect(fake.outbound().map((line) => line.method)).toEqual(["initialize", "initialized"]);
    if (ending === "exit") { fake.exit(1); await flush(); }
    await client[Symbol.asyncDispose]();
    await flush();
    try {
      expect(rejected).toHaveBeenCalledTimes(2);
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({
        category: ending === "exit" ? "process-exit" : "shutdown",
      }));
      expect(fake.outbound().map((line) => line.method)).toEqual(["initialize", "initialized"]);
    } finally {
      // A write can reject after the terminal failure won the race; it must remain observed.
      initializedFlush.reject(new Error("late private flush failure"));
      await Promise.all(pending);
    }
  });

  it("waits for an asynchronous FileSink write before flushing", async () => {
    const fake = new FakeAppServerProcess();
    const written = deferred<number>();
    const flushInput = vi.fn();
    vi.stubGlobal("Bun", { spawn: () => ({
      stdin: { write: () => written.promise, flush: flushInput, end: () => 0 },
      stdout: fake.stdout, stderr: fake.stderr, exited: fake.exited, kill: () => fake.kill(),
    }) });
    const process = spawnCodexAppServer(["fake-codex"], {});
    const settled = vi.fn();
    const writing = Promise.resolve(process.write("{}\n")).then(settled);
    await flush();
    try {
      expect(flushInput).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
    } finally { written.resolve(3); }
    await writing;
    expect(flushInput).toHaveBeenCalledTimes(1);
    fake.exit(0);
  });

  it("observes rejected FileSink writes and reports a sanitized client failure", async () => {
    const fake = new FakeAppServerProcess();
    const written = deferred<number>();
    const flushInput = vi.fn();
    vi.stubGlobal("Bun", { spawn: () => ({
      stdin: { write: () => written.promise, flush: flushInput, end: () => 0 },
      stdout: fake.stdout, stderr: fake.stderr, exited: fake.exited, kill: () => fake.kill(),
    }) });
    const client = new CodexAppServerClient({ spawn: () => spawnCodexAppServer(["fake-codex"], {}) });
    clients.push(client);
    const rejected = vi.fn();
    const pending = client.request("one", {}).catch(rejected);
    await flush();
    written.reject(new Error("private FileSink write failure"));
    await flush();
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ category: "connection" }));
    expect(String(rejected.mock.calls[0]?.[0])).not.toContain("private FileSink");
    expect(flushInput).not.toHaveBeenCalled();
    await pending;
  });

  it("observes a FileSink end rejection that arrives after close finishes", async () => {
    const fake = new FakeAppServerProcess();
    const ended = deferred<number>();
    let endCalls = 0;
    const end = () => { endCalls++; return ended.promise; };
    vi.stubGlobal("Bun", { spawn: () => ({
      stdin: { write: fake.write.bind(fake), flush: () => 0, end },
      stdout: fake.stdout, stderr: fake.stderr, exited: fake.exited, kill: () => fake.kill(),
    }) });
    const client = new CodexAppServerClient({ spawn: () => spawnCodexAppServer(["fake-codex"], {}) });
    clients.push(client);
    const pending = client.request("one", {}).catch((error: unknown) => error);
    await flush();
    await client[Symbol.asyncDispose]();
    expect(await pending).toMatchObject({ category: "shutdown" });
    expect(endCalls).toBe(1);
    ended.reject(new Error("private FileSink end failure"));
    await flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Vitest also fails this test run if the late rejection is unobserved.
  });
});
