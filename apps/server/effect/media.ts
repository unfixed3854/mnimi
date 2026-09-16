import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { uuidv7 as newUuid } from "uuidv7";
import {
  mkdir as nodeMkdir,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  rename as nodeRename,
  rm as nodeRm,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { resolve, sep } from "node:path";
import * as z from "zod";
import { AppConfig } from "./config.ts";
import { Logging } from "./logging.ts";
import { MediaFailure } from "./errors.ts";

export type MediaFileSystem = Readonly<{
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  writeFile: (path: string, bytes: Uint8Array, options?: unknown) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string, options?: unknown) => Promise<void>;
  readdir: (path: string, options?: { withFileTypes?: boolean }) => Promise<readonly Dirent[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  stat: (path: string) => Promise<Pick<Stats, "mtime"> & { isFile(): boolean }>;
}>;

export type MediaStoreDependencies = Readonly<{
  fs: MediaFileSystem;
  uuidv7: () => string;
  reportCleanupFailure: (cause: unknown) => void;
}>;

export type MediaStoreOptions = Readonly<{
  imagesDir: string;
  audioDir: string;
  fs?: Partial<MediaFileSystem>;
  uuidv7?: () => string;
  reportCleanupFailure?: (cause: unknown) => void;
}>;

export type MediaStoreService = Readonly<{
  writeImage(userId: string, noteId: string, bytes: Uint8Array): Effect.Effect<string, MediaFailure>;
  writeDraftImage(userId: string, bytes: Uint8Array): Effect.Effect<string, MediaFailure>;
  claimDraftImage(userId: string, draftId: string, noteId: string): Effect.Effect<string, MediaFailure>;
  writeAudio(userId: string, audioId: string, bytes: Uint8Array): Effect.Effect<string, MediaFailure>;
  removeImage(relativePath: string): Effect.Effect<void, MediaFailure>;
  removeDraftImage(userId: string, draftId: string): Effect.Effect<void, MediaFailure>;
  removeAudio(relativePath: string): Effect.Effect<void, MediaFailure>;
  audioExists(relativePath: string): Effect.Effect<boolean, MediaFailure>;
  sweepDrafts(maxAgeMs: number, referenced: ReadonlySet<string>, now?: number): Effect.Effect<number, MediaFailure>;
  readImage(relativePath: string, options?: { strict?: boolean }): Effect.Effect<Uint8Array, MediaFailure>;
  readDraftImage(userId: string, draftId: string): Effect.Effect<Uint8Array, MediaFailure>;
  readAudio(relativePath: string, options?: { strict?: boolean }): Effect.Effect<Uint8Array, MediaFailure>;
}>;

export class MediaStore extends Context.Tag("@mnimi/server/MediaStore")<
  MediaStore,
  MediaStoreService
>() {}

const defaultFs: MediaFileSystem = {
  mkdir: async (path, options) => { await nodeMkdir(path, options); },
  writeFile: async (path, bytes, options) => { await nodeWriteFile(path, bytes, options as never); },
  rename: async (from, to) => { await nodeRename(from, to); },
  rm: async (path, options) => { await nodeRm(path, options as never); },
  readdir: async (path) => await nodeReaddir(path, { withFileTypes: true }),
  readFile: async (path) => new Uint8Array(await nodeReadFile(path)),
  stat: async (path) => await nodeStat(path),
};

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : undefined;

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const failure = (operation: string, message: string, cause?: unknown) =>
  new MediaFailure({ operation, message, cause });

const isUuid = (value: string): boolean => z.uuidv7().safeParse(value).success;

function validatedPath(root: string, relativePath: string, extension: ".png" | ".mp3", kind: "image" | "audio", strict = true): string {
  const [userId, filename, ...rest] = relativePath.split("/");
  if (strict && (
    rest.length > 0 ||
    !isUuid(userId ?? "") ||
    !filename?.endsWith(extension) ||
    !isUuid(filename.slice(0, -extension.length))
  )) {
    throw new Error(`invalid ${kind} path`);
  }
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, relativePath);
  if (absolutePath === absoluteRoot || !absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`${kind} path escapes media root`);
  }
  return absolutePath;
}

