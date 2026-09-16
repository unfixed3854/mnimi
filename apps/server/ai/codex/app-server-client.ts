import { fileURLToPath } from "node:url";
import {
  CodexProviderError, isNotification, isRecord, isResponse, isServerRequest,
  type AppServerNotification, type AppServerProcess, type AppServerRequest, type SpawnAppServer,
} from "./protocol.ts";
import {
  settlesWithin, terminateAndReap, terminateProcessTree, terminateSupervisedTree,
} from "./process-tree.ts";

export type AppServerSubscription = {
  threadId?: string;
  turnId?: string;
  notification(message: AppServerNotification): void;
  disconnected(error: CodexProviderError): void;
};

/** All methods stay on the connection that created this handle; none restart. */
export type AppServerConnection = {
  request<T>(method: string, params: unknown): Promise<T>;
  subscribe(handlers: AppServerSubscription): () => void;
  trackTurn(threadId: string, turnId: string): () => void;
  unsubscribeThread(threadId: string): Promise<void>;
};
export type ConnectionValidator = (connection: Pick<AppServerConnection, "request">) => Promise<void>;
type TrackedTurn = { threadId: string; turnId: string; settled: Promise<void>; settle(): void };

type PendingRequest = { resolve(value: unknown): void; reject(error: CodexProviderError): void };
type Connection = {
  process: AppServerProcess;
  pending: Map<number, PendingRequest>;
  ready: Promise<void>;
  terminal: Promise<never>;
  rejectTerminal(error: CodexProviderError): void;
  readers: Promise<void>[];
  streamReaders: Set<ReadableStreamDefaultReader<Uint8Array>>;
  writers: Set<(error: CodexProviderError) => void>;
  failure?: CodexProviderError;
  cleanup?: Promise<void>;
  subscriptions: Set<AppServerSubscription>;
  turns: Set<TrackedTurn>;
  session?: AppServerConnection;
};

export type AppServerClientOptions = {
  spawn: SpawnAppServer;
  diagnostic?: (value: { stderrBytes: number }) => void;
  validate?: ConnectionValidator;
};

const LINUX_SUPERVISOR = fileURLToPath(new URL("./process-supervisor.ts", import.meta.url));

function ownedAppServerCommand(command: string[]): string[] {
  return process.platform === "linux"
    ? [process.execPath, "--no-env-file", LINUX_SUPERVISOR, "--", ...command]
    : command;
}

export function spawnCodexAppServer(command: string[], env: Record<string, string>): AppServerProcess {
  let resolveExit!: (code: number) => void;
  const exitSignal = new Promise<number>((resolve) => { resolveExit = resolve; });
  const supervised = process.platform === "linux";
  const child = Bun.spawn(ownedAppServerCommand(command), {
    env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32",
    onExit(_child, code) { resolveExit(code ?? 1); },
  });
  // Observe both APIs, but do not depend on a stdio-close event to reap a launcher.
  const exited = Promise.race([exitSignal, child.exited]);
  let stopping: Promise<void> | undefined;
  return {
    async write(line) { await child.stdin.write(line); await child.stdin.flush(); },
    closeInput() {
      try { void Promise.resolve(child.stdin.end()).catch(() => {}); }
      catch { /* Closing an already failed sink cannot prevent process cleanup. */ }
    },
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill() {
      const owned = {
        terminateTree: () => terminateProcessTree(child),
        destroyOutput() { /* The client's owned readers cancel both pipes. */ },
        exited,
        killDirect() { try { child.kill("SIGKILL"); } catch { /* Already exited. */ } },
      };
      return stopping ??= supervised
        ? terminateSupervisedTree({
            ...owned,
            requestStop() { child.kill("SIGTERM"); },
          })
        : terminateAndReap(owned);
    },
  };
}

const NOTIFICATIONS = new Set([
  "thread/started", "turn/started", "turn/completed", "item/started", "item/completed",
  "item/agentMessage/delta", "thread/tokenUsage/updated", "model/rerouted", "error",
]);

function notifySafely(callback: () => void): void {
  try { void Promise.resolve(callback()).catch(() => {}); }
  catch { /* Consumer failures must not disconnect unrelated operations. */ }
}

