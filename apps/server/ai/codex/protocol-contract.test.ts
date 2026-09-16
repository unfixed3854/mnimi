import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { scheduleDeadline, terminateAndReap, terminateProcessTree, TERMINATION_GRACE_MS, WINDOWS_TREE_KILLER_TIMEOUT_MS } from "./process-tree.ts";
import {
  codexChildEnv,
  codexCliCommand,
  ensurePrivateCodexHome,
} from "./runtime.ts";

type JsonObject = Record<string, unknown>;
type SchemaGeneratorExit =
  | { kind: "exit"; exitCode: number }
  | { kind: "signal"; signal: NodeJS.Signals | null }
  | { kind: "spawn-error" };
type SchemaGeneratorProcess = {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<SchemaGeneratorExit>;
  terminateTree(): void | Promise<void>;
  killDirect(): void;
  destroyOutput(): void;
};
type SchemaGeneratorOptions = {
  start?: (command: string[], env: Record<string, string>) => SchemaGeneratorProcess;
  scheduleDeadline?: (callback: () => void, milliseconds: number) => () => void;
  timeoutMs?: number;
};
type SchemaGeneratorAdapterOptions = {
  platform?: NodeJS.Platform;
  spawnChild?: typeof spawn;
  startWindowsTreeKiller?: (pid: number) => ChildProcess;
  scheduleDeadline?: NonNullable<SchemaGeneratorOptions["scheduleDeadline"]>;
};

const SCHEMA_GENERATION_TIMEOUT_MS = 4_000;

function startSchemaGenerator(
  command: string[],
  env: Record<string, string>,
  options: SchemaGeneratorAdapterOptions = {},
): SchemaGeneratorProcess {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error("Codex schema generation could not start");
  const platform = options.platform ?? process.platform;
  const spawnChild = options.spawnChild ?? spawn;
  const schedule = options.scheduleDeadline ?? scheduleDeadline;

  const child = (() => {
    try {
      return spawnChild(executable, args, {
        detached: platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("Codex schema generation could not start");
    }
  })();
  const exited = new Promise<SchemaGeneratorExit>((resolve) => {
    let settled = false;
    const finish = (exit: SchemaGeneratorExit) => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.once("error", () => finish({ kind: "spawn-error" }));
    child.once("exit", (code, signal) => {
      finish(code === null
        ? { kind: "signal", signal }
        : { kind: "exit", exitCode: code });
    });
  });

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    terminateTree: () => terminateProcessTree(child, {
      platform, startWindowsTreeKiller: options.startWindowsTreeKiller, scheduleDeadline: schedule,
    }),
    killDirect() {
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child may already have exited.
      }
    },
    destroyOutput() {
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}


async function cappedByteCount(
  stream: AsyncIterable<Uint8Array>,
  limit = 65_536,
): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) {
    bytes = Math.min(limit, bytes + chunk.byteLength);
  }
  return bytes;
}


