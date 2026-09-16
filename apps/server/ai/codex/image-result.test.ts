import { access, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGeneratedImage } from "./image-result.ts";
import type { CodexCompletedTurn } from "./operation.ts";
import { CodexProviderError } from "./protocol.ts";
import { openCodexImageWorkspace } from "./workspace-files.ts";

function imageItem(savedPath: unknown, overrides: Record<string, unknown> = {}) {
  return { id: "image-1", type: "imageGeneration", status: "completed", result: "generated", failure: null, savedPath, ...overrides };
}

function turn(items: unknown[]): CodexCompletedTurn {
  return { id: "turn-1", status: "completed", items };
}

describe("readGeneratedImage", () => {
  let fixture: string;
  let workspace: string;
  let outside: string;
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "mnimi-image-result-"));
    workspace = join(fixture, "workspace");
    outside = join(fixture, "private-outside.png");
    await mkdir(workspace);
    await writeFile(join(workspace, "image.png"), bytes);
    await writeFile(outside, bytes);
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  async function rejectsImage(items: unknown[], root = workspace) {
    const error = await readGeneratedImage(turn(items), root).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CodexProviderError);
    expect(error).toMatchObject({ category: "image" });
    expect((error as Error).message).not.toMatch(/mnimi-image-result-|private-outside|image\.png|ENOENT|ELOOP/);
    expect(error).not.toHaveProperty("cause");
  }

  async function readCodexArtifact(codexHome: string, savedPath: string) {
    const artifactAnchor = await openCodexImageWorkspace(codexHome);
    try {
      return await readGeneratedImage(
        turn([imageItem(savedPath)]),
        workspace,
        undefined,
        artifactAnchor,
      );
    } finally {
      await artifactAnchor.directory.close();
    }
  }

  it.each(["relative", "absolute"])("copies a regular in-workspace PNG using a %s path", async (kind) => {
    const savedPath = kind === "relative" ? "image.png" : join(workspace, "image.png");
    const result = await readGeneratedImage(turn([imageItem(savedPath)]), workspace);
    await rm(join(workspace, "image.png"));
    expect(result).toEqual(bytes);
    expect(result.constructor).toBe(Uint8Array);
  });

  it("selects the last image-generation item", async () => {
    await writeFile(join(workspace, "last.png"), new Uint8Array([42]));
    expect(await readGeneratedImage(turn([
      imageItem("image.png"), null, { type: "agentMessage", text: "ignore" }, imageItem("last.png"),
    ]), workspace)).toEqual(new Uint8Array([42]));
  });

  it("does not fall back to an earlier image when the last image failed", async () => {
    await rejectsImage([imageItem("image.png"), imageItem("image.png", { status: "failed" })]);
  });

  it("rejects missing image-generation items", async () => {
    await rejectsImage([null, { type: "agentMessage", text: "image.png" }]);
  });

  it.each([
    { status: "inProgress" }, { status: "failed" },
    { failure: "private-outside.png" }, { failure: {} }, { failure: undefined },
  ])("rejects unsuccessful image items: %j", async (overrides) => {
    await rejectsImage([imageItem("image.png", overrides)]);
  });

  it.each([null, "", "  ", 123, {}, undefined])("rejects invalid savedPath %j", async (savedPath) => {
    await rejectsImage([imageItem(savedPath)]);
  });

  it.each(["../private-outside.png", "../workspace/image.png", "nested/../image.png"])("rejects relative traversal %s", async (savedPath) => {
    await rejectsImage([imageItem(savedPath)]);
  });

  it("rejects an external absolute path", async () => {
    await rejectsImage([imageItem(outside)]);
  });

  it("rejects a Codex artifact root redirected through a symlink", async () => {
    const codexHome = join(fixture, "codex");
    const redirected = join(fixture, "redirected-artifacts");
    await mkdir(codexHome);
    await mkdir(redirected);
    await writeFile(join(redirected, "image.png"), bytes);
    await symlink(redirected, join(codexHome, "generated_images"));

    const error = await readCodexArtifact(
      codexHome,
      join(codexHome, "generated_images", "image.png"),
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ category: "image" });
  });

  it("removes a consumed Codex-owned artifact", async () => {
    const codexHome = join(fixture, "codex");
    const image = join(codexHome, "generated_images", "thread-1", "image.png");
    await mkdir(join(codexHome, "generated_images", "thread-1"), { recursive: true });
    await writeFile(image, bytes);

    expect(await readCodexArtifact(codexHome, image)).toEqual(bytes);
    await expect(access(image)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unrelated absolute path with a Codex artifact root configured", async () => {
    const codexHome = join(fixture, "codex");
    await mkdir(codexHome);

    const error = await readCodexArtifact(codexHome, outside)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ category: "image" });
    expect(new Uint8Array(await readFile(outside))).toEqual(bytes);
  });

  it("rejects sibling paths sharing the workspace prefix", async () => {
    const sibling = join(fixture, "workspace-other");
    await mkdir(sibling);
    await writeFile(join(sibling, "image.png"), bytes);
    await rejectsImage([imageItem(join(sibling, "image.png"))]);
  });

  it("rejects escaping symlinks", async () => {
    await symlink(outside, join(workspace, "link.png"));
    await rejectsImage([imageItem("link.png")]);
  });

  it("rejects symlink traversal even when its target stays inside", async () => {
    await symlink(join(workspace, "image.png"), join(workspace, "link.png"));
    await rejectsImage([imageItem("link.png")]);
  });

  it("resolves a symlinked workspace before containment checks", async () => {
    const alias = join(fixture, "workspace-alias");
    await symlink(workspace, alias);
    expect(await readGeneratedImage(turn([imageItem("image.png")]), alias)).toEqual(bytes);
  });

  it("sanitizes broken symlink and symlink-loop realpath failures", async () => {
    await symlink(join(fixture, "missing.png"), join(workspace, "broken.png"));
    await symlink("loop.png", join(workspace, "loop.png"));
    await rejectsImage([imageItem("broken.png")]);
    await rejectsImage([imageItem("loop.png")]);
  });

  it("rejects a directory", async () => {
    await mkdir(join(workspace, "directory"));
    await rejectsImage([imageItem("directory")]);
  });

  it("rejects the workspace itself", async () => {
    await rejectsImage([imageItem(workspace)]);
  });

  it("sanitizes a missing image and missing workspace", async () => {
    await rejectsImage([imageItem("missing.png")]);
    await rejectsImage([imageItem("image.png")], join(fixture, "missing-workspace"));
  });

  it("rejects a sparse regular file one byte over 25 MiB", async () => {
    await truncate(join(workspace, "image.png"), 25 * 1024 * 1024 + 1);
    await rejectsImage([imageItem("image.png")]);
  });

  it("accepts exactly 25 MiB", async () => {
    await truncate(join(workspace, "image.png"), 25 * 1024 * 1024);
    const result = await readGeneratedImage(turn([imageItem("image.png")]), workspace);
    expect(result.byteLength).toBe(25 * 1024 * 1024);
    expect(result.slice(0, bytes.length)).toEqual(bytes);
  });
});