function validatedId(value: string, message: string): void {
  if (!isUuid(value)) throw new Error(message);
}

function validatedOwner(value: string, message: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(message);
  }
}

export function makeMediaStore(options: MediaStoreOptions, dependencies: Partial<MediaStoreDependencies> = {}): MediaStoreService {
  const fs: MediaFileSystem = { ...defaultFs, ...options.fs, ...dependencies.fs };
  const generateUuid = dependencies.uuidv7 ?? options.uuidv7 ?? newUuid;
  const reportCleanupFailure = dependencies.reportCleanupFailure ?? options.reportCleanupFailure ?? ((cause: unknown) => console.error(cause));
  const imagesDir = resolve(options.imagesDir);
  const audioDir = resolve(options.audioDir);
  const imagePath = (relativePath: string, strict = true) => validatedPath(imagesDir, relativePath, ".png", "image", strict);
  const audioPath = (relativePath: string, strict = true) => validatedPath(audioDir, relativePath, ".mp3", "audio", strict);

  const write = (
    operation: string,
    root: string,
    relativePath: string,
    bytes: Uint8Array,
  ): Effect.Effect<string, MediaFailure> => Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        const [owner] = relativePath.split("/");
        const directory = `${root}/${owner}`;
        const temporary = `${directory}/${relativePath.split("/")[1]?.replace(/\.(?:png|mp3)$/, "")}.${generateUuid()}.tmp`;
        await fs.mkdir(directory, { recursive: true });
        try {
          await fs.writeFile(temporary, bytes);
          await fs.rename(temporary, `${root}/${relativePath}`);
        } catch (cause) {
          try {
            await fs.rm(temporary);
          } catch (cleanup) {
            // Cleanup must never obscure the primary write failure.
            if (errorCode(cleanup) !== "ENOENT") {
              try {
                reportCleanupFailure(cleanup);
              } catch {
                // Reporting is best effort and must not replace the primary error.
              }
            }
          }
          throw cause;
        }
        return relativePath;
      },
      catch: (cause) => failure(operation, causeMessage(cause), cause),
    }),
  );

  const read = (operation: string, path: () => string): Effect.Effect<Uint8Array, MediaFailure> =>
    Effect.try({
      try: () => path(),
      catch: (cause) => failure(operation, causeMessage(cause), cause),
    }).pipe(
      Effect.flatMap((absolutePath) => Effect.tryPromise({
        try: () => fs.readFile(absolutePath),
        catch: (cause) => failure(operation, causeMessage(cause), cause),
      })),
    );

  const remove = (operation: string, path: () => string): Effect.Effect<void, MediaFailure> =>
    Effect.try({
      try: () => path(),
      catch: (cause) => failure(operation, causeMessage(cause), cause),
    }).pipe(
      Effect.flatMap((absolutePath) => Effect.tryPromise({
        try: async () => {
          try {
            await fs.rm(absolutePath);
          } catch (cause) {
            if (errorCode(cause) !== "ENOENT") throw cause;
          }
        },
        catch: (cause) => failure(operation, causeMessage(cause), cause),
      })),
    );

  return {
    writeImage: (userId, noteId, bytes) => {
      try {
        validatedOwner(userId, "invalid image path");
        validatedId(noteId, "invalid image path");
      } catch (cause) {
        return Effect.fail(failure("media.writeImage", causeMessage(cause), cause));
      }
      return write("media.writeImage", imagesDir, `${userId}/${noteId}.png`, bytes);
    },
    writeDraftImage: (userId, bytes) => {
      try {
        validatedOwner(userId, "invalid image path");
      } catch (cause) {
        return Effect.fail(failure("media.writeDraftImage", causeMessage(cause), cause));
      }
      return Effect.uninterruptible(Effect.tryPromise({
        try: async () => {
          const draftId = generateUuid();
          await fs.mkdir(`${imagesDir}/drafts/${userId}`, { recursive: true });
          await fs.writeFile(`${imagesDir}/drafts/${userId}/${draftId}.png`, bytes);
          return draftId;
        },
        catch: (cause) => failure("media.writeDraftImage", causeMessage(cause), cause),
      }));
    },
    claimDraftImage: (userId, draftId, noteId) => {
      try {
        validatedOwner(userId, "invalid image path");
        validatedId(draftId, "invalid image path");
        validatedId(noteId, "invalid image path");
      } catch (cause) {
        return Effect.fail(failure("media.claimDraftImage", causeMessage(cause), cause));
      }
      return Effect.tryPromise({
        try: async () => {
          await fs.mkdir(`${imagesDir}/${userId}`, { recursive: true });
          await fs.rename(
            `${imagesDir}/drafts/${userId}/${draftId}.png`,
            `${imagesDir}/${userId}/${noteId}.png`,
          );
          return `${userId}/${noteId}.png`;
        },
        catch: (cause) => failure("media.claimDraftImage", causeMessage(cause), cause),
      });
    },
    writeAudio: (userId, audioId, bytes) => {
      try {
        validatedOwner(userId, "invalid audio path");
        validatedId(audioId, "invalid audio path");
      } catch (cause) {
        return Effect.fail(failure("media.writeAudio", causeMessage(cause), cause));
      }
      return write("media.writeAudio", audioDir, `${userId}/${audioId}.mp3`, bytes);
    },
    removeImage: (relativePath) => remove("media.removeImage", () => imagePath(relativePath)),
    removeDraftImage: (userId, draftId) => remove("media.removeDraftImage", () => {
      validatedOwner(userId, "invalid image path");
      validatedId(draftId, "invalid image path");
      return resolve(imagesDir, "drafts", userId, `${draftId}.png`);
    }),
    removeAudio: (relativePath) => remove("media.removeAudio", () => audioPath(relativePath)),
    audioExists: (relativePath) => Effect.try({
      try: () => audioPath(relativePath),
      catch: (cause) => failure("media.audioExists", causeMessage(cause), cause),
    }).pipe(Effect.flatMap((path) => Effect.tryPromise({
      try: async () => {
        try {
          return (await fs.stat(path)).isFile();
        } catch (cause) {
          if (errorCode(cause) === "ENOENT") return false;
          throw cause;
        }
      },
      catch: (cause) => failure("media.audioExists", causeMessage(cause), cause),
    }))),
    sweepDrafts: (maxAgeMs, referenced, now = Date.now()) => Effect.tryPromise({
      try: async () => {
        let users: readonly Dirent[];
        try {
          users = await fs.readdir(`${imagesDir}/drafts`, { withFileTypes: true });
        } catch (cause) {
          if (errorCode(cause) === "ENOENT") return 0;
          throw cause;
        }
        let deleted = 0;
        for (const user of users) {
          if (!user.isDirectory()) continue;
          const directory = `${imagesDir}/drafts/${user.name}`;
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const id = entry.name.replace(/\.png$/, "");
            if (referenced.has(id)) continue;
            const path = `${directory}/${entry.name}`;
            const info = await fs.stat(path);
            const modified = info.mtime?.getTime() ?? now;
            if (now - modified <= maxAgeMs) continue;
            await fs.rm(path);
            deleted++;
          }
        }
        return deleted;
      },
      catch: (cause) => failure("media.sweepDrafts", causeMessage(cause), cause),
    }),
    readImage: (relativePath, options = {}) => read("media.readImage", () => imagePath(relativePath, options.strict ?? true)),
    readDraftImage: (userId, draftId) => read("media.readDraftImage", () => {
      validatedOwner(userId, "invalid image path");
      validatedId(draftId, "invalid image path");
      return resolve(imagesDir, "drafts", userId, `${draftId}.png`);
    }),
    readAudio: (relativePath, options = {}) => read("media.readAudio", () => audioPath(relativePath, options.strict ?? true)),
  };
}

