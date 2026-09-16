import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const temporaryDirectories: string[] = [];
const serverDir = fileURLToPath(new URL(".", import.meta.url));

async function streamText(stream: NodeJS.ReadableStream | null) {
  if (!stream) return "";
  let output = "";
  for await (const chunk of stream) output += chunk.toString();
  return output;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("server import boundary", () => {
  it("imports pure transport modules without opening production resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "mnimi-import-boundary-"));
    temporaryDirectories.push(root);
    const databaseDir = join(root, "database");
    const imagesDir = join(root, "images");
    const audioDir = join(root, "audio");
    const source = [
      'await import("./app.ts")',
      'await import("./router/index.ts")',
      'await import("./images.ts")',
      'await import("./audio.ts")',
      'await import("./effect/index.ts")',
      'await import("./effect/config.ts")',
      'await import("./effect/logging.ts")',
      'await import("./effect/database.ts")',
      'await import("./effect/auth.ts")',
      'await import("./effect/live.ts")',
      'await import("./effect/core-runtime.ts")',
      'await import("./effect/testing.ts")',
      'await import("./effect/media.ts")',
      'await import("./effect/elevenlabs.ts")',
      'await import("./effect/ai-generation.ts")',
      'await import("./effect/openrouter.ts")',
      'await import("./effect/codex-runtime.ts")',
      'await import("./effect/expo-push.ts")',
      'await import("./effect/notifications.ts")',
      'const effectApi = await import("./effect/index.ts")',
      'for (const name of ["MediaStore", "ElevenLabs", "AiGeneration", "OpenRouter", "CodexRuntime", "ExpoPush", "Notifications"]) if (!(name in effectApi)) throw new Error(`missing Effect export: ${name}`)',
    ].join(";");
    const child = spawn("bun", ["--no-env-file", "-e", source], {
      cwd: serverDir,
      env: {
        ...globalThis.process.env,
        DATABASE_URL: `file:${join(databaseDir, "mnimi.db")}`,
        IMAGES_DIR: imagesDir,
        AUDIO_DIR: audioDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? -1));
      }),
      streamText(child.stdout),
      streamText(child.stderr),
    ]);

    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(existsSync(databaseDir)).toBe(false);
    expect(existsSync(imagesDir)).toBe(false);
    expect(existsSync(audioDir)).toBe(false);
  });

  it("keeps the process bootstrap and owned Effect modules within their import boundary", async () => {
    const mainSource = await readFile(join(serverDir, "main.ts"), "utf8");
    expect(mainSource).not.toMatch(/import\s+(?!type\b)[^;]*["']\.\/db\/index\.ts["']/s);
    expect(mainSource).not.toMatch(/from\s+["']\.\/auth\.instance\.ts["']/);
    expect(mainSource).not.toMatch(/serverOptions/);
    expect(mainSource).not.toMatch(/process\.(?:env|argv)/);

    const coreOwnedEffectModules = [
      "config.ts", "logging.ts", "database.ts", "auth.ts", "live.ts",
      "core-runtime.ts", "index.ts",
    ];
    const coreOwnedSources = await Promise.all(
      coreOwnedEffectModules.map((name) => readFile(join(serverDir, "effect", name), "utf8")),
    );
    const forbiddenRuntimeImport = /from\s+["']\.\.\/(?:app|router|ai|images|audio|logging)[^"']*["']/;
    for (const source of coreOwnedSources) {
      expect(source).not.toMatch(forbiddenRuntimeImport);
    }

    const adapterOwnedEffectModules = [
      "media.ts", "elevenlabs.ts", "ai-generation.ts", "openrouter.ts",
      "codex-runtime.ts", "expo-push.ts", "notifications.ts",
    ];
    const adapterOwnedSources = await Promise.all(
      adapterOwnedEffectModules.map((name) => readFile(join(serverDir, "effect", name), "utf8")),
    );
    const forbiddenAdapterImport = /from\s+["']\.\.\/(?:main|app|router|creations|images|audio|logging|jobs?|workers?|schedulers?|notifications)(?:[/.][^"']*)?["']/;
    for (const source of adapterOwnedSources) {
      expect(source).not.toMatch(forbiddenAdapterImport);
      expect(source).not.toMatch(/process\.(?:env|argv)/);
    }
  });

  it("does not retain legacy process-installed workflow facades", async () => {
    const legacyModules = [
      "ai/jobs.ts",
      "creations/image-scheduler.ts",
      "creations/scheduler.ts",
      "notifications/dispatcher.ts",
      "tts/jobs.ts",
    ];
    const sources = await Promise.all(
      legacyModules.map((name) => readFile(join(serverDir, name), "utf8")),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/install[A-Za-z]+Facade/);
    }
  });

  it("does not retain the database-keyed creation event facade", () => {
    expect(existsSync(join(serverDir, "creations", "events.ts"))).toBe(false);
  });

  it("keeps oRPC error construction at the transport boundary", async () => {
    const routerModules = [
      "router/ai.ts", "router/cards.ts", "router/creation-save.ts",
      "router/debug.ts", "router/decks.ts", "router/drafts.ts",
      "router/note-card-operations.ts", "router/notes.ts",
      "router/notifications.ts",
    ];
    const sources = await Promise.all(
      routerModules.map((name) => readFile(join(serverDir, name), "utf8")),
    );

    for (const source of sources) {
      expect(source).not.toMatch(/from\s+["']@orpc\/server["']/);
      expect(source).not.toMatch(/\bORPCError\b/);
    }
  });
});
