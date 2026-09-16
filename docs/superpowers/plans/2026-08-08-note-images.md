# Note Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated note images visible in the app, and generate them before the note is saved so they can be seen and rejected on the confirm screen.

**Architecture:** An authenticated Hono route serves PNGs from `IMAGES_DIR`, keyed by id rather than by path. Because auth is a bearer token in `localStorage`, a bare `<img src>` cannot authenticate, so the client fetches with the header and wraps the bytes in an object URL. Image generation moves ahead of the save: a draft is written under a server-issued `draftId`, shown on the confirm screen, and claimed by `notes.save` after its transaction commits.

**Tech Stack:** Deno + Hono + oRPC + Drizzle (SQLite via libsql) on the server; React 19 + TanStack Router/Query on the client; Vitest for both halves.

**Spec:** `docs/superpowers/specs/2026-08-08-note-image-display-design.md`

## Global Constraints

- **Package manager is `deno`.** Never `npm`, `npx`, `yarn` or `pnpm` (`AGENTS.md`).
- **Run tests with `deno task test`** (`vitest run`). A single file: `deno task test <path>`.
- **Type-check the server with `deno task check:api`** before committing server changes.
- Server code uses **explicit `.ts` extensions** on relative imports.
- **Using a new `Deno.*` API means extending `src/types/deno.d.ts` in the same task.** The client typecheck pulls `server/**` in through the router type import, so `tsc` needs a declaration for every `Deno` API the server touches. That shim is deliberately minimal and hand-maintained. `deno task check:api` does **not** catch the omission — only `deno task build` does. Any task adding a `Deno.*` call must add the declaration and run `deno task build` before committing. Tasks 2, 9 and 11 all add Deno APIs.
- Client imports use the `@/` alias for `src/` and `~server/` for `server/` — the latter **type-only**, so no server module reaches the browser bundle.
- No procedure may take a `userId` from its input; it comes from `context.userId` only (`server/router/base.ts`).
- Every write to a `metadata` JSON column goes through `withWriteLock` — it is a read-modify-write.
- `@testing-library/react` has **no automatic cleanup** here (no `globals: true`, no setup file). Every component test file must call `afterEach(cleanup)`.
- **Route components are not unit-tested in this codebase.** Logic is extracted into `src/lib/` or `src/hooks/` and tested there; `src/routes/*.tsx` carries wiring only. `src/lib/run-generation.ts`'s doc comment states the convention explicitly ("lives in a pure, testable module instead of the one route component the design otherwise leaves untested"). Tasks that change a route verify in the running app instead — that is the intended coverage, not a gap.
- Commit after every task.

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `server/images.ts` | All image storage and serving: `IMAGES_DIR`, `writeImage`, `writeDraftImage`, `claimDraftImage`, `sweepDrafts`, `createImagesRoute` |
| `server/images.test.ts` | HTTP-level tests for both serving scopes, plus `sweepDrafts` |
| `server/write-image.test.ts` | Moved from `server/router/`; real disk writes against a temp dir |
| `src/lib/api/images.ts` | `useGeneratedImage` — fetches image bytes with the bearer token |
| `src/lib/api/images.test.ts` | Header, path-per-scope, and no-retry-on-404 |
| `src/components/generated-image.tsx` | `GeneratedImage` — owns the object-URL lifetime |
| `src/components/generated-image.test.tsx` | Render states and URL revocation |
| `src/hooks/use-elapsed.ts` | `useElapsed`, extracted so the Save button and `GenerationStatus` share one clock |
| `src/lib/run-draft-image.ts` | Drives the draft-image call; owns the timeout |
| `src/lib/run-draft-image.test.ts` | Success, failure, abort, session-expiry, timeout |
| `src/routes/_authed.notes.$noteId.tsx` | Note detail screen with retry |

**Modified**

| Path | Change |
|---|---|
| `server/router/ai.ts` | Drop `IMAGES_DIR`/`writeImage`; add `generateDraftImage`; set/clear `imageFailed` |
| `server/router/base.ts` | `AppContext` gains `writeDraftImage` |
| `server/app.ts` | Mount `/images` |
| `server/db/schema.ts` | `NoteMetadata` gains `imageFailed`, `imagePrompt` |
| `server/router/cards.ts` | `due` returns `hasImage` |
| `server/router/notes.ts` | `save` claims the draft and persists `imagePrompt`; add `get` |
| `server/main.ts` | Wire `sweepDrafts` |
| `src/lib/generation-state.ts` | `review` gains `draftImage` |
| `src/lib/api/ai.ts` | Add `generateDraftImage` |
| `src/lib/api/notes.ts` | Send `draftImageId`; delete the fire-and-forget block |
| `src/components/generation-status.tsx` | Consume the extracted `useElapsed` |
| `src/routes/_authed.add.tsx` | Draft image, Save gating, retry |
| `src/routes/_authed.decks.$deckId.tsx` | Thumbnails, failure marker, links |
| `src/routes/_authed.review.$deckId.tsx` | Image after reveal |
| `README.md` | Document the route and the draft flow |

---

# Part 1 — Serving and display

Tasks 1–8 are shippable on their own: after Task 8 the images already on disk are visible.

---

### Task 1: Extract image storage into `server/images.ts`

Pure refactor, no behaviour change. Existing tests must pass untouched apart from their import.

**Files:**
- Create: `server/images.ts`
- Modify: `server/router/ai.ts:11-27` (delete the moved code, import it back)
- Move: `server/router/write-image.test.ts` → `server/write-image.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `IMAGES_DIR: string`, `writeImage(userId: string, noteId: string, bytes: Uint8Array): Promise<string>` from `server/images.ts`.

- [ ] **Step 1: Move the test file and point it at the new module**

```bash
git mv server/router/write-image.test.ts server/write-image.test.ts
```

In `server/write-image.test.ts`, change line 17 and the comment above it:

```ts
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
Deno.env.set("IMAGES_DIR", dir);
const { writeImage } = await import("./images.ts");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/write-image.test.ts`
Expected: FAIL — cannot resolve `./images.ts`.

- [ ] **Step 3: Create `server/images.ts`**

```ts
/**
 * Everything that touches image bytes on disk, plus the route that serves
 * them. The HTTP layer needs IMAGES_DIR, so it cannot live in the RPC router
 * without inverting the layering.
 */
export const IMAGES_DIR = Deno.env.get("IMAGES_DIR") ?? "./data/images";

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
  await Deno.mkdir(`${IMAGES_DIR}/${userId}`, { recursive: true });
  await Deno.writeFile(`${IMAGES_DIR}/${userId}/${noteId}.png`, bytes);
  return `${userId}/${noteId}.png`;
}
```

- [ ] **Step 4: Delete the moved code from `server/router/ai.ts`**

Remove lines 11-27 (the `IMAGES_DIR` constant and the whole `writeImage` function including its doc comment), and add to the imports at the top:

```ts
import { writeImage } from "../images.ts";
```

- [ ] **Step 5: Run the full suite and the type check**

Run: `deno task test && deno task check:api`
Expected: PASS, same test count as before the move.

- [ ] **Step 6: Commit**

```bash
git add server/images.ts server/router/ai.ts server/write-image.test.ts
git commit -m "refactor(images): move image storage out of the RPC router"
```

---

### Task 2: Serve note images over authenticated HTTP

**Files:**
- Modify: `server/images.ts` (add `createImagesRoute`)
- Modify: `server/app.ts` (mount it)
- Test: `server/images.test.ts`

**Interfaces:**
- Consumes: `IMAGES_DIR` (Task 1).
- Produces: `createImagesRoute({ db, auth }: { db: Db; auth: Auth }): Hono` from `server/images.ts`. Route `GET /images/notes/:noteId` → 200 `image/png` | 401 | 404.

- [ ] **Step 1: Write the failing test**

Create `server/images.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";

// IMAGES_DIR is read once at module load, so it must be set before anything
// that imports images.ts is imported. Hence the dynamic imports below.
const dir = mkdtempSync(join(tmpdir(), "mnimi-serve-"));
Deno.env.set("IMAGES_DIR", dir);

const { createApp } = await import("./app.ts");
const { createAuth } = await import("./auth.ts");
const { createTestDb } = await import("./db/testing.ts");
const { decks, notes } = await import("./db/schema.ts");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let close: () => void;
let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  db = testDb.db;
  const auth = createAuth(db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
  });
  app = createApp({ db, auth, corsOrigin: "http://localhost:1420" });
});