export function makeMediaStoreLayer(
  dependencies: Partial<MediaStoreDependencies> = {},
): Layer.Layer<MediaStore, never, AppConfig | Logging> {
  const fs = { ...defaultFs, ...dependencies.fs };
  const uuidv7 = dependencies.uuidv7 ?? newUuid;
  return Layer.effect(
    MediaStore,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const logging = yield* Logging;
      return makeMediaStore({
        imagesDir: config.media.imagesDir,
        audioDir: config.media.audioDir,
        fs,
        uuidv7,
        reportCleanupFailure: dependencies.reportCleanupFailure ?? ((cause) =>
          logging.getLogger(["mnimi", "media"]).error(
            "media temporary cleanup failed: {error}",
            { error: cause },
          )),
      });
    }),
  );
}

export const MediaStoreLive = makeMediaStoreLayer();

export type MediaPromiseFacade = Readonly<{
  writeImage(userId: string, noteId: string, bytes: Uint8Array): Promise<string>;
  writeDraftImage(userId: string, bytes: Uint8Array): Promise<string>;
  claimDraftImage(userId: string, draftId: string, noteId: string): Promise<string>;
  writeAudio(userId: string, audioId: string, bytes: Uint8Array): Promise<string>;
  removeImage(relativePath: string): Promise<void>;
  removeDraftImage(userId: string, draftId: string): Promise<void>;
  removeAudio(relativePath: string): Promise<void>;
  audioExists(relativePath: string): Promise<boolean>;
  sweepDrafts(maxAgeMs: number, referenced: ReadonlySet<string>, now?: number): Promise<number>;
  readImage(relativePath: string, options?: { strict?: boolean }): Promise<Uint8Array>;
  readDraftImage(userId: string, draftId: string): Promise<Uint8Array>;
  readAudio(relativePath: string, options?: { strict?: boolean }): Promise<Uint8Array>;
}>;

