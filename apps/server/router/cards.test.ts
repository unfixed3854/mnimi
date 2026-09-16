import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer, failingInsertInto } from "./testing.ts";
import { decksRouter } from "./decks.ts";
import { notesRouter } from "./notes.ts";

const { generateCardAudioMock } = vi.hoisted(() => ({
  generateCardAudioMock: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock("../tts/jobs.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../tts/jobs.ts")>(),
  generateCardAudio: generateCardAudioMock,
}));

import { cardsRouter } from "./cards.ts";
import { cards, drafts, notes, reviewLogs } from "../db/schema.ts";
import type { AppContext } from "./base.ts";
import {
  AudioCardIneligibleError,
  AudioCardNotFoundError,
} from "../tts/jobs.ts";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  generateCardAudioMock.mockReset();
  server = await createTestServer();
});

afterEach(() => {
  server.close();
});

const CLASSIFICATION = {
  domain: "concept",
  language: null,
  partOfSpeech: null,
};

/**
 * A deck with `count` cards, all due now.
 *
 * Built through `notesRouter.save` rather than by inserting cards directly,
 * which is what makes the `reps === 0` / `state === 0` assertions further down
 * this file also pin save's FSRS-new default. (They replace an explicit
 * assertion deleted in 2f94ed6; mutating `state: 3, reps: 7` into save's card
 * insert fails two tests here, so the coverage really did survive the move.)
 */
async function seed(
  userId: string,
  context: AppContext,
  count = 1,
  deckName = "Deck",
) {
  const deck = await call(decksRouter.create, { name: deckName }, { context });
  const draftCards = Array.from({ length: count }, (_, i) => ({
    aspect: `aspect-${i}`,
    front: `front-${i}`,
    back: `back-${i}`,
    imageCue: false,
  }));
  const [draft] = await server.db
    .insert(drafts)
    .values({
      userId,
      deckId: deck.id,
      sourceText: "source",
      status: "ready",
      classification: CLASSIFICATION,
      cards: draftCards,
      imagePrompt: null,
    })
    .returning();
  await call(
    notesRouter.save,
    { draftId: draft.id, cards: draftCards },
    { context },
  );
  return deck;
}

async function seedEligibleCard(
  userId: string,
  context: AppContext,
  pronunciationSpeed: "slow" | "normal" | "fast" = "normal",
) {
  const deck = await call(decksRouter.create, { name: "German" }, { context });
  if (pronunciationSpeed !== "normal") {
    await call(
      decksRouter.updatePronunciationSpeed,
      { deckId: deck.id, pronunciationSpeed },
      { context },
    );
  }
  const [note] = await server.db.insert(notes).values({
    userId,
    deckId: deck.id,
    sourceText: "die Banane",
    domain: "language",
    language: "de",
    metadata: {},
  }).returning();
  const [card] = await server.db.insert(cards).values({
    noteId: note.id,
    userId,
    aspect: "production",
    front: "Ich mag {{c1::Bananen::banany}}.",
    back: null,
    cardType: "cloze",
    imageCue: false,
    audioStatus: "pending",
    due: new Date(),
  }).returning();
  return card;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
  due: new Date("2026-08-05T00:00:00.000Z"),
  stability: 3.5,
  difficulty: 5.1,
  elapsedDays: 0,
  lastElapsedDays: 0,
  scheduledDays: 1,
  learningSteps: 1,
  review: new Date("2026-08-05T00:00:00.000Z"),
};