afterEach(() => close());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
    headers: { authorization: `Bearer ${response.headers.get("set-auth-token")}` },
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

    for (const path of [`/images/notes/${bobNote}`, `/images/notes/${uuidv7()}`, "/images/notes/nope"]) {
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/images.test.ts`
Expected: FAIL — every request 404s, because nothing is mounted at `/images`.

- [ ] **Step 3: Add the route to `server/images.ts`**

Append, and add the imports at the top of the file:

```ts
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { notes } from "./db/schema.ts";
import type { Db } from "./db/index.ts";
import type { Auth } from "./auth.ts";
```

```ts
/**
 * The client supplies an id, never a path: the path is composed from the
 * session's user id and a validated UUIDv7, so traversal is unreachable
 * rather than merely filtered.
 *
 * A missing row, someone else's row, a null imagePath and a malformed id all
 * answer 404 identically, so an id's existence never leaks — the same
 * reasoning as `notFound` in the RPC layer.
 */
export function createImagesRoute({ db, auth }: { db: Db; auth: Auth }) {
  const app = new Hono();

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

    return await sendPng(`${IMAGES_DIR}/${note.imagePath}`);
  });

  return app;
}

/** A `Response` rather than `c.body`: Hono's body type does not accept a
 *  Uint8Array, and Deno.readFile returns one. */
async function sendPng(path: string): Promise<Response> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    // Disk and database have diverged — worth knowing about, but the caller
    // still gets the same 404 as every other miss.
    console.error("image file missing on disk", path);
    return new Response(null, { status: 404 });
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-cache",
    },
  });
}
```

- [ ] **Step 4: Mount it in `server/app.ts`**

Add the import:

```ts
import { createImagesRoute } from "./images.ts";
```

and, immediately after the `app.on(["POST", "GET"], "/api/auth/*", ...)` line:

```ts
  app.route("/images", createImagesRoute({ db, auth }));
```

- [ ] **Step 5: Run the tests and the type check**

Run: `deno task test server/images.test.ts && deno task check:api`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add server/images.ts server/images.test.ts server/app.ts
git commit -m "feat(images): serve note images over an authenticated route"
```

---

### Task 3: Record a failed image generation on the note

**Files:**
- Modify: `server/db/schema.ts:96-100`
- Modify: `server/router/ai.ts` (the `generateImageProcedure` handler)
- Test: `server/router/ai.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NoteMetadata.imageFailed?: boolean`. `ai.generateImage` sets it on failure, clears it on success.

- [ ] **Step 1: Write the failing tests**

Append to `server/router/ai.test.ts`, inside the existing `describe("ai.generateImage", ...)` block:

```ts
  it("flags the note when generation fails, and rethrows", async () => {
    const ada = await server.signIn("ada@example.com");
    const note = await seedNote(ada.context);
    const context = {
      ...imageContext(ada.context),
      generateImageBytes: vi.fn(async () => {
        throw new Error("model exploded");
      }),
    };

    await expect(
      call(aiRouter.generateImage, { noteId: note.id, prompt: "a banana" }, { context }),
    ).rejects.toThrow();

    const [updated] = await server.db.select().from(notes).where(eq(notes.id, note.id));
    expect(updated.metadata.imageFailed).toBe(true);
    expect(updated.imagePath).toBeNull();
  });

  it("clears a previous failure flag once an image lands", async () => {
    const ada = await server.signIn("ada@example.com");
    const note = await seedNote(ada.context);
    await server.db
      .update(notes)
      .set({ metadata: { imageFailed: true } })
      .where(eq(notes.id, note.id));

    await call(
      aiRouter.generateImage,
      { noteId: note.id, prompt: "a banana" },
      { context: imageContext(ada.context) },
    );

    const [updated] = await server.db.select().from(notes).where(eq(notes.id, note.id));
    expect(updated.metadata.imageFailed).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `deno task test server/router/ai.test.ts`
Expected: FAIL — `imageFailed` is not a property of `NoteMetadata`, and nothing writes it.

- [ ] **Step 3: Extend `NoteMetadata` in `server/db/schema.ts`**

```ts
/** Classifier output kept alongside the note, plus generation-failure flags. */
export type NoteMetadata = {
  partOfSpeech?: string | null;
  generationFailed?: boolean;
  /** An image was attempted and did not arrive. Absent means none was ever
   *  wanted — the model returned a null imagePrompt — which is not a failure. */
  imageFailed?: boolean;
};
```

- [ ] **Step 4: Set and clear the flag in `server/router/ai.ts`**

Add the helper above `generateImageProcedure`:

```ts
/** Read-modify-write on a JSON column, so it takes the write lock like every
 *  other write to `metadata`. */
async function setImageFailed(
  context: { db: Db },
  userId: string,
  noteId: string,
  failed: boolean,
) {
  await withWriteLock(async () => {
    const [row] = await context.db
      .select({ metadata: notes.metadata })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .limit(1);
    if (!row) return;

    const { imageFailed: _dropped, ...rest } = row.metadata;
    await context.db
      .update(notes)
      .set({ metadata: failed ? { ...rest, imageFailed: true } : rest })
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)));
  });
}
```

with `import type { Db } from "../db/index.ts";` added to the imports.

Then wrap the byte generation in the handler — replace the existing `const bytes = await (...)` line with:

```ts
    let bytes: Uint8Array;
    try {
      bytes = await (context.generateImageBytes ?? generateImageBytes)(input.prompt);
    } catch (error) {
      await setImageFailed(context, context.userId, input.noteId, true);
      throw error;
    }
```

and immediately after the existing `withWriteLock` update that sets `imagePath`, add:

```ts
    await setImageFailed(context, context.userId, input.noteId, false);
```

- [ ] **Step 5: Run the tests and the type check**

Run: `deno task test server/router/ai.test.ts && deno task check:api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.ts server/router/ai.ts server/router/ai.test.ts
git commit -m "feat(images): record a failed image generation on the note"
```

---

### Task 4: Expose `hasImage` on due cards

**Files:**
- Modify: `server/router/cards.ts:36-56`
- Test: `server/router/cards.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `cards.due` now returns each card as `{ ...card, hasImage: boolean }`.

- [ ] **Step 1: Write the failing test**

Add `notes` to the schema import on `server/router/cards.test.ts:8`:

```ts
import { cards, notes, reviewLogs } from "../db/schema.ts";
```

Then append to the existing `describe("cards.due", ...)` block (line 71). It reuses that file's own `seed(context, count, deckName)` helper, which saves a note and returns its deck:

```ts
  it("reports whether the card's note has an image", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.context);

    const before = await call(cardsRouter.due, {}, { context: ada.context });
    expect(before.every((card) => card.hasImage === false)).toBe(true);

    await server.db
      .update(notes)
      .set({ imagePath: `${ada.userId}/whatever.png` })
      .where(eq(notes.userId, ada.userId));

    const after = await call(cardsRouter.due, {}, { context: ada.context });
    expect(after.every((card) => card.hasImage === true)).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test server/router/cards.test.ts`
Expected: FAIL — `hasImage` is undefined on the returned cards.

- [ ] **Step 3: Select the column and project it**

In `server/router/cards.ts`, change the `due` handler's select and return:

```ts
    const rows = await context.db
      .select({ card: cards, imagePath: notes.imagePath })
      .from(cards)
```

and the final line of the handler:

```ts
    // A boolean, not the path: the review screen only needs to know whether
    // to render, and the stored path is a server-side detail.
    return rows.map((row) => ({ ...row.card, hasImage: row.imagePath !== null }));
```

- [ ] **Step 4: Run the tests and the type check**

Run: `deno task test server/router/cards.test.ts && deno task check:api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/router/cards.ts server/router/cards.test.ts
git commit -m "feat(images): report hasImage on due cards"
```

---

### Task 5: `useGeneratedImage`

**Files:**
- Create: `src/lib/api/images.ts`
- Test: `src/lib/api/images.test.ts`

**Interfaces:**
- Consumes: `apiUrl`, `getToken` from `@/lib/orpc`; `sessionAwareFetch` from `@/lib/session-rejection`.
- Produces: `useGeneratedImage(scope: "notes" | "drafts", id: string, enabled: boolean)` returning React Query's result with `data?: Blob`, and `imageQueryOptions(scope, id, enabled)` for the test to exercise without a component.

- [ ] **Step 1: Write the failing test**

Create `src/lib/api/images.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchMock, getTokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getTokenMock: vi.fn(),
}));

vi.mock("@/lib/orpc", () => ({
  apiUrl: "http://api.test",
  getToken: getTokenMock,
}));
vi.mock("@/lib/session-rejection", () => ({ sessionAwareFetch: fetchMock }));

import { imageQueryOptions } from "./images";

function okResponse() {
  return { ok: true, blob: async () => new Blob([new Uint8Array([1])]) };
}

describe("imageQueryOptions", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getTokenMock.mockReset();
    getTokenMock.mockReturnValue("t0ken");
  });

  it("fetches the note scope with the bearer token", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    await imageQueryOptions("notes", "abc", true).queryFn();

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/images/notes/abc", {
      headers: { authorization: "Bearer t0ken" },
    });
  });

  it("fetches the draft scope from the drafts path", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    await imageQueryOptions("drafts", "d1", true).queryFn();

    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/images/drafts/d1");
  });

  it("returns the blob the response carries", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    const blob = await imageQueryOptions("notes", "abc", true).queryFn();

    expect(blob).toBeInstanceOf(Blob);
  });

  it("throws on a non-ok response and never retries", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(imageQueryOptions("notes", "abc", true).queryFn()).rejects.toThrow();
    // A missing image is a normal outcome, not something to hammer.
    expect(imageQueryOptions("notes", "abc", true).retry).toBe(false);
  });

  it("is disabled when the caller says there is no image", () => {
    expect(imageQueryOptions("notes", "abc", false).enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test src/lib/api/images.test.ts`