async function runSchemaGenerator(
  command: string[],
  env: Record<string, string>,
  options: SchemaGeneratorOptions,
): Promise<void> {
  let generator: SchemaGeneratorProcess;
  try {
    generator = options.start === undefined
      ? startSchemaGenerator(command, env, {
          scheduleDeadline: options.scheduleDeadline,
        })
      : options.start(command, env);
  } catch {
    throw new Error("Codex schema generation could not start");
  }

  const stdoutBytes = cappedByteCount(generator.stdout).catch(() => 0);
  const stderrBytes = cappedByteCount(generator.stderr).catch(() => 0);
  const exited = generator.exited.catch(
    (): SchemaGeneratorExit => ({ kind: "spawn-error" }),
  );
  const completion = exited.then(async (exit) => {
    if (exit.kind === "spawn-error") {
      return { kind: "completed" as const, exit, stdoutCount: 0, stderrCount: 0 };
    }
    const [stdoutCount, stderrCount] = await Promise.all([stdoutBytes, stderrBytes]);
    return { kind: "completed" as const, exit, stdoutCount, stderrCount };
  });
  let resolveTimeout!: () => void;
  const timedOut = new Promise<{ kind: "timeout" }>((resolve) => {
    resolveTimeout = () => resolve({ kind: "timeout" });
  });
  const schedule = options.scheduleDeadline ?? scheduleDeadline;
  const cancelDeadline = schedule(
    resolveTimeout,
    options.timeoutMs ?? SCHEMA_GENERATION_TIMEOUT_MS,
  );

  try {
    const outcome = await Promise.race([completion, timedOut]);
    if (outcome.kind === "timeout") {
      await terminateAndReap(generator, schedule);
      throw new Error("Codex schema generation timed out");
    }

    if (outcome.exit.kind === "spawn-error") {
      throw new Error("Codex schema generation could not start");
    }
    if (outcome.exit.kind === "signal") {
      throw new Error(
        `Codex schema generation ended from signal ${outcome.exit.signal ?? "unknown"}`,
      );
    }

    if (outcome.exit.exitCode !== 0) {
      throw new Error(
        `Codex schema generation exited with code ${outcome.exit.exitCode} ` +
        `(captured stdout bytes: ${outcome.stdoutCount}, ` +
        `stderr bytes: ${outcome.stderrCount})`,
      );
    }
  } finally {
    cancelDeadline();
  }
}

async function withGeneratedSchemas<T>(
  visit: (schemaDirectory: string) => Promise<T>,
  options: SchemaGeneratorOptions = {},
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mnimi-codex-schema-"));
  const schemaDirectory = join(temporaryRoot, "schemas");
  const codexHome = join(temporaryRoot, "home");

  try {
    await ensurePrivateCodexHome(codexHome);
    await runSchemaGenerator(
      codexCliCommand([
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
        schemaDirectory,
      ]),
      codexChildEnv(codexHome),
      options,
    );
    return await visit(schemaDirectory);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, context: string): JsonObject {
  if (!isObject(value)) throw new Error(`Expected object schema at ${context}`);
  return value;
}

function resolveReference(root: JsonObject, value: unknown): unknown {
  let current = value;
  const visited = new Set<string>();

  while (isObject(current) && typeof current.$ref === "string") {
    const reference = current.$ref;
    if (!reference.startsWith("#/") || visited.has(reference)) {
      throw new Error(`Unsupported schema reference: ${reference}`);
    }
    visited.add(reference);
    current = reference
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<unknown>((node, part) => object(node, reference)[part], root);
  }

  return current;
}

function unionBranches(root: JsonObject, value: unknown): unknown[] {
  const schema = object(resolveReference(root, value), "union");
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const union = schema[keyword];
    if (Array.isArray(union)) {
      return union.flatMap((branch) => unionBranches(root, branch));
    }
  }
  return [schema];
}

function findProperty(
  root: JsonObject,
  value: unknown,
  propertyName: string,
): unknown | undefined {
  const schema = object(resolveReference(root, value), propertyName);
  if (isObject(schema.properties) && propertyName in schema.properties) {
    return schema.properties[propertyName];
  }
  for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
    const composition = schema[keyword];
    if (!Array.isArray(composition)) continue;
    for (const branch of composition) {
      const property = findProperty(root, branch, propertyName);
      if (property !== undefined) return property;
    }
  }
  return undefined;
}

function property(root: JsonObject, value: unknown, propertyName: string): unknown {
  const found = findProperty(root, value, propertyName);
  if (found === undefined) throw new Error(`Missing schema property: ${propertyName}`);
  return found;
}

function expectRequired(root: JsonObject, value: unknown, fields: string[]): void {
  const schema = object(resolveReference(root, value), "required fields");
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = fields.filter((field) => !required.includes(field));
  if (missing.length > 0) {
    throw new Error(`Missing required schema fields: ${missing.join(", ")}`);
  }
}

