import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { and, eq } from "drizzle-orm";

const mediaRoot = mkdtempSync(join(tmpdir(), "mnimi-german-seed-media-"));
const imageRoot = join(mediaRoot, "images");
const audioRoot = join(mediaRoot, "audio");
const previousImagesDir = process.env.IMAGES_DIR;
const previousAudioDir = process.env.AUDIO_DIR;
process.env.IMAGES_DIR = imageRoot;
process.env.AUDIO_DIR = audioRoot;

// The roots are module constants, so import the app only after selecting the
// temporary directories. No writer/remover test seam is used in this file.
const { createApp } = await import("./app.ts");
const { createAuth } = await import("./auth.ts");
const { createTestDb } = await import("./db/testing.ts");
const { cards, notes } = await import("./db/schema.ts");

let close: Awaited<ReturnType<typeof createTestDb>>["close"];
let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  db = testDb.db;
  const auth = createAuth(db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    registrationEnabled: true,
  });
  app = createApp({
    db,
    auth,
    corsOrigin: "http://localhost:1420",
    devtoolsEnabled: true,
  });
});

afterEach(() => close());

afterAll(() => {
  rmSync(mediaRoot, { recursive: true, force: true });
  if (previousImagesDir === undefined) delete process.env.IMAGES_DIR;
  else process.env.IMAGES_DIR = previousImagesDir;
  if (previousAudioDir === undefined) delete process.env.AUDIO_DIR;
  else process.env.AUDIO_DIR = previousAudioDir;
});

async function signUp() {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "ada@example.com",
      password: "correct-horse",
      name: "Ada",
    }),
  });
  const body = await response.json();
  return {
    userId: body.user.id as string,
    headers: {
      authorization: `Bearer ${response.headers.get("set-auth-token")}`,
    },
  };
}

describe("authenticated German seed media", () => {
  it("writes fixtures with the default writers and serves them on normal routes", async () => {
    const ada = await signUp();

    const seedResponse = await app.request("/rpc/debug/seedGerman", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ada.headers,
      },
      body: JSON.stringify({ json: { replace: false } }),
    });

    expect(seedResponse.status).toBe(200);
    expect(JSON.stringify(await seedResponse.json())).toContain(
      '"cardCount":9',
    );

    const [note] = await db.select().from(notes).where(
      eq(notes.userId, ada.userId),
    );
    const [card] = await db.select().from(cards).where(
      and(eq(cards.userId, ada.userId), eq(cards.noteId, note.id)),
    );
    expect(note.imagePath).not.toBeNull();
    expect(card.audioPath).not.toBeNull();

    const imageResponse = await app.request(`/images/notes/${note.id}`, {
      headers: ada.headers,
    });
    const audioResponse = await app.request(`/audio/cards/${card.id}`, {
      headers: ada.headers,
    });

    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(
      Buffer.from(await imageResponse.arrayBuffer()).equals(
        Buffer.from(await readFile(join(imageRoot, note.imagePath!))),
      ),
    ).toBe(true);
    expect(audioResponse.status).toBe(200);
    expect(audioResponse.headers.get("content-type")).toBe("audio/mpeg");
    expect(
      Buffer.from(await audioResponse.arrayBuffer()).equals(
        Buffer.from(await readFile(join(audioRoot, card.audioPath!))),
      ),
    ).toBe(true);
  });
});