Expected: FAIL — cannot resolve `./images`.

- [ ] **Step 3: Write `src/lib/api/images.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { apiUrl, getToken } from "@/lib/orpc";
import { sessionAwareFetch } from "@/lib/session-rejection";

export type ImageScope = "notes" | "drafts";

/**
 * Raw HTTP rather than an oRPC procedure, because a procedure would have to
 * base64 the bytes into JSON.
 *
 * The query caches the **Blob, not an object URL**: React Query has no
 * destructor that fires on cache eviction, so a URL cached here would leak for
 * the lifetime of the tab. The component owns the URL; the cache owns bytes.
 *
 * Exported separately from the hook so it is testable without rendering.
 */
export function imageQueryOptions(scope: ImageScope, id: string, enabled: boolean) {
  return {
    queryKey: ["image", scope, id] as const,
    enabled,
    // A missing image is a normal outcome, not something to retry.
    retry: false as const,
    // The bytes behind an id do not change within a session.
    staleTime: Infinity,
    queryFn: async (): Promise<Blob> => {
      const token = getToken();
      const response = await sessionAwareFetch(`${apiUrl}/images/${scope}/${id}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
      return await response.blob();
    },
  };
}

export function useGeneratedImage(scope: ImageScope, id: string, enabled: boolean) {
  return useQuery(imageQueryOptions(scope, id, enabled));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test src/lib/api/images.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/images.ts src/lib/api/images.test.ts
git commit -m "feat(images): add useGeneratedImage"
```

---

### Task 6: `GeneratedImage`

**Files:**
- Create: `src/components/generated-image.tsx`
- Test: `src/components/generated-image.test.tsx`

**Interfaces:**
- Consumes: `useGeneratedImage` (Task 5), `Skeleton` from `@/components/ui/skeleton`.
- Produces: `<GeneratedImage scope id present alt className />` where `present: boolean` means "the server says an image exists".

- [ ] **Step 1: Write the failing test**

Create `src/components/generated-image.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GeneratedImage } from "@/components/generated-image";

afterEach(cleanup);

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@/lib/api/images", () => ({ useGeneratedImage: queryMock }));

// jsdom implements neither of these.
const createObjectURL = vi.fn(() => "blob:fake");
const revokeObjectURL = vi.fn();
URL.createObjectURL = createObjectURL;
URL.revokeObjectURL = revokeObjectURL;

function renderImage(props: Parameters<typeof GeneratedImage>[0]) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <GeneratedImage {...props} />
    </QueryClientProvider>,
  );
}