export class CodexAppServerClient {
  #connection?: Connection;
  #nextId = 0;
  #closed = false;
  #closing?: Promise<void>;
  #pendingSubscriptions = new Set<AppServerSubscription>();
  #connections = new Set<Connection>();
  #options: AppServerClientOptions;

  constructor(options: AppServerClientOptions) { this.#options = options; }

  async request<T>(method: string, params: unknown): Promise<T> {
    return (await this.connect()).request<T>(method, params);
  }

  async connect(): Promise<AppServerConnection> {
    const connection = this.#ensureConnection();
    await connection.ready;
    if (this.#closed) throw new CodexProviderError("shutdown", "Codex client is closed");
    if (connection.failure) throw connection.failure;
    return connection.session ??= {
      request: <T>(method: string, params: unknown) => {
        if (this.#closed) return Promise.reject(new CodexProviderError("shutdown", "Codex client is closed"));
        return this.#send<T>(connection, method, params);
      },
      subscribe: (handlers) => this.#subscribeOn(connection, handlers),
      trackTurn: (threadId, turnId) => this.#trackOn(connection, threadId, turnId),
      unsubscribeThread: async (threadId) => {
        // Cleanup owns this exact connection, including while close is waiting
        // for a turn. A dead process must never cause a replacement here.
        if (connection.failure) return;
        try { await this.#send(connection, "thread/unsubscribe", { threadId }, 1000); }
        catch { /* Best effort; preserve the operation's result/failure. */ }
      },
    };
  }

  subscribe(handlers: AppServerSubscription): () => void {
    return this.#subscribeOn(this.#connection, handlers);
  }

  #subscribeOn(connection: Connection | undefined, handlers: AppServerSubscription): () => void {
    const failure = connection?.failure ?? (this.#closed ? new CodexProviderError("shutdown", "Codex client is closed") : undefined);
    if (failure) {
      notifySafely(() => handlers.disconnected(failure));
      return () => {};
    }
    const subscriptions = connection?.subscriptions ?? this.#pendingSubscriptions;
    subscriptions.add(handlers);
    return () => { subscriptions.delete(handlers); };
  }

  trackTurn(threadId: string, turnId: string): () => void {
    return this.#connection ? this.#trackOn(this.#connection, threadId, turnId) : () => {};
  }

  #trackOn(connection: Connection, threadId: string, turnId: string): () => void {
    if (this.#closed || connection.failure) return () => {};
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const turn = { threadId, turnId, settled, settle };
    connection.turns.add(turn);
    return () => { connection.turns.delete(turn); settle(); };
  }

  #ensureConnection(): Connection {
    if (this.#closed) throw new CodexProviderError("shutdown", "Codex client is closed");
    if (this.#connection) return this.#connection;
    let process: AppServerProcess;
    try { process = this.#options.spawn(); }
    catch {
      const error = new CodexProviderError("connection", "Could not start Codex app server");
      this.#disconnectSubscriptions(this.#pendingSubscriptions, error);
      throw error;
    }
    let rejectTerminal!: (error: CodexProviderError) => void;
    const terminal = new Promise<never>((_, reject) => { rejectTerminal = reject; });
    // Keep the signal observed even when failure occurs without a write in flight.
    void terminal.catch(() => {});
    const connection: Connection = {
      process, pending: new Map(), ready: Promise.resolve(), terminal, rejectTerminal,
      readers: [], streamReaders: new Set(), writers: new Set(),
      subscriptions: this.#pendingSubscriptions, turns: new Set(),
    };
    this.#pendingSubscriptions = new Set();
    this.#connection = connection;
    this.#connections.add(connection);
    connection.readers.push(this.#readStdout(connection));
    connection.readers.push(this.#readStderr(connection));
    connection.readers.push(process.exited.then(
      () => { this.#fail(connection, new CodexProviderError("process-exit", "Codex app server exited")); },
      () => { this.#fail(connection, new CodexProviderError("process-exit", "Codex app server exited")); },
    ));
    connection.ready = Promise.race([this.#initialize(connection), terminal]);
    return connection;
  }

  async #initialize(connection: Connection): Promise<void> {
    try {
      await this.#send(connection, "initialize", {
        clientInfo: { name: "mnimi", title: "mnimi", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      await this.#write(connection, { method: "initialized", params: {} });
      await this.#options.validate?.({ request: <T>(method: string, params: unknown) => this.#send<T>(connection, method, params) });
    } catch (error) {
      const failure = error instanceof CodexProviderError ? error
        : new CodexProviderError("protocol", "Codex app server initialization failed");
      this.#fail(connection, failure);
      throw connection.failure ?? failure;
    }
  }

  #send<T>(connection: Connection, method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (connection.failure) return Promise.reject(connection.failure);
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        connection.pending.delete(id);
        reject(new CodexProviderError("protocol", "Codex cleanup request timed out"));
      }, timeoutMs);
      connection.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      void this.#write(connection, { id, method, params }).catch(() => {});
    });
  }

  async #write(connection: Connection, message: unknown): Promise<void> {
    if (connection.failure) throw connection.failure;
    try {
      // Remove each settled writer instead of adding permanent reactions to the
      // connection's lifetime promise on every JSONL message. A late rejection
      // after process exit remains observed by the write's own handler.
      await new Promise<void>((resolve, reject) => {
        connection.writers.add(reject);
        Promise.resolve().then(() => {
          if (connection.failure) throw connection.failure;
          return connection.process.write(JSON.stringify(message) + "\n");
        }).then(
          () => { connection.writers.delete(reject); resolve(); },
          (error: unknown) => { connection.writers.delete(reject); reject(error); },
        );
      });
    }
    catch {
      const error = new CodexProviderError("connection", "Could not write to Codex app server");
      this.#fail(connection, error);
      throw connection.failure ?? error;
    }
  }

  async #readStdout(connection: Connection): Promise<void> {
    const reader = connection.process.stdout.getReader();
    connection.streamReaders.add(reader);
    const decoder = new TextDecoder();
    let tail = "";
    try {
      while (!connection.failure) {
        const { done, value } = await reader.read();
        if (done) {
          tail += decoder.decode();
          if (tail.trim()) throw new CodexProviderError("protocol", "Incomplete Codex app server message");
          this.#fail(connection, new CodexProviderError("process-exit", "Codex app server output closed"));
          break;
        }
        tail += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = tail.indexOf("\n")) !== -1 && !connection.failure) {
          const line = tail.slice(0, newline).trim();
          tail = tail.slice(newline + 1);
          if (line) this.#dispatch(connection, JSON.parse(line));
        }
      }
    } catch {
      this.#fail(connection, new CodexProviderError("protocol", "Invalid Codex app server message"));
    } finally {
      connection.streamReaders.delete(reader);
      reader.releaseLock();
    }
  }

  async #readStderr(connection: Connection): Promise<void> {
    const reader = connection.process.stderr.getReader();
    connection.streamReaders.add(reader);
    let stderrBytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const capped = Math.min(65536, stderrBytes + value.byteLength);
        if (capped !== stderrBytes) {
          stderrBytes = capped;
          notifySafely(() => this.#options.diagnostic?.({ stderrBytes }));
        }
      }
    }
    catch { this.#fail(connection, new CodexProviderError("connection", "Could not read Codex app server diagnostics")); }
    finally {
      connection.streamReaders.delete(reader);
      reader.releaseLock();
    }
  }

  #dispatch(connection: Connection, value: unknown): void {
    if (isResponse(value)) {
      const pending = typeof value.id === "number" ? connection.pending.get(value.id) : undefined;
      if (!pending) return;
      connection.pending.delete(value.id as number);
      if (value.error) pending.reject(new CodexProviderError("protocol", "Codex app server rejected a request"));
      else pending.resolve(value.result);
      return;
    }
    if (isServerRequest(value)) {
      void this.#refuse(connection, value).catch(() => {});
      return;
    }
    if (!isNotification(value)) throw new CodexProviderError("protocol", "Invalid Codex app server envelope");
    if (!NOTIFICATIONS.has(value.method)) return;
    const params = isRecord(value.params) ? value.params : {};
    const turnId = params.turnId ?? (isRecord(params.turn) ? params.turn.id : undefined);
    if (value.method === "turn/completed") {
      for (const turn of connection.turns) {
        if (turn.threadId === params.threadId && turn.turnId === turnId) {
          connection.turns.delete(turn);
          turn.settle();
        }
      }
    }
    for (const handlers of connection.subscriptions) {
      if (handlers.threadId !== undefined && handlers.threadId !== params.threadId) continue;
      if (handlers.turnId !== undefined && handlers.turnId !== turnId) continue;
      notifySafely(() => handlers.notification(value));
    }
  }

  async #refuse(connection: Connection, request: AppServerRequest): Promise<void> {
    let result: unknown;
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": result = { decision: "decline" }; break;
      case "execCommandApproval":
      case "applyPatchApproval": result = { decision: "abort" }; break;
      case "item/permissions/requestApproval": result = { permissions: {}, scope: "turn" }; break;
      case "mcpServer/elicitation/request": result = { action: "cancel", content: null }; break;
      case "item/tool/requestUserInput": result = { answers: {} }; break;
      default:
        await this.#write(connection, { id: request.id, error: { code: -32601, message: "Method not found" } });
        return;
    }
    await this.#write(connection, { id: request.id, result });
    if (request.method === "item/tool/requestUserInput" && isRecord(request.params)
      && typeof request.params.threadId === "string" && typeof request.params.turnId === "string") {
      await this.#send(connection, "turn/interrupt", {
        threadId: request.params.threadId, turnId: request.params.turnId,
      });
    }
  }

  #fail(connection: Connection, error: CodexProviderError): void {
    if (connection.failure) return;
    if (this.#closed) error = new CodexProviderError("shutdown", "Codex client is closed");
    connection.failure = error;
    if (this.#connection === connection) this.#connection = undefined;
    connection.rejectTerminal(error);
    for (const reject of connection.writers) reject(error);
    connection.writers.clear();
    for (const reader of connection.streamReaders) {
      // Web-stream cancellation settles pending reads before awaiting the
      // underlying source's cancel promise. Never wait for that source here.
      try { void reader.cancel().catch(() => {}); } catch { /* Cleanup remains bounded below. */ }
    }
    for (const pending of connection.pending.values()) pending.reject(error);
    connection.pending.clear();
    for (const turn of connection.turns) turn.settle();
    connection.turns.clear();
    this.#disconnectSubscriptions(connection.subscriptions, error);
    try { connection.process.closeInput(); } catch { /* Already closed. */ }
    // An exited launcher can still own live descendants holding its pipes.
    const killed = Promise.resolve().then(() => connection.process.kill());
    connection.cleanup = (async () => {
      // Production teardown needs at most 1s including the Windows helper and
      // direct-child fallback. Bound even injected/failed implementations.
      await settlesWithin(killed, 1250);
      await settlesWithin(Promise.allSettled(connection.readers), 250);
      this.#connections.delete(connection);
    })();
  }

  #disconnectSubscriptions(subscriptions: Set<AppServerSubscription>, error: CodexProviderError): void {
    const handlers = [...subscriptions];
    subscriptions.clear();
    for (const handler of handlers) notifySafely(() => handler.disconnected(error));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#closeConnections();
    return this.#closing;
  }

  async #closeConnections(): Promise<void> {
    const connection = this.#connection;
    if (connection) {
      const turns = [...connection.turns];
      for (const { threadId, turnId } of turns) {
        void this.#send(connection, "turn/interrupt", { threadId, turnId }).catch(() => {});
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (turns.length) await Promise.race([
          Promise.all(turns.map((turn) => turn.settled)),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.#fail(connection, new CodexProviderError("shutdown", "Codex client is closed"));
      }
    } else {
      this.#disconnectSubscriptions(this.#pendingSubscriptions, new CodexProviderError("shutdown", "Codex client is closed"));
    }
    await Promise.all([...this.#connections].map((entry) => entry.cleanup));
  }
}
