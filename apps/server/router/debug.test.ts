import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { debugRouter } from "./debug.ts";
import {
  createTestServer,
  failingDeleteFrom,
  failingInsertInto,
} from "./testing.ts";
import { and, asc, eq } from "drizzle-orm";
import { cards, decks, drafts, notes, reviewLogs } from "../db/schema.ts";
import type { AppContext } from "./base.ts";
import { GERMAN_SEED, GERMAN_SEED_NAME } from "../devtools/german-seed.ts";
import { parseCloze } from "@mnimi/shared";
import { decksRouter } from "./decks.ts";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => {
  server.close();
});

async function seedDeck(
  userId: string,
  name: string,
  cardCount: number,
) {
  const [deck] = await server.db.insert(decks).values({ userId, name })
    .returning();
  const [note] = await server.db.insert(notes).values({
    userId,
    deckId: deck.id,
    sourceText: `${name} source`,
    domain: "concept",
    metadata: {},
  }).returning();
  const inserted = cardCount === 0 ? [] : await server.db.insert(cards).values(
    Array.from({ length: cardCount }, (_, index) => ({
      noteId: note.id,
      userId,
      aspect: `aspect-${index}`,
      front: `${name} front ${index}`,
      back: `${name} back ${index}`,
      due: new Date(),
    })),
  ).returning();
  return { deck, note, cards: inserted };
}

function enabled(context: AppContext): AppContext {
  return { ...context, devtoolsEnabled: true };
}

async function markReviewed(
  userId: string,
  cardRows: Array<typeof cards.$inferSelect>,
) {
  const future = new Date("2030-01-01T00:00:00.000Z");
  for (const card of cardRows) {
    await server.db.update(cards).set({
      due: future,
      stability: 3.5,
      difficulty: 5.1,
      elapsedDays: 2,
      scheduledDays: 7,
      learningSteps: 1,
      reps: 4,
      lapses: 1,
      state: 2,
      lastReview: new Date("2026-08-10T12:00:00.000Z"),
    }).where(eq(cards.id, card.id));
    await server.db.insert(reviewLogs).values({
      cardId: card.id,
      userId,
      rating: 3,
      state: 2,
      due: future,
      stability: 3.5,
      difficulty: 5.1,
      elapsedDays: 2,
      lastElapsedDays: 1,
      scheduledDays: 7,
      learningSteps: 1,
      review: new Date("2026-08-10T12:00:00.000Z"),
    });
  }
}

function expectNewScheduling(card: typeof cards.$inferSelect) {
  expect(card).toMatchObject({
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    lastReview: null,
  });
}

async function selectUserCards(userId: string) {
  return await server.db.select().from(cards).where(eq(cards.userId, userId))
    .orderBy(asc(cards.id));
}

async function selectLogs() {
  return await server.db.select().from(reviewLogs).orderBy(asc(reviewLogs.id));
}

