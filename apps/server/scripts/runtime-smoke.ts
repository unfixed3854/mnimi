import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function availablePort(): Promise<number> {
  const server = createServer();
  let closing = false;

  async function closeListener(): Promise<void> {
    if (!server.listening || closing) return;
    closing = true;
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    } finally {
      closing = false;
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no TCP port");
    const port = address.port;
    await closeListener();
    return port;
  } finally {
    if (server.listening) {
      try {
        await closeListener();
      } catch {
        // Preserve the original listen/address/close error.
      }
    }
  }
}

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const COMMAND_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 1_000;
const SERVER_SHUTDOWN_TIMEOUT_MS = 5_000;
const SERVER_STARTUP_TIMEOUT_MS = 5_000;
const MAX_SERVER_START_ATTEMPTS = 5;

function lastLines(stdout: string, stderr: string): string {
  return [
    ...stdout.split(/\r?\n/).filter(Boolean).map((line) => `stdout: ${line}`),
    ...stderr.split(/\r?\n/).filter(Boolean).map((line) => `stderr: ${line}`),
  ].slice(-100).join("\n");
}

async function output(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  return stream ? await new Response(stream).text() : "";
}

async function runChecked(
  command: string[],
  environment: Record<string, string | undefined>,
  label: string,
): Promise<void> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn(command, {
      cwd: serverDir,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(
      `${label} could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const stdoutPromise = output(child.stdout);
  const stderrPromise = output(child.stderr);
  let timedOut = false;
  const timeout = setTimeout(() => {
    if (child.exitCode !== null) return;
    timedOut = true;
    child.kill("SIGKILL");
  }, COMMAND_TIMEOUT_MS);
  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    clearTimeout(timeout);
  }

  const [stdoutResult, stderrResult] = await Promise.allSettled([
    stdoutPromise,
    stderrPromise,
  ]);
  const stdout = stdoutResult.status === "fulfilled"
    ? stdoutResult.value
    : `output stream failed: ${stdoutResult.reason}`;
  const stderr = stderrResult.status === "fulfilled"
    ? stderrResult.value
    : `error stream failed: ${stderrResult.reason}`;
  const diagnostics = lastLines(stdout, stderr);
  if (timedOut) {
    throw new Error(
      `${label} timed out after ${COMMAND_TIMEOUT_MS}ms${
        diagnostics ? `\n${diagnostics}` : ""
      }`,
    );
  }
  if (exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${exitCode}${
        diagnostics ? `\n${diagnostics}` : ""
      }`,
    );
  }
}

type CapturedOutput = {
  text: Promise<string>;
  tokenSeen: Promise<boolean>;
};

function captureOutput(
  stream: ReadableStream<Uint8Array> | null,
  token: string,
): CapturedOutput {
  let resolveToken!: (seen: boolean) => void;
  const tokenSeen = new Promise<boolean>((resolve) => {
    resolveToken = resolve;
  });

  const text = (async () => {
    if (!stream) {
      resolveToken(false);
      return "";
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = "";
    let seen = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
        if (!seen && result.includes(token)) {
          seen = true;
          resolveToken(true);
        }
      }
      result += decoder.decode();
      if (!seen) resolveToken(false);
    } catch (error) {
      if (!seen) resolveToken(false);
      throw error;
    }
    return result;
  })();

  return { text, tokenSeen };
}

