import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "./testing.ts";
import { cards, decks, drafts, notes, user } from "./schema.ts";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let close: Awaited<ReturnType<typeof createTestDb>>["close"];

beforeEach(async () => {
  ({ db, client, close } = await createTestDb());
  await db.insert(user).values({
    id: "u1",
    name: "Ada",
    email: "ada@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterEach(() => {
  close();
});

describe("schema", () => {
  it("defaults ids to a uuidv7 and timestamps to Dates", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();

    // uuidv7: canonical form with version nibble 7.
    expect(deck.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(deck.createdAt).toBeInstanceOf(Date);
  });

  it("sorts uuidv7 ids in creation order", async () => {
    const [first] = await db
      .insert(decks)
      .values({ userId: "u1", name: "A" })
      .returning();
    const [second] = await db
      .insert(decks)
      .values({ userId: "u1", name: "B" })
      .returning();

    expect(first.id < second.id).toBe(true);
  });

  it("round-trips note metadata as an object, not a string", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();
    const [note] = await db
      .insert(notes)
      .values({
        userId: "u1",
        deckId: deck.id,
        sourceText: "die Banane",
        domain: "language",
        language: "de",
        metadata: { partOfSpeech: "noun" },
      })
      .returning();

    expect(note.metadata).toEqual({ partOfSpeech: "noun" });
    expect(note.revision).toBe(0);
  });

  it("cascades a deck delete through its notes and cards", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();
    const [note] = await db
      .insert(notes)
      .values({
        userId: "u1",
        deckId: deck.id,
        sourceText: "die Banane",
        domain: "language",
        metadata: {},
      })
      .returning();
    await db.insert(cards).values({
      noteId: note.id,
      userId: "u1",
      aspect: "meaning",
      front: "die Banane",
      back: "banana",
      due: new Date(),
    });

    await db.delete(decks).where(eq(decks.id, deck.id));

    expect(await db.select().from(notes)).toHaveLength(0);
    expect(await db.select().from(cards)).toHaveLength(0);
  });

  it("creates the partial due index", async () => {
    const rows = await client.execute(
      "select sql from sqlite_master where name = 'cards_due_idx'",
    );
    expect(String(rows.rows[0].sql)).toContain("WHERE suspended = 0");
  });

  it("stores booleans as integers and reads them back as booleans", async () => {
    const [insertedUser] = await db
      .select()
      .from(user)
      .where(eq(user.id, "u1"));
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();
    const [note] = await db
      .insert(notes)
      .values({
        userId: "u1",
        deckId: deck.id,
        sourceText: "x",
        domain: "concept",
        metadata: {},
      })
      .returning();
    const [card] = await db
      .insert(cards)
      .values({
        noteId: note.id,
        userId: "u1",
        aspect: "meaning",
        front: "f",
        back: "b",
        due: new Date(),
      })
      .returning();

    expect(insertedUser.ttsAutoplay).toBe(true);
    expect(card.audioPath).toBeNull();
    expect(card.audioStatus).toBeNull();
    expect(card.suspended).toBe(false);
    expect(card.imageCue).toBe(false);
    expect(card.due).toBeInstanceOf(Date);
  });

  it("survives a transaction — the temp-file database is required", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();

    await db.transaction(async (tx) => {
      await tx.insert(notes).values({
        userId: "u1",
        deckId: deck.id,
        sourceText: "inside a transaction",
        domain: "concept",
        metadata: {},
      });
    });

    // With `:memory:` this query throws "no such table: notes".
    expect(await db.select().from(notes)).toHaveLength(1);
  });

  it("rolls a transaction back when the callback throws", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(notes).values({
          userId: "u1",
          deckId: deck.id,
          sourceText: "doomed",
          domain: "concept",
          metadata: {},
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await db.select().from(notes)).toHaveLength(0);
  });
});

describe("drafts", () => {
  it("round-trips classification and cards as objects, not strings", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();

    const [draft] = await db
      .insert(drafts)
      .values({
        userId: "u1",
        deckId: deck.id,
        sourceText: "die Banane",
        status: "generating",
        classification: {
          domain: "language",
          language: "de",
          partOfSpeech: "noun",
        },
        cards: [
          {
            aspect: "meaning",
            front: "die Banane",
            back: null,
            imageCue: false,
          },
        ],
      })
      .returning();

    expect(draft.classification).toEqual({
      domain: "language",
      language: "de",
      partOfSpeech: "noun",
    });
    expect(draft.cards[0].back).toBeNull();
    expect(draft.imageStatus).toBe("none");
    expect(draft.createdAt).toBeInstanceOf(Date);
  });

  it("allows several creations per user but rejects a duplicate client request", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();

    const values = {
      userId: "u1",
      deckId: deck.id,
      sourceText: "x",
      status: "generating" as const,
      clientRequestId: "request-1",
    };
    await db.insert(drafts).values(values);

    await db.insert(drafts).values({
      ...values,
      sourceText: "y",
      clientRequestId: "request-2",
    });
    expect(await db.select().from(drafts)).toHaveLength(2);

    await expect(db.insert(drafts).values(values)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/UNIQUE constraint failed/) },
    });
  });

  it("keeps the creation request when its selected deck goes", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();
    await db.insert(drafts).values({
      userId: "u1",
      deckId: deck.id,
      sourceText: "x",
      status: "generating",
      clientRequestId: "request-1",
    });

    await db.delete(decks).where(eq(decks.id, deck.id));

    const rows = await db.select().from(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0].deckId).toBeNull();
  });
});

/** `createTestDb` pushes the Drizzle schema object straight to SQLite via
 *  `pushSQLiteSchema` — it never reads a migration file. So `PRAGMA
 *  table_info` here checks that the *Drizzle definitions* build the shape we
 *  intend; it says nothing about whether the generated migration SQL
 *  reproduces that same shape from an existing database. That's what
 *  `apps/server/db/migrations.test.ts` checks instead, by replaying the actual
 *  migration files. */
async function columns(): Promise<
  Map<string, { notnull: number; dflt_value: unknown }>
> {
  const { client, close } = await createTestDb();
  try {
    const info = await client.execute("PRAGMA table_info(cards)");
    return new Map(
      info.rows.map((row) => [
        String(row.name),
        { notnull: Number(row.notnull), dflt_value: row.dflt_value },
      ]),
    );
  } finally {
    close();
  }
}

describe("the cards table", () => {
  it("carries a card_type defaulting to basic", async () => {
    const cardType = (await columns()).get("card_type");

    expect(cardType).toBeDefined();
    expect(cardType?.notnull).toBe(1);
    expect(String(cardType?.dflt_value)).toContain("basic");
  });

  it("allows a null back, because a cloze answer lives in the front", async () => {
    expect((await columns()).get("back")?.notnull).toBe(0);
  });

  it("still requires a front", async () => {
    expect((await columns()).get("front")?.notnull).toBe(1);
  });
});

// Referenced so the import is used even if a case above is trimmed.
void sql;