function createMediaFakes({
  failAudioWrite,
  writeThenFailAudioWrite,
  failCleanup = false,
}: {
  failAudioWrite?: number;
  writeThenFailAudioWrite?: number;
  failCleanup?: boolean;
} = {}) {
  const files = new Set<string>();
  const created: string[] = [];
  const removed: string[] = [];
  let audioWrites = 0;

  function write(path: string) {
    files.add(path);
    created.push(path);
    return path;
  }

  return {
    files,
    created,
    removed,
    context: {
      writeImage: async (userId: string, noteId: string, _bytes: Uint8Array) =>
        write(`${userId}/${noteId}.png`),
      writeAudio: async (
        userId: string,
        cardId: string,
        _bytes: Uint8Array,
      ) => {
        audioWrites++;
        const path = `${userId}/${cardId}.mp3`;
        if (audioWrites === failAudioWrite) {
          throw new Error("simulated audio write failure");
        }
        if (audioWrites === writeThenFailAudioWrite) {
          files.add(path);
          throw new Error("simulated partial audio write failure");
        }
        return write(path);
      },
      removeImage: async (path: string) => {
        files.delete(path);
        removed.push(path);
        if (failCleanup) throw new Error("simulated image cleanup failure");
      },
      removeAudio: async (path: string) => {
        files.delete(path);
        removed.push(path);
        if (failCleanup) throw new Error("simulated audio cleanup failure");
      },
    } satisfies Pick<
      AppContext,
      "writeImage" | "writeAudio" | "removeImage" | "removeAudio"
    >,
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Holds a deck creation at its final query, while preserving Drizzle's real
 * query builders. This makes the seed/create interleaving reproducible. */
function gateDeckInsert<T extends object>(
  db: T,
  entered: ReturnType<typeof deferred>,
  gate: ReturnType<typeof deferred>,
): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "insert") return Reflect.get(target, prop, receiver);
      return (table: unknown) => {
        const builder = (target as { insert: (arg: unknown) => object }).insert(
          table,
        );
        if (table !== decks) return builder;
        return new Proxy(builder, {
          get(innerTarget, innerProp, innerReceiver) {
            const value = Reflect.get(innerTarget, innerProp, innerReceiver);
            if (innerProp !== "values") {
              return typeof value === "function"
                ? value.bind(innerTarget)
                : value;
            }
            return (values: unknown) => {
              const valuesBuilder = (value as (v: unknown) => object).call(
                innerTarget,
                values,
              );
              return new Proxy(valuesBuilder, {
                get(valuesTarget, valuesProp, valuesReceiver) {
                  const valuesValue = Reflect.get(
                    valuesTarget,
                    valuesProp,
                    valuesReceiver,
                  );
                  if (valuesProp !== "returning") {
                    return typeof valuesValue === "function"
                      ? valuesValue.bind(valuesTarget)
                      : valuesValue;
                  }
                  return (...args: unknown[]) => {
                    entered.release();
                    return gate.promise.then(() =>
                      (valuesValue as (...a: unknown[]) => unknown).apply(
                        valuesTarget,
                        args,
                      )
                    );
                  };
                },
              });
            };
          },
        });
      };
    },
  });
}

async function selectSeedRows(userId: string, deckId: string) {
  const seedNotes = await server.db.select().from(notes).where(
    and(eq(notes.userId, userId), eq(notes.deckId, deckId)),
  ).orderBy(asc(notes.createdAt), asc(notes.id));
  const seedCards = await server.db.select().from(cards).where(
    eq(cards.userId, userId),
  ).orderBy(asc(cards.createdAt), asc(cards.id));
  return {
    notes: seedNotes,
    cards: seedCards.filter((card) =>
      seedNotes.some((note) => note.id === card.noteId)
    ),
  };
}

function expectGermanSeed(
  userId: string,
  deckId: string,
  seedNotes: Array<typeof notes.$inferSelect>,
  seedCards: Array<typeof cards.$inferSelect>,
) {
  expect(seedNotes).toHaveLength(GERMAN_SEED.notes.length);
  expect(seedCards).toHaveLength(
    GERMAN_SEED.notes.reduce((count, note) => count + note.cards.length, 0),
  );

  for (const fixtureNote of GERMAN_SEED.notes) {
    const storedNote = seedNotes.find((note) =>
      note.sourceText === fixtureNote.sourceText
    );
    expect(storedNote).toMatchObject({
      userId,
      deckId,
      sourceText: fixtureNote.sourceText,
      domain: fixtureNote.domain,
      language: fixtureNote.language,
      metadata: fixtureNote.metadata,
    });
    expect(storedNote?.imagePath).toEqual(expect.any(String));

    const storedCards = seedCards.filter((card) =>
      card.noteId === storedNote!.id
    );
    expect(storedCards).toHaveLength(fixtureNote.cards.length);
    for (const fixtureCard of fixtureNote.cards) {
      const storedCard = storedCards.find((card) =>
        card.aspect === fixtureCard.aspect
      );
      expect(storedCard).toMatchObject({
        userId,
        noteId: storedNote!.id,
        aspect: fixtureCard.aspect,
        front: fixtureCard.front,
        back: fixtureCard.back,
        imageCue: fixtureCard.imageCue,
        cardType: "cloze",
        audioStatus: "ready",
      });
      expect(parseCloze(storedCard!.front)).not.toBeNull();
      expect(storedCard?.audioPath).toEqual(expect.any(String));
    }
  }
}

