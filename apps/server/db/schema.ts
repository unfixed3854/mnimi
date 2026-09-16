import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { uuidv7 } from "uuidv7";

// --- better-auth tables ----------------------------------------------------
// Shape mirrors Better Auth's SQLite generator.
// `nativeLanguage` / `uiLanguage` / `aiInstructions` are the user.additionalFields declared in
// apps/server/auth.ts; better-auth writes them by JS key, so both halves must agree.

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .default(false)
    .notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
  nativeLanguage: text("native_language").default("en").notNull(),
  uiLanguage: text("ui_language").default("en").notNull(),
  ttsAutoplay: integer("tts_autoplay", { mode: "boolean" })
    .notNull()
    .default(true),
  aiInstructions: text("ai_instructions").notNull().default(""),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// --- application tables ----------------------------------------------------

/** Classifier output kept alongside the note, plus generation-failure flags. */
export type NoteMetadata = {
  partOfSpeech?: string | null;
  generationFailed?: boolean;
  /** An image was attempted and did not arrive. Absent means none was ever
   *  wanted — the model returned a null imagePrompt — which is not a failure. */
  imageFailed?: boolean;
  /** Kept so a retry after saving has something to regenerate from. */
  imagePrompt?: string | null;
};

export type AudioStatus = "pending" | "generating" | "ready" | "failed";
export type PronunciationSpeed = "slow" | "normal" | "fast";

export const decks = sqliteTable("decks", {
  id: text("id").primaryKey().$defaultFn(uuidv7),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  pronunciationSpeed: text("pronunciation_speed")
    .$type<PronunciationSpeed>()
    .notNull()
    .default("normal"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    sourceText: text("source_text").notNull(),
    domain: text("domain").notNull(),
    language: text("language"),
    metadata: text("metadata", { mode: "json" })
      .$type<NoteMetadata>()
      .notNull()
      .$defaultFn(() => ({})),
    imagePath: text("image_path"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    revision: integer("revision").notNull().default(0),
  },
  (t) => [index("notes_deck_id_idx").on(t.deckId)],
);

/** A cloze card hides one span inside `front`; a basic card is a plain
 *  front/back pair. Derived from the markup at save time, never asked of the
 *  model — see `apps/server/router/notes.ts`. */
export type CardType = "basic" | "cloze";

export const cards = sqliteTable(
  "cards",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    aspect: text("aspect").notNull(),
    front: text("front").notNull(),
    // Nullable: a cloze card's answer is inside `front`, so a `back` holding it
    // too would be two fields to edit and two to disagree. For a cloze row this
    // carries the sentence's meaning where one applies, and is null otherwise.
    back: text("back"),
    cardType: text("card_type").$type<CardType>().notNull().default("basic"),
    // Explicit retrieval-cue policy. False is legacy behavior, so adding the
    // column cannot put an existing scheduled card into a new review flow.
    imageCue: integer("image_cue", { mode: "boolean" }).notNull().default(
      false,
    ),
    audioPath: text("audio_path"),
    audioStatus: text("audio_status").$type<AudioStatus>(),
    suspended: integer("suspended", { mode: "boolean" }).notNull().default(
      false,
    ),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    // inline ts-fsrs state
    due: integer("due", { mode: "timestamp_ms" }).notNull(),
    stability: real("stability").notNull().default(0),
    difficulty: real("difficulty").notNull().default(0),
    elapsedDays: integer("elapsed_days").notNull().default(0),
    scheduledDays: integer("scheduled_days").notNull().default(0),
    learningSteps: integer("learning_steps").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    state: integer("state").notNull().default(0),
    lastReview: integer("last_review", { mode: "timestamp_ms" }),
  },
  (t) => [
    // The hottest query in the app: this user's due cards. The WHERE clause is
    // emitted raw, so it must name the DB column, not the JS property.
    index("cards_due_idx").on(t.userId, t.due).where(sql`suspended = 0`),
    index("cards_note_id_idx").on(t.noteId),
  ],
);

export const reviewLogs = sqliteTable(
  "review_logs",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    cardId: text("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    state: integer("state").notNull(),
    due: integer("due", { mode: "timestamp_ms" }).notNull(),
    stability: real("stability").notNull(),
    difficulty: real("difficulty").notNull(),
    elapsedDays: integer("elapsed_days").notNull(),
    lastElapsedDays: integer("last_elapsed_days").notNull(),
    scheduledDays: integer("scheduled_days").notNull(),
    learningSteps: integer("learning_steps").notNull().default(0),
    review: integer("review", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("review_logs_card_id_idx").on(t.cardId)],
);

export type DraftStatus =
  | "queued"
  | "routing"
  | "needs_choice"
  | "generating"
  | "ready"
  | "failed"
  | "adjusting"
  | "regenerating"
  | "removed";
export type DraftOperation =
  | "route_generate"
  | "generate"
  | "retry"
  | "adjust"
  | "regenerate";
export type DraftImageStatus =
  | "none"
  | "queued"
  | "generating"
  | "ready"
  | "failed";
export type DraftErrorStage = "submission" | "routing" | "cards" | "image";
export type DraftErrorCategory =
  | "interrupted"
  | "routing_failed"
  | "generation_failed"
  | "validation_failed"
  | "image_failed";

/** Restated rather than imported from `../ai/schemas.ts`, the same way
 *  `NoteMetadata` restates `partOfSpeech`: the database layer describes what
 *  it stores and does not depend on the AI layer to do it. */
export type DraftClassification = {
  domain: string;
  language: string | null;
  partOfSpeech: string | null;
};

/** A card inside a draft. Every field is nullable because a draft holds
 *  half-written cards while `status` is "generating". */
export type DraftCard = {
  key?: string;
  aspect: string | null;
  front: string | null;
  back: string | null;
  imageCue: boolean | null;
};

export type DraftRoutingOutcome =
  | { kind: "matched"; deckId: string; learningGoal: string }
  | {
    kind: "ambiguous";
    candidates: Array<{ deckId: string; learningGoal: string }>;
  }
  | {
    kind: "newDeck";
    proposedName: string;
    proposedDescription: string;
    learningGoal: string;
  };

/**
 * One durable creation-inbox item. Users may own many rows; the scheduler,
 * attempt/lease fences, and revision make background work safe independently
 * from any mounted client. Card and image state remain deliberately separate.
 */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientRequestId: text("client_request_id").notNull().$defaultFn(uuidv7),
    deckId: text("deck_id")
      .references(() => decks.id, { onDelete: "set null" }),
    targetDeckId: text("target_deck_id")
      .references(() => decks.id, { onDelete: "set null" }),
    sourceText: text("source_text").notNull(),
    learningGoal: text("learning_goal"),
    routing: text("routing", { mode: "json" })
      .$type<DraftRoutingOutcome | null>(),
    status: text("status").$type<DraftStatus>().notNull().default("queued"),
    operation: text("operation").$type<DraftOperation>().default("generate"),
    activeAttemptId: text("active_attempt_id"),
    classification: text("classification", { mode: "json" })
      .$type<DraftClassification | null>(),
    attemptCards: text("attempt_cards", { mode: "json" })
      .$type<DraftCard[]>()
      .notNull()
      .$defaultFn(() => []),
    cards: text("cards", { mode: "json" })
      .$type<DraftCard[]>()
      .notNull()
      .$defaultFn(() => []),
    undoCards: text("undo_cards", { mode: "json" })
      .$type<DraftCard[] | null>(),
    generationSummary: text("generation_summary"),
    undoGenerationSummary: text("undo_generation_summary"),
    revision: integer("revision").notNull().default(0),
    targetLearningGoal: text("target_learning_goal"),
    adjustmentInstruction: text("adjustment_instruction"),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    imageAttemptId: text("image_attempt_id"),
    imagePrompt: text("image_prompt"),
    imageStatus: text("image_status")
      .$type<DraftImageStatus>()
      .notNull()
      .$defaultFn(() => "none"),
    draftImageId: text("draft_image_id"),
    errorCategory: text("error_category").$type<DraftErrorCategory>(),
    errorStage: text("error_stage").$type<DraftErrorStage>(),
    error: text("error"),
    removedAt: integer("removed_at", { mode: "timestamp_ms" }),
    undoUntil: integer("undo_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("drafts_user_client_request_unique").on(
      t.userId,
      t.clientRequestId,
    ),
    index("drafts_user_status_queue_idx").on(
      t.userId,
      t.status,
      t.queuedAt,
      t.id,
    ),
    index("drafts_lease_idx").on(t.leaseExpiresAt),
    index("drafts_deck_id_idx").on(t.deckId),
    index("drafts_target_deck_id_idx").on(t.targetDeckId),
  ],
);

