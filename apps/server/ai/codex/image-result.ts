import { isAbsolute } from "node:path";
import type { CodexCompletedTurn } from "./operation.ts";
import { CodexProviderError, isRecord } from "./protocol.ts";
import {
  closeWorkspaceImage,
  openImageWorkspace,
  openWorkspaceImage,
  removeWorkspaceImage,
  type ImageWorkspace,
  type OpenedWorkspaceImage,
} from "./workspace-files.ts";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export async function readGeneratedImage(
  turn: CodexCompletedTurn,
  workspace: string,
  anchor?: ImageWorkspace,
  artifactAnchor?: ImageWorkspace,
): Promise<Uint8Array> {
  let ownedWorkspace: ImageWorkspace | undefined;
  let opened: OpenedWorkspaceImage | undefined;
  let providerArtifact = false;
  try {
    const item = [...turn.items].reverse().find(
      (candidate) => isRecord(candidate) && candidate.type === "imageGeneration",
    );
    if (!isRecord(item) || item.status !== "completed" || item.failure !== null
      || typeof item.savedPath !== "string" || !item.savedPath.trim()) {
      throw new CodexProviderError("image", "Codex returned no successful image");
    }
    if (!anchor) anchor = ownedWorkspace = await openImageWorkspace(workspace);
    try {
      opened = await openWorkspaceImage(anchor, workspace, item.savedPath);
    } catch (error) {
      if (!artifactAnchor || !isAbsolute(item.savedPath)) throw error;
      opened = await openWorkspaceImage(
        artifactAnchor,
        artifactAnchor.path,
        item.savedPath,
      );
      providerArtifact = true;
    }
    const file = opened.file;
    const stats = await file.stat({ bigint: true });
    if (!stats.isFile() || stats.size > BigInt(MAX_IMAGE_BYTES)) {
      throw new CodexProviderError("image", "Codex returned an invalid image file");
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = new Uint8Array(Math.min(65_536, MAX_IMAGE_BYTES + 1 - length));
      const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > MAX_IMAGE_BYTES) throw new Error();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    if (!after.isFile() || after.dev !== stats.dev || after.ino !== stats.ino
      || after.size > BigInt(MAX_IMAGE_BYTES)) throw new Error();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (providerArtifact) await removeWorkspaceImage(opened, after);
    return bytes;
  } catch {
    // Filesystem errors and provider items can contain private paths or details.
    throw new CodexProviderError("image", "Could not read a valid Codex image");
  } finally {
    if (opened) await closeWorkspaceImage(opened).catch(() => {});
    await ownedWorkspace?.directory.close().catch(() => {});
  }
}
