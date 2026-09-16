import { Rating, State } from "ts-fsrs";
import {
  type CardRow,
  fromFsrsCard,
  gradeCard,
  toFsrsCard,
} from "@/lib/fsrs";

function makeRow(overrides: Partial<CardRow> = {}): CardRow {
  return {
    id: "card-1",
    due: new Date("2026-07-27T10:00:00.000Z"),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    lastReview: null,
    ...overrides,
  };
}

describe("native FSRS persistence", () => {
  it("round-trips every persisted scheduler column without changing its shape", () => {
    const row = makeRow({
      due: new Date("2026-08-01T12:00:00.000Z"),
      stability: 4.5,
      difficulty: 6.25,
      elapsedDays: 3,
      scheduledDays: 7,
      learningSteps: 1,
      reps: 5,
      lapses: 2,
      state: State.Review,
      lastReview: new Date("2026-07-25T09:00:00.000Z"),
    });

    expect(fromFsrsCard(toFsrsCard(row))).toEqual({
      due: row.due,
      stability: 4.5,
      difficulty: 6.25,
      elapsedDays: 3,
      scheduledDays: 7,
      learningSteps: 1,
      reps: 5,
      lapses: 2,
      state: State.Review,
      lastReview: row.lastReview,
    });
  });

  it.each(
    [
      ["Again", Rating.Again],
      ["Good", Rating.Good],
      ["Easy", Rating.Easy],
    ] as const,
  )(
    "maps an FSRS %s result into card and review-log columns",
    (_label, rating) => {
      const now = new Date("2026-07-27T10:00:00.000Z");
      const { card, log } = gradeCard(makeRow(), rating, now);

      expect(card.reps).toBe(1);
      expect(card.state).not.toBe(State.New);
      expect(card.due.getTime()).toBeGreaterThan(log.due.getTime());
      expect(log.due).toEqual(now);
      expect(log.rating).toBe(rating);
      expect(log.review).toEqual(now);
      expect(Object.keys(log).sort()).toEqual([
        "difficulty",
        "due",
        "elapsedDays",
        "lastElapsedDays",
        "learningSteps",
        "rating",
        "review",
        "scheduledDays",
        "stability",
        "state",
      ]);
    },
  );

  it("schedules Again, Good, and Easy in increasing due-date order", () => {
    const now = new Date("2026-07-27T10:00:00.000Z");
    const again = gradeCard(makeRow(), Rating.Again, now).card.due.getTime();
    const good = gradeCard(makeRow(), Rating.Good, now).card.due.getTime();
    const easy = gradeCard(makeRow(), Rating.Easy, now).card.due.getTime();

    expect(again).toBeLessThan(good);
    expect(good).toBeLessThan(easy);
  });
});
