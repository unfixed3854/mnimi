import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer } from "./testing.ts";
import { decksRouter } from "./decks.ts";
import { notesRouter } from "./notes.ts";
import { aiRouter } from "./ai.ts";
import { drafts, notes } from "../db/schema.ts";

vi.mock("../ai/openrouter-image.ts", () => ({
  generateOpenRouterImageBytes() { throw new Error("Unexpected OpenRouter fallback"); },
}));

let server: Awaited<ReturnType<typeof createTestServer>>;
const written: Array<{ userId: string; noteId: string; bytes: Uint8Array }> =
  [];

beforeEach(async () => {
  server = await createTestServer();
  written.length = 0;
});

afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

/** Context plus the two seams that would otherwise hit a model and the disk. */
function imageContext(
  base: Awaited<ReturnType<typeof server.signIn>>["context"],
) {
  return {
    ...base,
    generateImageBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    writeImage: vi.fn(
      async (userId: string, noteId: string, bytes: Uint8Array) => {
        written.push({ userId, noteId, bytes });
        return `${userId}/${noteId}.png`;
      },
    ),
    removeImage: vi.fn(async () => {}),
  };
}

async function seedNote(user: Awaited<ReturnType<typeof server.signIn>>) {
  const { userId, context } = user;
  const deck = await call(decksRouter.create, { name: "Deck" }, { context });
  const [draft] = await server.db
    .insert(drafts)
    .values({
      userId,
      deckId: deck.id,
      sourceText: "die Banane",
      status: "ready",
      classification: {
        domain: "language",
        language: "de",
        partOfSpeech: "noun",
      },
      cards: [
        {
          aspect: "meaning",
          front: "f",
          back: "b",
          imageCue: false,
        },
      ],
      imagePrompt: "a banana",
    })
    .returning();
  return await call(
    notesRouter.save,
    {
      draftId: draft.id,
      cards: [
        {
          aspect: "meaning",
          front: "f",
          back: "b",
          imageCue: false,
        },
      ],
    },
    { context },
  );
}

describe("ai.generateImage", () => {
  it("reports a missing provider explicitly", async () => {
    const ada = await server.signIn("ada@example.com");
    const note = await seedNote(ada);
    await expect(call(aiRouter.generateImage, { noteId: note.id, prompt: "a banana" }, {
      context: ada.context,
    })).rejects.toThrow("AI provider is not configured");
  });

  it("writes the image under the owner and records the path", async () => {
    const ada = await server.signIn("ada@example.com");
    const note = await seedNote(ada);
    const context = imageContext(ada.context);

    const result = await call(
      aiRouter.generateImage,
      { noteId: note.id, prompt: "a banana" },
      { context },
    );

    expect(result.imagePath).toBe(`${ada.userId}/${note.id}.png`);
    expect(written).toHaveLength(1);
    expect(written[0].userId).toBe(ada.userId);

    const [updated] = await server.db
      .select()
      .from(notes)
      .where(eq(notes.id, note.id));
    expect(updated.imagePath).toBe(`${ada.userId}/${note.id}.png`);
  });

  it("refuses another user's note before spending a generation", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const bobNote = await seedNote(bob);
    const context = imageContext(ada.context);

    await expect(
      call(
        aiRouter.generateImage,
        { noteId: bobNote.id, prompt: "a banana" },
        { context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The point of the pre-check: no model call, no bytes written.
    expect(context.generateImageBytes).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it("refuses an unknown note before spending a generation", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = imageContext(ada.context);

    await expect(
      call(
        aiRouter.generateImage,
        {
          noteId: "0195f0e0-0000-7000-8000-000000000000",
          prompt: "a banana",
        },
        { context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(context.generateImageBytes).not.toHaveBeenCalled();
  });

  it("rejects an over-long prompt", async () => {
    const ada = await server.signIn("ada@example.com");
    const note = await seedNote(ada);

    await expect(
      call(
        aiRouter.generateImage,
        { noteId: note.id, prompt: "x".repeat(1001) },
        { context: imageContext(ada.context) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("flags the note when generation fails, and rethrows", async () => {
    const ada = await server.signIn("ada@example.com");
    const note = await seedNote(ada);
    const context = {
      ...imageContext(ada.context),
      generateImageBytes: vi.fn(async () => {
        throw new Error("model exploded");
      }),
    };

    await expect(
      call(aiRouter.generateImage, { noteId: note.id, prompt: "a banana" }, {
        context,
      }),
    ).rejects.toThrow();

    const [updated] = await server.db.select().from(notes).where(
      eq(notes.id, note.id),
    );
    expect(updated.metadata.imageFailed).toBe(true);
    expect(updated.imagePath).toBeNull();
  });

  it("clears a previous failure flag once an image lands", async () => {
    const ada = await server.signIn("ada@example.com");
    const note = await seedNote(ada);
    await server.db
      .update(notes)
      .set({ metadata: { imageFailed: true } })
      .where(eq(notes.id, note.id));

    await call(
      aiRouter.generateImage,
      { noteId: note.id, prompt: "a banana" },
      { context: imageContext(ada.context) },
    );

    const [updated] = await server.db.select().from(notes).where(
      eq(notes.id, note.id),
    );
    expect(updated.metadata.imageFailed).toBeUndefined();
  });

  it("removes a late image when replacement deleted the note before completion", async () => {
    const ada = await server.signIn("ada@example.com");
    const note = await seedNote(ada);
    let release!: (bytes: Uint8Array) => void;
    const bytes = new Promise<Uint8Array>((resolve) => {
      release = resolve;
    });
    const context = {
      ...imageContext(ada.context),
      generateImageBytes: vi.fn(() => bytes),
    };

    const run = call(
      aiRouter.generateImage,
      { noteId: note.id, prompt: "a banana" },
      { context },
    );
    await vi.waitFor(() =>
      expect(context.generateImageBytes).toHaveBeenCalled()
    );
    await server.db.delete(notes).where(eq(notes.id, note.id));

    release(new Uint8Array([9]));
    await run;

    expect(context.writeImage).toHaveBeenCalledWith(
      ada.userId,
      note.id,
      new Uint8Array([9]),
    );
    expect(context.removeImage).toHaveBeenCalledWith(
      `${ada.userId}/${note.id}.png`,
    );
  });
});
