import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AppServerConnection, CodexAppServerClient } from "./app-server-client.ts";
import { CodexProviderError, isRecord, type AppServerNotification, type CodexErrorCategory } from "./protocol.ts";
import { openImageWorkspace, type ImageWorkspace } from "./workspace-files.ts";

export type CodexClient = Pick<CodexAppServerClient, "connect">;
export type CodexCompletedTurn = {
  id: string;
  status: string;
  items: unknown[];
  error?: unknown;
};

function mapTurnError(error: unknown): CodexProviderError {
  const info = isRecord(error) ? error.codexErrorInfo : undefined;
  const variant = typeof info === "string" ? info
    : isRecord(info) && Object.keys(info).length === 1 ? Object.keys(info)[0] : undefined;
  let category: CodexErrorCategory = "protocol";
  switch (variant) {
    case "usageLimitExceeded": category = "usage-limit"; break;
    case "unauthorized": category = "unauthenticated"; break;
    case "sandboxError": category = "sandbox"; break;
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts": category = "connection"; break;
  }
  // Provider messages and additionalDetails can contain prompts, credentials,
  // or local paths. Only a locally selected category crosses this boundary.
  return new CodexProviderError(category, `Codex turn failed (${category})`);
}

function responseId(response: unknown, key: "thread" | "turn"): string {
  const value = isRecord(response) ? response[key] : undefined;
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    throw new CodexProviderError("protocol", `Codex returned an invalid ${key}`);
  }
  return value.id;
}

type TurnState = {
  completed: Promise<CodexCompletedTurn>;
  fail(error: unknown): void;
  notification(message: AppServerNotification): void;
  setTurnId(turnId: string): void;
};

function createTurnState(
  threadId: string,
  onDelta?: (delta: string) => void,
): TurnState {
  let turnId: string | undefined;
  let settled = false;
  const queued: AppServerNotification[] = [];
  let resolveTurn!: (turn: CodexCompletedTurn) => void;
  let rejectTurn!: (error: unknown) => void;
  const completed = new Promise<CodexCompletedTurn>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  // A disconnect may reject while turn/start is still awaiting its response.
  void completed.catch(() => {});

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectTurn(error);
  };

  const notification = (message: AppServerNotification) => {
    if (settled || !isRecord(message.params) || message.params.threadId !== threadId) return;
    if (!turnId) { queued.push(message); return; }
    const params = message.params;
    const eventTurnId = message.method === "turn/completed" && isRecord(params.turn)
      ? params.turn.id : params.turnId;
    if (eventTurnId !== turnId) return;
    try {
      switch (message.method) {
        case "item/agentMessage/delta":
          if (typeof params.delta !== "string") throw new CodexProviderError("protocol", "Codex returned an invalid text delta");
          onDelta?.(params.delta);
          break;
        case "model/rerouted":
          fail(new CodexProviderError("model-rerouted", "Codex rerouted the configured model"));
          break;
        case "error":
          if (params.willRetry !== true) fail(mapTurnError(params.error));
          break;
        case "turn/completed": {
          const turn = params.turn;
          if (!isRecord(turn) || turn.status !== "completed") { fail(mapTurnError(isRecord(turn) ? turn.error : undefined)); break; }
          if (!Array.isArray(turn.items)) throw new CodexProviderError("protocol", "Codex returned an invalid completed turn");
          settled = true;
          resolveTurn(turn as CodexCompletedTurn);
          break;
        }
      }
    } catch (error) { fail(error); }
  };

  return {
    completed,
    fail,
    notification,
    setTurnId(id) {
      turnId = id;
      for (const message of queued) notification(message);
      queued.length = 0;
    },
  };
}

async function startCodexThread(
  connection: AppServerConnection,
  request: { model: string; system: string },
  workspace: string,
): Promise<string> {
  return responseId(await connection.request("thread/start", {
    model: request.model,
    cwd: workspace,
    developerInstructions: request.system,
    ephemeral: true,
    approvalPolicy: "never",
    permissions: "mnimi-generation",
    runtimeWorkspaceRoots: [workspace],
    allowProviderModelFallback: false,
    serviceName: "mnimi",
  }), "thread");
}

async function removeCodexWorkspace(
  connection: AppServerConnection,
  threadId: string | undefined,
  tempRoot: string,
  workspace: string,
  originalWorkspace: BigIntStats | undefined,
  canonicalTempRoot: string | undefined,
  anchor: ImageWorkspace | undefined,
  unsubscribe: (() => void) | undefined,
  untrack: (() => void) | undefined,
): Promise<void> {
  if (threadId) await connection.unsubscribeThread(threadId);
  await anchor?.directory.close().catch(() => {});
  try { unsubscribe?.(); }
  finally {
    try { untrack?.(); }
    finally {
      // Derive the sole removal target from our mkdtemp result, never from a
      // response, item, notification, or consumer-returned path. Neither a
      // symlink nor a replacement directory may redirect recursive removal.
      const root = await realpath(tempRoot);
      const expected = join(root, basename(workspace));
      const actual = await realpath(workspace);
      const currentWorkspace = await lstat(workspace, { bigint: true });
      if (!originalWorkspace?.isDirectory() || !currentWorkspace.isDirectory()
        || currentWorkspace.dev !== originalWorkspace.dev
        || currentWorkspace.ino !== originalWorkspace.ino
        || root !== canonicalTempRoot
        || dirname(resolve(workspace)) !== resolve(tempRoot)
        || !basename(workspace).startsWith("mnimi-codex-")
        || dirname(actual) !== root || actual !== expected) {
        throw new CodexProviderError("sandbox", "Refused to remove an invalid Codex workspace");
      }
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export async function runCodexTurn<T>(
  client: CodexClient,
  request: { model: string; effort: string; system: string; user: string; outputSchema?: unknown },
  consume: (turn: CodexCompletedTurn, workspace: string, anchor?: ImageWorkspace) => Promise<T> | T,
  onDelta?: (delta: string) => void,
): Promise<T> {
  const connection = await client.connect();
  const tempRoot = tmpdir();
  const workspace = await mkdtemp(join(tempRoot, "mnimi-codex-"));
  let originalWorkspace: BigIntStats | undefined;
  let canonicalTempRoot: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let untrack: (() => void) | undefined;
  let anchor: ImageWorkspace | undefined;
  let threadId: string | undefined;
  try {
    [originalWorkspace, canonicalTempRoot] = await Promise.all([
      lstat(workspace, { bigint: true }), realpath(tempRoot),
    ]);
    if (!originalWorkspace.isDirectory()) {
      throw new CodexProviderError("sandbox", "Codex workspace is not a directory");
    }
    anchor = await openImageWorkspace(workspace, originalWorkspace);
    threadId = await startCodexThread(connection, request, workspace);
    const turn = createTurnState(threadId, onDelta);
    unsubscribe = connection.subscribe({ threadId, notification: turn.notification, disconnected: turn.fail });
    const response = await Promise.race([
      connection.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.user }],
        effort: request.effort,
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      }),
      turn.completed,
    ]);
    const turnId = responseId(response, "turn");
    turn.setTurnId(turnId);
    untrack = connection.trackTurn(threadId, turnId);
    return await consume(await turn.completed, workspace, anchor);
  } finally {
    await removeCodexWorkspace(connection, threadId, tempRoot, workspace, originalWorkspace,
      canonicalTempRoot, anchor, unsubscribe, untrack);
  }
}
