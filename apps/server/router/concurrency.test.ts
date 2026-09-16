import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer } from "./testing.ts";
import { decksRouter } from "./decks.ts";
import { notesRouter } from "./notes.ts";
import { cardsRouter } from "./cards.ts";
import { aiRouter } from "./ai.ts";
import { cards, drafts, notes, reviewLogs } from "../db/schema.ts";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => {
  server.close();
});

/**
 * Wraps a Drizzle handle so its transactions stay open for `holdMs` after the
 * callback finishes, still inside the transaction.
 *
 * Real transactions here are short enough that two concurrent calls almost
 * never overlap by chance, so a test that just fires both and hopes would pass
 * against an unlocked implementation. Holding one open makes the overlap
 * certain — which is exactly the state `withWriteLock` has to survive.
 */
function slowTransaction<T extends object>(db: T, holdMs: number): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return (
          callback: (tx: unknown) => Promise<unknown>,
          ...rest: unknown[]
        ) =>
          (target as { transaction: (...a: unknown[]) => unknown }).transaction(
            async (tx: unknown) => {
              const result = await callback(tx);
              await new Promise((resolve) => setTimeout(resolve, holdMs));
              return result;
            },
            ...rest,
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const CLASSIFICATION = {
  domain: "concept",
  language: null,
  partOfSpeech: null,
};

/** A ready draft, saveable straight away. */
async function seedDraft(
  userId: string,
  deckId: string,
  sourceText: string,
  cardsInput: {
    aspect: string;
    front: string;
    back: string;
    imageCue: boolean;
  }[],
  imagePrompt: string | null,
) {
  const [draft] = await server.db
    .insert(drafts)
    .values({
      userId,
      deckId,
      sourceText,
      status: "ready",
      classification: CLASSIFICATION,
      cards: cardsInput,
      imagePrompt,
    })
    .returning();
  return draft;
}

const GRADE_COLUMNS = {
  due: new Date("2030-01-01T00:00:00.000Z"),
  stability: 3.5,
  difficulty: 5.1,
  elapsedDays: 0,
  scheduledDays: 1,
  learningSteps: 1,
  reps: 1,
  lapses: 0,
  state: 1,
  lastReview: new Date("2026-08-05T00:00:00.000Z"),
};

const GRADE_LOG = {
  rating: 3,
  state: 0,
  due: new Date("2030-01-01T00:00:00.000Z"),
  stability: 3.5,
  difficulty: 5.1,
  elapsedDays: 0,
  lastElapsedDays: 0,
  scheduledDays: 1,
  learningSteps: 1,
  review: new Date("2026-08-05T00:00:00.000Z"),
};

describe("overlapping write transactions", () => {
  it("lets cards.grade succeed while notes.save holds its transaction", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );
    const bananaCards = [
      {
        aspect: "meaning",
        front: "die Banane",
        back: "banana",
        imageCue: false,
      },
    ];
    const firstDraft = await seedDraft(
      ada.userId,
      deck.id,
      "die Banane",
      bananaCards,
      null,
    );
    await call(
      notesRouter.save,
      { draftId: firstDraft.id, cards: bananaCards },
      { context: ada.context },
    );
    const [existing] = await server.db.select().from(cards);

    const appleCards = [
      {
        aspect: "meaning",
        front: "der Apfel",
        back: "apple",
        imageCue: false,
      },
    ];
    const secondDraft = await seedDraft(
      ada.userId,
      deck.id,
      "der Apfel",
      appleCards,
      null,
    );

    // The realistic collision: the user saves a note, and grades a card before
    // that save has committed. Both are transactional, so without the write
    // lock the second one to open fails SQLITE_BUSY in 0 ms — and React Query
    // does not retry mutations, so the work is simply lost behind an alert.
    const save = call(
      notesRouter.save,
      { draftId: secondDraft.id, cards: appleCards },
      { context: { ...ada.context, db: slowTransaction(server.db, 50) } },
    );

    // Long enough for `save` to be inside its transaction, short enough to be
    // well within the 50 ms hold.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const grade = call(
      cardsRouter.grade,
      { cardId: existing.id, card: GRADE_COLUMNS, log: GRADE_LOG },
      { context: ada.context },
    );

    await expect(Promise.all([save, grade])).resolves.toBeDefined();

    // Both landed: neither was silently dropped in favour of the other.
    expect(await server.db.select().from(cards)).toHaveLength(2);
    expect(await server.db.select().from(reviewLogs)).toHaveLength(1);
    const [graded] = await server.db
      .select()
      .from(cards)
      .where(eq(cards.id, existing.id));
    expect(graded.reps).toBe(1);
  });

  it("lets ai.generateImage's plain update succeed while a transaction is open", async () => {
    // The scenario that motivated the lock: `useSaveNote.onSuccess` kicks off
    // image generation, so this UPDATE lands right around the next write. It
    // is not itself transactional, but a plain write on the driver's second
    // connection loses to an open transaction just as fast — so it needs the
    // lock too, or a generated image ends up orphaned with no note pointing
    // at it.
    const ada = await server.signIn("ada@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );
    const bananaCards = [
      {
        aspect: "meaning",
        front: "die Banane",
        back: "banana",
        imageCue: false,
      },
    ];
    const firstDraft = await seedDraft(
      ada.userId,
      deck.id,
      "die Banane",
      bananaCards,
      "a banana",
    );
    const note = await call(
      notesRouter.save,
      { draftId: firstDraft.id, cards: bananaCards },
      { context: ada.context },
    );

    const appleCards = [
      {
        aspect: "meaning",
        front: "der Apfel",
        back: "apple",
        imageCue: false,
      },
    ];
    const secondDraft = await seedDraft(
      ada.userId,
      deck.id,
      "der Apfel",
      appleCards,
      null,
    );
    const save = call(
      notesRouter.save,
      { draftId: secondDraft.id, cards: appleCards },
      { context: { ...ada.context, db: slowTransaction(server.db, 50) } },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const image = call(
      aiRouter.generateImage,
      { noteId: note.id, prompt: "a banana" },
      {
        context: {
          ...ada.context,
          generateImageBytes: async () => new Uint8Array([1, 2, 3]),
          writeImage: async (userId: string, noteId: string) =>
            `${userId}/${noteId}.png`,
        },
      },
    );

    await expect(Promise.all([save, image])).resolves.toBeDefined();

    const [updated] = await server.db
      .select()
      .from(notes)
      .where(eq(notes.id, note.id));
    expect(updated.imagePath).toBe(`${ada.userId}/${note.id}.png`);
  });
});
