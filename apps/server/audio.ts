import { Hono } from "hono";
import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { uuidv7 } from "uuidv7";
import { cards } from "./db/schema.ts";
import { hasFsErrorCode } from "./fs-errors.ts";
import { resolveRuntimePath } from "./runtime-paths.ts";
import type { Auth } from "./auth.ts";
import type { Db } from "./db/index.ts";
import {
  makeMediaPromiseFacade,
  runMediaPromise,
  type MediaStoreService,
} from "./effect/media.ts";

export const AUDIO_DIR = resolveRuntimePath(
  process.env.AUDIO_DIR ?? "./data/audio",
);

/** Direct-call compatibility only; live routes receive application-owned media. */
const legacyMedia = () => makeMediaPromiseFacade({
  imagesDir: process.env.IMAGES_DIR ?? "./data/images",
  audioDir: AUDIO_DIR,
});

/**
 * Stores one immutable audio generation under its owner's directory. The
 * caller allocates a distinct audio ID per generation; the temporary file
 * lives beside the destination so the final rename is atomic.
 */
export async function writeAudio(
  userId: string,
  audioId: string,
  bytes: Uint8Array,
): Promise<string> {
  return legacyMedia().writeAudio(userId, audioId, bytes);
}

/** Deletes an audio file. A missing file is already clean; other filesystem
 * errors remain visible to the caller. */
export async function removeAudio(relativePath: string): Promise<void> {
  return legacyMedia().removeAudio(relativePath);
}

export async function audioExists(relativePath: string): Promise<boolean> {
  try {
    return await legacyMedia().audioExists(relativePath);
  } catch (error) {
    // Legacy existence checks treat malformed/unknown paths as a miss.
    if (error instanceof Error && error.message === "invalid audio path") return false;
    throw error;
  }
}

/**
 * Serves only audio belonging to the authenticated user. All misses return
 * the same 404 so card existence and another user's ownership never leak.
 */
type AudioRouteMedia = Readonly<{
  readAudio(
    relativePath: string,
    options?: { strict?: boolean },
  ): Effect.Effect<Uint8Array, unknown>;
}>;

export function createAudioRoute({
  db,
  auth,
  media: ownedMedia,
}: {
  db: Db;
  auth: Auth;
  media?: Pick<MediaStoreService, "readAudio">;
}) {
  const app = new Hono();
  const legacy = legacyMedia();
  const routeMedia: AudioRouteMedia = ownedMedia ?? {
    readAudio: (path, options) => Effect.tryPromise({
      try: () => legacy.readAudio(path, options),
      catch: (cause) => cause,
    }),
  };

  app.get("/cards/:cardId", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.body(null, 401);

    const cardId = c.req.param("cardId");
    if (!z.uuidv7().safeParse(cardId).success) return c.body(null, 404);

    const [card] = await db
      .select({ audioPath: cards.audioPath })
      .from(cards)
      .where(and(eq(cards.id, cardId), eq(cards.userId, session.user.id)))
      .limit(1);
    if (!card?.audioPath) return c.body(null, 404);

    let bytes: Uint8Array;
    try {
      bytes = await runMediaPromise(
        routeMedia.readAudio(card.audioPath!, { strict: false }),
      );
    } catch (error) {
      if (error instanceof Error && (error.message === "invalid audio path" || error.message === "audio path escapes media root")) {
        return c.body(null, 404);
      }
      if (hasFsErrorCode(error, "ENOENT")) return c.body(null, 404);
      throw error;
    }

    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "private, no-cache",
      },
    });
  });

  return app;
}
