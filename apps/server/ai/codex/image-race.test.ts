import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readGeneratedImage } from "./image-result.ts";
import { CodexProviderError } from "./protocol.ts";
import { openCodexImageWorkspace } from "./workspace-files.ts";

// Inject scheduling at real filesystem boundaries; every open/stat/read still
// uses an actual file. Reopening a checked pathname will disclose the sentinel.
const races = vi.hoisted(() => ({
  afterStat: undefined as undefined | (() => Promise<void>),
  afterRead: undefined as undefined | (() => Promise<void>),
  unavailableAnchor: false,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  async function checked<T extends { isFile(): boolean } | undefined>(stats: T): Promise<T> {
    if (stats?.isFile() && races.afterStat) {
      const mutate = races.afterStat;
      races.afterStat = undefined;
      await mutate();
    }
    return stats;
  }
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (races.unavailableAnchor && String(args[0]).startsWith("/proc/self/fd/")) throw new Error("private anchor path");
      return checked(await fs.stat(...args));
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      const stat = file.stat.bind(file);
      const read = file.read.bind(file);
      file.stat = (async (...args: Parameters<typeof stat>) => checked(await stat(...args))) as typeof stat;
      file.read = (async (...args: Parameters<typeof read>) => {
        const result = await read(...args);
        if (races.afterRead) {
          const mutate = races.afterRead;
          races.afterRead = undefined;
          await mutate();
        }
        return result;
      }) as typeof read;
      return file;
    },
  };
});

let fixture: string;
let workspace: string;
let image: string;
const inside = new Uint8Array([1, 2, 3]);
const outside = new Uint8Array([83, 69, 67, 82, 69, 84]);
const maxBytes = 25 * 1024 * 1024;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "mnimi-image-race-"));
  workspace = join(fixture, "workspace");
  await mkdir(join(workspace, "nested"), { recursive: true });
  image = join(workspace, "nested", "image.png");
  await writeFile(image, inside);
  await mkdir(join(fixture, "outside"));
  await writeFile(join(fixture, "outside", "image.png"), outside);
});

afterEach(async () => {
  races.afterStat = races.afterRead = undefined;
  races.unavailableAnchor = false;
  await rm(fixture, { recursive: true, force: true });
});

function readImage() {
  return readGeneratedImage({ id: "turn", status: "completed", items: [{
    type: "imageGeneration", status: "completed", failure: null, savedPath: "nested/image.png",
  }] }, workspace);
}

it("fails closed when descriptor-relative filesystem access is unavailable", async () => {
  races.unavailableAnchor = true;
  const error = await readImage().catch((error: unknown) => error);
  expect(error).toMatchObject({ category: "image" });
  expect(String(error)).not.toMatch(/private|\/proc|mnimi-image-race/);
  expect(error).not.toHaveProperty("cause");
});

it.each(["file", "directory"])("never reads outside bytes when a checked %s is replaced by a symlink", async (kind) => {
  let replaced = false;
  races.afterStat = async () => {
    const target = kind === "file" ? image : join(workspace, "nested");
    await rename(target, `${target}-original`);
    await symlink(kind === "file" ? join(fixture, "outside", "image.png") : join(fixture, "outside"), target);
    replaced = true;
  };
  const result = await readImage().catch((error: unknown) => error);
  expect(replaced).toBe(true);
  if (result instanceof CodexProviderError) {
    expect(result.category).toBe("image");
    expect(String(result)).not.toMatch(/SECRET|mnimi-image-race|outside/);
  } else {
    expect(result).toEqual(inside);
  }
});

it("rejects growth beyond 25 MiB after descriptor validation", async () => {
  races.afterStat = () => truncate(image, maxBytes + 1);
  expect(await readImage().then(() => "returned-bytes", (error) => error.category)).toBe("image");
});

it("enforces the maximum when the opened file grows during the byte copy", async () => {
  let grew = false;
  races.afterRead = async () => { grew = true; await truncate(image, maxBytes + 1); };
  expect(await readImage().then(() => "returned-bytes", (error) => error.category)).toBe("image");
  expect(grew).toBe(true);
});

it("removes the opened Codex artifact when its parent is replaced after reading", async () => {
  const codexHome = join(fixture, "codex");
  const artifactDirectory = join(codexHome, "generated_images", "thread-1");
  const artifact = join(artifactDirectory, "image.png");
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(artifact, inside);
  let replaced = false;
  races.afterRead = async () => {
    await rename(artifactDirectory, `${artifactDirectory}-original`);
    await symlink(join(fixture, "outside"), artifactDirectory, "dir");
    replaced = true;
  };

  const artifactAnchor = await openCodexImageWorkspace(codexHome);
  let result: unknown;
  try {
    result = await readGeneratedImage({ id: "turn", status: "completed", items: [{
      type: "imageGeneration", status: "completed", failure: null, savedPath: artifact,
    }] }, workspace, undefined, artifactAnchor).catch((error: unknown) => error);
  } finally {
    await artifactAnchor.directory.close();
  }
  expect(replaced).toBe(true);
  expect(result).toEqual(inside);
  await expect(access(`${artifactDirectory}-original/image.png`))
    .rejects.toMatchObject({ code: "ENOENT" });
  expect(new Uint8Array(await readFile(join(fixture, "outside", "image.png")))).toEqual(outside);
});