describe("GeneratedImage", () => {
  it("renders nothing when the server says there is no image", () => {
    queryMock.mockReturnValue({ data: undefined, isError: false });

    const { container } = renderImage({
      scope: "notes", id: "n1", present: false, alt: "die Banane",
    });

    // A note that was never meant to have a picture is correct, not broken.
    expect(container.firstChild).toBeNull();
  });

  it("renders the image once the blob arrives", async () => {
    queryMock.mockReturnValue({ data: new Blob([new Uint8Array([1])]), isError: false });

    renderImage({ scope: "notes", id: "n1", present: true, alt: "die Banane" });

    await waitFor(() => {
      const img = screen.getByAltText("die Banane") as HTMLImageElement;
      expect(img.src).toBe("blob:fake");
    });
  });

  it("renders nothing when the fetch failed", () => {
    queryMock.mockReturnValue({ data: undefined, isError: true });

    const { container } = renderImage({
      scope: "notes", id: "n1", present: true, alt: "die Banane",
    });

    expect(container.firstChild).toBeNull();
  });

  it("revokes the object URL on unmount", async () => {
    queryMock.mockReturnValue({ data: new Blob([new Uint8Array([1])]), isError: false });
    revokeObjectURL.mockClear();

    const { unmount } = renderImage({
      scope: "notes", id: "n1", present: true, alt: "die Banane",
    });
    await waitFor(() => screen.getByAltText("die Banane"));
    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test src/components/generated-image.test.tsx`
Expected: FAIL — cannot resolve `@/components/generated-image`.

- [ ] **Step 3: Write `src/components/generated-image.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useGeneratedImage, type ImageScope } from "@/lib/api/images";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Owns the object-URL lifetime the query cache cannot: React Query has no
 * destructor on eviction, so the URL is created here and revoked when this
 * component goes away.
 */
export function GeneratedImage({
  scope,
  id,
  present,
  alt,
  className,
}: {
  scope: ImageScope;
  id: string;
  present: boolean;
  alt: string;
  className?: string;
}) {
  const { data: blob, isError } = useGeneratedImage(scope, id, present);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  // Nothing wanted, or the fetch failed: collapse rather than leave a frame.
  if (!present || isError) return null;
  // The skeleton carries the final dimensions, so nothing shifts on arrival.
  if (!url) return <Skeleton className={className} />;

  return <img src={url} alt={alt} className={cn("object-cover", className)} />;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test src/components/generated-image.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/generated-image.tsx src/components/generated-image.test.tsx
git commit -m "feat(images): add the GeneratedImage component"
```

---

### Task 7: Show images in the deck note list

**Files:**
- Modify: `src/routes/_authed.decks.$deckId.tsx:96-108`

**Interfaces:**
- Consumes: `GeneratedImage` (Task 6), `NoteMetadata.imageFailed` (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Add the thumbnail and the failure marker**

Add the import:

```tsx
import { GeneratedImage } from "@/components/generated-image";
```

Replace the `<li>` body (lines 98-108) with:

```tsx
              <li
                key={note.id}
                className="animate-rise flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-4 py-3.5"
                style={{ "--stagger": index } as CSSProperties}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <GeneratedImage
                    scope="notes"
                    id={note.id}
                    present={note.imagePath !== null}
                    alt={note.sourceText}
                    className="size-10 shrink-0 rounded-lg"
                  />
                  <span className="min-w-0 font-medium break-words">
                    {note.sourceText}
                  </span>
                </div>
                <div className="flex shrink-0 items-baseline gap-2 text-xs text-muted-foreground">
                  {/* Information, not an error state: a picture was wanted and
                      did not arrive, which is worth knowing and not worth
                      shouting about. */}
                  {note.metadata.imageFailed && <span>image failed</span>}
                  <span>{note.domain}</span>
                </div>
              </li>
```

- [ ] **Step 2: Run the suite**

Run: `deno task test`
Expected: PASS — no existing test asserts on this markup.

- [ ] **Step 3: Verify in the running app**

Run: `deno task dev`, open a deck that contains `die Banane`.
Expected: its thumbnail renders. This is the first point in the plan where the original bug is visibly fixed.

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authed.decks.\$deckId.tsx
git commit -m "feat(images): show note thumbnails in the deck list"
```

---

### Task 8: Show the image on the review card after reveal

**Files:**
- Modify: `src/routes/_authed.review.$deckId.tsx:144-152`

**Interfaces:**
- Consumes: `GeneratedImage` (Task 6), `hasImage` on due cards (Task 4).
- Produces: nothing downstream.

- [ ] **Step 1: Render the image inside the revealed answer**

Add the import:

```tsx
import { GeneratedImage } from "@/components/generated-image";
```

Replace the revealed answer `<Card>` with:

```tsx
          <Card className="mt-3 ring-0 bg-accent">
            <CardContent className="py-10 text-center text-2xl font-medium text-balance text-accent-foreground">
              {card.back}
              {/* After reveal only. A picture of a banana IS the answer to
                  "what does die Banane mean?", so showing it on the front
                  would let the card be graded without recall, corrupting the
                  FSRS scheduling this whole app runs on. */}
              <GeneratedImage
                scope="notes"
                id={card.noteId}
                present={card.hasImage}
                alt={card.back}
                className="mx-auto mt-6 max-h-64 rounded-lg"
              />
            </CardContent>
          </Card>
```

- [ ] **Step 2: Run the suite and the type check**

Run: `deno task test && deno task check:api`
Expected: PASS.

- [ ] **Step 3: Verify in the running app**

Run: `deno task dev`, review a deck containing a note with an image.
Expected: the front shows no picture; the picture appears with the answer.

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authed.review.\$deckId.tsx
git commit -m "feat(images): show the note image once the answer is revealed"
```

---

# Part 2 — Pre-save generation

---

### Task 9: Draft image storage and its serving scope

**Files:**
- Modify: `server/images.ts`
- Test: `server/images.test.ts`, `server/write-image.test.ts`

**Interfaces:**
- Consumes: `IMAGES_DIR`, `createImagesRoute` (Tasks 1–2).
- Produces: `DRAFTS_DIR: string`, `writeDraftImage(userId: string, bytes: Uint8Array): Promise<string>` returning the new `draftId`, `claimDraftImage(userId: string, draftId: string, noteId: string): Promise<string>` returning the relative note path. Route `GET /images/drafts/:draftId`.

- [ ] **Step 1: Write the failing tests**

Append to `server/write-image.test.ts` (extend the dynamic import on line 17 to `const { writeImage, writeDraftImage, claimDraftImage } = await import("./images.ts");`):

```ts
describe("writeDraftImage / claimDraftImage", () => {
  it("writes a draft under the owner and claims it onto a note path", async () => {
    const userId = "0198c0b0-0000-7000-8000-000000000021";
    const noteId = "0198c0b0-0000-7000-8000-000000000022";
    const bytes = new Uint8Array([7, 7, 7]);

    const draftId = await writeDraftImage(userId, bytes);
    expect(existsSync(join(dir, "drafts", userId, `${draftId}.png`))).toBe(true);

    const path = await claimDraftImage(userId, draftId, noteId);

    expect(path).toBe(`${userId}/${noteId}.png`);
    expect(new Uint8Array(readFileSync(join(dir, path)))).toEqual(bytes);
    // The rename moves it — a second claim must not find a source.
    expect(existsSync(join(dir, "drafts", userId, `${draftId}.png`))).toBe(false);
  });

  it("rejects a claim for a draft that is not there", async () => {
    await expect(
      claimDraftImage(
        "0198c0b0-0000-7000-8000-000000000031",
        "0198c0b0-0000-7000-8000-000000000032",
        "0198c0b0-0000-7000-8000-000000000033",
      ),
    ).rejects.toBeInstanceOf(Deno.errors.NotFound);
  });
});
```

Append to `server/images.test.ts`:

```ts
describe("GET /images/drafts/:draftId", () => {
  it("serves the caller's own draft", async () => {
    const ada = await signUp("ada@example.com");
    const draftId = uuidv7();
    writePng(`drafts/${ada.userId}/${draftId}.png`);

    const response = await app.request(`/images/drafts/${draftId}`, {
      headers: ada.headers,
    });

    expect(response.status).toBe(200);
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `deno task test server/write-image.test.ts server/images.test.ts`
Expected: FAIL — `writeDraftImage` is not exported; the drafts route 404s even for its owner.

- [ ] **Step 3: Add the draft helpers to `server/images.ts`**

Add `import { uuidv7 } from "uuidv7";` at the top, then:

```ts
/** Drafts live beside the per-user note directories, under the same root, so
 *  claiming one is a rename within a single filesystem rather than a copy. */
export const DRAFTS_DIR = `${IMAGES_DIR}/drafts`;

/** Writes a not-yet-owned image and returns the id it was filed under. The id
 *  is generated here, never supplied by the client. */
export async function writeDraftImage(
  userId: string,
  bytes: Uint8Array,
): Promise<string> {
  const draftId = uuidv7();
  await Deno.mkdir(`${DRAFTS_DIR}/${userId}`, { recursive: true });
  await Deno.writeFile(`${DRAFTS_DIR}/${userId}/${draftId}.png`, bytes);
  return draftId;
}

/** Moves a draft onto its note's path. Throws `Deno.errors.NotFound` when the
 *  draft is gone — already claimed, or swept — which the caller records as a
 *  failed image rather than a failed save. */
export async function claimDraftImage(
  userId: string,
  draftId: string,
  noteId: string,
): Promise<string> {
  await Deno.mkdir(`${IMAGES_DIR}/${userId}`, { recursive: true });
  await Deno.rename(
    `${DRAFTS_DIR}/${userId}/${draftId}.png`,
    `${IMAGES_DIR}/${userId}/${noteId}.png`,
  );
  return `${userId}/${noteId}.png`;
}
```

- [ ] **Step 4: Add the drafts route**

Inside `createImagesRoute`, before `return app;`:

```ts
  // No database lookup: a draft belongs to whoever's directory it sits in, so
  // ownership IS the path prefix.
  app.get("/drafts/:draftId", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.body(null, 401);

    const draftId = c.req.param("draftId");
    if (!z.uuidv7().safeParse(draftId).success) return c.body(null, 404);

    return await sendPng(`${DRAFTS_DIR}/${session.user.id}/${draftId}.png`);
  });
```

- [ ] **Step 5: Run the tests and the type check**

Run: `deno task test server/write-image.test.ts server/images.test.ts && deno task check:api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/images.ts server/images.test.ts server/write-image.test.ts
git commit -m "feat(images): add draft image storage and its serving scope"
```

---

### Task 10: `ai.generateDraftImage`

**Files:**
- Modify: `server/router/ai.ts`, `server/router/base.ts:6-17`
- Test: `server/router/ai.test.ts`

**Interfaces:**
- Consumes: `writeDraftImage` (Task 9), `context.generateImageBytes` seam.
- Produces: `ai.generateDraftImage({ prompt: string }) → { draftId: string }`. `AppContext.writeDraftImage?: (userId: string, bytes: Uint8Array) => Promise<string>`.

- [ ] **Step 1: Write the failing test**

Append to `server/router/ai.test.ts`:

```ts
describe("ai.generateDraftImage", () => {
  it("generates bytes and files them under a server-issued draft id", async () => {
    const ada = await server.signIn("ada@example.com");
    const drafted: Array<{ userId: string; bytes: Uint8Array }> = [];
    const context = {
      ...ada.context,
      generateImageBytes: vi.fn(async () => new Uint8Array([4, 5, 6])),
      writeDraftImage: vi.fn(async (userId: string, bytes: Uint8Array) => {
        drafted.push({ userId, bytes });
        return "0198c0b0-0000-7000-8000-0000000000ff";
      }),
    };

    const result = await call(
      aiRouter.generateDraftImage,
      { prompt: "a banana" },
      { context },
    );

    expect(result.draftId).toBe("0198c0b0-0000-7000-8000-0000000000ff");
    expect(drafted).toHaveLength(1);
    // The owner comes from the session, never from input.
    expect(drafted[0].userId).toBe(ada.userId);
    expect(drafted[0].bytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("rejects an unauthenticated caller before spending a generation", async () => {
    const generateImageBytes = vi.fn(async () => new Uint8Array([1]));

    await expect(
      call(
        aiRouter.generateDraftImage,
        { prompt: "a banana" },
        { context: { db: server.db, auth: server.auth, generateImageBytes } },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(generateImageBytes).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test server/router/ai.test.ts`
Expected: FAIL — `aiRouter.generateDraftImage` is undefined.

- [ ] **Step 3: Add the context seam in `server/router/base.ts`**

In the `AppContext` type, after the existing `writeImage` entry:

```ts
  /** Overridden in tests so no bytes ever reach the disk. */
  writeDraftImage?: (userId: string, bytes: Uint8Array) => Promise<string>;
```

- [ ] **Step 4: Add the procedure in `server/router/ai.ts`**

Add `writeDraftImage` to the `../images.ts` import, then:

```ts
/**
 * Deliberately a separate procedure rather than a new event on the generation
 * stream: the stream contract, `runGeneration` and the validation-retry logic
 * all stay untouched, and "retry the image" is just calling this again.
 */
const generateDraftImageProcedure = authed
  .input(z.object({ prompt: z.string().min(1).max(1000) }))
  .handler(async ({ input, context }) => {
    const bytes = await (context.generateImageBytes ?? generateImageBytes)(
      input.prompt,
    );
    const draftId = await (context.writeDraftImage ?? writeDraftImage)(
      context.userId,
      bytes,
    );
    return { draftId };
  });
```

and register it:

```ts
export const aiRouter = {
  generateDraftImage: generateDraftImageProcedure,
  generateImage: generateImageProcedure,
  generateNote: generateNoteProcedure,
};
```

- [ ] **Step 5: Run the tests and the type check**

Run: `deno task test server/router/ai.test.ts && deno task check:api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/router/ai.ts server/router/base.ts server/router/ai.test.ts
git commit -m "feat(images): add ai.generateDraftImage"
```

---

### Task 11: Sweep abandoned drafts

**Files:**
- Modify: `server/images.ts`, `server/main.ts`
- Test: `server/images.test.ts`

**Interfaces:**
- Consumes: `DRAFTS_DIR` (Task 9).
- Produces: `sweepDrafts(maxAgeMs: number, now?: number): Promise<number>` returning how many files were deleted.

- [ ] **Step 1: Write the failing test**

Append to `server/images.test.ts`:

```ts
describe("sweepDrafts", () => {
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

    const deleted = await sweepDrafts(24 * 60 * 60 * 1000);

    expect(deleted).toBe(1);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(join(dir, "drafts", userId, `${fresh}.png`))).toBe(true);
  });

  it("is a no-op when no drafts directory exists yet", async () => {
    const { sweepDrafts } = await import("./images.ts");
    rmSync(join(dir, "drafts"), { recursive: true, force: true });

    await expect(sweepDrafts(1000)).resolves.toBe(0);
  });
});
```

Add `existsSync` and `utimesSync` to the `node:fs` import at the top of the file.

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test server/images.test.ts`
Expected: FAIL — `sweepDrafts` is not exported.

- [ ] **Step 3: Implement it in `server/images.ts`**

```ts
/**
 * Drafts are the only orphan class this design creates: `notes.save` claims
 * after its transaction commits, so a failed save leaves the file here rather
 * than at a note path no row points at.
 *
 * Exported as a plain function, and taking `now`, so it is tested against a
 * temp directory rather than against a clock.
 */
export async function sweepDrafts(
  maxAgeMs: number,
  now: number = Date.now(),
): Promise<number> {
  let deleted = 0;

  let userDirs: Deno.DirEntry[];
  try {
    userDirs = await Array.fromAsync(Deno.readDir(DRAFTS_DIR));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }

  for (const userDir of userDirs) {
    if (!userDir.isDirectory) continue;
    const path = `${DRAFTS_DIR}/${userDir.name}`;

    for await (const entry of Deno.readDir(path)) {
      if (!entry.isFile) continue;
      const file = `${path}/${entry.name}`;
      const info = await Deno.stat(file);
      const modified = info.mtime?.getTime() ?? now;
      if (now - modified <= maxAgeMs) continue;

      await Deno.remove(file);
      deleted++;
    }
  }

  return deleted;
}
```

- [ ] **Step 4: Wire it into `server/main.ts`**

```ts
import { createApp } from "./app.ts";
import { auth } from "./auth.instance.ts";
import { db } from "./db/index.ts";
import { sweepDrafts } from "./images.ts";

const port = Number(Deno.env.get("PORT") ?? 8787);
const app = createApp({ db, auth });

/** A draft nobody claimed is dead weight. Generous, because the only cost of
 *  keeping one an hour longer is disk. */
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function sweep() {
  sweepDrafts(DRAFT_MAX_AGE_MS).catch((error) =>
    console.error("draft sweep failed", error)
  );
}

sweep();
setInterval(sweep, SWEEP_INTERVAL_MS);

Deno.serve({ port }, app.fetch);
```

- [ ] **Step 5: Run the tests and the type check**

Run: `deno task test server/images.test.ts && deno task check:api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/images.ts server/images.test.ts server/main.ts
git commit -m "feat(images): sweep abandoned draft images"
```

---

### Task 12: `notes.save` persists the prompt and claims the draft

**Files:**
- Modify: `server/db/schema.ts` (`NoteMetadata`), `server/router/notes.ts`
- Test: `server/router/notes.test.ts`

**Interfaces:**
- Consumes: `claimDraftImage` (Task 9).
- Produces: `notes.save` input gains `draftImageId: string | null | undefined`; the returned note carries `imagePath` and `metadata.imagePrompt`.

- [ ] **Step 1: Update the two existing metadata assertions**

`save` now writes `imagePrompt` into `metadata`, so two `toEqual` assertions that enumerate the whole object go stale. They are correct today and wrong the moment Step 6 lands — update them first so the only failures you see afterwards are the new tests.

`server/router/notes.test.ts:53` — that test passes `imagePrompt: "a banana"` and no draft, which is precisely the "a picture was wanted and never arrived" case:

```ts
    expect(note.metadata).toEqual({
      partOfSpeech: "noun",
      imagePrompt: "a banana",
      imageFailed: true,
    });
```

`server/router/notes.test.ts:87` — that test passes `imagePrompt: null`, so no picture was ever wanted and nothing is flagged:

```ts
    expect(note.metadata).toEqual({
      partOfSpeech: null,
      imagePrompt: null,
      generationFailed: true,
    });
```

- [ ] **Step 2: Write the failing tests**

Append to `server/router/notes.test.ts`, reusing that file's existing `CLASSIFICATION` constant:

```ts
describe("notes.save and images", () => {
  function saveInput(deckId: string, overrides: Record<string, unknown> = {}) {
    return {
      deckId,
      sourceText: "die Banane",
      classification: { domain: "language", language: "de", partOfSpeech: "noun" },
      cards: [{ aspect: "meaning", front: "f", back: "b", hint: null }],
      imagePrompt: "a banana",
      ...overrides,
    };
  }

  it("claims the draft onto the new note and records the path", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(decksRouter.create, { name: "Deck" }, { context: ada.context });
    const claimed: Array<{ userId: string; draftId: string; noteId: string }> = [];
    const context = {
      ...ada.context,
      claimDraftImage: async (userId: string, draftId: string, noteId: string) => {
        claimed.push({ userId, draftId, noteId });
        return `${userId}/${noteId}.png`;
      },
    };

    const note = await call(
      notesRouter.save,
      saveInput(deck.id, { draftImageId: "0198c0b0-0000-7000-8000-0000000000ee" }),
      { context },
    );

    const [saved] = await server.db.select().from(notes).where(eq(notes.id, note.id));
    expect(saved.imagePath).toBe(`${ada.userId}/${note.id}.png`);
    expect(saved.metadata.imageFailed).toBeUndefined();
    expect(claimed).toEqual([
      { userId: ada.userId, draftId: "0198c0b0-0000-7000-8000-0000000000ee", noteId: note.id },
    ]);
  });

  it("persists the image prompt so a retry has something to regenerate from", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(decksRouter.create, { name: "Deck" }, { context: ada.context });

    const note = await call(notesRouter.save, saveInput(deck.id), { context: ada.context });

    const [saved] = await server.db.select().from(notes).where(eq(notes.id, note.id));
    expect(saved.metadata.imagePrompt).toBe("a banana");
  });

  it("flags a wanted image that never arrived", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(decksRouter.create, { name: "Deck" }, { context: ada.context });

    // A non-null prompt with no draft can only mean the attempt failed: Save
    // is disabled while a draft is in flight, and the fallback path carries a
    // null prompt.
    const note = await call(notesRouter.save, saveInput(deck.id), { context: ada.context });

    const [saved] = await server.db.select().from(notes).where(eq(notes.id, note.id));
    expect(saved.metadata.imageFailed).toBe(true);
    expect(saved.imagePath).toBeNull();
  });

  it("does not flag a note the model wanted no picture for", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(decksRouter.create, { name: "Deck" }, { context: ada.context });

    const note = await call(
      notesRouter.save,
      saveInput(deck.id, { imagePrompt: null }),
      { context: ada.context },
    );

    const [saved] = await server.db.select().from(notes).where(eq(notes.id, note.id));
    expect(saved.metadata.imageFailed).toBeUndefined();
  });

  it("still commits the note and its cards when the claim fails", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(decksRouter.create, { name: "Deck" }, { context: ada.context });
    const context = {
      ...ada.context,
      claimDraftImage: async () => {
        throw new Deno.errors.NotFound("swept");
      },
    };

    const note = await call(
      notesRouter.save,
      saveInput(deck.id, { draftImageId: "0198c0b0-0000-7000-8000-0000000000ed" }),
      { context },
    );

    const [saved] = await server.db.select().from(notes).where(eq(notes.id, note.id));
    expect(saved.imagePath).toBeNull();
    expect(saved.metadata.imageFailed).toBe(true);
    // Every failure degrades to "note without image", which is a valid note.
    const savedCards = await server.db.select().from(cards).where(eq(cards.noteId, note.id));
    expect(savedCards).toHaveLength(1);
  });
});
```

Import `cards` and `notes` from `../db/schema.ts` and `eq` from `drizzle-orm` if not already imported.

- [ ] **Step 3: Run to verify they fail**

Run: `deno task test server/router/notes.test.ts`
Expected: FAIL — `draftImageId` is rejected by the input schema, no metadata is written, and the two assertions from Step 1 now fail too.

- [ ] **Step 4: Extend `NoteMetadata`**

In `server/db/schema.ts`:

```ts
export type NoteMetadata = {
  partOfSpeech?: string | null;
  generationFailed?: boolean;
  /** An image was attempted and did not arrive. Absent means none was ever
   *  wanted — the model returned a null imagePrompt — which is not a failure. */
  imageFailed?: boolean;
  /** Kept so a retry after saving has something to regenerate from. */
  imagePrompt?: string | null;
};
```

- [ ] **Step 5: Add the context seam in `server/router/base.ts`**

```ts
  /** Overridden in tests so no file is ever moved on disk. */
  claimDraftImage?: (
    userId: string,
    draftId: string,
    noteId: string,
  ) => Promise<string>;
```

- [ ] **Step 6: Rewrite the `save` handler in `server/router/notes.ts`**

Add to the imports:

```ts
import { uuidv7 } from "uuidv7";
import { claimDraftImage } from "../images.ts";
```

Add to `saveNoteInput`, after `imagePrompt`:

```ts
  draftImageId: z.uuidv7().nullish(),
```

Replace the handler body with:

```ts
  .handler(async ({ input, context }) => {
    await assertOwnsDeck(context.db, context.userId, input.deckId);

    const now = new Date();
    // Generated here rather than left to the column default so the image's
    // destination path is known before anything is written.
    const noteId = uuidv7();

    const note = await withWriteLock(() =>
      context.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(notes)
          .values({
            id: noteId,
            userId: context.userId,
            deckId: input.deckId,
            sourceText: input.sourceText,
            domain: input.classification.domain,
            language: input.classification.language,
            metadata: {
              partOfSpeech: input.classification.partOfSpeech,
              imagePrompt: input.imagePrompt,
              ...(input.generationFailed ? { generationFailed: true } : {}),
            },
          })
          .returning();

        await tx.insert(cards).values(
          input.cards.map((card) => ({
            noteId: inserted.id,
            userId: context.userId,
            aspect: card.aspect,
            front: card.front,
            back: card.back,
            hint: card.hint,
            due: now,
          })),
        );

        return inserted;
      })
    );

    // Claiming AFTER the commit, never before: a rename first would, on a
    // failed transaction, leave a file at a note path with no note row — an
    // orphan class the draft sweep cannot see. This way every failure
    // degrades to "note without image", which is a valid note.
    return await attachImage(context, note, input.draftImageId ?? null);
  });
```

and add the helper above `save`:

```ts
/** Moves the staged draft onto the note, or records that the picture the user
 *  asked for never arrived. Returns the note as it now stands. */
async function attachImage(
  context: AuthedContext,
  note: typeof notes.$inferSelect,
  draftImageId: string | null,
) {
  if (draftImageId) {
    try {
      const imagePath = await (context.claimDraftImage ?? claimDraftImage)(
        context.userId,
        draftImageId,
        note.id,
      );
      await withWriteLock(() =>
        context.db.update(notes).set({ imagePath }).where(eq(notes.id, note.id))
      );
      return { ...note, imagePath };
    } catch (error) {
      console.error("could not claim the draft image", error);
    }
  } else if (!note.metadata.imagePrompt) {
    // No picture was ever wanted, so nothing failed.
    return note;
  }

  const metadata = { ...note.metadata, imageFailed: true };
  await withWriteLock(() =>
    context.db.update(notes).set({ metadata }).where(eq(notes.id, note.id))
  );
  return { ...note, metadata };
}
```

with `import type { AuthedContext } from "./base.ts";` added.

- [ ] **Step 7: Run the tests and the type check**

Run: `deno task test server/router/notes.test.ts && deno task check:api`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/db/schema.ts server/router/base.ts server/router/notes.ts server/router/notes.test.ts
git commit -m "feat(images): claim the draft image when the note is saved"
```

---

### Task 13: `notes.get`

**Files:**
- Modify: `server/router/notes.ts`
- Test: `server/router/notes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `notes.get({ noteId: string }) → { note: Note; cards: Card[] }`, 404 for another user's id.

- [ ] **Step 1: Write the failing test**

Append to `server/router/notes.test.ts`:

```ts
describe("notes.get", () => {
  it("returns the note with its cards", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(decksRouter.create, { name: "Deck" }, { context: ada.context });
    const saved = await call(
      notesRouter.save,
      {
        deckId: deck.id,
        sourceText: "die Banane",
        classification: { domain: "language", language: "de", partOfSpeech: "noun" },
        cards: [{ aspect: "meaning", front: "f", back: "b", hint: null }],
        imagePrompt: null,
      },
      { context: ada.context },
    );

    const result = await call(notesRouter.get, { noteId: saved.id }, { context: ada.context });

    expect(result.note.sourceText).toBe("die Banane");
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].aspect).toBe("meaning");
  });

  it("reports another user's note as missing", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const deck = await call(decksRouter.create, { name: "Deck" }, { context: bob.context });
    const bobNote = await call(
      notesRouter.save,
      {
        deckId: deck.id,
        sourceText: "das Flugzeug",
        classification: { domain: "language", language: "de", partOfSpeech: "noun" },
        cards: [{ aspect: "meaning", front: "f", back: "b", hint: null }],
        imagePrompt: null,
      },
      { context: bob.context },
    );

    await expect(
      call(notesRouter.get, { noteId: bobNote.id }, { context: ada.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test server/router/notes.test.ts`
Expected: FAIL — `notesRouter.get` is undefined.

- [ ] **Step 3: Add the procedure**

In `server/router/notes.ts`, before the export:

```ts
const get = authed
  .input(z.object({ noteId: z.uuidv7() }))
  .handler(async ({ input, context }) => {
    const [note] = await context.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, input.noteId), eq(notes.userId, context.userId)))
      .limit(1);
    if (!note) throw notFound("Note not found");

    const noteCards = await context.db
      .select()
      .from(cards)
      .where(eq(cards.noteId, note.id))
      .orderBy(asc(cards.due));

    return { note, cards: noteCards };
  });

export const notesRouter = { get, listByDeck, save };
```

Add `asc` to the `drizzle-orm` import.

- [ ] **Step 4: Run the tests and the type check**

Run: `deno task test server/router/notes.test.ts && deno task check:api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/router/notes.ts server/router/notes.test.ts
git commit -m "feat(notes): add notes.get for the note detail screen"
```

---

### Task 14: `draftImage` in the generation reducer

**Files:**
- Modify: `src/lib/generation-state.ts`
- Test: `src/lib/generation-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GenerationState`'s `review` variant gains `draftImage: DraftImageState`; three new `GenerationAction` members — `{ type: "draft-image-started"; startedAt: number }`, `{ type: "draft-image-ready"; draftId: string }`, `{ type: "draft-image-failed" }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/generation-state.test.ts`:

```ts
describe("draftImage", () => {
  const CLASSIFICATION = { domain: "language", language: "de", partOfSpeech: "noun" };

  function reviewState(imagePrompt: string | null) {
    let state = generationReducer(initialGenerationState, {
      type: "start", text: "die Banane", startedAt: 0,
    });
    state = generationReducer(state, { type: "classified", classification: CLASSIFICATION });
    return generationReducer(state, {
      type: "done",
      classification: CLASSIFICATION,
      generation: {
        cards: [{ aspect: "meaning", front: "f", back: "b", hint: null }],
        imagePrompt,
      },
    });
  }

  it("starts at none when the model wanted no picture", () => {
    const state = reviewState(null);
    expect(state.status === "review" && state.draftImage).toEqual({ status: "none" });
  });

  it("starts at none on the hand-editable fallback path", () => {
    let state = generationReducer(initialGenerationState, {
      type: "start", text: "die Banane", startedAt: 0,
    });
    state = generationReducer(state, { type: "error", message: "boom" });
    expect(state.status === "review" && state.draftImage).toEqual({ status: "none" });
  });

  it("moves through generating to ready", () => {
    let state = reviewState("a banana");
    state = generationReducer(state, { type: "draft-image-started", startedAt: 100 });
    expect(state.status === "review" && state.draftImage).toEqual({
      status: "generating", startedAt: 100,
    });

    state = generationReducer(state, { type: "draft-image-ready", draftId: "d1" });
    expect(state.status === "review" && state.draftImage).toEqual({
      status: "ready", draftId: "d1",
    });
  });

  it("moves to failed", () => {
    let state = reviewState("a banana");
    state = generationReducer(state, { type: "draft-image-started", startedAt: 100 });
    state = generationReducer(state, { type: "draft-image-failed" });
    expect(state.status === "review" && state.draftImage).toEqual({ status: "failed" });
  });

  it("ignores draft actions outside review", () => {
    const state = generationReducer(initialGenerationState, {
      type: "draft-image-ready", draftId: "d1",
    });
    expect(state).toBe(initialGenerationState);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test src/lib/generation-state.test.ts`
Expected: FAIL — `draftImage` is not on the state, and the actions are not in the union.

- [ ] **Step 3: Extend the state and the reducer**

In `src/lib/generation-state.ts`, add the type:

```ts
/** The staged image for a note that has not been saved yet. `none` means no
 *  picture was ever wanted, which is a decision and not a failure. */
export type DraftImageState =
  | { status: "none" }
  | { status: "generating"; startedAt: number }
  | { status: "ready"; draftId: string }
  | { status: "failed" };
```

Add to `GenerationAction`:

```ts
  | { type: "draft-image-started"; startedAt: number }
  | { type: "draft-image-ready"; draftId: string }
  | { type: "draft-image-failed" }
```

Add `draftImage: DraftImageState;` to the `review` variant of `GenerationState`.

In the `done` case, add `draftImage: { status: "none" },` to the returned object. Same for the `error` case — its `imagePrompt` is already null, so nothing was ever wanted there.

Add the three cases before `edit-card`:

```ts
    case "draft-image-started":
      if (state.status !== "review") return state;
      return {
        ...state,
        draftImage: { status: "generating", startedAt: action.startedAt },
      };

    case "draft-image-ready":
      if (state.status !== "review") return state;
      return { ...state, draftImage: { status: "ready", draftId: action.draftId } };

    case "draft-image-failed":
      if (state.status !== "review") return state;
      return { ...state, draftImage: { status: "failed" } };
```

- [ ] **Step 4: Run the tests**

Run: `deno task test src/lib/generation-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/generation-state.ts src/lib/generation-state.test.ts
git commit -m "feat(images): track the staged draft image in generation state"
```

---

### Task 15: `runDraftImage`

**Files:**
- Create: `src/lib/run-draft-image.ts`
- Test: `src/lib/run-draft-image.test.ts`

**Interfaces:**
- Consumes: `GenerationAction` (Task 14), `SessionExpiredError`.
- Produces: `runDraftImage(call: () => Promise<{ draftId: string }>, dispatch: (a: GenerationAction) => void, options?: { timeoutMs?: number }): Promise<void>` and `DRAFT_IMAGE_TIMEOUT_MS`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/run-draft-image.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runDraftImage } from "./run-draft-image";
import { SessionExpiredError } from "@/lib/session-expired";

describe("runDraftImage", () => {
  it("dispatches ready with the draft id", async () => {
    const dispatch = vi.fn();

    await runDraftImage(async () => ({ draftId: "d1" }), dispatch);

    expect(dispatch).toHaveBeenCalledWith({ type: "draft-image-ready", draftId: "d1" });
  });

  it("dispatches failed when the call rejects", async () => {
    const dispatch = vi.fn();

    await runDraftImage(async () => {
      throw new Error("model exploded");
    }, dispatch);

    expect(dispatch).toHaveBeenCalledWith({ type: "draft-image-failed" });
  });

  it("stays silent when the session is dead", async () => {
    const dispatch = vi.fn();

    // The route guard is already navigating to /login; a failed-image state
    // would offer the wrong remedy for the one failure that has a real fix.
    await runDraftImage(async () => {
      throw new SessionExpiredError();
    }, dispatch);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("settles as failed when the call never returns", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();

    const running = runDraftImage(() => new Promise(() => {}), dispatch, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await running;

    // Save is gated on this state: without the timeout, "disabled" would stop
    // being a wait and start being a trap.
    expect(dispatch).toHaveBeenCalledWith({ type: "draft-image-failed" });
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test src/lib/run-draft-image.test.ts`
Expected: FAIL — cannot resolve `./run-draft-image`.

- [ ] **Step 3: Write `src/lib/run-draft-image.ts`**

```ts
import { SessionExpiredError } from "@/lib/session-expired";
import type { GenerationAction } from "@/lib/generation-state";

/** Long enough that a slow model still lands, short enough that a hung
 *  request does not hold the Save button hostage forever. */
export const DRAFT_IMAGE_TIMEOUT_MS = 120_000;

/**
 * Drives the draft-image call to a settled state.
 *
 * Pulled out of `_authed.add.tsx` for the same reason as `runGeneration`: the
 * branches that need care — a dead session, and a call that never returns —
 * belong somewhere testable rather than in a route component.
 *
 * The timeout is not a nicety. Save is disabled while this is `generating`,
 * so a request that never settles would block saving for good.
 */
export async function runDraftImage(
  call: () => Promise<{ draftId: string }>,
  dispatch: (action: GenerationAction) => void,
  { timeoutMs = DRAFT_IMAGE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Image generation timed out")), timeoutMs);
  });

  try {
    const { draftId } = await Promise.race([call(), timeout]);
    dispatch({ type: "draft-image-ready", draftId });
  } catch (error) {
    // The session is dead and the route guard is already navigating away.
    if (error instanceof SessionExpiredError) return;
    dispatch({ type: "draft-image-failed" });
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test src/lib/run-draft-image.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/run-draft-image.ts src/lib/run-draft-image.test.ts
git commit -m "feat(images): add runDraftImage with a settling timeout"
```

---

### Task 16: Client API — draft generation, and save without the tail

**Files:**
- Modify: `src/lib/api/ai.ts`, `src/lib/api/notes.ts:12-31`
- Test: `src/lib/api/ai.test.ts`

**Interfaces:**
- Consumes: `ai.generateDraftImage` (Task 10), `notes.save` with `draftImageId` (Task 12).
- Produces: `generateDraftImage(prompt: string): Promise<{ draftId: string }>` from `@/lib/api/ai`. `useSaveNote()` unchanged in shape; its `mutate` input now accepts `draftImageId`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/api/ai.test.ts`, and add `generateDraftImageMock` to the `vi.hoisted` block and to the `ai` object in the `vi.mock("@/lib/orpc", ...)` factory:

```ts
describe("generateDraftImage", () => {
  beforeEach(() => generateDraftImageMock.mockReset());

  it("passes the prompt through and returns the draft id", async () => {
    generateDraftImageMock.mockResolvedValueOnce({ draftId: "d1" });

    await expect(generateDraftImage("a banana")).resolves.toEqual({ draftId: "d1" });
    expect(generateDraftImageMock).toHaveBeenCalledWith({ prompt: "a banana" });
  });

  it("reports a refused token as a dead session", async () => {
    generateDraftImageMock.mockRejectedValueOnce(new ORPCError("UNAUTHORIZED"));

    await expect(generateDraftImage("a banana")).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
```

Add `generateDraftImage` to the import from `./ai`.

- [ ] **Step 2: Run to verify it fails**

Run: `deno task test src/lib/api/ai.test.ts`
Expected: FAIL — `generateDraftImage` is not exported.

- [ ] **Step 3: Add the wrapper in `src/lib/api/ai.ts`**

```ts
export async function generateDraftImage(prompt: string) {
  try {
    return await client.ai.generateDraftImage({ prompt });
  } catch (error) {
    throw await asSessionError(error);
  }
}
```

- [ ] **Step 4: Delete the fire-and-forget block in `src/lib/api/notes.ts`**

Replace the whole file's `useSaveNote` with:

```ts
export function useSaveNote() {
  const queryClient = useQueryClient();

  return useMutation(
    orpc.notes.save.mutationOptions({
      // The image is attached server-side inside `save` now. The old
      // fire-and-forget call that used to live here is exactly where a failed
      // generation went silent — a console.error on a promise nobody awaited.
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.notes.key() });
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() });
      },
    }),
  );
}
```

and drop the now-unused `generateNoteImage` from the import on line 3, keeping the type re-exports.

- [ ] **Step 5: Run the suite and the type check**

Run: `deno task test && deno task check:api`
Expected: PASS. There is no `src/lib/api/notes.test.ts`, so nothing tested the deleted block — which is the other half of why the failure was invisible. Keep the `generateNoteImage` cases in `src/lib/api/ai.test.ts`: that wrapper survives as the retry path in Task 18.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api/ai.ts src/lib/api/ai.test.ts src/lib/api/notes.ts
git commit -m "feat(images): generate the image before the note is saved"
```

---

### Task 17: Wire the confirm screen

**Files:**
- Create: `src/hooks/use-elapsed.ts`
- Modify: `src/components/generation-status.tsx:36-55`, `src/routes/_authed.add.tsx`

**Interfaces:**
- Consumes: `runDraftImage` (Task 15), `generateDraftImage` (Task 16), `GeneratedImage` (Task 6), `draftImage` state (Task 14).
- Produces: `useElapsed(startedAt: number | null, running: boolean): number` from `@/hooks/use-elapsed`.

- [ ] **Step 1: Extract `useElapsed`**

Create `src/hooks/use-elapsed.ts` by moving the function verbatim out of `src/components/generation-status.tsx:36-55`, adding `export`:

```ts
import { useEffect, useState } from "react";

/** Milliseconds since `startedAt`, ticking once a second while `running`. */
export function useElapsed(startedAt: number | null, running: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0);
      return;
    }

    // Settle on the true value the moment the run stops, rather than freezing
    // on whatever the last tick happened to catch up to a second earlier.
    setElapsed(Date.now() - startedAt);
    if (!running) return;

    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt, running]);

  return elapsed;
}
```

Delete it from `generation-status.tsx` and import it there instead:

```tsx
import { useElapsed } from "@/hooks/use-elapsed";
```

- [ ] **Step 2: Run the suite to confirm the extraction changed nothing**

Run: `deno task test`
Expected: PASS.

- [ ] **Step 3: Fire the draft call when review is reached**

In `src/routes/_authed.add.tsx`, add the imports:

```tsx
import { generateDraftImage } from "@/lib/api/ai";
import { runDraftImage } from "@/lib/run-draft-image";
import { GeneratedImage } from "@/components/generated-image";
import { useElapsed } from "@/hooks/use-elapsed";
import { formatElapsed } from "@/lib/generation-status";
```

After the `review` narrowing (`const review = generation.status === "review" ? generation : null;`), add:

```tsx
  const draftImage = review?.draftImage ?? { status: "none" as const };
  const imagePrompt = review?.imagePrompt ?? null;

  // The image is generated before the note exists, so it can be seen — and
  // rejected — before anything is committed.
  useEffect(() => {
    if (!imagePrompt || draftImage.status !== "none") return;
    dispatch({ type: "draft-image-started", startedAt: Date.now() });
    runDraftImage(() => generateDraftImage(imagePrompt), dispatch);
  }, [imagePrompt, draftImage.status]);

  const imageElapsed = useElapsed(
    draftImage.status === "generating" ? draftImage.startedAt : null,
    draftImage.status === "generating",
  );
```

- [ ] **Step 4: Render the staged image and gate Save**

Above the card editors (immediately after the "Detected:" paragraph), add:

```tsx
      {draftImage.status === "ready" && (
        <GeneratedImage
          scope="drafts"
          id={draftImage.draftId}
          present
          alt={review?.text ?? ""}
          className="h-48 w-48 rounded-xl"
        />
      )}

      {draftImage.status === "failed" && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>The picture didn't come through.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!imagePrompt) return;
              dispatch({ type: "draft-image-started", startedAt: Date.now() });
              runDraftImage(() => generateDraftImage(imagePrompt), dispatch);
            }}
          >
            Try again
          </Button>
        </div>
      )}
```

Then change the Save button's `disabled` and label:

```tsx
          disabled={
            review.cards.length === 0 ||
            hasBlankCard ||
            saveNote.isPending ||
            draftImage.status === "generating"
          }
```

```tsx
          {draftImage.status === "generating"
            ? `Generating image… ${formatElapsed(imageElapsed)}`
            : saveNote.isPending
              ? "Saving…"
              : `Save ${review.cards.length} ${
                  review.cards.length === 1 ? "card" : "cards"
                }`}
```

And send the draft id in the mutation input, after `imagePrompt: review.imagePrompt,`:

```tsx
                draftImageId:
                  review.draftImage.status === "ready"
                    ? review.draftImage.draftId
                    : null,
```

- [ ] **Step 5: Run the suite and the type check**

Run: `deno task test && deno task check:api`
Expected: PASS.

- [ ] **Step 6: Verify the whole flow in the running app**

Run: `deno task dev`, add `die Banane` to a deck.
Expected: cards stream in; Save reads "Generating image… 0:07" and is disabled; the picture appears; Save enables; after saving, the thumbnail is in the deck list.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/use-elapsed.ts src/components/generation-status.tsx src/routes/_authed.add.tsx
git commit -m "feat(images): show the staged image before the note is saved"
```

---

### Task 18: Note detail screen with retry

**Files:**
- Create: `src/routes/_authed.notes.$noteId.tsx`
- Modify: `src/lib/api/notes.ts` (add `useNote`), `src/routes/_authed.decks.$deckId.tsx` (link the rows)

**Interfaces:**
- Consumes: `notes.get` (Task 13), `ai.generateImage` (Task 3), `GeneratedImage` (Task 6).
- Produces: route `/notes/$noteId`.

- [ ] **Step 1: Add the query hook**

In `src/lib/api/notes.ts`:

```ts
export function useNote(noteId: string) {
  return useQuery(orpc.notes.get.queryOptions({ input: { noteId } }));
}
```

- [ ] **Step 2: Create the route**

Create `src/routes/_authed.notes.$noteId.tsx`:

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNote } from "@/lib/api/notes";
import { generateNoteImage } from "@/lib/api/ai";
import { orpc } from "@/lib/orpc";
import { GeneratedImage } from "@/components/generated-image";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { BackLink, Page, PageHeader, PageTitle, SectionLabel } from "@/components/page";

export const Route = createFileRoute("/_authed/notes/$noteId")({ component: NotePage });

function NotePage() {
  const { noteId } = Route.useParams();
  const { data, isLoading } = useNote(noteId);
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (isLoading || !data) {
    return (
      <Page>
        <Skeleton className="h-9 w-48" />
      </Page>
    );
  }

  const { note, cards } = data;
  const prompt = note.metadata.imagePrompt;
  // Keyed on the persisted prompt rather than on imageFailed, so retry is
  // offered both for a failed attempt and for a note saved while its draft
  // was failing — without either needing to be told apart.
  const canRetry = note.imagePath === null && Boolean(prompt);

  return (
    <Page>
      <BackLink link={<Link to="/decks/$deckId" params={{ deckId: note.deckId }} />}>
        Deck
      </BackLink>

      <PageHeader>
        <PageTitle>{note.sourceText}</PageTitle>
      </PageHeader>

      <GeneratedImage
        scope="notes"
        id={note.id}
        present={note.imagePath !== null}
        alt={note.sourceText}
        className="h-56 w-56 rounded-xl"
      />

      {canRetry && (
        <div className="mt-4 flex items-center gap-3">
          <span className="text-sm text-muted-foreground">No picture for this note.</span>
          <Button
            variant="outline"
            size="sm"
            disabled={retrying}
            onClick={async () => {
              if (!prompt) return;
              setRetrying(true);
              setRetryError(null);
              try {
                await generateNoteImage(note.id, prompt);
                await queryClient.invalidateQueries({ queryKey: orpc.notes.key() });
              } catch {
                setRetryError("That didn't work either. Try again in a moment.");
              } finally {
                setRetrying(false);
              }
            }}
          >
            {retrying ? "Generating…" : "Generate one"}
          </Button>
        </div>
      )}

      {retryError && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{retryError}</AlertDescription>
        </Alert>
      )}

      <section className="mt-8">
        <SectionLabel className="mb-3">Cards</SectionLabel>
        <div className="grid gap-2">
          {cards.map((card) => (
            <Card key={card.id} className="ring-0">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">{card.aspect}</p>
                <p className="mt-1 font-medium">{card.front}</p>
                <p className="text-muted-foreground">{card.back}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </Page>
  );
}
```

- [ ] **Step 3: Link the deck rows**

In `src/routes/_authed.decks.$deckId.tsx`, wrap the `<li>` contents in a link:

```tsx
                <Link
                  to="/notes/$noteId"
                  params={{ noteId: note.id }}
                  className="flex min-w-0 items-center gap-3"
                >
```

closing `</Link>` in place of the `</div>` that currently wraps the thumbnail and source text.

- [ ] **Step 4: Regenerate the route tree**

Run: `deno task routes:generate`
Expected: `src/routeTree.gen.ts` gains the `/notes/$noteId` route.

- [ ] **Step 5: Run the suite and the type check**

Run: `deno task test && deno task check:api`
Expected: PASS.

- [ ] **Step 6: Verify in the running app**

Run: `deno task dev`, open a deck, click `das Flugzeug`.
Expected: the detail screen offers "Generate one", and clicking it produces a picture.

- [ ] **Step 7: Commit**

```bash
git add src/routes/_authed.notes.\$noteId.tsx src/routes/_authed.decks.\$deckId.tsx src/lib/api/notes.ts src/routeTree.gen.ts
git commit -m "feat(notes): add a note detail screen with image retry"
```

---

### Task 19: Document the new surfaces

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the procedure list**

In the section listing `ai.generateNote` and `ai.generateImage`, add before `ai.generateImage`:

```markdown
- **`ai.generateDraftImage`** — `{ prompt }`. Calls an OpenRouter image model and
  files the PNG under `IMAGES_DIR/drafts/<userId>/<draftId>.png`, returning the
  `draftId`. This runs while the capture screen is still showing cards for review,
  so the picture can be seen — and rejected — before the note is saved.
  `notes.save` claims the draft onto `<userId>/<noteId>.png` after its
  transaction commits.
```

and amend the `ai.generateImage` entry to say it is now the **retry** path, used from the note screen, regenerating from the prompt persisted on the note.

- [ ] **Step 2: Document the serving route**

Add after the procedure list:

```markdown
Images are served by `GET /images/notes/:noteId` and `GET /images/drafts/:draftId`,
both of which require the same bearer token as the RPC calls. A bare `<img src>`
cannot send an `Authorization` header, so the client fetches the bytes and wraps
them in an object URL — see `src/lib/api/images.ts` and
`src/components/generated-image.tsx`. Unclaimed drafts are swept after 24 hours.
```

- [ ] **Step 3: Fix the stale retry claim**

The Troubleshooting section says image generation is "independent and non-fatal: a note with no image is valid and the note screen offers a retry". The first half stays true; the retry is now real, at `/notes/$noteId`. Update the sentence to point there, and note that a note whose picture was wanted but never arrived is marked `image failed` in the deck list.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(images): document the image routes and the draft flow"
```

---

## Verification

After Task 19, run the whole suite and the type check one final time:

```bash
deno task test && deno task check:api
```

Then walk the flow end to end with `deno task dev`:

1. Add `das Flugzeug` — the image appears on the confirm screen before saving, with Save disabled while it generates.
2. Save — the thumbnail is in the deck list.
3. Review the deck — the front shows no picture; the picture appears with the answer.
4. Open a note that has no picture — "Generate one" produces one.