async function requestWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function jsonRequest(
  url: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const body = await response.json();
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function run(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "mnimi-server-runtime-"));
  let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let stdout: Promise<string> | undefined;
  let stderr: Promise<string> | undefined;
  const startupDiagnostics: string[] = [];
  let primaryError: unknown;

  async function serverLogs(): Promise<string> {
    const [stdoutResult, stderrResult] = await Promise.allSettled([
      stdout ?? Promise.resolve(""),
      stderr ?? Promise.resolve(""),
    ]);
    const capturedStdout = stdoutResult.status === "fulfilled"
      ? stdoutResult.value
      : `output stream failed: ${stdoutResult.reason}`;
    const capturedStderr = stderrResult.status === "fulfilled"
      ? stderrResult.value
      : `error stream failed: ${stderrResult.reason}`;
    return lastLines(capturedStdout, capturedStderr);
  }

  async function reapServer(): Promise<{ exitCode: number; logs: string }> {
    if (!server) throw new Error("server process is not running");
    const runningServer = server;
    const exitCode = await runningServer.exited;
    const logs = await serverLogs();
    server = undefined;
    stdout = undefined;
    stderr = undefined;
    return { exitCode, logs };
  }

  async function stopServer(): Promise<string> {
    if (!server) return "";
    const runningServer = server;
    const stopErrors: unknown[] = [];
    const kill = (signal: NodeJS.Signals) => {
      if (runningServer.exitCode !== null) return;
      try {
        runningServer.kill(signal);
      } catch (error) {
        stopErrors.push(error);
      }
    };
    kill("SIGTERM");
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (runningServer.exitCode === null) {
        timedOut = true;
        kill("SIGKILL");
      }
    }, SERVER_SHUTDOWN_TIMEOUT_MS);
    let exitCode: number | undefined;
    try {
      exitCode = await runningServer.exited;
    } catch (error) {
      stopErrors.push(error);
    } finally {
      clearTimeout(timeout);
    }
    if (runningServer.exitCode === null) {
      kill("SIGKILL");
      try {
        exitCode = await runningServer.exited;
      } catch (error) {
        stopErrors.push(error);
      }
    }
    const logs = await serverLogs();
    server = undefined;
    stdout = undefined;
    stderr = undefined;
    if (stopErrors.length > 0) {
      throw new Error(
        `server cleanup failed${
          logs ? `\nserver output:\n${logs}` : ""
        }\n${stopErrors.map((error) => String(error)).join("\n")}`,
      );
    }
    if (timedOut) {
      throw new Error(
        `server did not exit within five seconds of SIGTERM${
          logs ? `\nserver output:\n${logs}` : ""
        }`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(
        `server exited with status ${exitCode}${
          logs ? `\nserver output:\n${logs}` : ""
        }`,
      );
    }
    return logs;
  }

  async function waitForServerReady(
    child: Bun.Subprocess<"ignore", "pipe", "pipe">,
    tokenSeen: Promise<boolean>,
    timeoutMs: number,
  ): Promise<"ready" | "exited" | "timeout"> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const startupTimeout = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const ready = tokenSeen.then((seen) =>
      seen ? "ready" as const : new Promise<never>(() => {})
    );
    try {
      return await Promise.race([
        child.exited.then(() => "exited" as const),
        ready,
        startupTimeout,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  try {
    const databaseUrl = `file:${join(tempDir, "mnimi.db")}`;
    const environment = {
      ...process.env,
      AI_PROVIDER: "openrouter",
      REGISTRATION_ENABLED: "false",
      DATABASE_URL: databaseUrl,
      HOST: "127.0.0.1",
      IMAGES_DIR: join(tempDir, "images"),
      AUDIO_DIR: join(tempDir, "audio"),
      BETTER_AUTH_SECRET: "runtime-smoke-secret-at-least-32-characters",
      // createUser does not persist this base URL. The actual port is selected
      // only after setup and is supplied to each final server attempt below.
      BETTER_AUTH_URL: "http://127.0.0.1:8787",
    };

    await runChecked(
      ["bun", "run", "db:migrate"],
      environment,
      "migration",
    );

    const seedUser = [
      'const { db } = await import("./db/index.ts")',
      'const { createUser } = await import("./scripts/create-user.ts")',
      'await createUser(db, { email: "runtime@example.com", name: "Runtime", password: "correct-horse" }, { secret: process.env.BETTER_AUTH_SECRET, baseURL: process.env.BETTER_AUTH_URL })',
    ].join(";");
    await runChecked(
      ["bun", "--no-env-file", "-e", seedUser],
      environment,
      "user seed",
    );

    const startupDeadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
    let port = 0;
    for (let attempt = 1; attempt <= MAX_SERVER_START_ATTEMPTS; attempt++) {
      const attemptPort = await availablePort();
      const token = `mnimi-runtime-ready:${crypto.randomUUID()}`;
      const serverEnvironment = {
        ...environment,
        PORT: String(attemptPort),
        BETTER_AUTH_URL: `http://127.0.0.1:${attemptPort}`,
        MNIMI_DEV_READY_TOKEN: token,
      };
      const child = Bun.spawn(["bun", "main.ts"], {
        cwd: serverDir,
        env: serverEnvironment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      server = child;
      const capturedStdout = captureOutput(child.stdout, token);
      stdout = capturedStdout.text;
      stderr = output(child.stderr);

      const remaining = startupDeadline - Date.now();
      if (remaining <= 0) {
        throw new Error("server did not become ready within five seconds");
      }
      const readiness = await waitForServerReady(
        child,
        capturedStdout.tokenSeen,
        remaining,
      );
      if (readiness === "ready") {
        port = attemptPort;
        break;
      }
      if (readiness === "timeout") {
        throw new Error("server did not emit its readiness token within five seconds");
      }

      const ended = await reapServer();
      if (
        ended.logs.includes("EADDRINUSE") &&
        attempt < MAX_SERVER_START_ATTEMPTS &&
        Date.now() < startupDeadline
      ) {
        startupDiagnostics.push(ended.logs);
        continue;
      }
      throw new Error(
        `server exited before readiness with status ${ended.exitCode}${
          ended.logs ? `\nserver output:\n${ended.logs}` : ""
        }`,
      );
    }
    if (port === 0) {
      throw new Error(
        `server did not become ready after ${MAX_SERVER_START_ATTEMPTS} attempts`,
      );
    }

    const baseUrl = `http://127.0.0.1:${port}`;
    const remaining = startupDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error("server became ready after the five-second startup deadline");
    }
    const response = await requestWithTimeout(
      `${baseUrl}/`,
      undefined,
      Math.min(REQUEST_TIMEOUT_MS, remaining),
    );
    const responseStatus = response.status;
    await response.body?.cancel();
    if (responseStatus !== 404) {
      throw new Error(`expected HTTP 404, received ${responseStatus}`);
    }

    const registration = await jsonRequest(`${baseUrl}/api/registration`);
    if (
      registration.response.status !== 200 ||
      JSON.stringify(registration.body) !== JSON.stringify({ enabled: false })
    ) {
      throw new Error(
        `registration contract failed: ${registration.response.status} ${JSON.stringify(registration.body)}`,
      );
    }

    const signIn = await jsonRequest(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "runtime@example.com",
        password: "correct-horse",
      }),
    });
    const token = signIn.response.headers.get("set-auth-token");
    if (signIn.response.status !== 200 || !token) {
      throw new Error(
        `sign-in contract failed: ${signIn.response.status} ${JSON.stringify(signIn.body)}`,
      );
    }
    const rpcHeaders = {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
    };
    const created = await jsonRequest(`${baseUrl}/rpc/decks/create`, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({ json: { name: "Runtime smoke" } }),
    });
    if (created.response.status !== 200) {
      throw new Error(
        `deck create failed: ${created.response.status} ${JSON.stringify(created.body)}`,
      );
    }
    const listed = await jsonRequest(`${baseUrl}/rpc/decks/list`, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify({ json: {} }),
    });
    if (
      listed.response.status !== 200 ||
      !JSON.stringify(listed.body).includes("Runtime smoke")
    ) {
      throw new Error(
        `deck list failed: ${listed.response.status} ${JSON.stringify(listed.body)}`,
      );
    }

    for (const path of [
      "/images/notes/0198c0b0-0000-7000-8000-000000000099",
      "/audio/cards/0198c0b0-0000-7000-8000-000000000099",
    ]) {
      const media = await requestWithTimeout(`${baseUrl}${path}`, undefined);
      const mediaStatus = media.status;
      await media.body?.cancel();
      if (mediaStatus !== 401) {
        throw new Error(`media auth failed for ${path}: ${mediaStatus}`);
      }
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  let logs = "";
  try {
    logs = await stopServer();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  const primary = primaryError instanceof Error
    ? primaryError.message
    : primaryError === undefined
    ? ""
    : String(primaryError);
  const diagnostics = [...startupDiagnostics, logs].filter(Boolean).join("\n");
  const cleanupMessages = cleanupErrors.map((error) =>
    error instanceof Error ? error.message : String(error)
  );
  if (primaryError !== undefined) {
    const details = [
      primary,
      diagnostics ? `server output:\n${diagnostics}` : "",
      cleanupMessages.length > 0
        ? `cleanup failed:\n${cleanupMessages.join("\n")}`
        : "",
    ].filter(Boolean).join("\n");
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      details,
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `runtime smoke cleanup failed:\n${cleanupMessages.join("\n")}${
        diagnostics ? `\nserver output:\n${diagnostics}` : ""
      }`,
    );
  }
}

await run();
