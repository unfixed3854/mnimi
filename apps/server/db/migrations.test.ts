import { describe, expect, it } from "vitest";
import { type Client, createClient } from "@libsql/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `apps/server/db/schema.test.ts` proves the *Drizzle definitions* build the
 * intended shape, via `pushSQLiteSchema` — but that helper pushes the schema
 * object directly and never reads a migration file, so it can't catch a bad
 * migration. This file replays the actual files in `apps/server/drizzle/`, in the
 * order `meta/_journal.json` records, against a scratch database — the same
 * SQL `bun run db:migrate` executes against production. It exists because
 * drizzle-kit's generated SQL for 0002 initially referenced a column that
 * didn't exist yet on the pre-migration table (see the hand-fix noted in
 * `0002_adorable_rachel_grey.sql`) — a class of bug `schema.test.ts` cannot
 * see.
 */

const drizzleDir = join(import.meta.dirname!, "..", "drizzle");

interface Journal {
  entries: { tag: string }[];
}

function migrationTags(): string[] {
  const journal: Journal = JSON.parse(
    readFileSync(join(drizzleDir, "meta", "_journal.json"), "utf-8"),
  );
  return journal.entries.map((entry) => entry.tag);
}

/** Migration files separate statements with a `--> statement-breakpoint`
 *  marker comment rather than relying on `;`, since `;` also appears inside
 *  statements (e.g. multi-statement triggers) — so that marker is what has to
 *  split them here too. */
async function applyMigration(client: Client, tag: string): Promise<void> {
  const sql = readFileSync(join(drizzleDir, `${tag}.sql`), "utf-8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await client.execute(statement);
  }
}