function expectIncludes(
  actual: unknown[],
  expected: unknown[],
  context: string,
): void {
  const missing = expected.filter(
    (value) => !actual.some((candidate) => jsonEqual(candidate, value)),
  );
  if (missing.length > 0) {
    throw new Error(`Missing ${context}: ${missing.map(String).join(", ")}`);
  }
}

function literalValues(root: JsonObject, value: unknown): unknown[] {
  const schema = object(resolveReference(root, value), "literal values");
  const values: unknown[] = [];
  if ("const" in schema) values.push(schema.const);
  if (Array.isArray(schema.enum)) values.push(...schema.enum);
  for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
    const composition = schema[keyword];
    if (Array.isArray(composition)) {
      for (const branch of composition) values.push(...literalValues(root, branch));
    }
  }
  return values;
}

function propertyLiteralValues(
  root: JsonObject,
  value: unknown,
  propertyName: string,
): unknown[] {
  return unionBranches(root, value).flatMap((branch) => {
    const found = findProperty(root, branch, propertyName);
    return found === undefined ? [] : literalValues(root, found);
  });
}

function findVariant(
  root: JsonObject,
  value: unknown,
  propertyName: string,
  discriminator: unknown,
): unknown {
  const variant = unionBranches(root, value).find((branch) => {
    const found = findProperty(root, branch, propertyName);
    return found !== undefined && literalValues(root, found).includes(discriminator);
  });
  if (variant === undefined) {
    throw new Error(`Missing ${propertyName} variant: ${String(discriminator)}`);
  }
  return variant;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function schemaAccepts(root: JsonObject, value: unknown, instance: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;
  const schema = object(resolveReference(root, value), "validation");

  if (Array.isArray(schema.allOf) &&
      !schema.allOf.every((branch) => schemaAccepts(root, branch, instance))) {
    return false;
  }
  if (Array.isArray(schema.anyOf) &&
      !schema.anyOf.some((branch) => schemaAccepts(root, branch, instance))) {
    return false;
  }
  if (Array.isArray(schema.oneOf) &&
      schema.oneOf.filter((branch) => schemaAccepts(root, branch, instance)).length !== 1) {
    return false;
  }
  if ("const" in schema && !jsonEqual(schema.const, instance)) return false;
  if (Array.isArray(schema.enum) &&
      !schema.enum.some((candidate) => jsonEqual(candidate, instance))) {
    return false;
  }

  const types = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type) ? schema.type : [];
  if (types.length > 0) {
    const actualType = instance === null
      ? "null"
      : Array.isArray(instance) ? "array" : typeof instance;
    if (!types.includes(actualType)) return false;
  }

  if (isObject(instance)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (!required.every((key) => typeof key === "string" && key in instance)) {
      return false;
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, propertyValue] of Object.entries(instance)) {
      if (key in properties) {
        if (!schemaAccepts(root, properties[key], propertyValue)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (isObject(schema.additionalProperties) &&
                 !schemaAccepts(root, schema.additionalProperties, propertyValue)) {
        return false;
      }
    }
  }

  return true;
}

async function readSchema(directory: string, name: string): Promise<JsonObject> {
  return object(
    JSON.parse(await readFile(join(directory, name), "utf8")),
    name,
  );
}

function arrayItem(root: JsonObject, value: unknown): unknown {
  const schema = object(resolveReference(root, value), "array items");
  if (!("items" in schema)) throw new Error("Missing array item schema");
  return schema.items;
}

it("matches every Codex app-server schema consumed by the provider", async () => {
  await withGeneratedSchemas(async (schemaDirectory) => {
    const initialize = await readSchema(schemaDirectory, "v1/InitializeParams.json");
    expectRequired(initialize, initialize, ["clientInfo"]);
    expect(property(initialize, property(initialize, initialize, "capabilities"), "experimentalApi"))
      .toBeDefined();

    const threadStart = await readSchema(schemaDirectory, "v2/ThreadStartParams.json");
    for (const field of [
      "ephemeral",
      "developerInstructions",
      "permissions",
      "runtimeWorkspaceRoots",
      "allowProviderModelFallback",
    ]) {
      expect(property(threadStart, threadStart, field)).toBeDefined();
    }

    const turnStart = await readSchema(schemaDirectory, "v2/TurnStartParams.json");
    expectRequired(turnStart, turnStart, ["threadId", "input"]);
    expect(property(turnStart, turnStart, "effort")).toBeDefined();
    expect(property(turnStart, turnStart, "outputSchema")).toBeDefined();
    const unsubscribe = await readSchema(schemaDirectory, "v2/ThreadUnsubscribeParams.json");
    expectRequired(unsubscribe, unsubscribe, ["threadId"]);

    const account = await readSchema(schemaDirectory, "v2/GetAccountResponse.json");
    expectIncludes(
      propertyLiteralValues(account, property(account, account, "account"), "type"),
      ["apiKey", "chatgpt"],
      "account variants",
    );

    const modelList = await readSchema(schemaDirectory, "v2/ModelListResponse.json");
    const model = arrayItem(modelList, property(modelList, modelList, "data"));
    expect(property(modelList, model, "model")).toBeDefined();
    const reasoningEfforts = property(modelList, model, "supportedReasoningEfforts");
    expect(property(modelList, arrayItem(modelList, reasoningEfforts), "reasoningEffort"))
      .toBeDefined();

    const capabilities = await readSchema(
      schemaDirectory,
      "v2/ModelProviderCapabilitiesReadResponse.json",
    );
    expectRequired(capabilities, capabilities, ["imageGeneration"]);

    const delta = await readSchema(
      schemaDirectory,
      "v2/AgentMessageDeltaNotification.json",
    );
    expectRequired(delta, delta, ["threadId", "turnId", "itemId", "delta"]);

    const rerouted = await readSchema(schemaDirectory, "v2/ModelReroutedNotification.json");
    expectRequired(rerouted, rerouted, ["fromModel", "toModel"]);

    const turnCompleted = await readSchema(
      schemaDirectory,
      "v2/TurnCompletedNotification.json",
    );
    const completedTurn = property(turnCompleted, turnCompleted, "turn");
    for (const field of ["items", "status", "error"]) {
      expect(property(turnCompleted, completedTurn, field)).toBeDefined();
    }

    const itemCompleted = await readSchema(
      schemaDirectory,
      "v2/ItemCompletedNotification.json",
    );
    const imageGeneration = findVariant(
      itemCompleted,
      property(itemCompleted, itemCompleted, "item"),
      "type",
      "imageGeneration",
    );
    expect(property(itemCompleted, imageGeneration, "savedPath")).toBeDefined();

    const refusalCases: Array<[string, unknown]> = [
      ["CommandExecutionRequestApprovalResponse.json", { decision: "decline" }],
      ["FileChangeRequestApprovalResponse.json", { decision: "decline" }],
      ["ExecCommandApprovalResponse.json", { decision: "abort" }],
      ["ApplyPatchApprovalResponse.json", { decision: "abort" }],
      ["PermissionsRequestApprovalResponse.json", { permissions: {}, scope: "turn" }],
      ["McpServerElicitationRequestResponse.json", { action: "cancel", content: null }],
      ["ToolRequestUserInputResponse.json", { answers: {} }],
    ];
    for (const [name, refusal] of refusalCases) {
      const response = await readSchema(schemaDirectory, name);
      expect(schemaAccepts(response, response, refusal), name).toBe(true);
    }

    const clientRequests = await readSchema(schemaDirectory, "ClientRequest.json");
    expectIncludes(
      propertyLiteralValues(clientRequests, clientRequests, "method"),
      [
        "thread/start",
        "thread/unsubscribe",
        "turn/start",
        "turn/interrupt",
        "model/list",
        "modelProvider/capabilities/read",
        "account/read",
      ],
      "client request methods",
    );

    const serverRequests = await readSchema(schemaDirectory, "ServerRequest.json");
    expectIncludes(
      propertyLiteralValues(serverRequests, serverRequests, "method"),
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "execCommandApproval",
        "applyPatchApproval",
        "item/permissions/requestApproval",
        "mcpServer/elicitation/request",
        "item/tool/requestUserInput",
      ],
      "server request methods",
    );
  });
}, 10_000);