export type CreationImageAttemptStatus =
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "canceled";

export const creationImageAttempts = sqliteTable(
  "creation_image_attempts",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    creationId: text("creation_id")
      .references(() => drafts.id, { onDelete: "cascade" }),
    noteId: text("note_id")
      .references(() => notes.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    status: text("status")
      .$type<CreationImageAttemptStatus>()
      .notNull()
      .default("queued"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    draftImageId: text("draft_image_id"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      "creation_image_attempt_owner_check",
      sql`(${t.creationId} is not null and ${t.noteId} is null) or (${t.creationId} is null and ${t.noteId} is not null)`,
    ),
    index("creation_image_attempt_status_idx").on(
      t.status,
      t.createdAt,
      t.id,
    ),
    index("creation_image_attempt_user_idx").on(t.userId),
    index("creation_image_attempt_lease_idx").on(t.leaseExpiresAt),
  ],
);

export const creationSaveReceipts = sqliteTable(
  "creation_save_receipts",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    creationId: text("creation_id").notNull(),
    saveRequestId: text("save_request_id").notNull(),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("creation_save_receipt_creation_unique").on(
      t.userId,
      t.creationId,
    ),
    uniqueIndex("creation_save_receipt_request_unique").on(
      t.userId,
      t.saveRequestId,
    ),
  ],
);

export const pushInstallations = sqliteTable(
  "push_installations",
  {
    id: text("id").primaryKey().$defaultFn(uuidv7),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: text("platform").$type<"android">().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (t) => [index("push_installations_user_idx").on(t.userId)],
);

export type Deck = typeof decks.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type CreationImageAttempt = typeof creationImageAttempts.$inferSelect;
export type CreationSaveReceipt = typeof creationSaveReceipts.$inferSelect;
export type PushInstallation = typeof pushInstallations.$inferSelect;