describe("cards.due", () => {
  it("returns sanitized audio state for eligible cards", async () => {
    const ada = await server.signIn("ada@example.com");
    const stored = await seedEligibleCard(ada.userId, ada.context);

    const [card] = await call(cardsRouter.due, {}, { context: ada.context });

    expect(card).toMatchObject({
      id: stored.id,
      hasAudio: false,
      audioStatus: "pending",
      audioEligible: true,
    });
    expect(card).not.toHaveProperty("audioPath");
  });

  it("includes each card's deck pronunciation speed in a mixed queue", async () => {
    const ada = await server.signIn("ada@example.com");
    const slowCard = await seedEligibleCard(
      ada.userId,
      ada.context,
      "slow",
    );
    const normalCard = await seedEligibleCard(ada.userId, ada.context);

    const due = await call(cardsRouter.due, {}, { context: ada.context });
    const byId = new Map(due.map((card) => [card.id, card]));

    expect(byId.get(slowCard.id)).toMatchObject({
      pronunciationSpeed: "slow",
    });
    expect(byId.get(normalCard.id)).toMatchObject({
      pronunciationSpeed: "normal",
    });
  });

  it("returns only the session user's due cards", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    await seed(ada.userId, ada.context, 2);
    await seed(bob.userId, bob.context, 3);

    const due = await call(cardsRouter.due, {}, { context: ada.context });
    expect(due).toHaveLength(2);
    expect(due.every((c) => c.userId === ada.userId)).toBe(true);
  });

  it("filters by deck without widening past the session user", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaDeck = await seed(ada.userId, ada.context, 2, "Ada's");
    const bobDeck = await seed(bob.userId, bob.context, 3, "Bob's");

    const mine = await call(
      cardsRouter.due,
      { deckId: adaDeck.id },
      { context: ada.context },
    );
    expect(mine).toHaveLength(2);

    // Ada asking for Bob's deck gets nothing, not Bob's cards.
    const theirs = await call(
      cardsRouter.due,
      { deckId: bobDeck.id },
      { context: ada.context },
    );
    expect(theirs).toHaveLength(0);
  });

  it("excludes suspended and not-yet-due cards", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.userId, ada.context, 3);
    const all = await server.db.select().from(cards);

    await server.db
      .update(cards)
      .set({ suspended: true })
      .where(eq(cards.id, all[0].id));
    await server.db
      .update(cards)
      .set({ due: new Date(Date.now() + 86_400_000) })
      .where(eq(cards.id, all[1].id));

    const due = await call(cardsRouter.due, {}, { context: ada.context });
    expect(due.map((c) => c.id)).toEqual([all[2].id]);
  });

  it("caps the queue at 100 cards", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.userId, ada.context, 120);

    const due = await call(cardsRouter.due, {}, { context: ada.context });
    expect(due).toHaveLength(100);
  });

  it("orders a review session by its shuffle seed instead of due time", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.userId, ada.context, 3);
    const stored = await server.db.select().from(cards);
    const ids = [
      "0195f0e0-0000-7000-8000-000000000001",
      "0195f0e0-0000-7000-8000-000000000002",
      "0195f0e0-0000-7000-8000-000000000003",
    ];

    for (const [index, card] of stored.entries()) {
      await server.db
        .update(cards)
        .set({
          id: ids[index],
          due: new Date(`2020-01-0${index + 1}T00:00:00.000Z`),
        })
        .where(eq(cards.id, card.id));
    }

    const due = await call(
      cardsRouter.due,
      { shuffleSeed: 2 },
      { context: ada.context },
    );

    expect(due.map((card) => card.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("reports whether the card's note has an image", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.userId, ada.context);

    const before = await call(cardsRouter.due, {}, { context: ada.context });
    expect(before.every((card) => card.hasImage === false)).toBe(true);

    await server.db
      .update(notes)
      .set({ imagePath: `${ada.userId}/whatever.png` })
      .where(eq(notes.userId, ada.userId));

    const after = await call(cardsRouter.due, {}, { context: ada.context });
    expect(after.every((card) => card.hasImage === true)).toBe(true);
  });

  it("returns imageCue unchanged beside hasImage", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(decksRouter.create, { name: "German" }, {
      context: ada.context,
    });
    const draftCards = [
      {
        aspect: "plural",
        front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
        back: "I see two bananas.",
        imageCue: true,
      },
    ];
    const [draft] = await server.db
      .insert(drafts)
      .values({
        userId: ada.userId,
        deckId: deck.id,
        sourceText: "die Banane",
        status: "ready",
        classification: {
          domain: "language",
          language: "de",
          partOfSpeech: "noun",
        },
        cards: draftCards,
        imagePrompt: "two bananas",
      })
      .returning();
    await call(
      notesRouter.save,
      { draftId: draft.id, cards: draftCards },
      { context: ada.context },
    );
    await server.db
      .update(notes)
      .set({ imagePath: `${ada.userId}/whatever.png` })
      .where(eq(notes.userId, ada.userId));

    const due = await call(cardsRouter.due, {}, { context: ada.context });
    expect(due).toHaveLength(1);
    expect(due[0].imageCue).toBe(true);
    expect(due[0].hasImage).toBe(true);
  });
});

