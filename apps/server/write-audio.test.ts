import { afterAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// AUDIO_DIR is captured when audio.ts loads, so set it before the dynamic
// import. A private temporary root also keeps these disk tests hermetic.
const dir = mkdtempSync(join(tmpdir(), "mnimi-audio-write-"));
const outsideDir = mkdtempSync(join(tmpdir(), "mnimi-audio-outside-"));
const previousAudioDir = process.env.AUDIO_DIR;
process.env.AUDIO_DIR = dir;

const { audioExists, removeAudio, writeAudio } = await import("./audio.ts");

const USER_ID = "0198c0b0-0000-7000-8000-0000000000a1";
const AUDIO_ID = "0198c0b0-0000-7000-8000-0000000000b2";

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
  if (previousAudioDir === undefined) delete process.env.AUDIO_DIR;
  else process.env.AUDIO_DIR = previousAudioDir;
});

describe("writeAudio", () => {
  it("stores bytes at the caller-allocated user-relative path", async () => {
    const path = await writeAudio(
      USER_ID,
      AUDIO_ID,
      new Uint8Array([1, 2, 3]),
    );

    expect(path).toBe(`${USER_ID}/${AUDIO_ID}.mp3`);
    expect(new Uint8Array(readFileSync(join(dir, path)))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(await audioExists(path)).toBe(true);
    expect(await audioExists(`${USER_ID}/unknown.mp3`)).toBe(false);
  });

  it("atomically replaces an existing audio object without leaving a temporary file", async () => {
    const path = await writeAudio(
      USER_ID,
      AUDIO_ID,
      new Uint8Array([4, 5, 6]),
    );
    await writeAudio(USER_ID, AUDIO_ID, new Uint8Array([7, 8]));

    expect(new Uint8Array(readFileSync(join(dir, path)))).toEqual(
      new Uint8Array([7, 8]),
    );
    expect(readdirSync(join(dir, USER_ID))).toEqual([`${AUDIO_ID}.mp3`]);
  });
});

describe("removeAudio", () => {
  it("deletes the file and tolerates it already being gone", async () => {
    const path = await writeAudio(USER_ID, AUDIO_ID, new Uint8Array([1, 2, 3]));

    await removeAudio(path);
    expect(existsSync(join(dir, path))).toBe(false);

    await expect(removeAudio(path)).resolves.toBeUndefined();
  });

  it("rethrows an unexpected filesystem error", async () => {
    const blockedUserId = "0198c0b0-0000-7000-8000-0000000000c1";
    const blockedCardId = "0198c0b0-0000-7000-8000-0000000000c2";
    writeFileSync(join(dir, blockedUserId), new Uint8Array([1]));

    await expect(
      removeAudio(`${blockedUserId}/${blockedCardId}.mp3`),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("rejects traversal and malformed paths without touching an outside file", async () => {
    const outsideFile = join(outsideDir, "sentinel.mp3");
    writeFileSync(outsideFile, new Uint8Array([9]));
    const traversal = relative(dir, outsideFile);

    for (
      const path of [traversal, "not-generated.mp3", `${USER_ID}/card.wav`]
    ) {
      await expect(removeAudio(path)).rejects.toThrow("invalid audio path");
    }

    expect(existsSync(outsideFile)).toBe(true);
  });
});
