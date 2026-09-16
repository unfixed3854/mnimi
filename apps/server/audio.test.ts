import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { uuidv7 } from "uuidv7";
import { Effect } from "effect";
import { MediaFailure } from "./effect/errors.ts";

// AUDIO_DIR is read once at module load. Set it before importing app.ts,
// which mounts the route exported by audio.ts.
const dir = mkdtempSync(join(tmpdir(), "mnimi-audio-serve-"));
const outsideDir = mkdtempSync(join(tmpdir(), "mnimi-audio-serve-outside-"));
const previousAudioDir = process.env.AUDIO_DIR;
process.env.AUDIO_DIR = dir;

const { createApp } = await import("./app.ts");
const { createAuth } = await import("./auth.ts");
const { createTestDb } = await import("./db/testing.ts");
const { cards, decks, notes } = await import("./db/schema.ts");

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);

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
  if (previousAudioDir === undefined) delete process.env.AUDIO_DIR;
  else process.env.AUDIO_DIR = previousAudioDir;
});

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

async function seedCard(userId: string, audioPath: string | null) {
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
  });

  const cardId = uuidv7();
  await db.insert(cards).values({
    id: cardId,
    noteId,
    userId,
    aspect: "meaning",
    front: "die Banane",
    back: "the banana",
    audioPath,
    due: new Date(),
  });
  return cardId;
}

function writeMp3(relativePath: string) {
  mkdirSync(join(dir, relativePath, ".."), { recursive: true });
  writeFileSync(join(dir, relativePath), MP3);
}

describe("GET /audio/cards/:cardId", () => {
  it("serves the owner's MP3 with private no-cache headers", async () => {
    const ada = await signUp("ada@example.com");
    const cardId = await seedCard(ada.userId, `${ada.userId}/card.mp3`);
    writeMp3(`${ada.userId}/card.mp3`);

    const response = await app.request(`/audio/cards/${cardId}`, {
      headers: ada.headers,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3);
  });

  it("401s without a bearer token", async () => {
    const response = await app.request(`/audio/cards/${uuidv7()}`);
    expect(response.status).toBe(401);
  });

  it("404s malformed, unknown, foreign-owned, null-path, and missing-file cards alike", async () => {
    const ada = await signUp("ada@example.com");
    const bob = await signUp("bob@example.com");

    const foreignCard = await seedCard(
      bob.userId,
      `${bob.userId}/foreign.mp3`,
    );
    writeMp3(`${bob.userId}/foreign.mp3`);
    const nullPathCard = await seedCard(ada.userId, null);
    const missingFileCard = await seedCard(
      ada.userId,
      `${ada.userId}/missing.mp3`,
    );

    for (
      const cardId of [
        "not-a-uuid",
        uuidv7(),
        foreignCard,
        nullPathCard,
        missingFileCard,
      ]
    ) {
      const response = await app.request(`/audio/cards/${cardId}`, {
        headers: ada.headers,
      });
      expect(response.status).toBe(404);
    }
  });

  it("404s when the application-owned media store reports missing audio", async () => {
    const ada = await signUp("owned-missing-audio@example.com");
    const cardId = await seedCard(ada.userId, `${ada.userId}/missing.mp3`);
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const ownedApp = createApp({
      db,
      auth,
      corsOrigin: "http://localhost:1420",
      media: {
        readAudio: () => Effect.fail(new MediaFailure({
          operation: "media.readAudio",
          message: "missing",
          cause: missing,
        })),
      } as never,
    });

    const response = await ownedApp.request(`/audio/cards/${cardId}`, {
      headers: ada.headers,
    });

    expect(response.status).toBe(404);
  });

  it("404s a stored path that escapes the media root without reading outside it", async () => {
    const ada = await signUp("path-audio@example.com");
    const outsideFile = join(outsideDir, "sentinel-route.mp3");
    writeFileSync(outsideFile, MP3);
    const traversal = relative(dir, outsideFile);
    const cardId = await seedCard(ada.userId, traversal);

    const response = await app.request(`/audio/cards/${cardId}`, {
      headers: ada.headers,
    });

    expect(response.status).toBe(404);
    expect(new Uint8Array(readFileSync(outsideFile))).toEqual(MP3);
  });
});
