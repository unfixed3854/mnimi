import { Hono } from "hono";
import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { uuidv7 } from "uuidv7";
import { resolve } from "node:path";
import { notes } from "./db/schema.ts";
import { hasFsErrorCode } from "./fs-errors.ts";
import { resolveRuntimePath } from "./runtime-paths.ts";
import type { Db } from "./db/index.ts";
import type { Auth } from "./auth.ts";
import {
  makeMediaPromiseFacade,
  runMediaPromise,
  type MediaStoreService,
} from "./effect/media.ts";

/**
 * Everything that touches image bytes on disk, plus the route that serves
 * them. The HTTP layer needs IMAGES_DIR, so it cannot live in the RPC router
 * without inverting the layering.
 */
export const IMAGES_DIR = resolveRuntimePath(
  process.env.IMAGES_DIR ?? "./data/images",
);

/**
 * Direct-call compatibility for isolated legacy tests. This deliberately
 * constructs no process-global binding; the live server injects MediaStore
 * from its owned Application graph into createImagesRoute.
 */
const legacyMedia = () => makeMediaPromiseFacade({
  imagesDir: IMAGES_DIR,
  audioDir: process.env.AUDIO_DIR ?? "./data/audio",
});

/** Writes the PNG under `<userId>/<noteId>.png` and returns that relative path.
 *  The first path segment is the owner, mirroring the layout the old storage
 *  bucket policy checked.
 *
 *  Both segments are server-generated UUIDv7 strings, never client-supplied
 *  text, so no path traversal is reachable here. */
export async function writeImage(
  userId: string,
  noteId: string,
  bytes: Uint8Array,
): Promise<string> {
  return legacyMedia().writeImage(userId, noteId, bytes);
}

/** Deletes an image file. A missing file is already clean; other filesystem
 * errors remain visible to the caller. */
export async function removeImage(relativePath: string): Promise<void> {
  return legacyMedia().removeImage(relativePath);
}

/** Drafts live beside the per-user note directories, under the same root, so
 *  claiming one is a rename within a single filesystem rather than a copy. */
export const DRAFTS_DIR = `${IMAGES_DIR}/drafts`;

/** Writes a not-yet-owned image and returns the id it was filed under. The id
 *  is generated here, never supplied by the client. */
export async function writeDraftImage(
  userId: string,
  bytes: Uint8Array,
): Promise<string> {
  return legacyMedia().writeDraftImage(userId, bytes);
}

/** Moves a draft onto its note's path. Throws an ENOENT filesystem error when the
 *  draft is gone — already claimed, or swept — which the caller records as a
 *  failed image rather than a failed save. */
export async function claimDraftImage(
  userId: string,
  draftId: string,
  noteId: string,
): Promise<string> {
  return legacyMedia().claimDraftImage(userId, draftId, noteId);
}

/** Deletes a draft's file. A miss is not an error: a discard racing the sweep,
 *  or a stage settling after its file was already claimed, both land here. */
export async function removeDraftImage(
  userId: string,
  draftId: string,
): Promise<void> {
  return legacyMedia().removeDraftImage(userId, draftId);
}

/**
 * Records — or clears — "a picture was wanted and did not arrive" on a note.
 *
 * A read-modify-write on a JSON column, and deliberately WITHOUT its own
 * write lock: one caller runs inside a locked section already (the image
 * stage's settle) and nesting `withWriteLock` deadlocks. Callers that are not
 * already holding it must wrap this.
 */
export async function setNoteImageFailed(
  db: Db,
  userId: string,
  noteId: string,
  failed: boolean,
): Promise<void> {
  const [row] = await db
    .select({ metadata: notes.metadata })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);
  if (!row) return;

  const { imageFailed: _dropped, ...rest } = row.metadata;
  await db
    .update(notes)
    .set({ metadata: failed ? { ...rest, imageFailed: true } : rest })
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)));
}

/**
 * Drafts are the only orphan class this design creates: `notes.save` claims
 * after its transaction commits, so a failed save leaves the file here rather
 * than at a note path no row points at. A discarded draft whose file delete
 * failed lands here too.
 *
 * `referenced` is the set of ids live creation rows or durable image attempts
 * point at. Creation inbox rows have no TTL, so an age check alone would
 * delete the picture out from under a creation awaiting review.
 *
 * Promise facade for transport and other non-workflow callers. Background
 * maintenance consumes the application-owned MediaStore directly.
 */
