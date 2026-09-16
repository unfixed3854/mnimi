import {
  type Card as FsrsCard,
  fsrs,
  type Grade,
  Rating,
  State,
} from "ts-fsrs";
/** Server card columns required for the untouched ts-fsrs scheduling calculation. */
export type CardRow = {
  id: string;
  due: Date;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: Date | null;
};

export type FsrsColumns = Pick<
  CardRow,
  | "due"
  | "stability"
  | "difficulty"
  | "elapsedDays"
  | "scheduledDays"
  | "learningSteps"
  | "reps"
  | "lapses"
  | "state"
  | "lastReview"
>;

export type ReviewLogInsert = {
  rating: number;
  state: number;
  due: Date;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  lastElapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  review: Date;
};

const scheduler = fsrs();

export const RATINGS = [
  { value: Rating.Again, label: "Again" },
  { value: Rating.Hard, label: "Hard" },
  { value: Rating.Good, label: "Good" },
  { value: Rating.Easy, label: "Easy" },
] as const satisfies ReadonlyArray<{ value: Grade; label: string }>;

export function toFsrsCard(row: CardRow): FsrsCard {
  return {
    due: row.due,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsedDays,
    scheduled_days: row.scheduledDays,
    learning_steps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state as State,
    last_review: row.lastReview ?? undefined,
  };
}

export function fromFsrsCard(card: FsrsCard): FsrsColumns {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review ?? null,
  };
}

export function gradeCard(
  row: CardRow,
  rating: Grade,
  now: Date = new Date(),
): { card: FsrsColumns; log: ReviewLogInsert } {
  const { card, log } = scheduler.next(toFsrsCard(row), now, rating);

  return {
    card: fromFsrsCard(card),
    log: {
      rating: log.rating,
      state: log.state,
      due: log.due,
      stability: log.stability,
      difficulty: log.difficulty,
      elapsedDays: log.elapsed_days,
      lastElapsedDays: log.last_elapsed_days,
      scheduledDays: log.scheduled_days,
      learningSteps: log.learning_steps,
      review: log.review,
    },
  };
}