it("settles timeout cleanup after launcher exit while descendant pipes stay open", async () => {
  let fireDeadline: (() => void) | undefined;
  let generatedDirectory: string | undefined;
  const cancelDeadline = vi.fn();
  const cancelExitGrace = vi.fn();
  const visit = vi.fn(async () => undefined);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.write(Buffer.from("private stdout"));
  stderr.write(Buffer.from("private stderr"));
  const killLauncher = vi.fn(() => true);
  const launcher = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    pid: undefined,
    kill: killLauncher,
  }) as unknown as ChildProcessWithoutNullStreams;
  const spawnChild = vi.fn(() => launcher) as unknown as typeof spawn;

  const outcome = withGeneratedSchemas(visit, {
    timeoutMs: 123,
    scheduleDeadline: (callback, milliseconds) => {
      if (milliseconds === 123) {
        fireDeadline = callback;
        return cancelDeadline;
      }
      expect(milliseconds).toBe(TERMINATION_GRACE_MS);
      return cancelExitGrace;
    },
    start: (command, env) => {
      generatedDirectory = command.at(-1);
      return startSchemaGenerator(["controlled-launcher"], env, { spawnChild });
    },
  }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );

  await vi.waitFor(() => expect(fireDeadline).toBeTypeOf("function"));
  launcher.emit("exit", 0, null);
  fireDeadline!();
  expect(launcher.listenerCount("close")).toBe(0);

  const result = await outcome;
  expect(result.error).toMatchObject({ message: "Codex schema generation timed out" });
  expect(String(result.error)).not.toMatch(/private|mnimi-codex-schema/);
  expect(result.value).toBeUndefined();
  expect(killLauncher).toHaveBeenCalledWith("SIGKILL");
  expect(stdout.destroyed).toBe(true);
  expect(stderr.destroyed).toBe(true);
  expect(cancelDeadline).toHaveBeenCalledOnce();
  expect(cancelExitGrace).toHaveBeenCalledOnce();
  expect(visit).not.toHaveBeenCalled();
  expect(generatedDirectory).toBeTypeOf("string");
  await expect(stat(dirname(generatedDirectory!))).rejects.toMatchObject({ code: "ENOENT" });
});

