import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { uuidv7 } from "uuidv7";
import { Effect } from "effect";
import { MediaFailure } from "./effect/errors.ts";

// IMAGES_DIR is read once at module load, so it must be set before anything
// that imports images.ts is imported. Hence the dynamic imports below.
const dir = mkdtempSync(join(tmpdir(), "mnimi-serve-"));
const outsideDir = mkdtempSync(join(tmpdir(), "mnimi-serve-outside-"));
const previousImagesDir = process.env.IMAGES_DIR;
process.env.IMAGES_DIR = dir;

const { createApp } = await import("./app.ts");
const { createAuth } = await import("./auth.ts");
const { createTestDb } = await import("./db/testing.ts");
const { decks, notes } = await import("./db/schema.ts");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let close: () => void;
let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let auth: ReturnType<typeof createAuth>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  db = testDb.db;
  auth = createAuth(db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    registrationEnabled: true,
  });
  app = createApp({ db, auth, corsOrigin: "http://localhost:1420" });
});

afterEach(() => close());
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
  if (previousImagesDir === undefined) delete process.env.IMAGES_DIR;
  else process.env.IMAGES_DIR = previousImagesDir;
});

/** Signs a user up and returns their id plus a usable bearer header. */
async function signUp(email: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse", name: "x" }),
  });
  const body = await response.json();
  return {
    userId: body.user.id as string,
    headers: {
      authorization: `Bearer ${response.headers.get("set-auth-token")}`,
    },
  };
}

/** Inserts a note directly — these tests are about the route, not about save. */
async function seedNote(userId: string, imagePath: string | null) {
  const deckId = uuidv7();
  await db.insert(decks).values({ id: deckId, userId, name: "Deck" });
  const noteId = uuidv7();
  await db.insert(notes).values({
    id: noteId,
    userId,
    deckId,
    sourceText: "die Banane",
    domain: "language",
    metadata: {},
    imagePath,
  });
  return noteId;
}

function writePng(relativePath: string) {
  mkdirSync(join(dir, relativePath, ".."), { recursive: true });
  writeFileSync(join(dir, relativePath), PNG);
}