export async function sweepDrafts(
  maxAgeMs: number,
  referenced: ReadonlySet<string>,
  now: number = Date.now(),
): Promise<number> {
  return legacyMedia().sweepDrafts(maxAgeMs, referenced, now);
}

/**
 * The client supplies an id, never a path: the path is composed from the
 * session's user id and a validated UUIDv7, so traversal is unreachable
 * rather than merely filtered.
 *
 * A missing row, someone else's row, a null imagePath and a malformed id all
 * answer 404 identically, so an id's existence never leaks — the same
 * reasoning as `notFound` in the RPC layer.
 */
type ImageRouteMedia = Readonly<{
  readImage(
    relativePath: string,
    options?: { strict?: boolean },
  ): Effect.Effect<Uint8Array, unknown>;
  readDraftImage(userId: string, draftId: string): Effect.Effect<Uint8Array, unknown>;
}>;

export function createImagesRoute({
  db,
  auth,
  media: ownedMedia,
}: {
  db: Db;
  auth: Auth;
  media?: Pick<MediaStoreService, "readImage" | "readDraftImage">;
}) {
  const app = new Hono();
  const legacy = legacyMedia();
  const routeMedia: ImageRouteMedia =
    ownedMedia ?? {
      readImage: (path, options) => Effect.tryPromise({
        try: () => legacy.readImage(path, options),
        catch: (cause) => cause,
      }),
      readDraftImage: (userId, draftId) => Effect.tryPromise({
        try: () => legacy.readDraftImage(userId, draftId),
        catch: (cause) => cause,
      }),
    };

  app.get("/notes/:noteId", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.body(null, 401);

    const noteId = c.req.param("noteId");
    if (!z.uuidv7().safeParse(noteId).success) return c.body(null, 404);

    const [note] = await db
      .select({ imagePath: notes.imagePath })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.userId, session.user.id)))
      .limit(1);
    if (!note?.imagePath) return c.body(null, 404);

    // A missing file here means disk and database disagree — the one signal
    // worth logging.
    return await sendPng(() => runMedia(routeMedia.readImage(note.imagePath!, { strict: false })), `${IMAGES_DIR}/${note.imagePath}`, {
      logMissing: true,
    });
  });

  // No database lookup: a draft belongs to whoever's directory it sits in, so
  // ownership IS the path prefix.
  app.get("/drafts/:draftId", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.body(null, 401);

    const draftId = c.req.param("draftId");
    if (!z.uuidv7().safeParse(draftId).success) return c.body(null, 404);

    // A miss here is routine — a swept draft, one already claimed, a stale
    // confirm screen, or an authenticated user probing random ids — so it is
    // not logged. Logging it would bury the one signal `logMissing` exists
    // for (the notes scope, where a miss means disk and DB disagree) and
    // would let any authenticated user spam the server log for free.
    return await sendPng(() => runMedia(routeMedia.readDraftImage(session.user.id, draftId)), `${DRAFTS_DIR}/${session.user.id}/${draftId}.png`, {
      logMissing: false,
    });
  });

  return app;
}

function runMedia<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return runMediaPromise(effect);
}

/** A `Response` rather than `c.body`: Hono's body type does not accept a
 *  Uint8Array, and the filesystem read returns one. */
async function sendPng(
  read: () => Promise<Uint8Array>,
  path: string,
  { logMissing }: { logMissing: boolean },
): Promise<Response> {
  let bytes: Uint8Array;
  try {
    bytes = await read();
  } catch (error) {
    if (error instanceof Error && (error.message === "invalid image path" || error.message === "image path escapes media root")) {
      return new Response(null, { status: 404 });
    }
    if (!hasFsErrorCode(error, "ENOENT")) throw error;
    // Disk and database have diverged — worth knowing about, but the caller
    // still gets the same 404 as every other miss. Only worth logging for
    // scopes where a miss is not routine; see call sites.
    if (logMissing) console.error("image file missing on disk", path);
    return new Response(null, { status: 404 });
  }

  // Uint8Array does not narrow to the DOM BodyInit type under this
  // program's lib config, so the cast is needed even though the value is a
  // valid body.
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-cache",
    },
  });
}