function controlledWindowsProcesses() {
  const events: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.write(Buffer.from("private stdout"));
  stderr.write(Buffer.from("private stderr"));
  let launcher!: ChildProcessWithoutNullStreams;
  const killLauncher = vi.fn(() => {
    events.push("launcher:kill");
    queueMicrotask(() => launcher.emit("exit", null, "SIGKILL"));
    return true;
  });
  launcher = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    pid: 4_242,
    kill: killLauncher,
  }) as unknown as ChildProcessWithoutNullStreams;
  const treeKiller = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => {
      events.push("tree:kill");
      return true;
    }),
    unref: vi.fn(),
  });

  return {
    events,
    stdout,
    stderr,
    launcher,
    killLauncher,
    treeKiller,
    spawnChild: vi.fn(() => launcher) as unknown as typeof spawn,
    startTreeKiller: vi.fn(() => {
      events.push("tree:start");
      return treeKiller;
    }),
  };
}

it("waits for the Windows tree helper before killing the launcher", async () => {
  const controlled = controlledWindowsProcesses();
  const scheduled: Array<{ callback: () => void; milliseconds: number }> = [];
  let generatedDirectory: string | undefined;
  const outcome = withGeneratedSchemas(async () => undefined, {
    timeoutMs: 123,
    scheduleDeadline: (callback, milliseconds) => {
      scheduled.push({ callback, milliseconds });
      return vi.fn();
    },
    start: (command, env) => {
      generatedDirectory = command.at(-1);
      return startSchemaGenerator(["controlled-launcher"], env, {
        platform: "win32",
        spawnChild: controlled.spawnChild,
        startWindowsTreeKiller: controlled.startTreeKiller as unknown as () => ChildProcess,
        scheduleDeadline: (callback: () => void, milliseconds: number) => {
          scheduled.push({ callback, milliseconds });
          return vi.fn();
        },
      });
    },
  }).catch((error: unknown) => error);

  await vi.waitFor(() => expect(scheduled).toHaveLength(1));
  scheduled[0]!.callback();
  await vi.waitFor(() => expect(controlled.startTreeKiller).toHaveBeenCalledOnce());
  expect(controlled.startTreeKiller).toHaveBeenCalledWith(4_242);
  expect(scheduled[1]?.milliseconds).toBe(WINDOWS_TREE_KILLER_TIMEOUT_MS);
  expect(controlled.killLauncher).not.toHaveBeenCalled();
  controlled.events.push("tree:exit");
  controlled.treeKiller.emit("exit", 0, null);

  const error = await outcome;
  expect(error).toMatchObject({ message: "Codex schema generation timed out" });
  expect(controlled.events).toEqual(["tree:start", "tree:exit", "launcher:kill"]);
  expect(controlled.treeKiller.unref).toHaveBeenCalledOnce();
  expect(controlled.treeKiller.kill).not.toHaveBeenCalled();
  expect(controlled.stdout.destroyed).toBe(true);
  expect(controlled.stderr.destroyed).toBe(true);
  await expect(stat(dirname(generatedDirectory!))).rejects.toMatchObject({ code: "ENOENT" });
});

