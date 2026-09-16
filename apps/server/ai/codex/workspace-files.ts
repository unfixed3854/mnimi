import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CodexProviderError } from "./protocol.ts";

export type ImageWorkspace = { directory: FileHandle; path: string };
export type OpenedWorkspaceImage = {
  file: FileHandle;
  parent: FileHandle;
  name: string;
  ownsParent: boolean;
};

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Capture the trusted operation root before any model work starts. */
export async function openImageWorkspace(workspace: string, identity?: BigIntStats): Promise<ImageWorkspace> {
  let directory: FileHandle | undefined;
  try {
    // /proc/self/fd supplies anchored lookup to Node/Bun, which do not expose
    // openat. Never silently substitute pathname checks on other platforms.
    if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw new Error();
    const path = await realpath(workspace);
    const before = identity ?? await lstat(path, { bigint: true });
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await directory.stat({ bigint: true });
    const anchored = await stat(`/proc/self/fd/${directory.fd}`, { bigint: true });
    if (!before.isDirectory() || !opened.isDirectory() || !anchored.isDirectory()
      || !sameFile(before, opened) || !sameFile(opened, anchored)) throw new Error();
    return { directory, path };
  } catch {
    await directory?.close().catch(() => {});
    throw new CodexProviderError("image", "Secure Codex image workspace access is unavailable");
  }
}

/** Anchor Codex's provider-owned artifact directory without following its final component. */
export async function openCodexImageWorkspace(codexHome: string): Promise<ImageWorkspace> {
  let home: ImageWorkspace | undefined;
  let directory: FileHandle | undefined;
  try {
    home = await openImageWorkspace(codexHome);
    const generatedImages = `/proc/self/fd/${home.directory.fd}/generated_images`;
    try {
      await mkdir(generatedImages, { mode: 0o700 });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error)
        || error.code !== "EEXIST") throw error;
    }
    directory = await open(generatedImages,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await directory.stat({ bigint: true });
    const descriptorPath = `/proc/self/fd/${directory.fd}`;
    const anchored = await stat(descriptorPath, { bigint: true });
    if (!opened.isDirectory() || !anchored.isDirectory() || !sameFile(opened, anchored)) {
      throw new Error();
    }
    return { directory, path: await realpath(descriptorPath) };
  } catch {
    await directory?.close().catch(() => {});
    throw new CodexProviderError("image", "Secure Codex image artifact access is unavailable");
  } finally {
    await home?.directory.close().catch(() => {});
  }
}

function workspaceImageComponents(anchor: ImageWorkspace, workspace: string, savedPath: string): string[] {
  if (savedPath.includes("\0") || savedPath.split(sep).includes("..")) throw new Error();
  let name = savedPath;
  if (isAbsolute(name)) {
    name = relative(resolve(workspace), savedPath);
    if (isAbsolute(name) || name === ".." || name.startsWith(`..${sep}`)) {
      name = relative(anchor.path, savedPath);
    }
  }
  if (!name || isAbsolute(name) || name.split(sep).includes("..")) throw new Error();
  const components = name.split(sep).filter((part) => part !== "" && part !== ".");
  if (!components.length) throw new Error();
  return components;
}

async function openWorkspaceImageParent(
  anchor: ImageWorkspace,
  workspace: string,
  savedPath: string,
): Promise<{ directory: FileHandle; name: string }> {
  const components = workspaceImageComponents(anchor, workspace, savedPath);
  let parent = anchor.directory;
  try {
    for (const component of components.slice(0, -1)) {
      const child = await open(`/proc/self/fd/${parent.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (parent !== anchor.directory) await parent.close().catch(() => {});
      parent = child;
    }
    return { directory: parent, name: components.at(-1)! };
  } catch (error) {
    if (parent !== anchor.directory) await parent.close().catch(() => {});
    throw error;
  }
}

/** Each component is opened relative to an owned directory descriptor. */
export async function openWorkspaceImage(
  anchor: ImageWorkspace,
  workspace: string,
  savedPath: string,
): Promise<OpenedWorkspaceImage> {
  const parent = await openWorkspaceImageParent(anchor, workspace, savedPath);
  try {
    // NONBLOCK prevents an attacker substituting a FIFO from hanging open().
    const file = await open(`/proc/self/fd/${parent.directory.fd}/${parent.name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return {
      file,
      parent: parent.directory,
      name: parent.name,
      ownsParent: parent.directory !== anchor.directory,
    };
  } catch (error) {
    if (parent.directory !== anchor.directory) await parent.directory.close().catch(() => {});
    throw error;
  }
}

/** Remove only the same regular file that was read from the anchored directory. */
export async function removeWorkspaceImage(
  image: OpenedWorkspaceImage,
  identity: BigIntStats,
): Promise<void> {
  // The retained parent descriptor prevents a directory rename from redirecting
  // cleanup. The completed app-server call owns the unique final filename; the
  // identity check rejects any replacement already present before unlink().
  const path = `/proc/self/fd/${image.parent.fd}/${image.name}`;
  const current = await lstat(path, { bigint: true });
  if (!current.isFile() || !sameFile(current, identity)) throw new Error();
  await unlink(path);
}

export async function closeWorkspaceImage(image: OpenedWorkspaceImage): Promise<void> {
  try {
    await image.file.close();
  } finally {
    if (image.ownsParent) await image.parent.close();
  }
}