async function createScratchDb() {
  const dir = mkdtempSync(join(tmpdir(), "mnimi-migrations-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  await client.execute("PRAGMA foreign_keys = ON");
  const close = () => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { client, close };
}

describe("the cards migrations", () => {
  it("removes the obsolete card hint without losing scheduled-card state or indexes", async () => {
    const { client, close } = await createScratchDb();
    try {
      const tags = migrationTags();
      expect(tags.length).toBeGreaterThanOrEqual(3);
      const targetIndex = tags.indexOf("0005_tearful_punisher");
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      const beforeTarget = tags.slice(0, targetIndex);
      const target = tags[targetIndex];

      // Build the database up to (but not including) the migration under
      // test, through 0002 where `back` is nullable and `card_type` already
      // exists — the real starting point for any existing user's database
      // before applying the hint-removal migration.
      for (const tag of beforeTarget) {
        await applyMigration(client, tag);
      }

      await client.execute({
        sql:
          "insert into user (id, name, email, updated_at) values (?, ?, ?, ?)",
        args: ["u1", "Ada", "ada@example.com", 0],
      });
      await client.execute({
        sql:
          "insert into decks (id, user_id, name, created_at) values (?, ?, ?, ?)",
        args: ["d1", "u1", "German", 0],
      });
      await client.execute({
        sql:
          "insert into notes (id, user_id, deck_id, source_text, domain, metadata, created_at) values (?, ?, ?, ?, ?, ?, ?)",
        args: ["n1", "u1", "d1", "die Banane", "language", "{}", 0],
      });

      // Distinctive FSRS values — chosen so a bug that zeroes, drops, or
      // reorders a column can't accidentally still match.
      const seeded = {
        due: 1_700_000_000_000,
        stability: 12.5,
        difficulty: 3.75,
        elapsedDays: 11,
        scheduledDays: 22,
        learningSteps: 3,
        reps: 8,
        lapses: 2,
        state: 2,
        lastReview: 1_699_000_000_000,
      };
      await client.execute({
        sql: `insert into cards
          (id, note_id, user_id, aspect, front, back, hint, suspended, created_at,
           due, stability, difficulty, elapsed_days, scheduled_days,
           learning_steps, reps, lapses, state, last_review)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "c1",
          "n1",
          "u1",
          "meaning",
          "die Banane",
          "banana",
          "legacy prompt",
          0,
          0,
          seeded.due,
          seeded.stability,
          seeded.difficulty,
          seeded.elapsedDays,
          seeded.scheduledDays,
          seeded.learningSteps,
          seeded.reps,
          seeded.lapses,
          seeded.state,
          seeded.lastReview,
        ],
      });

      // The migration under test.
      await applyMigration(client, target);

      const rows = await client.execute("select * from cards where id = 'c1'");
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.due).toBe(seeded.due);
      expect(row.stability).toBe(seeded.stability);
      expect(row.difficulty).toBe(seeded.difficulty);
      expect(row.elapsed_days).toBe(seeded.elapsedDays);
      expect(row.scheduled_days).toBe(seeded.scheduledDays);
      expect(row.learning_steps).toBe(seeded.learningSteps);
      expect(row.reps).toBe(seeded.reps);
      expect(row.lapses).toBe(seeded.lapses);
      expect(row.state).toBe(seeded.state);
      expect(row.last_review).toBe(seeded.lastReview);
      expect(row.back).toBe("banana");
      expect(row.card_type).toBe("basic");
      expect(row.image_cue).toBe(0);
      expect(row.audio_path).toBeNull();
      expect(row.audio_status).toBeNull();
      expect(row.hint).toBeUndefined();
      const userRow = await client.execute(
        "select tts_autoplay from user where id = 'u1'",
      );
      expect(userRow.rows[0].tts_autoplay).toBe(1);

      const columns = await client.execute("PRAGMA table_info(cards)");
      const names = columns.rows.map((column) => String(column.name));
      expect(names).toContain("image_cue");
      expect(names).not.toContain("hint");
      for (
        const fsrsColumn of [
          "due",
          "stability",
          "difficulty",
          "elapsed_days",
          "scheduled_days",
          "learning_steps",
          "reps",
          "lapses",
          "state",
          "last_review",
        ]
      ) {
        expect(names).toContain(fsrsColumn);
      }

      const indexes = await client.execute(
        "select name, sql from sqlite_master where type = 'index' and tbl_name = 'cards'",
      );
      const byName = new Map(
        indexes.rows.map((r) => [String(r.name), String(r.sql)]),
      );
      expect(byName.get("cards_due_idx")).toContain("WHERE suspended = 0");
      expect(byName.has("cards_note_id_idx")).toBe(true);
    } finally {
      close();
    }
  });

  it("defaults existing notes to revision zero when the revision migration is applied", async () => {
    const { client, close } = await createScratchDb();
    try {
      const tags = migrationTags();
      const targetIndex = tags.indexOf("0006_note_revision");
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      const beforeTarget = tags.slice(0, targetIndex);
      const target = tags[targetIndex];
      for (const tag of beforeTarget) await applyMigration(client, tag);

      await client.execute({
        sql:
          "insert into user (id, name, email, updated_at) values (?, ?, ?, ?)",
        args: ["u1", "Ada", "ada@example.com", 0],
      });
      await client.execute({
        sql:
          "insert into decks (id, user_id, name, created_at) values (?, ?, ?, ?)",
        args: ["d1", "u1", "German", 0],
      });
      await client.execute({
        sql:
          "insert into notes (id, user_id, deck_id, source_text, domain, metadata, created_at) values (?, ?, ?, ?, ?, ?, ?)",
        args: ["n1", "u1", "d1", "die Banane", "language", "{}", 0],
      });

      await applyMigration(client, target);

      const result = await client.execute(
        "select revision, source_text, metadata from notes where id = 'n1'",
      );
      const row = result.rows[0];
      expect(row.revision).toBe(0);
      expect(row.source_text).toBe("die Banane");
      expect(row.metadata).toBe("{}");
    } finally {
      close();
    }
  });

  it("migrates legacy drafts into a multi-creation inbox without losing content", async () => {
    const { client, close } = await createScratchDb();
    try {
      const tags = migrationTags();
      const targetIndex = tags.findIndex((tag) => tag.startsWith("0007_"));
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      for (const tag of tags.slice(0, targetIndex)) {
        await applyMigration(client, tag);
      }

      for (const [id, email] of [["u1", "ada@example.com"], ["u2", "bob@example.com"]]) {
        await client.execute({
          sql: "insert into user (id, name, email, updated_at) values (?, ?, ?, ?)",
          args: [id, id, email, 0],
        });
        await client.execute({
          sql: "insert into decks (id, user_id, name, created_at) values (?, ?, ?, ?)",
          args: [`d-${id}`, id, "Legacy deck", 0],
        });
      }

      const readyCards = [{
        aspect: "meaning",
        front: "die Banane",
        back: "banana",
        imageCue: false,
      }];
      await client.execute({
        sql: `insert into drafts
          (id, user_id, deck_id, source_text, status, classification, cards,
           image_prompt, image_status, draft_image_id, error, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "draft-ready",
          "u1",
          "d-u1",
          "die Banane",
          "ready",
          JSON.stringify({ domain: "language", language: "de", partOfSpeech: "noun" }),
          JSON.stringify(readyCards),
          "a banana",
          "ready",
          "image-1",
          null,
          100,
        ],
      });
      await client.execute({
        sql: `insert into drafts
          (id, user_id, deck_id, source_text, status, cards, image_status, error, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "draft-running",
          "u2",
          "d-u2",
          "entropy",
          "generating",
          "[]",
          "generating",
          null,
          200,
        ],
      });

      await applyMigration(client, tags[targetIndex]);

      const result = await client.execute(
        "select * from drafts order by created_at",
      );
      expect(result.rows).toHaveLength(2);
      const ready = result.rows[0];
      const running = result.rows[1];
      expect(ready.source_text).toBe("die Banane");
      expect(ready.status).toBe("ready");
      expect(ready.deck_id).toBe("d-u1");
      expect(JSON.parse(String(ready.cards))).toEqual(readyCards);
      expect(ready.image_prompt).toBe("a banana");
      expect(ready.image_status).toBe("ready");
      expect(ready.draft_image_id).toBe("image-1");
      expect(ready.client_request_id).toBe("legacy:draft-ready");
      expect(running.status).toBe("queued");
      expect(running.operation).toBe("generate");
      expect(running.lease_owner).toBeNull();
      expect(running.client_request_id).toBe("legacy:draft-running");

      await client.execute({
        sql: `insert into drafts
          (id, user_id, client_request_id, source_text, status, created_at,
           updated_at, queued_at, cards, attempt_cards, image_status, revision)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "draft-second",
          "u1",
          "request-2",
          "Haus",
          "queued",
          300,
          300,
          300,
          "[]",
          "[]",
          "none",
          0,
        ],
      });
      const u1Drafts = await client.execute(
        "select id from drafts where user_id = 'u1' order by created_at",
      );
      expect(u1Drafts.rows.map((row) => row.id)).toEqual([
        "draft-ready",
        "draft-second",
      ]);
    } finally {
      close();
    }
  });
});

describe("the deck pronunciation speed migration", () => {
  it("defaults existing decks to normal speed", async () => {
    const { client, close } = await createScratchDb();
    try {
      const tags = migrationTags();
      const targetIndex = tags.findIndex((tag) =>
        readFileSync(join(drizzleDir, `${tag}.sql`), "utf-8").includes(
          "pronunciation_speed",
        )
      );
      expect(targetIndex).toBeGreaterThanOrEqual(0);

      for (const tag of tags.slice(0, targetIndex)) {
        await applyMigration(client, tag);
      }
      await client.execute(
        "insert into user (id, name, email, updated_at) values ('u1', 'Ada', 'ada@example.com', 0)",
      );
      await client.execute(
        "insert into decks (id, user_id, name, created_at) values ('d1', 'u1', 'German', 0)",
      );

      await applyMigration(client, tags[targetIndex]);

      const rows = await client.execute(
        "select pronunciation_speed from decks where id = 'd1'",
      );
      expect(rows.rows[0].pronunciation_speed).toBe("normal");
    } finally {
      close();
    }
  });
});

describe("the generation summary migration", () => {
  it("adds nullable summaries to existing drafts", async () => {
    const { client, close } = await createScratchDb();
    try {
      const tags = migrationTags();
      const targetIndex = tags.indexOf("0009_fresh_zaladane");
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      for (const tag of tags.slice(0, targetIndex)) {
        await applyMigration(client, tag);
      }

      await client.execute(
        "insert into user (id, name, email, updated_at) values ('u1', 'Ada', 'ada@example.com', 0)",
      );
      await client.execute({
        sql: `insert into drafts
          (id, user_id, client_request_id, source_text, status, attempt_cards,
           cards, queued_at, image_status, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "draft-1",
          "u1",
          "request-1",
          "die Banane",
          "ready",
          "[]",
          "[]",
          0,
          "none",
          0,
          0,
        ],
      });

      await applyMigration(client, tags[targetIndex]);

      const result = await client.execute(
        "select generation_summary, undo_generation_summary from drafts where id = 'draft-1'",
      );
      expect(result.rows[0]).toMatchObject({
        generation_summary: null,
        undo_generation_summary: null,
      });
    } finally {
      close();
    }
  });
});