/**
 * Media remains a Promise boundary for Hono and legacy callers. Preserve the
 * underlying filesystem error there so existing ENOENT and path validation
 * handling does not observe the Effect-only wrapper.
 */
export const runMediaPromise = async <A, E>(operation: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(operation);
  if (Exit.isSuccess(exit)) return exit.value;
  const typed = Option.getOrUndefined(Cause.failureOption(exit.cause));
  if (typed instanceof MediaFailure) {
    if (typed.cause !== undefined) throw typed.cause;
    throw new Error(typed.message);
  }
  throw Cause.squash(exit.cause);
};

export function makeMediaPromiseFacade(options: MediaStoreOptions | MediaStoreService): MediaPromiseFacade {
  const service = "writeImage" in options ? options : makeMediaStore(options);
  return {
    writeImage: (userId, noteId, bytes) => runMediaPromise(service.writeImage(userId, noteId, bytes)),
    writeDraftImage: (userId, bytes) => runMediaPromise(service.writeDraftImage(userId, bytes)),
    claimDraftImage: (userId, draftId, noteId) => runMediaPromise(service.claimDraftImage(userId, draftId, noteId)),
    writeAudio: (userId, audioId, bytes) => runMediaPromise(service.writeAudio(userId, audioId, bytes)),
    removeImage: (path) => runMediaPromise(service.removeImage(path)),
    removeDraftImage: (userId, draftId) => runMediaPromise(service.removeDraftImage(userId, draftId)),
    removeAudio: (path) => runMediaPromise(service.removeAudio(path)),
    audioExists: (path) => runMediaPromise(service.audioExists(path)),
    sweepDrafts: (maxAgeMs, referenced, now) => runMediaPromise(service.sweepDrafts(maxAgeMs, referenced, now)),
    readImage: (path, options) => runMediaPromise(service.readImage(path, options)),
    readDraftImage: (userId, draftId) => runMediaPromise(service.readDraftImage(userId, draftId)),
    readAudio: (path, options) => runMediaPromise(service.readAudio(path, options)),
  };
}
