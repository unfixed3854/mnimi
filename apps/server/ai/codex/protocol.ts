export type CodexErrorCategory =
  | "unauthenticated"
  | "model-unavailable"
  | "usage-limit"
  | "connection"
  | "protocol"
  | "sandbox"
  | "model-rerouted"
  | "image"
  | "process-exit"
  | "shutdown";

export class CodexProviderError extends Error {
  constructor(readonly category: CodexErrorCategory, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexProviderError";
  }
}

export type AppServerNotification = { method: string; params: unknown };
export type AppServerProcess = {
  write(line: string): void | Promise<void>;
  closeInput(): void;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void | Promise<void>;
};
export type SpawnAppServer = () => AppServerProcess;
export type RpcId = number | string;
export type AppServerResponse =
  | { id: RpcId; result: unknown; error?: never }
  | { id: RpcId; error: { code: number; message: string }; result?: never };
export type AppServerRequest = AppServerNotification & { id: RpcId };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

export function isResponse(value: unknown): value is AppServerResponse {
  if (!isRecord(value) || !isRpcId(value.id) || "method" in value) return false;
  if ("result" in value) return !("error" in value);
  return isRecord(value.error) && typeof value.error.code === "number"
    && Number.isFinite(value.error.code) && typeof value.error.message === "string";
}

export function isNotification(value: unknown): value is AppServerNotification {
  return isRecord(value) && typeof value.method === "string" && !("id" in value)
    && !("result" in value) && !("error" in value);
}

export function isServerRequest(value: unknown): value is AppServerRequest {
  return isRecord(value) && typeof value.method === "string" && isRpcId(value.id)
    && !("result" in value) && !("error" in value);
}