describe("cards.generateAudio", () => {
  it("reports another user's card as missing", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const bobCard = await seedEligibleCard(bob.userId, bob.context);
    generateCardAudioMock.mockRejectedValueOnce(new AudioCardNotFoundError());

    await expect(
      call(cardsRouter.generateAudio, { cardId: bobCard.id }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects cards that are not eligible for audio", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.userId, ada.context);
    const [card] = await server.db.select().from(cards);
    generateCardAudioMock.mockRejectedValueOnce(
      new AudioCardIneligibleError(),
    );

    await expect(
      call(cardsRouter.generateAudio, { cardId: card.id }, {
        context: ada.context,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("waits for generation and returns ready audio state", async () => {
    const ada = await server.signIn("ada@example.com");
    const card = await seedEligibleCard(ada.userId, ada.context);
    const generation = deferred();
    generateCardAudioMock.mockImplementationOnce(() => generation.promise);
    let settled = false;

    const result = call(cardsRouter.generateAudio, { cardId: card.id }, {
      context: ada.context,
    }).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    generation.release();
    await expect(result).resolves.toEqual({
      hasAudio: true,
      audioStatus: "ready",
    });
    expect(generateCardAudioMock).toHaveBeenCalledWith(
      server.db,
      ada.userId,
      card.id,
    );
  });
});

describe("cards.dueCount", () => {
  it("counts past the 100-card queue cap", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.userId, ada.context, 120);

    const count = await call(cardsRouter.dueCount, {}, {
      context: ada.context,
    });
    expect(count).toBe(120);
  });

  it("counts zero for a user with nothing due", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    await seed(bob.userId, bob.context, 5);

    expect(await call(cardsRouter.dueCount, {}, { context: ada.context })).toBe(
      0,
    );
  });
});

describe("cards.grade", () => {
  it("updates the card and writes a review log together", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.userId, ada.context, 1);
    const [card] = await server.db.select().from(cards);

    await call(
      cardsRouter.grade,
      { cardId: card.id, card: GRADE_COLUMNS, log: GRADE_LOG },
      { context: ada.context },
    );

    const [updated] = await server.db
      .select()
      .from(cards)
      .where(eq(cards.id, card.id));
    expect(updated.reps).toBe(1);
    expect(updated.state).toBe(1);
    expect(updated.due).toEqual(GRADE_COLUMNS.due);

    const logs = await server.db.select().from(reviewLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].cardId).toBe(card.id);
    expect(logs[0].userId).toBe(ada.userId);
    expect(logs[0].rating).toBe(3);
  });

  it("refuses to grade another user's card", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    await seed(bob.userId, bob.context, 1);
    const [bobCard] = await server.db.select().from(cards);

    await expect(
      call(
        cardsRouter.grade,
        { cardId: bobCard.id, card: GRADE_COLUMNS, log: GRADE_LOG },
        { context: ada.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const [unchanged] = await server.db.select().from(cards);
    expect(unchanged.reps).toBe(0);
    expect(await server.db.select().from(reviewLogs)).toHaveLength(0);
  });

  it("leaves the card untouched when the log insert fails", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.userId, ada.context, 1);
    const [card] = await server.db.select().from(cards);

    // The failure must land INSIDE the transaction, after the card update.
    // Invalid input cannot do that: oRPC validates against the procedure's
    // schema before the handler runs, so the call would fail with BAD_REQUEST
    // and the transaction would never open — passing whether or not `grade` is
    // transactional at all.
    const context = {
      ...ada.context,
      db: failingInsertInto(server.db, reviewLogs),
    };

    await expect(
      call(
        cardsRouter.grade,
        { cardId: card.id, card: GRADE_COLUMNS, log: GRADE_LOG },
        { context },
      ),
    ).rejects.toThrow("simulated insert failure");

    const [unchanged] = await server.db
      .select()
      .from(cards)
      .where(eq(cards.id, card.id));
    expect(unchanged.reps).toBe(0);
    expect(unchanged.state).toBe(0);
    expect(await server.db.select().from(reviewLogs)).toHaveLength(0);
  });

  it("rejects an unknown card id", async () => {
    const ada = await server.signIn("ada@example.com");
    await expect(
      call(
        cardsRouter.grade,
        {
          cardId: "0195f0e0-0000-7000-8000-000000000000",
          card: GRADE_COLUMNS,
          log: GRADE_LOG,
        },
        { context: ada.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
