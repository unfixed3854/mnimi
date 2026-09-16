import type { AppServerProcess } from "./protocol.ts";

export class FakeAppServerProcess implements AppServerProcess {
  #output!: ReadableStreamDefaultController<Uint8Array>;
  #errors!: ReadableStreamDefaultController<Uint8Array>;
  #resolveExit!: (code: number) => void;
  #lines: Array<Record<string, unknown>> = [];
  #didExit = false;
  #stdoutClosed = false;
  #stderrClosed = false;
  killed = false;
  inputClosed = false;
  stdout = new ReadableStream<Uint8Array>({ start: (c) => { this.#output = c; }, cancel: () => { this.#stdoutClosed = true; } });
  stderr = new ReadableStream<Uint8Array>({ start: (c) => { this.#errors = c; }, cancel: () => { this.#stderrClosed = true; } });
  exited = new Promise<number>((resolve) => { this.#resolveExit = resolve; });
  write(line: string): void | Promise<void> { this.#lines.push(JSON.parse(line)); }
  closeInput() { this.inputClosed = true; }
  kill() { this.killed = true; this.exit(137); }
  emitStdout(text: string) { this.#output.enqueue(new TextEncoder().encode(text)); }
  emitStdoutBytes(bytes: Uint8Array) { this.#output.enqueue(bytes); }
  emitStderr(bytes: Uint8Array) { this.#errors.enqueue(bytes); }
  stderrQueueSize() { return this.#errors.desiredSize; }
  endStdout() { if (!this.#stdoutClosed) this.#output.close(); this.#stdoutClosed = true; }
  endStderr() { if (!this.#stderrClosed) this.#errors.close(); this.#stderrClosed = true; }
  exit(code: number, holdPipes = false) {
    if (this.#didExit) return;
    this.#didExit = true;
    this.#resolveExit(code);
    if (!holdPipes) { this.endStdout(); this.endStderr(); }
  }
  outbound() { return this.#lines; }
  respond(id: number, result: unknown) { this.emitStdout(JSON.stringify({ id, result }) + "\n"); }
  notify(method: string, params: unknown) { this.emitStdout(JSON.stringify({ method, params }) + "\n"); }
  requestFromServer(id: number, method: string, params: unknown) {
    this.emitStdout(JSON.stringify({ id, method, params }) + "\n");
  }
}
