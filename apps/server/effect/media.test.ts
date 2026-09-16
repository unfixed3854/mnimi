import { describe, expect, it, vi } from "vitest";
import { Effect, Exit, Layer } from "effect";
import {
  makeMediaStore,
  makeMediaStoreLayer,
  makeMediaPromiseFacade,
  MediaStore,
  type MediaFileSystem,
} from "./media.ts";
import { MediaFailure } from "./errors.ts";
import { AppConfig, type AppConfigValue } from "./config.ts";
import { Logging } from "./logging.ts";
import { makeTestRuntime, testService } from "./testing.ts";

const USER = "0198c0b0-0000-7000-8000-000000000001";
const NOTE = "0198c0b0-0000-7000-8000-000000000002";
const DRAFT = "0198c0b0-0000-7000-8000-000000000003";
const AUDIO = "0198c0b0-0000-7000-8000-000000000004";

const makeFs = (overrides: Partial<MediaFileSystem> = {}) => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
  stat: vi.fn(async () => ({ isFile: () => true, mtime: new Date(0) })),
  ...overrides,
});

describe("MediaStore", () => {
  it("does no filesystem work while constructing the service", () => {
    const fs = makeFs();
    makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs });
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it("writes images atomically and removes a failed sibling temporary file", async () => {
    const primary = Object.assign(new Error("rename failed"), { code: "EIO" });
    const fs = makeFs({
      rename: vi.fn(async () => { throw primary; }),
      rm: vi.fn(async () => undefined),
    });
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs, uuidv7: () => DRAFT });

    const exit = await Effect.runPromiseExit(service.writeImage(USER, NOTE, new Uint8Array([8])));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.toString();
      expect(failure).toContain("MediaFailure");
    }
    expect(fs.writeFile).toHaveBeenCalledWith(`/images/${USER}/${NOTE}.${DRAFT}.tmp`, expect.anything());
    expect(fs.rm).toHaveBeenCalledWith(`/images/${USER}/${NOTE}.${DRAFT}.tmp`);
  });

  it("preserves the primary write failure when temporary cleanup fails", async () => {
    const primary = Object.assign(new Error("write failed"), { code: "EIO" });
    const cleanup = Object.assign(new Error("cleanup failed"), { code: "EPERM" });
    const fs = makeFs({
      writeFile: vi.fn(async () => { throw primary; }),
      rm: vi.fn(async () => { throw cleanup; }),
    });
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs, uuidv7: () => DRAFT });
    const exit = await Effect.runPromiseExit(service.writeImage(USER, NOTE, new Uint8Array([8])));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defects = exit.cause.toString();
      expect(defects).toContain("write failed");
      expect(defects).not.toContain("cleanup failed");
    }
  });

  it("validates an audio ID before any filesystem operation", async () => {
    const fs = makeFs();
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs });
    const exit = await Effect.runPromiseExit(service.writeAudio(USER, "../escape", new Uint8Array([1])));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("reports temporary cleanup failures through the injected reporter", async () => {
    const report = vi.fn();
    const primary = new Error("write failed");
    const cleanup = new Error("cleanup failed");
    const fs = makeFs({
      writeFile: vi.fn(async () => { throw primary; }),
      rm: vi.fn(async () => { throw cleanup; }),
    });
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs, reportCleanupFailure: report });
    await Effect.runPromiseExit(service.writeImage(USER, NOTE, new Uint8Array([1])));
    expect(report).toHaveBeenCalledWith(cleanup);
  });

  it("preserves the primary write error when the cleanup reporter throws", async () => {
    const primary = Object.assign(new Error("primary write error"), { code: "EIO" });
    const fs = makeFs({
      writeFile: vi.fn(async () => { throw primary; }),
      rm: vi.fn(async () => { throw new Error("cleanup error"); }),
    });
    const reportCleanupFailure = () => { throw new Error("reporter error"); };
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs, reportCleanupFailure });
    const exit = await Effect.runPromiseExit(service.writeImage(USER, NOTE, new Uint8Array([1])));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("primary write error");
  });

  it("rejects traversal before touching the filesystem and validates audio extensions", async () => {
    const fs = makeFs();
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs });
    const imageExit = await Effect.runPromiseExit(service.removeImage(`${USER}/../${NOTE}.png`));
    const audioExit = await Effect.runPromiseExit(service.audioExists(`${USER}/${AUDIO}.wav`));
    expect(Exit.isFailure(imageExit)).toBe(true);
    expect(Exit.isFailure(audioExit)).toBe(true);
    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it("treats only ENOENT as an idempotent remove miss", async () => {
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    const fs = makeFs({ rm: vi.fn(async () => { throw missing; }) });
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs });
    await expect(Effect.runPromise(service.removeAudio(`${USER}/${AUDIO}.mp3`))).resolves.toBeUndefined();

    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const deniedFs = makeFs({ rm: vi.fn(async () => { throw denied; }) });
    const deniedService = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs: deniedFs });
    const exit = await Effect.runPromiseExit(deniedService.removeAudio(`${USER}/${AUDIO}.mp3`));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("reads audio and classifies a missing file as a MediaFailure", async () => {
    const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
    const fs = makeFs({ readFile: vi.fn(async () => { throw missing; }) });
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs });
    const exit = await Effect.runPromiseExit(service.readAudio(`${USER}/${AUDIO}.mp3`));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("not found");
  });

  it("reads a route path with containment checks but without legacy UUID filename validation", async () => {
    const fs = makeFs({ readFile: vi.fn(async () => new Uint8Array([7])) });
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs });
    await expect(Effect.runPromise(service.readImage(`${USER}/n.png`, { strict: false }))).resolves.toEqual(new Uint8Array([7]));
    expect(fs.readFile).toHaveBeenCalledWith(`/images/${USER}/n.png`);
  });

  it("preserves the raw filesystem error through the media Promise facade", async () => {
    const raw = Object.assign(new Error("read failed"), { code: "EIO" });
    const fs = makeFs({ readFile: vi.fn(async () => { throw raw; }) });
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs });
    const facade = makeMediaPromiseFacade(service);
    await expect(facade.readImage(`${USER}/${NOTE}.png`)).rejects.toBe(raw);
  });

  it("sweeps only stale unreferenced draft files sequentially and tolerates an absent root", async () => {
    const stale = `${DRAFT}.png`;
    const fresh = `${AUDIO}.png`;
    const fs = makeFs({
      readdir: vi.fn()
        .mockResolvedValueOnce([
          { name: USER, isDirectory: () => true, isFile: () => false },
        ])
        .mockResolvedValueOnce([
          { name: stale, isDirectory: () => false, isFile: () => true },
          { name: fresh, isDirectory: () => false, isFile: () => true },
        ]),
      stat: vi.fn(async () => ({ isFile: () => true, mtime: new Date(0) })),
    });
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs });
    await expect(Effect.runPromise(service.sweepDrafts(100, new Set([AUDIO]), 1000))).resolves.toBe(1);
    expect(fs.rm).toHaveBeenCalledWith(`/images/drafts/${USER}/${stale}`);

    const absent = Object.assign(new Error("absent"), { code: "ENOENT" });
    const absentFs = makeFs({ readdir: vi.fn(async () => { throw absent; }) });
    const absentService = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs: absentFs });
    await expect(Effect.runPromise(absentService.sweepDrafts(100, new Set(), 1000))).resolves.toBe(0);
  });

  it("exposes typed MediaFailure diagnostics", async () => {
    const fs = makeFs({ readFile: vi.fn(async () => { throw new Error("boom"); }) });
    const service = makeMediaStore({ imagesDir: "/images", audioDir: "/audio", fs });
    const exit = await Effect.runPromiseExit(service.readImage(`${USER}/${NOTE}.png`));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause as unknown as { failure?: unknown };
      expect(String(failure)).toContain("MediaFailure");
    }
  });

  it("builds from captured AppConfig and Logging without filesystem work at Layer acquisition", async () => {
    const fs = makeFs();
    const config = {
      media: { imagesDir: "/configured/images", audioDir: "/configured/audio" },
    } as AppConfigValue;
    const logging = { getLogger: vi.fn() };
    const runtime = makeTestRuntime(makeMediaStoreLayer({ fs }).pipe(
      Layer.provide(Layer.mergeAll(testService(AppConfig, config), testService(Logging, logging))),
    ));
    try {
      await runtime.runPromise(Effect.gen(function* () {
        return yield* MediaStore;
      }));
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.readFile).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});
