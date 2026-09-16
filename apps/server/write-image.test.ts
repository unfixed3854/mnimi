import { afterAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The real `writeImage`, against a temp IMAGES_DIR.
 *
 * Every other test of the image path injects `context.writeImage`, so without
 * this file the only code that actually touches the disk would ship having
 * never executed. `images.ts` reads IMAGES_DIR once, at module load, so the
 * env var has to be set before the import — hence the dynamic import below,
 * which also keeps this file's module registry separate from `images.test.ts`.
 */
const dir = mkdtempSync(join(tmpdir(), "mnimi-images-"));
const previousImagesDir = process.env.IMAGES_DIR;
process.env.IMAGES_DIR = dir;
const { writeImage, writeDraftImage, claimDraftImage } = await import(
  "./images.ts"
);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previousImagesDir === undefined) delete process.env.IMAGES_DIR;
  else process.env.IMAGES_DIR = previousImagesDir;
});

describe("writeImage", () => {
  it("writes the bytes to <userId>/<noteId>.png and returns that relative path", async () => {
    const userId = "0198c0b0-0000-7000-8000-000000000001";
    const noteId = "0198c0b0-0000-7000-8000-000000000002";
    const bytes = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]);

    const path = await writeImage(userId, noteId, bytes);

    // The path is stored on the note and later served relative to IMAGES_DIR,
    // so it must be exactly this — not absolute, and not prefixed.
    expect(path).toBe(`${userId}/${noteId}.png`);
    expect(new Uint8Array(readFileSync(join(dir, path)))).toEqual(bytes);
  });

  it("creates the per-user directory that does not exist yet", async () => {
    const userId = "0198c0b0-0000-7000-8000-00000000000a";
    expect(existsSync(join(dir, userId))).toBe(false);

    await writeImage(
      userId,
      "0198c0b0-0000-7000-8000-00000000000b",
      new Uint8Array([1]),
    );

    expect(existsSync(join(dir, userId))).toBe(true);
  });

  it("overwrites an earlier image for the same note", async () => {
    const userId = "0198c0b0-0000-7000-8000-000000000011";
    const noteId = "0198c0b0-0000-7000-8000-000000000012";

    await writeImage(userId, noteId, new Uint8Array([1, 2, 3, 4]));
    const path = await writeImage(userId, noteId, new Uint8Array([9]));

    // The note screen offers a retry, which regenerates into the same path.
    // A partial overwrite would leave a corrupt PNG behind.
    expect(new Uint8Array(readFileSync(join(dir, path)))).toEqual(
      new Uint8Array([9]),
    );
  });

  it("atomically replaces an image without leaving a temporary file", async () => {
    const userId = "0198c0b0-0000-7000-8000-000000000021";
    const noteId = "0198c0b0-0000-7000-8000-000000000022";

    await writeImage(userId, noteId, new Uint8Array([1, 2, 3]));
    const path = await writeImage(userId, noteId, new Uint8Array([9]));

    expect(new Uint8Array(readFileSync(join(dir, path)))).toEqual(
      new Uint8Array([9]),
    );
    expect(readdirSync(join(dir, userId))).toEqual([`${noteId}.png`]);
  });
});

describe("writeDraftImage / claimDraftImage", () => {
  it("writes a draft under the owner and claims it onto a note path", async () => {
    const userId = "0198c0b0-0000-7000-8000-000000000021";
    const noteId = "0198c0b0-0000-7000-8000-000000000022";
    const bytes = new Uint8Array([7, 7, 7]);

    const draftId = await writeDraftImage(userId, bytes);
    expect(existsSync(join(dir, "drafts", userId, `${draftId}.png`))).toBe(
      true,
    );

    const path = await claimDraftImage(userId, draftId, noteId);

    expect(path).toBe(`${userId}/${noteId}.png`);
    expect(new Uint8Array(readFileSync(join(dir, path)))).toEqual(bytes);
    // The rename moves it — a second claim must not find a source.
    expect(existsSync(join(dir, "drafts", userId, `${draftId}.png`))).toBe(
      false,
    );
  });

  it("rejects a claim for a draft that is not there", async () => {
    await expect(
      claimDraftImage(
        "0198c0b0-0000-7000-8000-000000000031",
        "0198c0b0-0000-7000-8000-000000000032",
        "0198c0b0-0000-7000-8000-000000000033",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