describe("GET /images/notes/:noteId", () => {
  it("serves the owner's image as image/png", async () => {
    const ada = await signUp("ada@example.com");
    const noteId = await seedNote(ada.userId, `${ada.userId}/n.png`);
    writePng(`${ada.userId}/n.png`);

    const response = await app.request(`/images/notes/${noteId}`, {
      headers: ada.headers,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("includes the allowed browser CORS header on an authenticated image", async () => {
    const ada = await signUp("cors-image@example.com");
    const noteId = await seedNote(ada.userId, `${ada.userId}/cors.png`);
    writePng(`${ada.userId}/cors.png`);

    const response = await app.request(`/images/notes/${noteId}`, {
      headers: {
        ...ada.headers,
        Origin: "http://localhost:1420",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin"))
      .toBe("http://localhost:1420");
  });

  it("401s without a bearer token", async () => {
    const ada = await signUp("ada@example.com");
    const noteId = await seedNote(ada.userId, `${ada.userId}/n.png`);
    writePng(`${ada.userId}/n.png`);

    const response = await app.request(`/images/notes/${noteId}`);

    expect(response.status).toBe(401);
  });

  it("404s another user's note, an unknown id, and a malformed id alike", async () => {
    const ada = await signUp("ada@example.com");
    const bob = await signUp("bob@example.com");
    const bobNote = await seedNote(bob.userId, `${bob.userId}/n.png`);
    writePng(`${bob.userId}/n.png`);

    for (
      const path of [
        `/images/notes/${bobNote}`,
        `/images/notes/${uuidv7()}`,
        "/images/notes/nope",
      ]
    ) {
      const response = await app.request(path, { headers: ada.headers });
      expect(response.status).toBe(404);
    }
  });

  it("404s a note with no image and a row whose file is gone", async () => {
    const ada = await signUp("ada@example.com");
    const noImage = await seedNote(ada.userId, null);
    const missingFile = await seedNote(ada.userId, `${ada.userId}/gone.png`);

    for (const noteId of [noImage, missingFile]) {
      const response = await app.request(`/images/notes/${noteId}`, {
        headers: ada.headers,
      });
      expect(response.status).toBe(404);
    }
  });

  it("404s when the application-owned media store reports a missing image", async () => {
    const ada = await signUp("owned-missing-image@example.com");
    const noteId = await seedNote(ada.userId, `${ada.userId}/missing.png`);
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const ownedApp = createApp({
      db,
      auth,
      corsOrigin: "http://localhost:1420",
      media: {
        readImage: () => Effect.fail(new MediaFailure({
          operation: "media.readImage",
          message: "missing",
          cause: missing,
        })),
        readDraftImage: () => Effect.fail(new MediaFailure({
          operation: "media.readDraftImage",
          message: "missing",
          cause: missing,
        })),
      } as never,
    });

    const response = await ownedApp.request(`/images/notes/${noteId}`, {
      headers: ada.headers,
    });

    expect(response.status).toBe(404);
  });

  it("404s a stored path that escapes the media root without reading outside it", async () => {
    const ada = await signUp("path-image@example.com");
    const outsideFile = join(outsideDir, "sentinel-route.png");
    writeFileSync(outsideFile, PNG);
    const traversal = relative(dir, outsideFile);
    const noteId = await seedNote(ada.userId, traversal);

    const response = await app.request(`/images/notes/${noteId}`, {
      headers: ada.headers,
    });

    expect(response.status).toBe(404);
    expect(new Uint8Array(readFileSync(outsideFile))).toEqual(PNG);
  });
});

describe("GET /images/drafts/:draftId", () => {
  it("serves the caller's own draft", async () => {
    const ada = await signUp("ada@example.com");
    const draftId = uuidv7();
    writePng(`drafts/${ada.userId}/${draftId}.png`);

    const response = await app.request(`/images/drafts/${draftId}`, {
      headers: ada.headers,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("404s a draft belonging to someone else", async () => {
    const ada = await signUp("ada@example.com");
    const bob = await signUp("bob@example.com");
    const draftId = uuidv7();
    writePng(`drafts/${bob.userId}/${draftId}.png`);

    // The path prefix IS the authorization here — this is the test that proves it.
    const response = await app.request(`/images/drafts/${draftId}`, {
      headers: ada.headers,
    });

    expect(response.status).toBe(404);
  });

  it("401s without a bearer token", async () => {
    const response = await app.request(`/images/drafts/${uuidv7()}`);
    expect(response.status).toBe(401);
  });
});

describe("removeDraftImage", () => {
  it("deletes the file and tolerates it already being gone", async () => {
    const { removeDraftImage, writeDraftImage } = await import("./images.ts");
    const draftId = await writeDraftImage("u1", PNG);

    await removeDraftImage("u1", draftId);
    expect(existsSync(join(dir, "drafts", "u1", `${draftId}.png`))).toBe(false);

    // A discard racing a sweep must not throw.
    await expect(removeDraftImage("u1", draftId)).resolves.toBeUndefined();
  });
});

describe("removeImage", () => {
  it("deletes the file and tolerates it already being gone", async () => {
    const { removeImage } = await import("./images.ts");
    const path =
      "0198c0b0-0000-7000-8000-0000000000a1/0198c0b0-0000-7000-8000-0000000000b2.png";
    writePng(path);

    await removeImage(path);
    expect(existsSync(join(dir, path))).toBe(false);

    await expect(removeImage(path)).resolves.toBeUndefined();
  });

  it("rethrows an unexpected filesystem error", async () => {
    const { removeImage } = await import("./images.ts");
    const blockedUserId = "0198c0b0-0000-7000-8000-0000000000c1";
    const blockedNoteId = "0198c0b0-0000-7000-8000-0000000000c2";
    writeFileSync(join(dir, blockedUserId), PNG);

    await expect(
      removeImage(`${blockedUserId}/${blockedNoteId}.png`),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("rejects traversal and malformed paths without touching an outside file", async () => {
    const { removeImage } = await import("./images.ts");
    const outsideFile = join(outsideDir, "sentinel.png");
    writeFileSync(outsideFile, PNG);
    const traversal = relative(dir, outsideFile);

    for (const path of [traversal, "not-generated.png", "u1/note.jpg"]) {
      await expect(removeImage(path)).rejects.toThrow("invalid image path");
    }

    expect(existsSync(outsideFile)).toBe(true);
  });
});

describe("sweepDrafts", () => {
  it("accepts readonly references and uses the supplied clock for the exact cutoff", async () => {
    const { sweepDrafts, writeDraftImage } = await import("./images.ts");
    const kept = await writeDraftImage("cutoff-owner", PNG);
    const boundary = await writeDraftImage("cutoff-owner", PNG);
    const now = Date.now() + 86_400_000;
    const cutoff = new Date(now - 86_400_000);
    for (const id of [kept, boundary]) {
      utimesSync(join(dir, "drafts", "cutoff-owner", `${id}.png`), cutoff, cutoff);
    }
    const references: ReadonlySet<string> = new Set([kept]);
    await sweepDrafts(86_400_000, references, now);
    expect(existsSync(join(dir, "drafts", "cutoff-owner", `${boundary}.png`))).toBe(true);
    await sweepDrafts(86_400_000, references, now + 1);
    expect(existsSync(join(dir, "drafts", "cutoff-owner", `${boundary}.png`))).toBe(false);
    expect(existsSync(join(dir, "drafts", "cutoff-owner", `${kept}.png`))).toBe(true);
  });

  it("deletes drafts past the cutoff and keeps newer ones", async () => {
    const { sweepDrafts } = await import("./images.ts");
    const userId = "0198c0b0-0000-7000-8000-0000000000a1";
    const stale = uuidv7();
    const fresh = uuidv7();
    writePng(`drafts/${userId}/${stale}.png`);
    writePng(`drafts/${userId}/${fresh}.png`);

    const stalePath = join(dir, "drafts", userId, `${stale}.png`);
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stalePath, longAgo, longAgo);

    const deleted = await sweepDrafts(24 * 60 * 60 * 1000, new Set());

    expect(deleted).toBe(1);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(join(dir, "drafts", userId, `${fresh}.png`))).toBe(true);
  });

  it("is a no-op when no drafts directory exists yet", async () => {
    const { sweepDrafts } = await import("./images.ts");
    rmSync(join(dir, "drafts"), { recursive: true, force: true });

    await expect(sweepDrafts(1000, new Set())).resolves.toBe(0);
  });

  it("keeps a file a live draft still points at, however old", async () => {
    const { sweepDrafts, writeDraftImage } = await import("./images.ts");
    const kept = await writeDraftImage("u1", PNG);
    const dropped = await writeDraftImage("u1", PNG);

    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const id of [kept, dropped]) {
      utimesSync(join(dir, "drafts", "u1", `${id}.png`), ancient, ancient);
    }

    const deleted = await sweepDrafts(24 * 60 * 60 * 1000, new Set([kept]));

    expect(deleted).toBe(1);
    expect(existsSync(join(dir, "drafts", "u1", `${kept}.png`))).toBe(true);
    expect(existsSync(join(dir, "drafts", "u1", `${dropped}.png`))).toBe(false);
  });
});