it("bounds and kills a stalled Windows tree helper before launcher fallback", async () => {
  const controlled = controlledWindowsProcesses();
  const scheduled: Array<{ callback: () => void; milliseconds: number }> = [];
  let generatedDirectory: string | undefined;
  const outcome = withGeneratedSchemas(async () => undefined, {
    timeoutMs: 123,
    scheduleDeadline: (callback, milliseconds) => {
      scheduled.push({ callback, milliseconds });
      return vi.fn();
    },
    start: (command, env) => {
      generatedDirectory = command.at(-1);
      return startSchemaGenerator(["controlled-launcher"], env, {
        platform: "win32",
        spawnChild: controlled.spawnChild,
        startWindowsTreeKiller: controlled.startTreeKiller as unknown as () => ChildProcess,
        scheduleDeadline: (callback: () => void, milliseconds: number) => {
          scheduled.push({ callback, milliseconds });
          return vi.fn();
        },
      });
    },
  }).catch((error: unknown) => error);

  await vi.waitFor(() => expect(scheduled).toHaveLength(1));
  scheduled[0]!.callback();
  await vi.waitFor(() => expect(scheduled).toHaveLength(2));
  expect(controlled.startTreeKiller).toHaveBeenCalledWith(4_242);
  expect(scheduled[1]?.milliseconds).toBe(WINDOWS_TREE_KILLER_TIMEOUT_MS);
  expect(controlled.killLauncher).not.toHaveBeenCalled();
  scheduled[1]!.callback();
  await vi.waitFor(() => expect(controlled.treeKiller.kill).toHaveBeenCalledWith("SIGKILL"));
  expect(controlled.killLauncher).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(scheduled).toHaveLength(3));
  expect(scheduled[2]?.milliseconds).toBe(WINDOWS_TREE_KILLER_TIMEOUT_MS);
  scheduled[2]!.callback();

  const error = await outcome;
  expect(error).toMatchObject({ message: "Codex schema generation timed out" });
  expect(controlled.events).toEqual(["tree:start", "tree:kill", "launcher:kill"]);
  expect(controlled.treeKiller.unref).toHaveBeenCalledOnce();
  expect(controlled.stdout.destroyed).toBe(true);
  expect(controlled.stderr.destroyed).toBe(true);
  await expect(stat(dirname(generatedDirectory!))).rejects.toMatchObject({ code: "ENOENT" });
});