describe("debug.summary", () => {
  it("returns the signed-in user's decks and cards with per-deck counts", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const german = await seedDeck(ada.userId, "German", 2);
    await seedDeck(ada.userId, "Physics", 1);
    await seedDeck(ada.userId, "Empty", 0);
    await seedDeck(bob.userId, "Bob's private deck", 1);

    const summary = await call(debugRouter.summary, {}, {
      context: enabled(ada.context),
    });

    expect(summary.totalCards).toBe(3);
    expect(summary.decks.map(({ name, cardCount }) => [name, cardCount]))
      .toEqual([
        ["German", 2],
        ["Physics", 1],
        ["Empty", 0],
      ]);
    expect(summary.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: german.cards[0].id,
        deckId: german.deck.id,
        aspect: "aspect-0",
        front: "German front 0",
      }),
    ]));
    expect(summary.cards).toHaveLength(3);
    expect(summary.cards.every((card) => !("userId" in card))).toBe(true);
  });

  it("rejects access when server devtools are disabled", async () => {
    const ada = await server.signIn("ada@example.com");

    await expect(
      call(debugRouter.summary, {}, {
        context: { ...ada.context, devtoolsEnabled: false },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("debug.resetSrs", () => {
  it("resets all cards and logs owned by the signed-in user", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const german = await seedDeck(ada.userId, "German", 2);
    const physics = await seedDeck(ada.userId, "Physics", 1);
    const privateDeck = await seedDeck(bob.userId, "Private", 1);
    const adaCards = [...german.cards, ...physics.cards];
    await markReviewed(ada.userId, adaCards);
    await markReviewed(bob.userId, privateDeck.cards);
    const beforeReset = Date.now();

    const result = await call(
      debugRouter.resetSrs,
      { scope: "all" },
      { context: enabled(ada.context) },
    );
    const afterReset = Date.now();

    expect(result).toEqual({ resetCount: 3 });
    const storedAdaCards = await server.db.select().from(cards)
      .where(eq(cards.userId, ada.userId)).orderBy(asc(cards.id));
    for (const card of storedAdaCards) expectNewScheduling(card);
    expect(new Set(storedAdaCards.map((card) => card.due.getTime())).size).toBe(
      1,
    );
    expect(storedAdaCards[0].due.getTime()).toBeGreaterThanOrEqual(beforeReset);
    expect(storedAdaCards[0].due.getTime()).toBeLessThanOrEqual(afterReset);

    const [storedBobCard] = await server.db.select().from(cards)
      .where(eq(cards.userId, bob.userId));
    expect(storedBobCard.reps).toBe(4);
    const logs = await server.db.select().from(reviewLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(bob.userId);
  });

  it("resets only cards and logs in the selected owned deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const german = await seedDeck(ada.userId, "German", 2);
    const physics = await seedDeck(ada.userId, "Physics", 1);
    await markReviewed(ada.userId, [...german.cards, ...physics.cards]);
    const beforeReset = Date.now();

    const result = await call(
      debugRouter.resetSrs,
      { scope: "deck", deckId: german.deck.id },
      { context: enabled(ada.context) },
    );
    const afterReset = Date.now();

    expect(result).toEqual({ resetCount: 2 });
    const storedGerman = await server.db.select().from(cards)
      .where(eq(cards.noteId, german.note.id)).orderBy(asc(cards.id));
    for (const card of storedGerman) expectNewScheduling(card);
    expect(new Set(storedGerman.map((card) => card.due.getTime())).size).toBe(
      1,
    );
    expect(storedGerman[0].due.getTime()).toBeGreaterThanOrEqual(beforeReset);
    expect(storedGerman[0].due.getTime()).toBeLessThanOrEqual(afterReset);
    const [storedPhysics] = await server.db.select().from(cards)
      .where(eq(cards.noteId, physics.note.id));
    expect(storedPhysics.reps).toBe(4);
    const logs = await selectLogs();
    expect(logs.map((log) => log.cardId)).toEqual([physics.cards[0].id]);
  });

  it("resets only the selected owned card and its logs", async () => {
    const ada = await server.signIn("ada@example.com");
    const german = await seedDeck(ada.userId, "German", 2);
    await markReviewed(ada.userId, german.cards);
    const beforeReset = Date.now();

    const result = await call(
      debugRouter.resetSrs,
      { scope: "card", cardId: german.cards[0].id },
      { context: enabled(ada.context) },
    );
    const afterReset = Date.now();

    expect(result).toEqual({ resetCount: 1 });
    const stored = await server.db.select().from(cards)
      .where(eq(cards.noteId, german.note.id)).orderBy(asc(cards.id));
    const resetCard = stored.find((card) => card.id === german.cards[0].id)!;
    expectNewScheduling(resetCard);
    expect(resetCard.due.getTime()).toBeGreaterThanOrEqual(beforeReset);
    expect(resetCard.due.getTime()).toBeLessThanOrEqual(afterReset);
    expect(stored.find((card) => card.id === german.cards[1].id)!.reps).toBe(4);
    const logs = await selectLogs();
    expect(logs.map((log) => log.cardId)).toEqual([german.cards[1].id]);
  });

  it("returns zero and reveals nothing for another user's deck or card id", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaDeck = await seedDeck(ada.userId, "Ada", 1);
    const bobDeck = await seedDeck(bob.userId, "Bob", 1);
    await markReviewed(ada.userId, adaDeck.cards);
    await markReviewed(bob.userId, bobDeck.cards);

    await expect(
      call(
        debugRouter.resetSrs,
        { scope: "deck", deckId: bobDeck.deck.id },
        { context: enabled(ada.context) },
      ),
    ).resolves.toEqual({ resetCount: 0 });

    await expect(
      call(
        debugRouter.resetSrs,
        { scope: "card", cardId: bobDeck.cards[0].id },
        { context: enabled(ada.context) },
      ),
    ).resolves.toEqual({ resetCount: 0 });

    const [adaCard] = await selectUserCards(ada.userId);
    const [bobCard] = await selectUserCards(bob.userId);
    expect(adaCard.reps).toBe(4);
    expect(bobCard.reps).toBe(4);
    expect((await selectLogs()).map((log) => log.userId).sort()).toEqual([
      ada.userId,
      bob.userId,
    ]);
  });

  it("returns zero for an unknown valid uuidv7", async () => {
    const ada = await server.signIn("ada@example.com");
    const german = await seedDeck(ada.userId, "German", 1);
    await markReviewed(ada.userId, german.cards);
    const unknownId = "0195f0e0-0000-7000-8000-000000000000";

    await expect(
      call(
        debugRouter.resetSrs,
        { scope: "card", cardId: unknownId },
        { context: enabled(ada.context) },
      ),
    ).resolves.toEqual({ resetCount: 0 });

    const [stored] = await selectUserCards(ada.userId);
    expect(stored.reps).toBe(4);
    expect((await selectLogs()).map((log) => log.cardId)).toEqual([
      german.cards[0].id,
    ]);
  });

  it("keeps suspended status and non-scheduling fields unchanged", async () => {
    const ada = await server.signIn("ada@example.com");
    const german = await seedDeck(ada.userId, "German", 1);
    await server.db.update(cards).set({
      back: "custom back",
      imageCue: true,
      audioPath: "/tmp/audio.mp3",
      audioStatus: "ready",
      suspended: true,
    }).where(eq(cards.id, german.cards[0].id));
    await markReviewed(ada.userId, german.cards);
    const [beforeCard] = await server.db.select().from(cards).where(
      eq(cards.id, german.cards[0].id),
    );
    const [beforeNote] = await server.db.select().from(notes).where(
      eq(notes.id, german.note.id),
    );

    const result = await call(
      debugRouter.resetSrs,
      { scope: "card", cardId: german.cards[0].id },
      { context: enabled(ada.context) },
    );

    expect(result).toEqual({ resetCount: 1 });
    const [afterCard] = await server.db.select().from(cards).where(
      eq(cards.id, german.cards[0].id),
    );
    const [afterNote] = await server.db.select().from(notes).where(
      eq(notes.id, german.note.id),
    );
    expectNewScheduling(afterCard);
    expect(afterCard.suspended).toBe(true);
    expect(afterCard.noteId).toBe(beforeCard.noteId);
    expect(afterCard.front).toBe(beforeCard.front);
    expect(afterCard.back).toBe("custom back");
    expect(afterCard.imageCue).toBe(true);
    expect(afterCard.audioPath).toBe("/tmp/audio.mp3");
    expect(afterCard.audioStatus).toBe("ready");
    expect(afterNote.deckId).toBe(beforeNote.deckId);
  });

  it("rejects reset when server devtools are disabled", async () => {
    const ada = await server.signIn("ada@example.com");

    await expect(
      call(
        debugRouter.resetSrs,
        { scope: "all" },
        { context: { ...ada.context, devtoolsEnabled: false } },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rolls back the card update when review-log deletion fails", async () => {
    const ada = await server.signIn("ada@example.com");
    const german = await seedDeck(ada.userId, "German", 1);
    await markReviewed(ada.userId, german.cards);
    const [beforeCard] = await server.db.select().from(cards).where(
      eq(cards.id, german.cards[0].id),
    );
    const context = {
      ...enabled(ada.context),
      db: failingDeleteFrom(server.db, reviewLogs),
    };

    await expect(
      call(
        debugRouter.resetSrs,
        { scope: "card", cardId: german.cards[0].id },
        { context },
      ),
    ).rejects.toThrow("simulated delete failure");

    const [afterCard] = await server.db.select().from(cards).where(
      eq(cards.id, german.cards[0].id),
    );
    expect(afterCard).toMatchObject({
      due: beforeCard.due,
      stability: beforeCard.stability,
      difficulty: beforeCard.difficulty,
      elapsedDays: beforeCard.elapsedDays,
      scheduledDays: beforeCard.scheduledDays,
      learningSteps: beforeCard.learningSteps,
      reps: beforeCard.reps,
      lapses: beforeCard.lapses,
      state: beforeCard.state,
      lastReview: beforeCard.lastReview,
    });
    expect(await selectLogs()).toHaveLength(1);
  });
});

describe("debug.seedGerman", () => {
  it("creates the fixture with ready media without calling a paid provider", async () => {
    const ada = await server.signIn("ada@example.com");
    const media = createMediaFakes();
    let imageProviderCalls = 0;

    const result = await call(
      debugRouter.seedGerman,
      { replace: false },
      {
        context: {
          ...enabled(ada.context),
          ...media.context,
          generateImageBytes: async () => {
            imageProviderCalls++;
            throw new Error("seed must not generate an image");
          },
        },
      },
    );

    expect(result).toEqual({
      status: "seeded",
      deckId: expect.any(String),
      replaced: false,
      noteCount: 3,
      cardCount: 9,
    });
    if (result.status !== "seeded") throw new Error("seed was not created");
    expect(imageProviderCalls).toBe(0);
    expect(media.created).toHaveLength(12);

    const [deck] = await server.db.select().from(decks).where(
      and(eq(decks.id, result.deckId), eq(decks.userId, ada.userId)),
    );
    expect(deck).toMatchObject({ name: GERMAN_SEED_NAME, userId: ada.userId });
    const seeded = await selectSeedRows(ada.userId, result.deckId);
    expectGermanSeed(ada.userId, result.deckId, seeded.notes, seeded.cards);
  });

  it("requires confirmation without changing an owned German deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const oldGerman = await seedDeck(ada.userId, GERMAN_SEED_NAME, 1);
    const media = createMediaFakes();

    await expect(
      call(debugRouter.seedGerman, { replace: false }, {
        context: { ...enabled(ada.context), ...media.context },
      }),
    ).resolves.toEqual({
      status: "needs-confirmation",
      existingDeckId: oldGerman.deck.id,
    });

    const [storedDeck] = await server.db.select().from(decks).where(
      eq(decks.id, oldGerman.deck.id),
    );
    const [storedNote] = await server.db.select().from(notes).where(
      eq(notes.id, oldGerman.note.id),
    );
    const [storedCard] = await server.db.select().from(cards).where(
      eq(cards.id, oldGerman.cards[0].id),
    );
    expect(storedDeck.name).toBe(GERMAN_SEED_NAME);
    expect(storedNote.sourceText).toBe(`${GERMAN_SEED_NAME} source`);
    expect(storedCard.front).toBe(`${GERMAN_SEED_NAME} front 0`);
    expect(media.created).toEqual([]);
  });

  it("does not prepare media when a queued German deck creation wins the lock", async () => {
    const ada = await server.signIn("ada@example.com");
    const entered = deferred();
    const releaseDeck = deferred();
    const creating = call(
      decksRouter.create,
      { name: GERMAN_SEED_NAME },
      {
        context: {
          ...ada.context,
          db: gateDeckInsert(server.db, entered, releaseDeck),
        },
      },
    );
    await entered.promise;

    const media = createMediaFakes();
    const seeding = call(debugRouter.seedGerman, { replace: false }, {
      context: { ...enabled(ada.context), ...media.context },
    });
    // With an unlocked decks.create the seed reaches media preparation while
    // this insert is still paused. The shared lock must keep it queued here.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(media.created).toEqual([]);

    releaseDeck.release();
    const deck = await creating;
    await expect(seeding).resolves.toEqual({
      status: "needs-confirmation",
      existingDeckId: deck.id,
    });
    expect(media.created).toEqual([]);
  });

  it("replaces only the caller's German deck and removes its old media after commit", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const oldGerman = await seedDeck(ada.userId, GERMAN_SEED_NAME, 1);
    const physics = await seedDeck(ada.userId, "Physics", 1);
    const bobGerman = await seedDeck(bob.userId, GERMAN_SEED_NAME, 1);
    const oldImagePath = `${ada.userId}/${oldGerman.note.id}.png`;
    const oldAudioPath = `${ada.userId}/${oldGerman.cards[0].id}.mp3`;
    await server.db.update(notes).set({ imagePath: oldImagePath }).where(
      eq(notes.id, oldGerman.note.id),
    );
    await server.db.update(cards).set({ audioPath: oldAudioPath }).where(
      eq(cards.id, oldGerman.cards[0].id),
    );
    const media = createMediaFakes();
    media.files.add(oldImagePath);
    media.files.add(oldAudioPath);

    const result = await call(debugRouter.seedGerman, { replace: true }, {
      context: { ...enabled(ada.context), ...media.context },
    });

    expect(result).toEqual({
      status: "seeded",
      deckId: expect.any(String),
      replaced: true,
      noteCount: 3,
      cardCount: 9,
    });
    if (result.status !== "seeded") throw new Error("seed was not replaced");
    expect(
      await server.db.select().from(decks).where(
        eq(decks.id, oldGerman.deck.id),
      ),
    )
      .toEqual([]);
    expect(
      await server.db.select().from(notes).where(
        eq(notes.id, oldGerman.note.id),
      ),
    )
      .toEqual([]);
    expect(
      await server.db.select().from(cards).where(
        eq(cards.id, oldGerman.cards[0].id),
      ),
    )
      .toEqual([]);
    expect(media.removed).toEqual(
      expect.arrayContaining([oldImagePath, oldAudioPath]),
    );
    expect(media.files.has(oldImagePath)).toBe(false);
    expect(media.files.has(oldAudioPath)).toBe(false);

    const seeded = await selectSeedRows(ada.userId, result.deckId);
    expectGermanSeed(ada.userId, result.deckId, seeded.notes, seeded.cards);
    expect(
      await server.db.select().from(decks).where(eq(decks.id, physics.deck.id)),
    )
      .toHaveLength(1);
    expect(
      await server.db.select().from(notes).where(eq(notes.id, physics.note.id)),
    )
      .toHaveLength(1);
    expect(
      await server.db.select().from(decks).where(
        eq(decks.id, bobGerman.deck.id),
      ),
    )
      .toHaveLength(1);
    expect(
      await server.db.select().from(notes).where(
        eq(notes.id, bobGerman.note.id),
      ),
    )
      .toHaveLength(1);
  });

  it("blocks confirmed replacement while the target German deck has an active draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const oldGerman = await seedDeck(ada.userId, GERMAN_SEED_NAME, 1);
    const oldImagePath = `${ada.userId}/${oldGerman.note.id}.png`;
    const oldAudioPath = `${ada.userId}/${oldGerman.cards[0].id}.mp3`;
    await server.db.update(notes).set({ imagePath: oldImagePath }).where(
      eq(notes.id, oldGerman.note.id),
    );
    await server.db.update(cards).set({ audioPath: oldAudioPath }).where(
      eq(cards.id, oldGerman.cards[0].id),
    );
    const [activeDraft] = await server.db.insert(drafts).values({
      userId: ada.userId,
      deckId: oldGerman.deck.id,
      sourceText: "die Birne",
      status: "ready",
    }).returning();
    const media = createMediaFakes();
    media.files.add(oldImagePath);
    media.files.add(oldAudioPath);
    const context = { ...enabled(ada.context), ...media.context };

    await expect(
      call(debugRouter.seedGerman, { replace: false }, { context }),
    ).resolves.toEqual({
      status: "needs-confirmation",
      existingDeckId: oldGerman.deck.id,
    });
    await expect(
      call(debugRouter.seedGerman, { replace: true }, { context }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Save or discard the active draft before replacing German",
    });

    expect(
      await server.db.select().from(decks).where(
        eq(decks.id, oldGerman.deck.id),
      ),
    ).toHaveLength(1);
    expect(
      await server.db.select().from(notes).where(
        eq(notes.id, oldGerman.note.id),
      ),
    ).toHaveLength(1);
    expect(
      await server.db.select().from(cards).where(
        eq(cards.id, oldGerman.cards[0].id),
      ),
    ).toHaveLength(1);
    expect(
      await server.db.select().from(drafts).where(
        eq(drafts.id, activeDraft.id),
      ),
    ).toHaveLength(1);
    expect(media.files).toEqual(new Set([oldImagePath, oldAudioPath]));
    expect(media.created).toEqual([]);
    expect(media.removed).toEqual([]);
  });

  it("does not let a draft on another owned deck block German replacement", async () => {
    const ada = await server.signIn("ada@example.com");
    const oldGerman = await seedDeck(ada.userId, GERMAN_SEED_NAME, 1);
    const physics = await seedDeck(ada.userId, "Physics", 1);
    const [activeDraft] = await server.db.insert(drafts).values({
      userId: ada.userId,
      deckId: physics.deck.id,
      sourceText: "Trägheit",
      status: "ready",
    }).returning();
    const media = createMediaFakes();

    await expect(
      call(debugRouter.seedGerman, { replace: true }, {
        context: { ...enabled(ada.context), ...media.context },
      }),
    ).resolves.toMatchObject({ status: "seeded", replaced: true });

    expect(
      await server.db.select().from(decks).where(
        eq(decks.id, oldGerman.deck.id),
      ),
    ).toEqual([]);
    expect(
      await server.db.select().from(drafts).where(
        eq(drafts.id, activeDraft.id),
      ),
    ).toMatchObject([{ deckId: physics.deck.id, userId: ada.userId }]);
  });

  it("cleans up only newly copied media and preserves old rows when a media write fails", async () => {
    const ada = await server.signIn("ada@example.com");
    const oldGerman = await seedDeck(ada.userId, GERMAN_SEED_NAME, 1);
    const oldImagePath = `${ada.userId}/${oldGerman.note.id}.png`;
    const oldAudioPath = `${ada.userId}/${oldGerman.cards[0].id}.mp3`;
    await server.db.update(notes).set({ imagePath: oldImagePath }).where(
      eq(notes.id, oldGerman.note.id),
    );
    await server.db.update(cards).set({ audioPath: oldAudioPath }).where(
      eq(cards.id, oldGerman.cards[0].id),
    );
    const media = createMediaFakes({ failAudioWrite: 2 });
    media.files.add(oldImagePath);
    media.files.add(oldAudioPath);

    await expect(
      call(debugRouter.seedGerman, { replace: true }, {
        context: { ...enabled(ada.context), ...media.context },
      }),
    ).rejects.toThrow("simulated audio write failure");

    expect(
      await server.db.select().from(decks).where(
        eq(decks.id, oldGerman.deck.id),
      ),
    )
      .toHaveLength(1);
    expect(
      await server.db.select().from(notes).where(
        eq(notes.id, oldGerman.note.id),
      ),
    )
      .toHaveLength(1);
    expect(
      await server.db.select().from(cards).where(
        eq(cards.id, oldGerman.cards[0].id),
      ),
    )
      .toHaveLength(1);
    expect(media.files).toEqual(new Set([oldImagePath, oldAudioPath]));
    expect(media.removed).toEqual(expect.arrayContaining(media.created));
    expect(media.removed).not.toEqual(
      expect.arrayContaining([oldImagePath, oldAudioPath]),
    );
  });

  it("removes an intended path when an audio writer writes then rejects", async () => {
    const ada = await server.signIn("ada@example.com");
    const oldGerman = await seedDeck(ada.userId, GERMAN_SEED_NAME, 1);
    const oldImagePath = `${ada.userId}/${oldGerman.note.id}.png`;
    const oldAudioPath = `${ada.userId}/${oldGerman.cards[0].id}.mp3`;
    const media = createMediaFakes({ writeThenFailAudioWrite: 2 });
    media.files.add(oldImagePath);
    media.files.add(oldAudioPath);

    await expect(
      call(debugRouter.seedGerman, { replace: true }, {
        context: { ...enabled(ada.context), ...media.context },
      }),
    ).rejects.toThrow("simulated partial audio write failure");

    expect(media.files).toEqual(new Set([oldImagePath, oldAudioPath]));
    expect(media.removed).toContainEqual(expect.stringMatching(/\.mp3$/));
    expect(
      await server.db.select().from(decks).where(
        eq(decks.id, oldGerman.deck.id),
      ),
    )
      .toHaveLength(1);
  });

  it("preserves media and cleanup failures when rollback cleanup also fails", async () => {
    const ada = await server.signIn("ada@example.com");
    const media = createMediaFakes({
      writeThenFailAudioWrite: 2,
      failCleanup: true,
    });

    const error = await call(debugRouter.seedGerman, { replace: false }, {
      context: { ...enabled(ada.context), ...media.context },
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "simulated partial audio write failure",
        }),
        expect.any(AggregateError),
      ]),
    );
  });

  it("rolls back inserted rows and removes prepared media when card insertion fails", async () => {
    const ada = await server.signIn("ada@example.com");
    const oldGerman = await seedDeck(ada.userId, GERMAN_SEED_NAME, 1);
    const oldImagePath = `${ada.userId}/${oldGerman.note.id}.png`;
    const oldAudioPath = `${ada.userId}/${oldGerman.cards[0].id}.mp3`;
    await server.db.update(notes).set({ imagePath: oldImagePath }).where(
      eq(notes.id, oldGerman.note.id),
    );
    await server.db.update(cards).set({ audioPath: oldAudioPath }).where(
      eq(cards.id, oldGerman.cards[0].id),
    );
    const media = createMediaFakes();
    media.files.add(oldImagePath);
    media.files.add(oldAudioPath);

    await expect(
      call(debugRouter.seedGerman, { replace: true }, {
        context: {
          ...enabled(ada.context),
          ...media.context,
          db: failingInsertInto(server.db, cards),
        },
      }),
    ).rejects.toThrow("simulated insert failure");

    expect(
      await server.db.select().from(decks).where(
        eq(decks.id, oldGerman.deck.id),
      ),
    )
      .toHaveLength(1);
    expect(
      await server.db.select().from(notes).where(
        eq(notes.id, oldGerman.note.id),
      ),
    )
      .toHaveLength(1);
    expect(
      await server.db.select().from(cards).where(
        eq(cards.id, oldGerman.cards[0].id),
      ),
    )
      .toHaveLength(1);
    expect(media.files).toEqual(new Set([oldImagePath, oldAudioPath]));
    expect(media.removed).toEqual(expect.arrayContaining(media.created));
  });

  it("rejects the seed procedure when server devtools are disabled", async () => {
    const ada = await server.signIn("ada@example.com");

    await expect(
      call(debugRouter.seedGerman, { replace: false }, {
        context: { ...ada.context, devtoolsEnabled: false },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
