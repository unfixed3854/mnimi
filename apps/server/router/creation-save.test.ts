import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer, failingInsertInto } from "./testing.ts";
import { decksRouter } from "./decks.ts";
import { draftsRouter } from "./drafts.ts";
import {
  cards,
  creationImageAttempts,
  creationSaveReceipts,
  drafts,
  notes,
} from "../db/schema.ts";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => server = await createTestServer());
afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

const REVIEWED = [{
  key: "card-1",
  aspect: "meaning",
  front: "What is photosynthesis?",
  back: "Plants converting light into chemical energy.",
  imageCue: false,
}];

async function seedReady(
  user: Awaited<ReturnType<typeof server.signIn>>,
  clientRequestId: string,
  overrides: Partial<typeof drafts.$inferInsert> = {},
) {
  const deck = await call(decksRouter.create, { name: clientRequestId }, {
    context: user.context,
  });
  const [creation] = await server.db.insert(drafts).values({
    userId: user.userId,
    clientRequestId,
    deckId: deck.id,
    sourceText: `source-${clientRequestId}`,
    learningGoal: "Understand this concept.",
    status: "ready",
    operation: null,
    classification: {
      domain: "concept",
      language: null,
      partOfSpeech: null,
    },
    cards: REVIEWED,
    revision: 2,
    ...overrides,
  }).returning();
  return { deck, creation };
}

describe("drafts.save", () => {
  it("consumes exactly one creation and returns one receipt-backed note", async () => {
    const ada = await server.signIn("ada@example.com");
    const first = await seedReady(ada, "first");
    const second = await seedReady(ada, "second");

    const saved = await call(draftsRouter.save, {
      creationId: first.creation.id,
      expectedRevision: 2,
      saveRequestId: "save-first",
    }, { context: ada.context });

    expect(saved).toEqual({
      noteId: expect.any(String),
      deckId: first.deck.id,
      sourceText: "source-first",
    });
    expect(await server.db.select().from(notes)).toHaveLength(1);
    expect(await server.db.select().from(cards)).toHaveLength(1);
    expect(await server.db.select().from(creationSaveReceipts)).toHaveLength(1);
    expect(await server.db.select().from(drafts)).toEqual([
      expect.objectContaining({ id: second.creation.id }),
    ]);
  });

  it("returns the same note for concurrent and post-consumption retries", async () => {
    const ada = await server.signIn("ada@example.com");
    const { creation } = await seedReady(ada, "idempotent");
    const input = {
      creationId: creation.id,
      expectedRevision: 2,
      saveRequestId: "save-idempotent",
    };

    const [first, second] = await Promise.all([
      call(draftsRouter.save, input, { context: ada.context }),
      call(draftsRouter.save, input, { context: ada.context }),
    ]);
    const third = await call(draftsRouter.save, input, { context: ada.context });

    expect(first.noteId).toBe(second.noteId);
    expect(second.noteId).toBe(third.noteId);
    expect(await server.db.select().from(notes)).toHaveLength(1);
    expect(await server.db.select().from(cards)).toHaveLength(1);
  });

  it("rolls back the note and cards when the receipt cannot be recorded", async () => {
    const ada = await server.signIn("ada@example.com");
    const { creation } = await seedReady(ada, "rollback");

    await expect(call(draftsRouter.save, {
      creationId: creation.id,
      expectedRevision: 2,
      saveRequestId: "save-rollback",
    }, {
      context: {
        ...ada.context,
        db: failingInsertInto(server.db, creationSaveReceipts),
      },
    })).rejects.toThrow("simulated insert failure");

    expect(await server.db.select().from(notes)).toHaveLength(0);
    expect(await server.db.select().from(cards)).toHaveLength(0);
    expect(await server.db.select().from(creationSaveReceipts)).toHaveLength(0);
    expect(await server.db.select().from(drafts)).toEqual([
      expect.objectContaining({ id: creation.id }),
    ]);
  });

  it("rejects foreign, stale, and active replacements without side effects", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const { creation } = await seedReady(ada, "guarded");

    await expect(call(draftsRouter.save, {
      creationId: creation.id,
      expectedRevision: 2,
      saveRequestId: "save-foreign",
    }, { context: bob.context })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(draftsRouter.save, {
      creationId: creation.id,
      expectedRevision: 1,
      saveRequestId: "save-stale",
    }, { context: ada.context })).rejects.toMatchObject({ code: "CONFLICT" });
    await server.db.update(drafts).set({
      status: "queued",
      operation: "adjust",
      adjustmentInstruction: "Simplify",
    }).where(eq(drafts.id, creation.id));
    await expect(call(draftsRouter.save, {
      creationId: creation.id,
      expectedRevision: 2,
      saveRequestId: "save-active",
    }, { context: ada.context })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await server.db.select().from(notes)).toHaveLength(0);
    expect(await server.db.select().from(creationSaveReceipts)).toHaveLength(0);
    expect(await server.db.select().from(drafts)).toHaveLength(1);
  });

  it("transfers a pending image attempt to the saved note", async () => {
    const ada = await server.signIn("ada@example.com");
    const { creation } = await seedReady(ada, "pending-image", {
      imageAttemptId: "image-pending",
      imagePrompt: "a green leaf",
      imageStatus: "queued",
    });
    await server.db.insert(creationImageAttempts).values({
      id: "image-pending",
      userId: ada.userId,
      creationId: creation.id,
      prompt: "a green leaf",
      status: "queued",
    });

    const saved = await call(draftsRouter.save, {
      creationId: creation.id,
      expectedRevision: 2,
      saveRequestId: "save-pending-image",
    }, { context: ada.context });

    expect((await server.db.select().from(creationImageAttempts))[0])
      .toMatchObject({ creationId: null, noteId: saved.noteId, status: "queued" });
    expect(await server.db.select().from(drafts)).toHaveLength(0);
  });

  it("claims only the ready creation image into the new note", async () => {
    const ada = await server.signIn("ada@example.com");
    const { creation } = await seedReady(ada, "ready-image", {
      imageAttemptId: "image-ready",
      imagePrompt: "a green leaf",
      imageStatus: "ready",
      draftImageId: "draft-image-ready",
    });
    await server.db.insert(creationImageAttempts).values({
      id: "image-ready",
      userId: ada.userId,
      creationId: creation.id,
      prompt: "a green leaf",
      status: "ready",
      draftImageId: "draft-image-ready",
    });
    const claimDraftImage = vi.fn(async (
      userId: string,
      draftImageId: string,
      noteId: string,
    ) => `${userId}/${noteId}/${draftImageId}.png`);

    const saved = await call(draftsRouter.save, {
      creationId: creation.id,
      expectedRevision: 2,
      saveRequestId: "save-ready-image",
    }, { context: { ...ada.context, claimDraftImage } });

    expect(claimDraftImage).toHaveBeenCalledWith(
      ada.userId,
      "draft-image-ready",
      saved.noteId,
    );
    expect((await server.db.select().from(notes))[0].imagePath)
      .toBe(`${ada.userId}/${saved.noteId}/draft-image-ready.png`);
    expect((await server.db.select().from(creationImageAttempts))[0])
      .toMatchObject({ creationId: null, noteId: saved.noteId, draftImageId: null });
  });
});
