# SQLite + Drizzle + better-auth Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Supabase entirely with a self-hosted Hono server on Deno that owns a SQLite file through Drizzle, authenticates with better-auth, and exposes an oRPC API plus one SSE route.

**Architecture:** One server process in `server/`. Drizzle over `@libsql/client` on a local file. better-auth with the Drizzle adapter and the bearer plugin. An oRPC router whose every procedure is built on an `authed` base that injects `userId` from the verified session — this replaces Row Level Security. Card generation stays a raw `text/event-stream` route so its existing wire protocol and tests survive untouched.

**Tech Stack:** Deno 2.9.3, Hono 4.13.0, better-auth 1.6.26, drizzle-orm 0.45.2, drizzle-kit 0.31.10, @libsql/client 0.17.4, @orpc/{server,client,tanstack-query} 1.14.14, uuidv7 1.2.1, zod 4.4.3, React 19 + TanStack Router/Query/Form, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-05-sqlite-better-auth-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Package manager is `deno`.** Never run `npm`, `npx`, `yarn` or `pnpm`. `AGENTS.md` mandates this.
- **`server/deno.json` MUST set `"nodeModulesDir": "auto"`** and MUST include the trailing-slash import `"drizzle-orm/": "npm:/drizzle-orm@0.45.2/"`. Without both, `drizzle-kit` fails with the misleading "Please install latest version of drizzle-orm".
- **drizzle-kit dialect is `"sqlite"`**, never `"turso"`.
- **Every test database is a unique temp file**, created by `createTestDb()` and deleted on close. Two in-memory URLs are both wrong and were both measured: `:memory:` gives each connection a private database, so the first `db.transaction()` — which hands @libsql/client's only connection to the transaction and lazily opens another — silently destroys the schema and every later query fails "no such table". `file::memory:?cache=shared` fixes that but goes too far the other way: shared-cache databases are keyed by name, so every `createTestDb()` call in a process shares **one** database and tests collide on unique constraints. `mode=memory` with a distinct name is not an option — @libsql/client rejects the `mode` query parameter outright.
- **Inside a `db.transaction(async (tx) => …)` callback, only `tx` may be used.** The root `db` handle is a different connection: it cannot see uncommitted rows and its writes fail against the held lock.
- **No procedure ever accepts a `userId` from the client.** Input schemas must not contain a `userId` field. Inserts take it from `context.userId`; every select/update/delete carries `eq(table.userId, context.userId)`.
- **Column names are explicit snake_case strings** (`text("source_text")`); TypeScript property names are camelCase. Do NOT use drizzle's `casing` config — a runtime/kit mismatch there breaks queries silently.
- **`additionalFields` must NOT set `input: false`.** That flag blocks `updateUser` as well as sign-up.
- Exact dependency versions: `better-auth@1.6.26`, `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`, `@libsql/client@0.17.4`, `@orpc/server@1.14.14`, `@orpc/client@1.14.14`, `@orpc/tanstack-query@1.14.14`, `hono@4.13.0`, `uuidv7@1.2.1`, `zod@4.4.3`.
- Do **not** install `@orpc/zod`. oRPC validates through Standard Schema; zod 4 works directly.
- Run `deno task test` (Vitest) after every task. It must stay green. To run a single file, use `deno task test <path>` — NOT `deno task test -- <path>`, which forwards a literal `--` to vitest and silently runs the whole suite instead of filtering.

---

### Task 1: Server scaffold and database schema

**Files:**
- Create: `server/deno.json`
- Create: `server/db/schema.ts`
- Create: `server/db/index.ts`
- Create: `server/db/testing.ts`
- Create: `server/drizzle.config.ts`
- Create: `server/.gitignore`
- Test: `server/db/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `db` (a `LibSQLDatabase<typeof schema>`), `createTestDb(): Promise<{ db, client }>`, and the tables `user`, `session`, `account`, `verification`, `decks`, `notes`, `cards`, `reviewLogs`. Row types `Deck`, `Note`, `Card`, `ReviewLog`, `NewCard`, `NewReviewLog` via `$inferSelect` / `$inferInsert`. All later tasks import from `server/db/schema.ts` and `server/db/index.ts`.

- [ ] **Step 1: Create `server/deno.json`**

```json
{
  "nodeModulesDir": "auto",
  "imports": {
    "@libsql/client": "npm:@libsql/client@0.17.4",
    "@orpc/client": "npm:@orpc/client@1.14.14",
    "@orpc/server": "npm:@orpc/server@1.14.14",
    "@tanstack/ai": "npm:@tanstack/ai@0.42.0",
    "@tanstack/ai-openrouter": "npm:@tanstack/ai-openrouter@0.15.10",
    "better-auth": "npm:better-auth@1.6.26",
    "drizzle-kit": "npm:drizzle-kit@0.31.10",
    "drizzle-orm": "npm:drizzle-orm@0.45.2",
    "drizzle-orm/": "npm:/drizzle-orm@0.45.2/",
    "hono": "npm:hono@4.13.0",
    "uuidv7": "npm:uuidv7@1.2.1",
    "zod": "npm:zod@4.4.3"
  },
  "tasks": {
    "dev": "deno run -A --env-file --watch main.ts",
    "start": "deno run -A --env-file main.ts",
    "db:generate": "deno run -A --env-file npm:drizzle-kit@0.31.10 generate",
    "db:migrate": "deno run -A --env-file npm:drizzle-kit@0.31.10 migrate"
  }
}
```

- [ ] **Step 2: Create `server/.gitignore`**

```
data/
node_modules/
.env
```

- [ ] **Step 3: Write `server/db/schema.ts`**

The auth tables reproduce exactly what better-auth's generator emits for `provider: "sqlite"`, plus the two additional fields. Do not improvise column names — better-auth indexes rows by the JS key and reads/writes these exact ones.

```ts
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { uuidv7 } from "uuidv7";

// --- better-auth tables ----------------------------------------------------
// Shape mirrors `deno run -A npm:auth@latest generate` for provider "sqlite".
// `nativeLanguage` / `uiLanguage` are the user.additionalFields declared in
// server/auth.ts; better-auth writes them by JS key, so both halves must agree.

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
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
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

/** Classifier output kept alongside the note, plus a generation-failure flag. */
export type NoteMetadata = {
  partOfSpeech?: string | null;
  generationFailed?: boolean;
};

export const decks = sqliteTable("decks", {
  id: text("id").primaryKey().$defaultFn(uuidv7),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
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
  },
  (t) => [index("notes_deck_id_idx").on(t.deckId)],
);

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
    back: text("back").notNull(),
    hint: text("hint"),
    suspended: integer("suspended", { mode: "boolean" }).notNull().default(false),
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

export type Deck = typeof decks.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type ReviewLog = typeof reviewLogs.$inferSelect;
export type NewCard = typeof cards.$inferInsert;
export type NewReviewLog = typeof reviewLogs.$inferInsert;
```

- [ ] **Step 3b: Write `server/db/url.ts`**

```ts
/** The SQLite URL every entry point opens. */
export const databaseUrl = Deno.env.get("DATABASE_URL") ?? "file:./data/mnimi.db";

/**
 * Guarantees the database's parent directory exists.
 *
 * Shared by the runtime client and `drizzle.config.ts`, because both open the
 * same file and SQLite will not create a missing parent — it fails with
 * SQLITE_CANTOPEN. Without this on the drizzle-kit side, `deno task db:migrate`
 * fails on a clean checkout before anything else can run.
 *
 * Synchronous so a config file can call it without top-level await.
 */
export function ensureDatabaseDir(url = databaseUrl): void {
  if (!url.startsWith("file:")) return;
  const path = url.slice("file:".length);
  const separator = path.lastIndexOf("/");
  // No separator, or one at index 0, means there is no directory component to
  // create — a bare filename, or a path already at the root.
  if (separator <= 0) return;
  Deno.mkdirSync(path.slice(0, separator), { recursive: true });
}
```

- [ ] **Step 4: Write `server/db/index.ts`**

```ts
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { databaseUrl, ensureDatabaseDir } from "./url.ts";
import * as schema from "./schema.ts";

ensureDatabaseDir();

export const client = createClient({ url: databaseUrl });

// WAL lets readers proceed while a write transaction is open, and busy_timeout
// makes a contended write wait instead of failing immediately. Both matter
// because @libsql/client hands its only connection to a transaction and opens
// a second one for everything else, so concurrent requests really do contend.
await client.execute("PRAGMA journal_mode = WAL");
await client.execute("PRAGMA busy_timeout = 5000");
await client.execute("PRAGMA foreign_keys = ON");

export const db = drizzle({ client, schema });

export type Db = typeof db;
```

- [ ] **Step 5: Write `server/db/testing.ts`**

```ts
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { pushSQLiteSchema } from "drizzle-kit/api";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "./schema.ts";

/**
 * A genuinely fresh database per test, with the schema pushed straight from
 * the Drizzle definitions — no migration files needed, so schema tests never
 * go stale against an unregenerated migration.
 *
 * A unique temp file, not an in-memory database, and both in-memory forms were
 * measured before settling here:
 *
 *   - `:memory:` gives every connection its own private database. Opening a
 *     transaction hands @libsql/client's only connection to that transaction
 *     and nulls its own, so the next query lazily opens a second connection —
 *     a brand-new empty database. Every query after the first transaction
 *     fails "no such table".
 *   - `file::memory:?cache=shared` fixes that, but shared-cache databases are
 *     keyed by name, so every call here would return the SAME database and
 *     tests would collide on unique constraints like user.email.
 *   - A distinct name via `mode=memory` would solve both, but @libsql/client
 *     rejects the `mode` query parameter.
 *
 * A temp file has none of these problems: isolated per call, and it survives
 * the transaction connection-swap because both connections open the same path.
 *
 * Callers must call `close()` — it drops the connection and removes the file.
 */
export async function createTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "mnimi-test-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle({ client, schema });
  const { apply } = await pushSQLiteSchema(schema, db);
  await apply();

  const close = () => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { db, client, close };
}
```

- [ ] **Step 6: Write `server/drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";
import { databaseUrl, ensureDatabaseDir } from "./db/url.ts";

// drizzle-kit opens the database directly, without going through db/index.ts,
// so it needs the directory guaranteed here too.
ensureDatabaseDir();

export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
});
```

- [ ] **Step 7: Write the failing test `server/db/schema.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "./testing";
import { cards, decks, notes, user } from "./schema";

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

    expect(card.suspended).toBe(false);
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

// Referenced so the import is used even if a case above is trimmed.
void sql;
```

- [ ] **Step 8: Add the server deps to the root `package.json` so Vitest resolves them**

Vitest resolves bare specifiers from `node_modules`, while Deno resolves them from `server/deno.json`. Anything a **test** imports must exist in both. Add to `dependencies`:

```json
"@libsql/client": "0.17.4",
"@orpc/client": "1.14.14",
"@orpc/server": "1.14.14",
"@orpc/tanstack-query": "1.14.14",
"better-auth": "1.6.26",
"drizzle-orm": "0.45.2",
"uuidv7": "1.2.1"
```

and to `devDependencies`:

```json
"drizzle-kit": "0.31.10"
```

`hono` and `@tanstack/ai` are only imported by non-test server modules, so they stay in `server/deno.json` alone.

- [ ] **Step 9: Point Vitest at the server**

Edit `vitest.config.ts`, replacing `supabase/functions/**/*.test.ts` with `server/**/*.test.ts`:

```ts
include: ["src/**/*.test.ts", "src/**/*.test.tsx", "server/**/*.test.ts"],
```

- [ ] **Step 10: Install and run the test**

Run: `deno install`
Run: `deno task test server/db/schema.test.ts`
Expected: PASS, 8 tests.

Unlike every later task, this one writes its implementation before its test. A schema is a declaration, not behaviour — there is no failing-then-passing cycle to run against a table that does not exist yet, only an import error. The assertions above are therefore aimed at the parts that *are* behaviour and that a plausible schema mistake would break: uuidv7 ordering, `Date` round-tripping, JSON columns, cascade deletes, the partial index reaching SQLite, and transaction survival. Every task from Task 2 on is test-first.

If a case fails, the likely causes are a missing `nodeModulesDir: "auto"` (drizzle-kit's `pushSQLiteSchema` cannot load) or a `:memory:` URL sneaking into `testing.ts`.

- [ ] **Step 11: Generate the initial migration**

Run: `cd server && deno task db:generate`
Expected: writes `server/drizzle/0000_*.sql` plus `server/drizzle/meta/`. Open the SQL and confirm it contains `CREATE INDEX \`cards_due_idx\` ON \`cards\` (\`user_id\`,\`due\`) WHERE suspended = 0`.

- [ ] **Step 12: Run the whole suite**

Run: `deno task test`
Expected: PASS — the new schema tests plus every pre-existing test. The `supabase/functions/**` tests are no longer collected; that is expected and they are deleted in Task 13.

- [ ] **Step 13: Commit**

```bash
git add server package.json vitest.config.ts deno.lock
git commit -m "feat(server): SQLite schema with Drizzle and uuidv7 keys"
```

---

### Task 2: better-auth

**Files:**
- Create: `server/auth.ts`
- Test: `server/auth.test.ts`

**Interfaces:**
- Consumes: `db` from `server/db/index.ts`, the auth tables from `server/db/schema.ts`.
- Produces: `createAuth(db, options?)`, the process-wide singleton `auth` in the separate module `server/auth.instance.ts`, and the types `Auth = ReturnType<typeof createAuth>` and `SessionUser = Auth["$Infer"]["Session"]["user"]`. Later tasks call `auth.handler(request)` and `auth.api.getSession({ headers })`, always on an `Auth` passed in as a parameter rather than the singleton.

> **Order:** write the test in Step 2 **first**, run it (Step 3) and watch it fail, then come back and write `server/auth.ts`. The implementation is printed first below only so the test's expectations are readable against it.

- [ ] **Step 1: Write `server/auth.ts` (do this after Steps 2-3)**

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { uuidv7 } from "uuidv7";
import type { Db } from "./db/index.ts";
import { account, session, user, verification } from "./db/schema.ts";

/**
 * Split from the module-level singleton so tests can build an instance over an
 * in-memory database without touching the real one.
 */
export function createAuth(db: Db, options?: { secret?: string; baseURL?: string }) {
  return betterAuth({
    baseURL: options?.baseURL ?? Deno.env.get("BETTER_AUTH_URL") ??
      "http://127.0.0.1:8787",
    secret: options?.secret ?? Deno.env.get("BETTER_AUTH_SECRET") ?? "",
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user, session, account, verification },
      // Left at its default. Enabling it makes the adapter open deferred
      // transactions, which on SQLite can fail SQLITE_BUSY_SNAPSHOT in a way
      // busy_timeout cannot retry.
      transaction: false,
    }),
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        // No `input: false` here: that flag blocks updateUser as well as
        // sign-up, so the settings screen could never save a language.
        nativeLanguage: { type: "string", required: false, defaultValue: "en" },
        uiLanguage: { type: "string", required: false, defaultValue: "en" },
      },
    },
    // Without this better-auth mints 32-char nanoid-style ids, leaving user.id
    // in a different format from every foreign key that references it.
    advanced: { database: { generateId: () => uuidv7() } },
    plugins: [bearer()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

export type SessionUser = Auth["$Infer"]["Session"]["user"];
```

Note the `import type` on `Db`: this module must not pull `db/index.ts` in at
runtime. That module opens the real database as an import side effect, so a test
importing `createAuth` would otherwise touch `data/mnimi.db` just by loading.
The singleton lives in its own module for the same reason.

- [ ] **Step 1b: Write `server/auth.instance.ts`**

```ts
import { createAuth } from "./auth.ts";
import { db } from "./db/index.ts";

/** The process-wide instance, over the real database. Only `main.ts` needs it;
 *  everything else takes an `Auth` as a parameter so it can be given a test
 *  instance instead. */
export const auth = createAuth(db);
```

- [ ] **Step 2: Write the failing test `server/auth.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./db/testing";
import { createAuth } from "./auth";

let close: Awaited<ReturnType<typeof createTestDb>>["close"];
let auth: Auth;

beforeEach(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  auth = createAuth(testDb.db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
  });
});

afterEach(() => {
  close();
});

async function signUp(email = "ada@example.com") {
  return auth.api.signUpEmail({
    body: { email, password: "correct-horse", name: "ada" },
    returnHeaders: true,
  });
}

describe("auth", () => {
  it("mints uuidv7 user ids", async () => {
    const { response } = await signUp();
    expect(response.user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("defaults nativeLanguage to en and exposes it on the session user", async () => {
    const { headers } = await signUp();
    const token = headers.get("set-auth-token");
    expect(token).toBeTruthy();

    const result = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(result?.user.nativeLanguage).toBe("en");
  });

  it("returns null rather than throwing when there is no session", async () => {
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    expect(
      await auth.api.getSession({
        headers: new Headers({ authorization: "Bearer garbage" }),
      }),
    ).toBeNull();
  });

  it("lets a signed-in user change their native language", async () => {
    const { headers } = await signUp();
    const authHeaders = new Headers({
      authorization: `Bearer ${headers.get("set-auth-token")}`,
    });

    await auth.api.updateUser({
      body: { nativeLanguage: "pl" },
      headers: authHeaders,
    });

    const result = await auth.api.getSession({ headers: authHeaders });
    expect(result?.user.nativeLanguage).toBe("pl");
  });

  it("emits the bearer token on the set-auth-token header at sign-in", async () => {
    await signUp();
    const { headers } = await auth.api.signInEmail({
      body: { email: "ada@example.com", password: "correct-horse" },
      returnHeaders: true,
    });
    expect(headers.get("set-auth-token")).toBeTruthy();
    // The plugin must also expose it, or a browser client cannot read it.
    expect(headers.get("access-control-expose-headers")).toContain(
      "set-auth-token",
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `deno task test server/auth.test.ts`
Expected: FAIL with "Cannot find module './auth'". Now write `server/auth.ts` from Step 1.

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test server/auth.test.ts`
Expected: PASS, 5 tests.

If `nativeLanguage` comes back `undefined`, the additional field is missing from `server/db/schema.ts`. If the update returns `FIELD_NOT_ALLOWED`, an `input: false` crept into the config.

- [ ] **Step 5: Commit**

```bash
git add server/auth.ts server/auth.test.ts
git commit -m "feat(server): better-auth over Drizzle with bearer sessions"
```

---

### Task 3: oRPC base procedure and the authorization middleware

**Files:**
- Create: `server/router/base.ts`
- Test: `server/router/base.test.ts`

**Interfaces:**
- Consumes: `auth` / `createAuth` from `server/auth.ts`, `Db` from `server/db/index.ts`.
- Produces:
  - `type AppContext = { db: Db; auth: Auth; reqHeaders?: Headers }`
  - `type AuthedContext = AppContext & { userId: string }`
  - `pub` — the base builder typed with `AppContext`.
  - `authed` — `pub.use(requireAuth)`; every procedure in Tasks 4-6 and 8 builds on this.
  - `notFound(message)` — helper returning an `ORPCError("NOT_FOUND")`.

- [ ] **Step 1: Write `server/router/base.ts`**

```ts
import { ORPCError, os } from "@orpc/server";
import type { Auth } from "../auth.ts";
import type { Db } from "../db/index.ts";

export type AppContext = {
  db: Db;
  auth: Auth;
  /** Supplied by oRPC's RequestHeadersPlugin. Optional: a direct server-side
   *  call has no HTTP request behind it. */
  reqHeaders?: Headers;
};

export type AuthedContext = AppContext & { userId: string };

export const pub = os.$context<AppContext>();

/**
 * The whole authorization boundary. Row Level Security used to guarantee that
 * a query could only ever touch its owner's rows; nothing does that
 * automatically any more, so this middleware establishes the one fact every
 * procedure relies on — `context.userId` is a user the auth server just
 * vouched for — and each procedure is responsible for filtering on it.
 *
 * No procedure may take a userId from its input. There is deliberately no
 * other way to obtain one.
 */
const requireAuth = pub.middleware(async ({ context, next }) => {
  const headers = context.reqHeaders;
  if (!headers) throw new ORPCError("UNAUTHORIZED");

  const session = await context.auth.api.getSession({ headers });
  if (!session) throw new ORPCError("UNAUTHORIZED");

  return next({ context: { userId: session.user.id } });
});

export const authed = pub.use(requireAuth);

/**
 * A row that does not exist and a row owned by someone else are reported
 * identically, so an id's existence never leaks.
 */
export function notFound(message: string): ORPCError<"NOT_FOUND", undefined> {
  return new ORPCError("NOT_FOUND", { message });
}
```

- [ ] **Step 2: Write the failing test `server/router/base.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORPCError } from "@orpc/server";
import { call } from "@orpc/server";
import * as z from "zod";
import { createTestDb } from "../db/testing";
import { createAuth } from "../auth";
import { authed } from "./base";

const whoami = authed
  .input(z.object({}))
  .handler(({ context }) => context.userId);

let close: Awaited<ReturnType<typeof createTestDb>>["close"];
let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let auth: Auth;

beforeEach(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  db = testDb.db;
  auth = createAuth(db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
  });
});

afterEach(() => {
  close();
});

async function signIn(email: string) {
  const { response, headers } = await auth.api.signUpEmail({
    body: { email, password: "correct-horse", name: email.split("@")[0] },
    returnHeaders: true,
  });
  return {
    userId: response.user.id,
    headers: new Headers({
      authorization: `Bearer ${headers.get("set-auth-token")}`,
    }),
  };
}

describe("authed", () => {
  it("rejects a call with no request headers at all", async () => {
    await expect(call(whoami, {}, { context: { db, auth } })).rejects
      .toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a call with no Authorization header", async () => {
    await expect(
      call(whoami, {}, { context: { db, auth, reqHeaders: new Headers() } }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a garbage token", async () => {
    await expect(
      call(whoami, {}, {
        context: {
          db,
          auth,
          reqHeaders: new Headers({ authorization: "Bearer garbage" }),
        },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("maps UNAUTHORIZED to HTTP 401", async () => {
    const error = await call(whoami, {}, { context: { db, auth } }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.status).toBe(401);
  });

  it("injects the verified userId into context", async () => {
    const { userId, headers } = await signIn("ada@example.com");
    await expect(
      call(whoami, {}, { context: { db, auth, reqHeaders: headers } }),
    ).resolves.toBe(userId);
  });

  it("gives two users different ids", async () => {
    const ada = await signIn("ada@example.com");
    const bob = await signIn("bob@example.com");
    expect(ada.userId).not.toBe(bob.userId);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `deno task test server/router/base.test.ts`
Expected: FAIL with "Cannot find module './base'".

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test server/router/base.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Extract the shared test helper**

Every router test from here on needs the same setup. Create `server/router/testing.ts`:

```ts
import { createTestDb } from "../db/testing.ts";
import { createAuth } from "../auth.ts";
import type { AppContext } from "./base.ts";

export async function createTestServer() {
  const { db, client, close } = await createTestDb();
  const auth = createAuth(db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
  });

  /** Signs a new user up and returns the context an authed call needs. */
  async function signIn(email: string): Promise<
    { userId: string; context: AppContext }
  > {
    const { response, headers } = await auth.api.signUpEmail({
      body: { email, password: "correct-horse", name: email.split("@")[0] },
      returnHeaders: true,
    });
    return {
      userId: response.user.id,
      context: {
        db,
        auth,
        reqHeaders: new Headers({
          authorization: `Bearer ${headers.get("set-auth-token")}`,
        }),
      },
    };
  }

  return { db, client, auth, signIn, close };
}

/**
 * Wraps a Drizzle instance so an insert into `table` throws once a transaction
 * is open.
 *
 * This is the ONLY way to prove a transaction actually rolls back. The obvious
 * approach — passing invalid data so the second insert violates NOT NULL —
 * does not work: oRPC validates input against the procedure's zod schema
 * BEFORE the handler runs, so the call fails with BAD_REQUEST and the
 * transaction is never opened. A test written that way passes whether or not
 * the transaction exists at all, which makes it worse than no test.
 */
export function failingInsertInto<T extends object>(
  db: T,
  table: unknown,
  message = "simulated insert failure",
): T {
  const failing = (target: object) => (arg: unknown) => {
    if (arg === table) throw new Error(message);
    return (target as { insert: (a: unknown) => unknown }).insert(arg);
  };

  return new Proxy(db, {
    get(target, prop, receiver) {
      // Intercept at the top level too, not only inside a transaction. If a
      // handler ever stopped using a transaction, a transaction-only proxy
      // would simply never fire, the call would succeed, and the test would
      // fail with "expected a rejection" — true, but it would be reporting the
      // wrong thing. Intercepting here means the note commits, the cards
      // insert still throws, and the surviving orphan is what fails the test.
      if (prop === "insert") return failing(target);
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);

      return (callback: (tx: unknown) => unknown, ...rest: unknown[]) =>
        (target as { transaction: (...a: unknown[]) => unknown }).transaction(
          (tx: object) =>
            callback(
              new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp === "insert") return failing(txTarget);
                  return Reflect.get(txTarget, txProp, txReceiver);
                },
              }),
            ),
          ...rest,
        );
    },
  }) as T;
}
```

- [ ] **Step 6: Run the whole suite**

Run: `deno task test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/router
git commit -m "feat(server): oRPC authed base procedure replacing RLS"
```

---

### Task 4: Decks router

**Files:**
- Create: `server/router/decks.ts`
- Test: `server/router/decks.test.ts`

**Interfaces:**
- Consumes: `authed` from `server/router/base.ts`, `decks` table, `createTestServer` from `server/router/testing.ts`.
- Produces: `decksRouter = { list, create }`. `list` takes no input and returns `Deck[]` oldest-first. `create` takes `{ name: string; description?: string | null }` and returns `Deck`.

- [ ] **Step 1: Write the failing test `server/router/decks.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { createTestServer } from "./testing";
import { decksRouter } from "./decks";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => {
  server.close();
});

describe("decks.create", () => {
  it("stores the deck under the session's user", async () => {
    const ada = await server.signIn("ada@example.com");

    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    expect(deck.name).toBe("German");
    expect(deck.userId).toBe(ada.userId);
    expect(deck.description).toBeNull();
  });

  it("ignores a userId smuggled into the input", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");

    const deck = await call(
      decksRouter.create,
      // The input schema has no userId, so this is stripped by validation
      // rather than trusted. Cast because it is deliberately off-contract.
      { name: "German", userId: bob.userId } as { name: string },
      { context: ada.context },
    );

    expect(deck.userId).toBe(ada.userId);
  });

  it("rejects an empty name", async () => {
    const ada = await server.signIn("ada@example.com");
    await expect(
      call(decksRouter.create, { name: "" }, { context: ada.context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("decks.list", () => {
  it("returns only the session user's decks", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");

    await call(decksRouter.create, { name: "Ada's" }, { context: ada.context });
    await call(decksRouter.create, { name: "Bob's" }, { context: bob.context });

    const adaDecks = await call(decksRouter.list, {}, { context: ada.context });
    expect(adaDecks.map((d) => d.name)).toEqual(["Ada's"]);

    const bobDecks = await call(decksRouter.list, {}, { context: bob.context });
    expect(bobDecks.map((d) => d.name)).toEqual(["Bob's"]);
  });

  it("returns decks oldest first", async () => {
    const ada = await server.signIn("ada@example.com");
    await call(decksRouter.create, { name: "First" }, { context: ada.context });
    await call(decksRouter.create, { name: "Second" }, { context: ada.context });

    const decks = await call(decksRouter.list, {}, { context: ada.context });
    expect(decks.map((d) => d.name)).toEqual(["First", "Second"]);
  });

  it("returns createdAt as a Date", async () => {
    const ada = await server.signIn("ada@example.com");
    await call(decksRouter.create, { name: "German" }, { context: ada.context });

    const [deck] = await call(decksRouter.list, {}, { context: ada.context });
    expect(deck.createdAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/router/decks.test.ts`
Expected: FAIL with "Cannot find module './decks'".

- [ ] **Step 3: Write `server/router/decks.ts`**

```ts
import * as z from "zod";
import { asc, eq } from "drizzle-orm";
import { authed } from "./base.ts";
import { decks } from "../db/schema.ts";

const list = authed
  .input(z.object({}))
  .handler(async ({ context }) => {
    return await context.db
      .select()
      .from(decks)
      .where(eq(decks.userId, context.userId))
      .orderBy(asc(decks.createdAt));
  });

const create = authed
  .input(
    z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).nullish(),
    }),
  )
  .handler(async ({ input, context }) => {
    const [deck] = await context.db
      .insert(decks)
      .values({
        userId: context.userId,
        name: input.name,
        description: input.description ?? null,
      })
      .returning();
    return deck;
  });

export const decksRouter = { list, create };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test server/router/decks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/router/decks.ts server/router/decks.test.ts
git commit -m "feat(server): decks router scoped to the session user"
```

---

### Task 5: Notes router

**Files:**
- Create: `server/router/notes.ts`
- Test: `server/router/notes.test.ts`

**Interfaces:**
- Consumes: `authed`, `notFound`, the `decks` / `notes` / `cards` tables.
- Produces: `notesRouter = { listByDeck, save }`.
  - `listByDeck({ deckId: string }) → Note[]`, newest first.
  - `save({ deckId, sourceText, classification: { domain, language, partOfSpeech }, cards: Array<{ aspect, front, back, hint }>, imagePrompt, generationFailed? }) → Note`. Inserts the note and every card in one transaction.
  - Exported schema `saveNoteInput` so the client can share the shape.

- [ ] **Step 1: Write the failing test `server/router/notes.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer, failingInsertInto } from "./testing";
import { decksRouter } from "./decks";
import { notesRouter } from "./notes";
import { cards, notes } from "../db/schema";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => {
  server.close();
});

const CLASSIFICATION = {
  domain: "language",
  language: "de",
  partOfSpeech: "noun",
};

const CARDS = [
  { aspect: "meaning", front: "die Banane", back: "banana", hint: null },
  { aspect: "gender", front: "___ Banane", back: "die", hint: null },
];

describe("notes.save", () => {
  it("writes the note and all its cards", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    const note = await call(
      notesRouter.save,
      {
        deckId: deck.id,
        sourceText: "die Banane",
        classification: CLASSIFICATION,
        cards: CARDS,
        imagePrompt: "a banana",
      },
      { context: ada.context },
    );

    expect(note.userId).toBe(ada.userId);
    expect(note.sourceText).toBe("die Banane");
    expect(note.metadata).toEqual({ partOfSpeech: "noun" });

    const saved = await server.db
      .select()
      .from(cards)
      .where(eq(cards.noteId, note.id));
    expect(saved).toHaveLength(2);
    expect(saved.every((c) => c.userId === ada.userId)).toBe(true);
    expect(saved.every((c) => c.due instanceof Date)).toBe(true);
    // New cards start in the FSRS "new" state.
    expect(saved.every((c) => c.reps === 0 && c.state === 0)).toBe(true);
  });

  it("records generationFailed in the metadata when set", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    const note = await call(
      notesRouter.save,
      {
        deckId: deck.id,
        sourceText: "x",
        classification: { domain: "concept", language: null, partOfSpeech: null },
        cards: [{ aspect: "meaning", front: "f", back: "b", hint: null }],
        imagePrompt: null,
        generationFailed: true,
      },
      { context: ada.context },
    );

    expect(note.metadata).toEqual({ partOfSpeech: null, generationFailed: true });
  });

  it("refuses to save into another user's deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const bobDeck = await call(
      decksRouter.create,
      { name: "Bob's" },
      { context: bob.context },
    );

    await expect(
      call(
        notesRouter.save,
        {
          deckId: bobDeck.id,
          sourceText: "die Banane",
          classification: CLASSIFICATION,
          cards: CARDS,
          imagePrompt: null,
        },
        { context: ada.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await server.db.select().from(notes)).toHaveLength(0);
  });

  it("leaves no orphaned note when the cards insert fails", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    // The failure must happen INSIDE the transaction, after the note row is
    // already inserted. Invalid input cannot produce that: oRPC validates
    // against saveNoteInput before the handler runs, so the call would fail
    // with BAD_REQUEST and the transaction would never open — passing whether
    // or not `save` is transactional at all.
    const context = {
      ...ada.context,
      db: failingInsertInto(server.db, cards),
    };

    await expect(
      call(
        notesRouter.save,
        {
          deckId: deck.id,
          sourceText: "die Banane",
          classification: CLASSIFICATION,
          cards: CARDS,
          imagePrompt: null,
        },
        { context },
      ),
    ).rejects.toThrow("simulated insert failure");

    // The note insert succeeded before the cards insert threw. Without the
    // transaction it would still be here.
    expect(await server.db.select().from(notes)).toHaveLength(0);
    expect(await server.db.select().from(cards)).toHaveLength(0);
  });

  it("keeps a note out of another user's view even if its userId is wrong", async () => {
    // listByDeck filters on notes.userId as well as deck ownership. Under the
    // current write path a note's deckId already implies its owner, so that
    // clause is defence in depth — this pins it so a future refactor cannot
    // quietly drop it.
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    await server.db.insert(notes).values({
      userId: bob.userId,
      deckId: deck.id,
      sourceText: "bob's row in ada's deck",
      domain: "concept",
      metadata: {},
    });

    const list = await call(
      notesRouter.listByDeck,
      { deckId: deck.id },
      { context: ada.context },
    );
    expect(list).toHaveLength(0);
  });

  it("rejects an empty card list", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    await expect(
      call(
        notesRouter.save,
        {
          deckId: deck.id,
          sourceText: "x",
          classification: CLASSIFICATION,
          cards: [],
          imagePrompt: null,
        },
        { context: ada.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("notes.listByDeck", () => {
  it("returns the deck's notes newest first", async () => {
    const ada = await server.signIn("ada@example.com");
    const deck = await call(
      decksRouter.create,
      { name: "German" },
      { context: ada.context },
    );

    for (const text of ["first", "second"]) {
      await call(
        notesRouter.save,
        {
          deckId: deck.id,
          sourceText: text,
          classification: CLASSIFICATION,
          cards: CARDS,
          imagePrompt: null,
        },
        { context: ada.context },
      );
    }

    const list = await call(
      notesRouter.listByDeck,
      { deckId: deck.id },
      { context: ada.context },
    );
    expect(list.map((n) => n.sourceText)).toEqual(["second", "first"]);
  });

  it("refuses another user's deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const bobDeck = await call(
      decksRouter.create,
      { name: "Bob's" },
      { context: bob.context },
    );

    await expect(
      call(
        notesRouter.listByDeck,
        { deckId: bobDeck.id },
        { context: ada.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/router/notes.test.ts`
Expected: FAIL with "Cannot find module './notes'".

- [ ] **Step 3: Write `server/router/notes.ts`**

```ts
import * as z from "zod";
import { and, desc, eq } from "drizzle-orm";
import { authed, notFound } from "./base.ts";
import { cards, decks, notes } from "../db/schema.ts";
import type { Db } from "../db/index.ts";

/** Throws unless this deck exists and belongs to this user. */
async function assertOwnsDeck(db: Db, userId: string, deckId: string) {
  const [deck] = await db
    .select({ id: decks.id })
    .from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.userId, userId)))
    .limit(1);
  if (!deck) throw notFound("Deck not found");
}

export const saveNoteInput = z.object({
  deckId: z.uuidv7(),
  sourceText: z.string().min(1).max(200),
  classification: z.object({
    domain: z.string().min(1),
    language: z.string().nullable(),
    partOfSpeech: z.string().nullable(),
  }),
  cards: z
    .array(
      z.object({
        aspect: z.string().min(1),
        front: z.string().min(1),
        back: z.string().min(1),
        hint: z.string().nullable(),
      }),
    )
    .min(1),
  imagePrompt: z.string().nullable(),
  generationFailed: z.boolean().optional(),
});

const listByDeck = authed
  .input(z.object({ deckId: z.uuidv7() }))
  .handler(async ({ input, context }) => {
    await assertOwnsDeck(context.db, context.userId, input.deckId);

    return await context.db
      .select()
      .from(notes)
      .where(
        and(eq(notes.deckId, input.deckId), eq(notes.userId, context.userId)),
      )
      .orderBy(desc(notes.createdAt));
  });

const save = authed
  .input(saveNoteInput)
  .handler(async ({ input, context }) => {
    await assertOwnsDeck(context.db, context.userId, input.deckId);

    const now = new Date();

    // One transaction, so a failing card insert can never leave a committed
    // note behind. Only `tx` may be used in here — the outer `db` handle is a
    // different connection and its writes would deadlock against this one.
    return await context.db.transaction(async (tx) => {
      const [note] = await tx
        .insert(notes)
        .values({
          userId: context.userId,
          deckId: input.deckId,
          sourceText: input.sourceText,
          domain: input.classification.domain,
          language: input.classification.language,
          metadata: {
            partOfSpeech: input.classification.partOfSpeech,
            ...(input.generationFailed ? { generationFailed: true } : {}),
          },
        })
        .returning();

      await tx.insert(cards).values(
        input.cards.map((card) => ({
          noteId: note.id,
          userId: context.userId,
          aspect: card.aspect,
          front: card.front,
          back: card.back,
          hint: card.hint,
          due: now,
        })),
      );

      return note;
    });
  });

export const notesRouter = { listByDeck, save };
```

Note on FSRS defaults: a brand-new card's scheduling state is all zeros except `due`, and the schema already declares those defaults, so the insert only has to supply `due`. This is what `newCardColumns()` used to compute client-side; the client no longer sends it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test server/router/notes.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/router/notes.ts server/router/notes.test.ts
git commit -m "feat(server): notes router with transactional save"
```

---

### Task 6: Cards router

**Files:**
- Create: `server/router/cards.ts`
- Test: `server/router/cards.test.ts`

**Interfaces:**
- Consumes: `authed`, `notFound`, the `cards` / `notes` / `reviewLogs` tables.
- Produces: `cardsRouter = { due, dueCount, grade }`.
  - `due({ deckId?: string | null }) → Card[]` — unsuspended, due now or earlier, soonest first, limit 100.
  - `dueCount({ deckId?: string | null }) → number` — the same predicate, uncapped.
  - `grade({ cardId, card: FsrsColumns, log: ReviewLogInput }) → void` — one transaction.
  - Exported schemas `fsrsColumnsSchema` and `reviewLogInputSchema`.

- [ ] **Step 1: Write the failing test `server/router/cards.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer, failingInsertInto } from "./testing";
import { decksRouter } from "./decks";
import { notesRouter } from "./notes";
import { cardsRouter } from "./cards";
import { cards, reviewLogs } from "../db/schema";
import type { AppContext } from "./base";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => {
  server.close();
});

const CLASSIFICATION = { domain: "concept", language: null, partOfSpeech: null };

/** A deck with `count` cards, all due now. */
async function seed(context: AppContext, count = 1, deckName = "Deck") {
  const deck = await call(decksRouter.create, { name: deckName }, { context });
  await call(
    notesRouter.save,
    {
      deckId: deck.id,
      sourceText: "source",
      classification: CLASSIFICATION,
      cards: Array.from({ length: count }, (_, i) => ({
        aspect: `aspect-${i}`,
        front: `front-${i}`,
        back: `back-${i}`,
        hint: null,
      })),
      imagePrompt: null,
    },
    { context },
  );
  return deck;
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
  it("returns only the session user's due cards", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    await seed(ada.context, 2);
    await seed(bob.context, 3);

    const due = await call(cardsRouter.due, {}, { context: ada.context });
    expect(due).toHaveLength(2);
    expect(due.every((c) => c.userId === ada.userId)).toBe(true);
  });

  it("filters by deck without widening past the session user", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaDeck = await seed(ada.context, 2, "Ada's");
    const bobDeck = await seed(bob.context, 3, "Bob's");

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
    await seed(ada.context, 3);
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
    await seed(ada.context, 120);

    const due = await call(cardsRouter.due, {}, { context: ada.context });
    expect(due).toHaveLength(100);
  });
});

describe("cards.dueCount", () => {
  it("counts past the 100-card queue cap", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.context, 120);

    const count = await call(cardsRouter.dueCount, {}, { context: ada.context });
    expect(count).toBe(120);
  });

  it("counts zero for a user with nothing due", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    await seed(bob.context, 5);

    expect(await call(cardsRouter.dueCount, {}, { context: ada.context })).toBe(0);
  });
});

describe("cards.grade", () => {
  it("updates the card and writes a review log together", async () => {
    const ada = await server.signIn("ada@example.com");
    await seed(ada.context, 1);
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
    await seed(bob.context, 1);
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
    await seed(ada.context, 1);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/router/cards.test.ts`
Expected: FAIL with "Cannot find module './cards'".

- [ ] **Step 3: Write `server/router/cards.ts`**

```ts
import * as z from "zod";
import { and, asc, count, eq, lte } from "drizzle-orm";
import { authed, notFound } from "./base.ts";
import { cards, notes, reviewLogs } from "../db/schema.ts";

/** The scheduling state ts-fsrs produces for a graded card. */
export const fsrsColumnsSchema = z.object({
  due: z.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsedDays: z.number().int(),
  scheduledDays: z.number().int(),
  learningSteps: z.number().int(),
  reps: z.number().int(),
  lapses: z.number().int(),
  state: z.number().int().min(0).max(3),
  lastReview: z.date().nullable(),
});

export const reviewLogInputSchema = z.object({
  rating: z.number().int().min(1).max(4),
  state: z.number().int().min(0).max(3),
  due: z.date(),
  stability: z.number(),
  difficulty: z.number(),
  elapsedDays: z.number().int(),
  lastElapsedDays: z.number().int(),
  scheduledDays: z.number().int(),
  learningSteps: z.number().int(),
  review: z.date(),
});

const dueFilterInput = z.object({ deckId: z.uuidv7().nullish() });

const due = authed
  .input(dueFilterInput)
  .handler(async ({ input, context }) => {
    const rows = await context.db
      .select({ card: cards })
      .from(cards)
      .innerJoin(notes, eq(cards.noteId, notes.id))
      .where(
        and(
          eq(cards.userId, context.userId),
          eq(cards.suspended, false),
          lte(cards.due, new Date()),
          input.deckId ? eq(notes.deckId, input.deckId) : undefined,
        ),
      )
      .orderBy(asc(cards.due))
      // 100 is a review session's worth. dueCount below deliberately does not
      // share this cap: a "Today" counter built on it would tell a user with
      // 120 cards due that only 100 are.
      .limit(100);

    return rows.map((row) => row.card);
  });

const dueCount = authed
  .input(dueFilterInput)
  .handler(async ({ input, context }) => {
    const [row] = await context.db
      .select({ value: count() })
      .from(cards)
      .innerJoin(notes, eq(cards.noteId, notes.id))
      .where(
        and(
          eq(cards.userId, context.userId),
          eq(cards.suspended, false),
          lte(cards.due, new Date()),
          input.deckId ? eq(notes.deckId, input.deckId) : undefined,
        ),
      );

    return row?.value ?? 0;
  });

const grade = authed
  .input(
    z.object({
      cardId: z.uuidv7(),
      card: fsrsColumnsSchema,
      log: reviewLogInputSchema,
    }),
  )
  .handler(async ({ input, context }) => {
    // Ownership first, outside the transaction, so a wrong-owner id costs a
    // cheap lookup rather than an opened write transaction.
    const [owned] = await context.db
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.id, input.cardId), eq(cards.userId, context.userId)))
      .limit(1);
    if (!owned) throw notFound("Card not found");

    // The card update and its log are one unit: a card whose state advanced
    // without a log would silently lose review history.
    await context.db.transaction(async (tx) => {
      await tx
        .update(cards)
        .set(input.card)
        .where(
          and(eq(cards.id, input.cardId), eq(cards.userId, context.userId)),
        );

      await tx.insert(reviewLogs).values({
        ...input.log,
        cardId: input.cardId,
        userId: context.userId,
      });
    });
  });

export const cardsRouter = { due, dueCount, grade };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test server/router/cards.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/router/cards.ts server/router/cards.test.ts
git commit -m "feat(server): cards router with transactional grading"
```

---

### Task 7: Port the AI modules

**Files:**
- Create: `server/ai/generate.ts` (moved from `supabase/functions/_shared/generate.ts`, unchanged)
- Create: `server/ai/generate.test.ts` (moved, unchanged)
- Create: `server/ai/rule-packs.ts` + `server/ai/rule-packs.test.ts` (moved, unchanged)
- Create: `server/ai/schemas.ts` + `server/ai/schemas.test.ts` (moved, unchanged)
- Create: `server/ai/sse.ts` + `server/ai/sse.test.ts` (moved, CORS headers removed)
- Create: `server/ai/openrouter.ts` (moved, unchanged)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `eventStreamResponse(producer)`, `encodeEvent(payload)`, `parseWithRetry`, `streamWithRetry`, `projectCards`, `buildSystemPrompt`, `selectRulePacks`, `classificationSchema`, `generatedNoteSchema`, `textAdapter`, `imageAdapter`, `classifyModel`, `generateModel`, `imageModel`, and the types `Classification`, `GeneratedNote`, `PartialCard`.

- [ ] **Step 1: Copy the modules across, preserving history where possible**

```bash
mkdir -p server/ai
git mv supabase/functions/_shared/generate.ts server/ai/generate.ts
git mv supabase/functions/_shared/generate.test.ts server/ai/generate.test.ts
git mv supabase/functions/_shared/rule-packs.ts server/ai/rule-packs.ts
git mv supabase/functions/_shared/rule-packs.test.ts server/ai/rule-packs.test.ts
git mv supabase/functions/_shared/schemas.ts server/ai/schemas.ts
git mv supabase/functions/_shared/schemas.test.ts server/ai/schemas.test.ts
git mv supabase/functions/_shared/sse.ts server/ai/sse.ts
git mv supabase/functions/_shared/sse.test.ts server/ai/sse.test.ts
git mv supabase/functions/_shared/openrouter.ts server/ai/openrouter.ts
```

- [ ] **Step 2: Strip the CORS coupling out of `server/ai/sse.ts`**

CORS is now Hono middleware, not something each response assembles for itself. Delete the `import { corsHeaders } from "./cors.ts";` line and change the returned headers:

```ts
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
```

Leave the rest of the file — `encodeEvent`, the `ReadableStream` producer wrapper and its comments — exactly as it is.

- [ ] **Step 2b: Type the model ids in `server/ai/openrouter.ts`**

The adapters accept a literal union of ~330 model ids, but these values come from the environment and are `string`, so `deno check` fails with TS2345 on both. The values are genuinely not knowable at compile time — an operator may set any model — so derive the parameter type from the adapter rather than duplicating the union or reaching for `any`:

```ts
type TextModel = Parameters<typeof openRouterText>[0];
type ImageModel = Parameters<typeof openRouterImage>[0];

export const textAdapter = (model: string) =>
  openRouterText(model as TextModel, { apiKey: apiKey() });

export const imageAdapter = (model: string) =>
  openRouterImage(model as ImageModel, { apiKey: apiKey() });
```

An unknown id is an OpenRouter error at request time, which the generation route already reports as a terminal `error` event.

- [ ] **Step 3: Fix the comment in `server/ai/schemas.ts` that references Deno modules**

The `PartialCard` doc comment says the client "cannot load Deno modules". Update that sentence to say the two meet over the wire because the browser bundle does not import server modules. The type itself does not change.

- [ ] **Step 4: Run the ported tests**

Run: `deno task test server/ai`
Expected: PASS. These tests were green before the move and import nothing that changed except `sse.ts`'s headers, which its test does not assert on. If `sse.test.ts` does assert CORS headers, delete only those assertions — the header is genuinely gone.

- [ ] **Step 5: Run the whole suite**

Run: `deno task test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A server/ai supabase
git commit -m "refactor(server): move AI modules out of supabase/functions"
```

---

### Task 8: Image generation procedure

**Files:**
- Create: `server/router/ai.ts`
- Test: `server/router/ai.test.ts`

**Interfaces:**
- Consumes: `authed`, `notFound`, the `notes` table, `imageAdapter` / `imageModel` from `server/ai/openrouter.ts`.
- Produces: `aiRouter = { generateImage }` — `{ noteId, prompt } → { imagePath: string }`. Also `writeImage(userId, noteId, bytes): Promise<string>` and the injectable seam `generateImageBytes`, so the test never calls a model.

- [ ] **Step 1: Write the failing test `server/router/ai.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer } from "./testing";
import { decksRouter } from "./decks";
import { notesRouter } from "./notes";
import { aiRouter } from "./ai";
import { notes } from "../db/schema";

let server: Awaited<ReturnType<typeof createTestServer>>;
const written: Array<{ userId: string; noteId: string; bytes: Uint8Array }> = [];

beforeEach(async () => {
  server = await createTestServer();
  written.length = 0;
});

afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

/** Context plus the two seams that would otherwise hit a model and the disk. */
function imageContext(base: Awaited<ReturnType<typeof server.signIn>>["context"]) {
  return {
    ...base,
    generateImageBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    writeImage: vi.fn(async (userId: string, noteId: string, bytes: Uint8Array) => {
      written.push({ userId, noteId, bytes });
      return `${userId}/${noteId}.png`;
    }),
  };
}

async function seedNote(context: Awaited<ReturnType<typeof server.signIn>>["context"]) {
  const deck = await call(decksRouter.create, { name: "Deck" }, { context });
  return await call(
    notesRouter.save,
    {
      deckId: deck.id,
      sourceText: "die Banane",
      classification: { domain: "language", language: "de", partOfSpeech: "noun" },
      cards: [{ aspect: "meaning", front: "f", back: "b", hint: null }],
      imagePrompt: "a banana",
    },
    { context },
  );
}

describe("ai.generateImage", () => {
  it("writes the image under the owner and records the path", async () => {
    const ada = await server.signIn("ada@example.com");
    const note = await seedNote(ada.context);
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
    const bobNote = await seedNote(bob.context);
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
    const note = await seedNote(ada.context);

    await expect(
      call(
        aiRouter.generateImage,
        { noteId: note.id, prompt: "x".repeat(1001) },
        { context: imageContext(ada.context) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/router/ai.test.ts`
Expected: FAIL with "Cannot find module './ai'".

- [ ] **Step 3: Extend the context type in `server/router/base.ts`**

Add the two seams to `AppContext` so the handler can be tested without a model or a filesystem:

```ts
export type AppContext = {
  db: Db;
  auth: Auth;
  reqHeaders?: Headers;
  /** Overridden in tests so no request ever reaches a model. */
  generateImageBytes?: (prompt: string) => Promise<Uint8Array>;
  /** Overridden in tests so no bytes ever reach the disk. */
  writeImage?: (userId: string, noteId: string, bytes: Uint8Array) => Promise<string>;
};
```

- [ ] **Step 4: Write `server/router/ai.ts`**

```ts
import * as z from "zod";
import { and, eq } from "drizzle-orm";
import { generateImage } from "@tanstack/ai";
import { authed, notFound } from "./base.ts";
import { notes } from "../db/schema.ts";
import { imageAdapter, imageModel } from "../ai/openrouter.ts";

const IMAGES_DIR = Deno.env.get("IMAGES_DIR") ?? "./data/images";

/** Writes the PNG under `<userId>/<noteId>.png` and returns that relative path.
 *  The first path segment is the owner, mirroring the layout the old storage
 *  bucket policy checked.
 *
 *  Both segments are server-generated UUIDv7 strings, never client-supplied
 *  text, so no path traversal is reachable here. */
export async function writeImage(
  userId: string,
  noteId: string,
  bytes: Uint8Array,
): Promise<string> {
  await Deno.mkdir(`${IMAGES_DIR}/${userId}`, { recursive: true });
  await Deno.writeFile(`${IMAGES_DIR}/${userId}/${noteId}.png`, bytes);
  return `${userId}/${noteId}.png`;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function generateImageBytes(prompt: string): Promise<Uint8Array> {
  const result = await generateImage({
    adapter: imageAdapter(imageModel()),
    prompt:
      `${prompt}. Photographic, plain background, no text, no letters, no words anywhere in the image.`,
    size: "1024x1024",
  });

  const image = result.images[0];
  if (!image) throw new Error("Model returned no image");

  return image.b64Json
    ? decodeBase64(image.b64Json)
    : new Uint8Array(await (await fetch(image.url!)).arrayBuffer());
}

const generateImageProcedure = authed
  .input(
    z.object({
      noteId: z.uuidv7(),
      prompt: z.string().min(1).max(1000),
    }),
  )
  .handler(async ({ input, context }) => {
    // Existence and ownership BEFORE spending money. Without this, any
    // authenticated caller could POST random ids in a loop and bill a full
    // image generation for each one before the 404.
    const [note] = await context.db
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(eq(notes.id, input.noteId), eq(notes.userId, context.userId)),
      )
      .limit(1);
    if (!note) throw notFound("Note not found");

    const bytes = await (context.generateImageBytes ?? generateImageBytes)(
      input.prompt,
    );
    const imagePath = await (context.writeImage ?? writeImage)(
      context.userId,
      input.noteId,
      bytes,
    );

    await context.db
      .update(notes)
      .set({ imagePath })
      .where(
        and(eq(notes.id, input.noteId), eq(notes.userId, context.userId)),
      );

    return { imagePath };
  });

export const aiRouter = { generateImage: generateImageProcedure };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `deno task test server/router/ai.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add server/router/ai.ts server/router/ai.test.ts server/router/base.ts
git commit -m "feat(server): image generation writing to disk"
```

---

### Task 9: Hono application

**Files:**
- Create: `server/router/index.ts`
- Create: `server/routes/generate-note.ts`
- Create: `server/app.ts`
- Create: `server/main.ts`
- Create: `server/.env.example`
- Test: `server/app.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-8.
- Produces: `router` (the oRPC root, `{ decks, notes, cards, ai }`), `export type AppRouter = typeof router` — the type the client imports — and `createApp({ db, auth })` returning a Hono app. `main.ts` serves it.

- [ ] **Step 1: Write `server/router/index.ts`**

```ts
import { decksRouter } from "./decks.ts";
import { notesRouter } from "./notes.ts";
import { cardsRouter } from "./cards.ts";
import { aiRouter } from "./ai.ts";

export const router = {
  decks: decksRouter,
  notes: notesRouter,
  cards: cardsRouter,
  ai: aiRouter,
};

/** The single type the client consumes. */
export type AppRouter = typeof router;
```

- [ ] **Step 2: Write `server/routes/generate-note.ts`**

This is the old `supabase/functions/generate-note/index.ts` with its Supabase auth swapped for better-auth and its CORS preflight handled by Hono. The two-pass generation logic and every comment in it are unchanged.

```ts
import { chat, parsePartialJSON } from "@tanstack/ai";
import * as z from "zod";
import type { Context } from "hono";
import { eventStreamResponse } from "../ai/sse.ts";
import { classifyModel, generateModel, textAdapter } from "../ai/openrouter.ts";
import { buildSystemPrompt } from "../ai/rule-packs.ts";
import { classificationSchema, generatedNoteSchema } from "../ai/schemas.ts";
import { parseWithRetry, projectCards, streamWithRetry } from "../ai/generate.ts";
import type { Auth } from "../auth.ts";

const requestSchema = z.object({
  text: z.string().min(1).max(200),
  nativeLanguage: z.string().min(2).max(10),
});

const CLASSIFY_PROMPT = `
You classify a single thing a learner wants to remember.

Decide whether it is a language-learning item — a word, phrase or grammatical
form in a language the learner is studying — or something else entirely, such
as a person, a scientific concept, a historical event or a quotation.

Set domain to "language" only for language-learning items. Otherwise use a
short lowercase label describing what it is: concept, person, place, event,
phrase, formula.

For language items set language to the target language code and partOfSpeech
to the word class. For everything else leave both null.
`.trim();

export function generateNoteRoute(auth: Auth) {
  return async (c: Context) => {
    // Auth and request validation run before a single byte is written. Once
    // the event stream opens the status code is committed, so everything after
    // this point has to report failure as an `error` event instead.
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    let body: z.infer<typeof requestSchema>;
    try {
      body = requestSchema.parse(await c.req.json());
    } catch (error) {
      // Malformed JSON throws SyntaxError, well-formed but wrong-shaped throws
      // ZodError. Both are the caller's fault, so both are 400.
      return c.json(
        { error: error instanceof Error ? error.message : "Invalid request body" },
        400,
      );
    }

    return eventStreamResponse(async (send) => {
      try {
        // Pass 1 — classify, which selects the rule packs. Not streamed: it is
        // cheap, and pass 2's system prompt cannot be built until it lands.
        const classification = await parseWithRetry(
          classificationSchema,
          (feedback) =>
            chat({
              adapter: textAdapter(classifyModel()),
              systemPrompts: [CLASSIFY_PROMPT],
              messages: [
                {
                  role: "user",
                  content: feedback ? `${body.text}\n\n${feedback}` : body.text,
                },
              ],
              outputSchema: classificationSchema,
              stream: false,
            }),
        );
        send({ type: "classified", classification });

        // Pass 2 — generate under base + any domain packs, streamed.
        let lastSnapshot = "";
        const generation = await streamWithRetry(
          generatedNoteSchema,
          async (feedback, onDelta) => {
            const stream = chat({
              adapter: textAdapter(generateModel()),
              systemPrompts: [buildSystemPrompt(classification)],
              messages: [
                {
                  role: "user",
                  content: [
                    `Create flashcards for: ${body.text}`,
                    `The learner's native language is ${body.nativeLanguage}.`,
                    `Write the learner-facing side in their native language where that makes sense.`,
                    `If a picture would help anchor this in memory, supply an imagePrompt describing the thing itself, with no text in the image. If a picture would not help, set imagePrompt to null.`,
                    feedback ?? "",
                  ]
                    .filter(Boolean)
                    .join("\n"),
                },
              ],
              outputSchema: generatedNoteSchema,
              stream: true,
            });

            let object: unknown;
            for await (const chunk of stream) {
              if (chunk.type === "TEXT_MESSAGE_CONTENT") onDelta(chunk.delta);
              if (
                chunk.type === "CUSTOM" &&
                chunk.name === "structured-output.complete"
              ) {
                // The streaming path does not validate against outputSchema —
                // partial payloads are partial by design — so this object is
                // still unvalidated. streamWithRetry validates it.
                object = (chunk.value as { object?: unknown }).object;
              }
              if (chunk.type === "RUN_ERROR") {
                // The adapter yields RUN_ERROR and returns normally for every
                // provider failure — it never throws. Left unhandled, `object`
                // stays undefined, streamWithRetry treats that as a validation
                // failure and burns a pointless retry against a provider that
                // just failed. Throwing skips that retry: it propagates to the
                // outer catch, which emits the terminal `error` event.
                throw new Error(chunk.message);
              }
            }
            return object;
          },
          {
            onPartial: (raw) => {
              const cards = projectCards(parsePartialJSON(raw));
              // Most deltas land inside a string that is already on screen and
              // change nothing structural, so only ship real changes.
              const snapshot = JSON.stringify(cards);
              if (snapshot === lastSnapshot) return;
              lastSnapshot = snapshot;
              send({ type: "cards", cards });
            },
            onRetry: () => {
              lastSnapshot = "";
              send({ type: "retry" });
            },
          },
        );

        send({ type: "done", classification, generation });
      } catch (error) {
        // The full detail stays server-side in the log. The client only ever
        // gets a short, generic message — it renders verbatim in a destructive
        // alert, so anything more specific would leak internals to the screen.
        console.error("generate-note failed", error);
        send({ type: "error", message: "Generation failed" });
      }
    });
  };
}
```

- [ ] **Step 3: Write `server/app.ts`**

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { router } from "./router/index.ts";
import { generateNoteRoute } from "./routes/generate-note.ts";
import type { Auth } from "./auth.ts";
import type { Db } from "./db/index.ts";

export function createApp(
  { db, auth, corsOrigin }: {
    db: Db;
    auth: Auth;
    corsOrigin?: string;
  },
) {
  const app = new Hono();

  // Must be registered before the routes it protects. `set-auth-token` has to
  // be exposed or the browser hides the header the bearer plugin sends back
  // and sign-in appears to succeed while leaving the client with no token.
  app.use(
    "*",
    cors({
      origin: corsOrigin ?? Deno.env.get("CORS_ORIGIN") ?? "http://localhost:1420",
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["POST", "GET", "OPTIONS"],
      exposeHeaders: ["set-auth-token"],
      credentials: true,
    }),
  );

  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.post("/api/generate-note", generateNoteRoute(auth));

  // RequestHeadersPlugin is what puts `reqHeaders` in procedure context, which
  // is the only way the authed middleware can see the bearer token.
  const handler = new RPCHandler(router, {
    plugins: [new RequestHeadersPlugin()],
    interceptors: [onError((error) => console.error(error))],
  });

  app.use("/rpc/*", async (c, next) => {
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: "/rpc",
      context: { db, auth },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  return app;
}
```

- [ ] **Step 4: Write `server/main.ts`**

```ts
import { createApp } from "./app.ts";
import { auth } from "./auth.instance.ts";
import { db } from "./db/index.ts";

const port = Number(Deno.env.get("PORT") ?? 8787);
const app = createApp({ db, auth });

Deno.serve({ port }, app.fetch);
```

- [ ] **Step 5: Write `server/.env.example`**

```
DATABASE_URL=file:./data/mnimi.db
BETTER_AUTH_SECRET=change-me-to-at-least-32-random-characters
BETTER_AUTH_URL=http://127.0.0.1:8787
CORS_ORIGIN=http://localhost:1420
IMAGES_DIR=./data/images
PORT=8787

OPENROUTER_API_KEY=sk-or-...
CLASSIFY_MODEL=google/gemini-2.5-flash
GENERATE_MODEL=anthropic/claude-sonnet-4.5
IMAGE_MODEL=google/gemini-2.5-flash-image
```

- [ ] **Step 6: Write the failing test `server/app.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./db/testing";
import { createAuth } from "./auth";
import { createApp } from "./app";

let close: Awaited<ReturnType<typeof createTestDb>>["close"];
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  const auth = createAuth(testDb.db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
  });
  app = createApp({ db: testDb.db, auth, corsOrigin: "http://localhost:1420" });
});

afterEach(() => {
  close();
});

async function signUp() {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "ada@example.com",
      password: "correct-horse",
      name: "ada",
    }),
  });
  return response;
}

describe("app", () => {
  it("serves the better-auth handler", async () => {
    const response = await signUp();
    expect(response.status).toBe(200);
  });

  it("exposes set-auth-token so a browser client can read it", async () => {
    const response = await signUp();
    expect(response.headers.get("set-auth-token")).toBeTruthy();
    expect(
      response.headers.get("access-control-expose-headers"),
    ).toContain("set-auth-token");
  });

  it("answers an unauthenticated RPC call with 401", async () => {
    const response = await app.request("/rpc/decks/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: {} }),
    });
    expect(response.status).toBe(401);
  });

  it("answers an authenticated RPC call", async () => {
    const token = (await signUp()).headers.get("set-auth-token");

    const created = await app.request("/rpc/decks/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ json: { name: "German" } }),
    });
    expect(created.status).toBe(200);

    const listed = await app.request("/rpc/decks/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ json: {} }),
    });
    const body = await listed.json();
    expect(JSON.stringify(body)).toContain("German");
  });

  it("rejects an unauthenticated generate-note with 401 and CORS headers", async () => {
    const response = await app.request("/api/generate-note", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:1420",
      },
      body: JSON.stringify({ text: "die Banane", nativeLanguage: "en" }),
    });

    expect(response.status).toBe(401);
    // Without the CORS header the browser blocks the 401 outright and the
    // client sees an indistinguishable network failure instead of "expired".
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:1420",
    );
  });

  it("rejects a malformed generate-note body with 400, not 500", async () => {
    const token = (await signUp()).headers.get("set-auth-token");

    const response = await app.request("/api/generate-note", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: "not json at all",
    });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails, then passes**

Run: `deno task test server/app.test.ts`
Expected: FAIL first (no `./app`), then PASS with 6 tests once Steps 1-5 are in.

If the RPC path 404s, check the `prefix` matches the Hono route (`/rpc`). If the authed call 401s with a valid token, `RequestHeadersPlugin` is missing from the handler's plugins.

- [ ] **Step 8: Boot the server once by hand**

```bash
cd server
cp .env.example .env   # then set BETTER_AUTH_SECRET and OPENROUTER_API_KEY
deno task db:migrate
deno task dev
```

Expected: listening on 8787. `curl http://127.0.0.1:8787/api/auth/get-session` returns `null` with status 200.

- [ ] **Step 9: Commit**

```bash
git add server
git commit -m "feat(server): Hono app serving auth, RPC and the generation stream"
```

---

### Task 10: Client auth and oRPC client

**Files:**
- Create: `src/lib/orpc.ts`
- Rewrite: `src/lib/auth.ts`
- Modify: `src/lib/session-rejection.ts`
- Delete: `src/lib/supabase.ts`
- Test: `src/lib/auth.test.ts` (rewrite), `src/lib/session-rejection.test.ts` (modify)

**Interfaces:**
- Consumes: `AppRouter` type from `server/router/index.ts`.
- Produces:
  - `src/lib/orpc.ts`: `client` (`RouterClient<AppRouter>`), `orpc` (TanStack Query utils), `apiUrl`, `getToken()`, `setToken(t)`, `clearToken()`.
  - `src/lib/auth.ts`: the SAME public API as today — `AuthContext`, `getSession()`, `subscribeAuth(cb)`, `initAuth()`, `useSession()`, `signIn(email, password)`, `signUp(email, password)`, `signOut()`, `clearRejectedSession()`. `useProfile` is deleted.

- [ ] **Step 1: Add the `@/server` path alias so the client can import router types**

In `tsconfig.json` add to `compilerOptions.paths`:

```json
"~server/*": ["./server/*"]
```

and in `vite.config.ts` and `vitest.config.ts` add to the resolve aliases:

```ts
"~server": path.resolve(__dirname, "./server"),
```

This is type-only usage — `import type { AppRouter }` — so nothing from `server/` is bundled.

- [ ] **Step 1b: Declare Deno's globals for the client typecheck**

`import type` still pulls `server/**` into tsc's program, and tsc typechecks those files. They use `Deno`, which the client's `lib` does not declare, so `deno task build` fails with `TS2304: Cannot find name 'Deno'` until this exists. (Vitest is unaffected — `deno task test` runs the runner under Deno, so the real global is present at runtime.)

Create `src/types/deno.d.ts` declaring only what the server actually uses:

```ts
/**
 * The client typecheck pulls `server/**` in through the router type import, so
 * tsc needs to know these exist. Deliberately minimal rather than the full
 * `deno types` output: that redeclares DOM globals (fetch, Request, Response)
 * which collide with this program's DOM lib.
 *
 * Drift here is loud, not silent — if the server starts using another Deno
 * API, `deno task build` fails with TS2304 and the fix is one more line.
 */
declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  function writeFile(path: string, data: Uint8Array): Promise<void>;
  function serve(
    options: { port?: number },
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown;
}
```

Verify with `deno task build` at the end of Task 12; it is expected to fail earlier in the sequence only for reasons the later tasks fix.

- [ ] **Step 2: Write `src/lib/orpc.ts`**

```ts
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "~server/router/index";
import { sessionAwareFetch } from "@/lib/session-rejection";

export const apiUrl = import.meta.env.VITE_API_URL;

if (!apiUrl) {
  throw new Error("VITE_API_URL must be set in .env.local");
}

const TOKEN_KEY = "mnimi.bearer";

/**
 * The bearer token, in localStorage. better-auth has no official bearer client
 * plugin — the client half is this plus the fetchOptions in auth.ts.
 */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // A Tauri webview can refuse storage. Treat it as signed out rather than
    // crashing the module body, which would leave the app blank.
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch (error) {
    console.error("could not persist the session token:", error);
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (error) {
    console.error("could not clear the session token:", error);
  }
}

const link = new RPCLink({
  url: `${apiUrl}/rpc`,
  headers: () => {
    const token = getToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
  // The one fetch every RPC call passes through, so it is the single place a
  // refused token is visible as a status code.
  fetch: (request, init) => sessionAwareFetch(request, init),
});

export const client: RouterClient<AppRouter> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
```

- [ ] **Step 3: Modify `src/lib/session-rejection.ts`**

Only the exclusion rule changes. Replace `isSessionRejection` and its comment:

```ts
function isSessionRejection(url: string, status: number): boolean {
  if (status !== 401) return false;
  // better-auth answers 401 for a rejected sign-in, which is not a verdict on
  // a stored session and is already handled where it is called. Its
  // get-session endpoint does not 401 at all — it answers 200 with a null
  // body. Everything else (RPC, the generation stream) only 401s when the
  // bearer token itself was refused.
  return !url.includes("/api/auth/");
}
```

- [ ] **Step 4: Update `src/lib/session-rejection.test.ts`**

Replace the Supabase URLs with the new ones. The three cases stay the same in spirit:

```ts
const RPC = "http://127.0.0.1:8787/rpc/decks/list";
const STREAM = "http://127.0.0.1:8787/api/generate-note";
const SIGN_IN = "http://127.0.0.1:8787/api/auth/sign-in/email";
```

Keep every existing assertion, mapping the old PostgREST/storage/functions URLs onto `RPC` and `STREAM`, and the old `/auth/v1/` URL onto `SIGN_IN`.

- [ ] **Step 5: Rewrite `src/lib/auth.ts`**

```ts
import { useSyncExternalStore } from "react";
import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { apiUrl, clearToken, getToken, setToken } from "@/lib/orpc";

/** The session shape the app consumes. Mirrors better-auth's session user
 *  plus the two additional fields declared on the server. */
export type Session = {
  user: {
    id: string;
    email: string;
    name: string;
    nativeLanguage: string;
    uiLanguage: string;
  };
};

/** What the router receives as context so `beforeLoad` can guard routes. */
export type AuthContext = { getSession: () => Session | null };

export const authClient = createAuthClient({
  baseURL: apiUrl,
  plugins: [
    inferAdditionalFields({
      user: {
        nativeLanguage: { type: "string" },
        uiLanguage: { type: "string" },
      },
    }),
  ],
  fetchOptions: {
    // The bearer plugin returns the token on this header, and exposes it via
    // Access-Control-Expose-Headers so a browser client can read it.
    onSuccess: (ctx) => {
      const token = ctx.response.headers.get("set-auth-token");
      if (token) setToken(token);
    },
    auth: {
      type: "Bearer",
      token: () => getToken() ?? "",
    },
  },
});

let currentSession: Session | null = null;
let initPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setSession(next: Session | null) {
  if (next === currentSession) return;
  currentSession = next;
  for (const listener of listeners) listener();
}

/**
 * Synchronous read of the current session. This is what route guards use:
 * `beforeLoad` runs outside React and cannot await a network round trip on
 * every navigation. It reflects local state only — the server re-verifies the
 * token on every request, and the `authed` middleware is the real
 * authorization boundary.
 */
export function getSession(): Session | null {
  return currentSession;
}

export function subscribeAuth(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Resolves once the session is known and validated. The router awaits this
 * before the first render, which is why nothing in the app needs a "loading"
 * state for auth.
 */
export function initAuth(): Promise<void> {
  initPromise ??= resolveInitialSession();
  return initPromise;
}

async function resolveInitialSession(): Promise<void> {
  // Subscribe FIRST, and deliberately never unsubscribe: this listener is a
  // process-lifetime singleton backing the module-level session store, not
  // tied to any one consumer's lifecycle. It also has to exist before the
  // getSession() call below, because better-auth's session atom is wrapped in
  // onMount — it does not start fetching, and never updates, until it has its
  // first listener.
  authClient.$store.atoms.session.listen((value) => {
    setSession(toSession(value.data));
  });

  // getSession() hits the server, so it doubles as the boot-time validation
  // the old implementation needed a separate getUser() call for: a token
  // signed by a rotated key, or belonging to a deleted user, looks fine
  // locally and only fails here.
  //
  // Fails open on network trouble: this is a Tauri app and must still open
  // offline. A genuinely dead token is refused by the server on the first
  // request anyway.
  try {
    const { data, error } = await authClient.getSession();
    if (error) {
      // An HTTP status means the server answered and refused us. An error
      // without one is a fetch failure — offline, DNS, server down.
      if (typeof error.status === "number") {
        clearToken();
        setSession(null);
      }
      return;
    }
    setSession(toSession(data));
  } catch {
    // Thrown fetch failure. Keep whatever we have.
  }
}

function toSession(data: unknown): Session | null {
  if (!data || typeof data !== "object" || !("user" in data)) return null;
  return data as Session;
}

/**
 * Drops a session the server has just refused, reached from a live request
 * that came back 401: the notified subscriber invalidates the router, and the
 * `_authed` guard evicts to /login with a redirect back to where the user was.
 *
 * Never throws. The session must end regardless — leaving it in place would
 * put the user back on a screen every request 401s on.
 */
export async function clearRejectedSession(): Promise<void> {
  // One dead token 401s every request a screen makes, and the fetch
  // interceptor and the caller both report the same one. Only the first needs
  // to do anything.
  if (!currentSession) return;

  clearToken();
  setSession(null);

  try {
    await authClient.signOut();
  } catch (error) {
    console.error("signOut failed while clearing a rejected session:", error);
  }
}

export function useSession(): Session | null {
  return useSyncExternalStore(subscribeAuth, getSession, getSession);
}

export async function signIn(email: string, password: string) {
  const { error } = await authClient.signIn.email({ email, password });
  if (error) throw new Error(error.message ?? "Sign in failed");
}

export async function signUp(email: string, password: string) {
  // better-auth's user.name is NOT NULL, but this form collects only an email
  // and a password. Derive one rather than block sign-up; adding a name field
  // is a product change, not part of this migration.
  const name = email.split("@")[0] || email;
  const { error } = await authClient.signUp.email({ email, password, name });
  if (error) throw new Error(error.message ?? "Sign up failed");
}

export async function signOut() {
  clearToken();
  const { error } = await authClient.signOut();
  if (error) {
    console.error("signOut failed:", error);
    throw new Error(error.message ?? "Sign out failed");
  }
}

export async function updateNativeLanguage(nativeLanguage: string) {
  const { error } = await authClient.updateUser({ nativeLanguage });
  if (error) throw new Error(error.message ?? "Failed to update language");
}
```

- [ ] **Step 6: Rewrite `src/lib/auth.test.ts`**

Mock the better-auth client rather than the network. Keep the behaviours the old test covered.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock, signOutMock, listenMock, atomValue } = vi.hoisted(() => {
  const listeners: Array<(v: unknown) => void> = [];
  return {
    getSessionMock: vi.fn(),
    signOutMock: vi.fn().mockResolvedValue({ error: null }),
    listenMock: vi.fn((cb: (v: unknown) => void) => {
      listeners.push(cb);
      return () => {};
    }),
    atomValue: { listeners },
  };
});

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    getSession: getSessionMock,
    signOut: signOutMock,
    signIn: { email: vi.fn().mockResolvedValue({ error: null }) },
    signUp: { email: vi.fn().mockResolvedValue({ error: null }) },
    updateUser: vi.fn().mockResolvedValue({ error: null }),
    $store: { atoms: { session: { listen: listenMock, get: () => ({ data: null }) } } },
  }),
}));

vi.mock("better-auth/client/plugins", () => ({
  inferAdditionalFields: () => ({}),
}));

const SESSION = {
  user: {
    id: "u1",
    email: "ada@example.com",
    name: "ada",
    nativeLanguage: "en",
    uiLanguage: "en",
  },
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  atomValue.listeners.length = 0;
  getSessionMock.mockReset();
  signOutMock.mockClear();
});

describe("initAuth", () => {
  it("resolves the session before returning", async () => {
    getSessionMock.mockResolvedValue({ data: SESSION, error: null });
    const auth = await import("./auth");

    await auth.initAuth();

    expect(auth.getSession()?.user.id).toBe("u1");
  });

  it("subscribes before fetching, so the session atom actually starts", async () => {
    getSessionMock.mockResolvedValue({ data: SESSION, error: null });
    const auth = await import("./auth");

    await auth.initAuth();

    expect(listenMock).toHaveBeenCalled();
  });

  it("clears a token the server rejects with a status", async () => {
    localStorage.setItem("mnimi.bearer", "dead");
    getSessionMock.mockResolvedValue({
      data: null,
      error: { status: 401, message: "Unauthorized" },
    });
    const auth = await import("./auth");

    await auth.initAuth();

    expect(auth.getSession()).toBeNull();
    expect(localStorage.getItem("mnimi.bearer")).toBeNull();
  });

  it("keeps the token when the failure has no status — offline must still open", async () => {
    localStorage.setItem("mnimi.bearer", "maybe-fine");
    getSessionMock.mockResolvedValue({
      data: null,
      error: { message: "Failed to fetch" },
    });
    const auth = await import("./auth");

    await auth.initAuth();

    expect(localStorage.getItem("mnimi.bearer")).toBe("maybe-fine");
  });

  it("boots signed-out rather than throwing when getSession rejects", async () => {
    getSessionMock.mockRejectedValue(new Error("storage unavailable"));
    const auth = await import("./auth");

    await expect(auth.initAuth()).resolves.toBeUndefined();
    expect(auth.getSession()).toBeNull();
  });

  it("runs only once across repeated calls", async () => {
    getSessionMock.mockResolvedValue({ data: SESSION, error: null });
    const auth = await import("./auth");

    await Promise.all([auth.initAuth(), auth.initAuth()]);

    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });
});

describe("clearRejectedSession", () => {
  it("drops the session and notifies subscribers", async () => {
    getSessionMock.mockResolvedValue({ data: SESSION, error: null });
    const auth = await import("./auth");
    await auth.initAuth();

    const onChange = vi.fn();
    auth.subscribeAuth(onChange);

    await auth.clearRejectedSession();

    expect(auth.getSession()).toBeNull();
    expect(onChange).toHaveBeenCalled();
    expect(localStorage.getItem("mnimi.bearer")).toBeNull();
  });

  it("does nothing when there is no session", async () => {
    getSessionMock.mockResolvedValue({ data: null, error: null });
    const auth = await import("./auth");
    await auth.initAuth();

    await auth.clearRejectedSession();

    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("still ends the session when signOut throws", async () => {
    getSessionMock.mockResolvedValue({ data: SESSION, error: null });
    signOutMock.mockRejectedValueOnce(new Error("storage unavailable"));
    const auth = await import("./auth");
    await auth.initAuth();

    await expect(auth.clearRejectedSession()).resolves.toBeUndefined();
    expect(auth.getSession()).toBeNull();
  });
});
```

- [ ] **Step 7: Delete the Supabase client**

```bash
git rm src/lib/supabase.ts
```

- [ ] **Step 8: Run the tests**

Run: `deno task test src/lib/auth.test.ts src/lib/session-rejection.test.ts`
Expected: PASS. Other client tests will still fail to compile until Task 11 — that is expected at this checkpoint.

- [ ] **Step 9: Commit**

```bash
git add -A src/lib tsconfig.json vite.config.ts vitest.config.ts
git commit -m "feat(client): better-auth session store and oRPC client"
```

---

### Task 11: Client data hooks and FSRS

**Files:**
- Modify: `src/lib/fsrs.ts`, `src/lib/fsrs.test.ts`
- Rewrite: `src/lib/api/decks.ts`, `src/lib/api/notes.ts`, `src/lib/api/review.ts`
- Delete: `src/types/database.ts`

**Interfaces:**
- Consumes: `orpc` and `client` from `src/lib/orpc.ts`; row types from `~server/db/schema`.
- Produces: unchanged hook names — `useDecks()`, `useCreateDeck()`, `useNotes(deckId)`, `useSaveNote()`, `useDueCards(deckId?)`, `useDueCount(deckId?)`, `useGradeCard()`. `fsrs.ts` exports `CardRow` (now `Card` from the schema), `FsrsColumns`, `ReviewLogInsert`, `toFsrsCard`, `fromFsrsCard`, `gradeCard`, `RATINGS`. `newCardColumns` is **deleted** — the server sets new-card state.

- [ ] **Step 1: Rewrite `src/lib/fsrs.ts`**

Dates now travel as `Date` objects end to end, so the ISO conversion disappears from both directions.

```ts
import {
  fsrs,
  Rating,
  State,
  type Card as FsrsCard,
  type Grade,
} from "ts-fsrs";
import type { Card } from "~server/db/schema";

export type CardRow = Card;

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
```

- [ ] **Step 2: Update `src/lib/fsrs.test.ts`**

Every construction of a `CardRow` fixture switches to camelCase keys and `Date` values instead of ISO strings, and every assertion that compared an ISO string now compares a `Date`. Delete the `newCardColumns` describe block entirely — that function no longer exists; the equivalent is now asserted server-side in `server/router/notes.test.ts` ("New cards start in the FSRS 'new' state"). Keep every other case: the round-trip through `toFsrsCard`/`fromFsrsCard`, and that `gradeCard` advances `reps` and produces a log whose `review` is the grading time.

Run: `deno task test src/lib/fsrs.test.ts`
Expected: PASS.

- [ ] **Step 3: Rewrite `src/lib/api/decks.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/orpc";
import type { Deck } from "~server/db/schema";

export type { Deck };

export function useDecks() {
  return useQuery(orpc.decks.list.queryOptions({ input: {} }));
}

export function useCreateDeck() {
  const queryClient = useQueryClient();

  return useMutation(
    orpc.decks.create.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
    }),
  );
}
```

- [ ] **Step 4: Rewrite `src/lib/api/notes.ts`**

The manual orphan cleanup is gone — the server does this in one transaction now.

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/orpc";
import { generateNoteImage, type Classification, type GeneratedCard } from "@/lib/api/ai";
import type { Note } from "~server/db/schema";

export type { Note };

export function useNotes(deckId: string) {
  return useQuery(orpc.notes.listByDeck.queryOptions({ input: { deckId } }));
}

export function useSaveNote() {
  const queryClient = useQueryClient();

  return useMutation(
    orpc.notes.save.mutationOptions({
      onSuccess: (note, variables) => {
        // Fire and forget: a note without an image is still a valid note.
        if (variables.imagePrompt) {
          generateNoteImage(note.id, variables.imagePrompt)
            .then(() =>
              queryClient.invalidateQueries({ queryKey: orpc.notes.key() })
            )
            .catch((e) => console.error("Image generation failed", e));
        }
        queryClient.invalidateQueries({ queryKey: orpc.notes.key() });
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() });
      },
    }),
  );
}

export type { Classification, GeneratedCard };
```

- [ ] **Step 5: Rewrite `src/lib/api/review.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Grade } from "ts-fsrs";
import { orpc } from "@/lib/orpc";
import { gradeCard, type CardRow } from "@/lib/fsrs";

export function useDueCards(deckId?: string) {
  return useQuery(orpc.cards.due.queryOptions({ input: { deckId: deckId ?? null } }));
}

// Separate from useDueCards, which caps at 100 rows because that's the right
// size for a review session queue. A "Today" counter using that same capped
// query would tell a user with 120 cards due that only 100 are — silently
// wrong. This counts server-side instead, so the number is always honest.
export function useDueCount(deckId?: string) {
  return useQuery(
    orpc.cards.dueCount.queryOptions({ input: { deckId: deckId ?? null } }),
  );
}

export function useGradeCard() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ card, rating }: { card: CardRow; rating: Grade }) => {
      const { card: columns, log } = gradeCard(card, rating);
      // One call: the server writes the card and its review log in a single
      // transaction, so the state can no longer advance without a log.
      await orpc.cards.grade.call({ cardId: card.id, card: columns, log });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
  });
}
```

- [ ] **Step 6: Delete the generated Supabase types**

```bash
git rm src/types/database.ts
```

- [ ] **Step 7: Typecheck and test**

Run: `deno task build` (runs `tsc` then vite build)
Expected: the remaining errors are only in the route components and `src/lib/api/ai.ts`, which Task 12 fixes. Note them and continue.

Run: `deno task test src/lib/fsrs.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A src/lib src/types
git commit -m "feat(client): oRPC data hooks and Date-native FSRS mapping"
```

---

### Task 12: Client AI calls, routes and components

**Files:**
- Rewrite: `src/lib/api/ai.ts`
- Modify: `src/routes/_authed.settings.tsx`, `src/routes/_authed.add.tsx`, `src/routes/_authed.review.$deckId.tsx`, `src/routes/_authed.decks.$deckId.tsx`
- Modify: `src/main.tsx` (only if it referenced `useProfile` — it does not; verify)

**Interfaces:**
- Consumes: `client` / `orpc` / `apiUrl` / `getToken` from `src/lib/orpc.ts`; `useSession`, `updateNativeLanguage` from `src/lib/auth.ts`.
- Produces: `generateNoteStream(text, nativeLanguage, signal)`, `generateNoteImage(noteId, prompt)`, `readGenerationEvents(body)`, and the unchanged types `Classification`, `GeneratedCard`, `GeneratedNote`, `PartialCard`, `GenerationEvent`.

- [ ] **Step 1: Rewrite `src/lib/api/ai.ts`**

Only the transport changes. `readGenerationEvents` and the event vocabulary are untouched, so `src/lib/sse.test.ts`, `run-generation.test.ts`, `generation-state.test.ts` and `generation-status.test.ts` all keep passing.

```ts
import { apiUrl, client, getToken } from "@/lib/orpc";
import { clearRejectedSession } from "@/lib/auth";
import { SessionExpiredError } from "@/lib/session-expired";
import { readEventStream } from "@/lib/sse";
import { ORPCError } from "@orpc/client";

export type Classification = {
  domain: string;
  language: string | null;
  partOfSpeech: string | null;
};

export type GeneratedCard = {
  aspect: string;
  front: string;
  back: string;
  hint: string | null;
};

export type GeneratedNote = {
  imagePrompt: string | null;
  cards: GeneratedCard[];
};

/**
 * A card mid-stream: a field is null until the model reaches it, which is what
 * the UI draws as a skeleton. Mirrors `PartialCard` in `server/ai/schemas.ts` —
 * the two meet over the wire, since the browser bundle does not import server
 * modules.
 */
export type PartialCard = {
  aspect: string | null;
  front: string | null;
  back: string | null;
};

/** The five events `generate-note` emits. See the design doc for the protocol. */
export type GenerationEvent =
  | { type: "classified"; classification: Classification }
  | { type: "cards"; cards: PartialCard[] }
  | { type: "retry" }
  | { type: "done"; classification: Classification; generation: GeneratedNote }
  | { type: "error"; message: string };

/** Synthesised whenever the connection ends without a terminal event — a
 * corrupt frame or a dropped connection are indistinguishable to the client. */
const CONNECTION_DROPPED_MESSAGE = "The connection dropped mid-generation";

export async function* readGenerationEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GenerationEvent> {
  let terminated = false;

  for await (const data of readEventStream(body)) {
    let event: GenerationEvent;
    try {
      event = JSON.parse(data) as GenerationEvent;
    } catch {
      // A corrupt frame would leave the UI on skeletons forever if we throw,
      // so synthesise an error and stop reading instead.
      yield { type: "error", message: CONNECTION_DROPPED_MESSAGE };
      return;
    }
    if (event.type === "done" || event.type === "error") terminated = true;
    yield event;
  }

  // A stream that stops without a verdict means the connection dropped
  // mid-generation. Unreported it would leave the UI on skeletons forever, so
  // synthesise the failure the server never got to send.
  if (!terminated) {
    yield { type: "error", message: CONNECTION_DROPPED_MESSAGE };
  }
}

export async function* generateNoteStream(
  text: string,
  nativeLanguage: string,
  signal?: AbortSignal,
): AsyncGenerator<GenerationEvent> {
  const token = getToken();
  const response = await fetch(`${apiUrl}/api/generate-note`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text, nativeLanguage }),
    signal,
  });

  // The server answers 401 for exactly two things — no Authorization header,
  // or a token it refused — and both mean this session is dead. Reporting it
  // as a generation failure would drop the user onto the hand-editable
  // fallback card, quietly nudging them into writing the card themselves when
  // signing in again is the actual fix.
  if (response.status === 401) {
    await clearRejectedSession();
    throw new SessionExpiredError();
  }
  if (!response.ok) {
    throw new Error(`generate-note failed with ${response.status}`);
  }
  if (!response.body) throw new Error("generate-note returned no stream");

  yield* readGenerationEvents(response.body);
}

export async function generateNoteImage(noteId: string, prompt: string) {
  try {
    return await client.ai.generateImage({ noteId, prompt });
  } catch (error) {
    if (error instanceof ORPCError && error.status === 401) {
      await clearRejectedSession();
      throw new SessionExpiredError();
    }
    throw error;
  }
}
```

- [ ] **Step 2: Update `src/routes/_authed.settings.tsx`**

Replace the `useProfile` + Supabase update with the session and better-auth. Change the imports:

```ts
import { useSession, signOut, updateNativeLanguage } from "@/lib/auth";
```

Replace `const { data: profile } = useProfile();` with:

```ts
const session = useSession();
```

Replace the mutation body:

```ts
  const updateLanguage = useMutation({
    mutationFn: async (nativeLanguage: string) => {
      // The select below is disabled while signed out, but guard here too
      // rather than assume the UI can never race ahead of this check.
      if (!session) throw new Error("Not signed in");
      await updateNativeLanguage(nativeLanguage);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }),
  });
```

Replace both remaining reads of `profile`:
- `disabled={!profile || updateLanguage.isPending}` → `disabled={!session || updateLanguage.isPending}`
- `profile?.native_language ?? "en"` → `session?.user.nativeLanguage ?? "en"`

Keep the `isSavingRef` guard, the in-flight `updateLanguage.variables` display and every comment explaining them — that race is unchanged.

> **Note:** `updateUser` refreshes better-auth's session atom, which the store in `auth.ts` is subscribed to, so `useSession()` re-renders with the new value on its own. The `invalidateQueries` above is belt-and-braces for any query keyed on the session.

- [ ] **Step 3: Update `src/routes/_authed.add.tsx`**

- Replace `import { useProfile } from "@/lib/auth";` with `import { useSession } from "@/lib/auth";`
- Replace `const { data: profile } = useProfile();` with `const session = useSession();`
- Replace `profile?.native_language ?? "en"` with `session?.user.nativeLanguage ?? "en"`

Nothing else in this file changes: `saveNote.mutateAsync` already takes exactly the shape `notes.save` accepts.

- [ ] **Step 4: Update `src/routes/_authed.review.$deckId.tsx`**

Replace the PostgREST error-code heuristic. Change the import block to add:

```ts
import { ORPCError } from "@orpc/client";
```

and replace `isConnectionError` entirely:

```ts
// An ORPCError means the server answered and reported a problem. Anything else
// — a TypeError from fetch, an abort — never reached the server, which is the
// only reliable signal that the connection is the problem. Matching on message
// text would be brittle.
function isConnectionError(error: unknown): boolean {
  return !(error instanceof ORPCError);
}
```

- [ ] **Step 5: Update `src/routes/_authed.decks.$deckId.tsx`**

One rename: `note.source_text` → `note.sourceText`.

- [ ] **Step 6: Sweep for any remaining snake_case row access**

Run: `grep -rn "source_text\|native_language\|ui_language\|image_path\|elapsed_days\|scheduled_days\|learning_steps\|last_review\|user_id\|note_id\|deck_id\|card_id\|created_at" src/`
Expected: no hits outside comments. Fix any that remain.

- [ ] **Step 6b: Retarget `src/routes/-routes.test.ts`**

That test currently `vi.mock`s `@/lib/supabase`, a module deleted in Task 10. Nothing imports it any more, so the mock is inert and the test passes for the wrong reason. Point it at `@/lib/orpc` instead, so it once again isolates the route tree from the data layer it is meant to stub out.

- [ ] **Step 7: Typecheck and run the full suite**

First generate the route tree — `src/routeTree.gen.ts` is gitignored build output and may not exist in a fresh worktree. Without it every route file typechecks against a `never` router and the build failure is meaningless:

Run: `deno task routes:generate`

Run: `deno task build`
Expected: clean. This is the first task at which a clean build is expected; Tasks 10 and 11 leave it failing by design.

Run: `deno task test`
Expected: PASS, all suites.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "feat(client): route and AI-call migration off Supabase"
```

---

### Task 13: Remove Supabase and update the docs

**Files:**
- Delete: `supabase/` (everything remaining)
- Modify: `mise.toml`, `README.md`, `docs/OUT-OF-SCOPE.md`, `package.json`, `.env.local`
- Modify: `src-tauri/tauri.conf.json` (only the two scaffold hooks noted in the README)

**Interfaces:**
- Consumes: nothing.
- Produces: a repository with no Supabase surface left.

- [ ] **Step 1: Delete the remaining Supabase tree**

```bash
git rm -r supabase
```

Everything under it has either moved (`_shared/*` → `server/ai/`, both function entrypoints → `server/routes/` and `server/router/ai.ts`) or is obsolete (`config.toml`, `migrations/`, `functions/deno.json`).

- [ ] **Step 2: Drop Supabase from the toolchain**

Edit `mise.toml`: remove the `supabase = "2.109.1"` line and the `DOCKER_HOST` entry. Node, Deno, Java 17 and the Android SDK stay — Java and the SDK are still needed for Android, and Node backs Vitest.

- [ ] **Step 3: Drop `@supabase/supabase-js` from `package.json`**

Remove it from `dependencies`, then:

Run: `deno install`

- [ ] **Step 4: Update `.env.local` and add a root `.env.example`**

Replace both Supabase variables in `.env.local` with:

```
VITE_API_URL=http://127.0.0.1:8787
```

`.env.local` is gitignored, so a fresh checkout has no `VITE_API_URL` and `src/lib/orpc.ts` throws at module load — a blank window with a console error. Commit a root `.env.example` alongside it so the required variable is discoverable:

```
# Copy to .env.local. The API server this client talks to.
# On Android the device cannot reach 127.0.0.1 on your machine — use the LAN
# address, and set CORS_ORIGIN in server/.env to match.
VITE_API_URL=http://127.0.0.1:8787
```

- [ ] **Step 5: Add root tasks for the server**

Add to `package.json` scripts so the server is runnable from the repo root:

```json
"server": "cd server && deno task dev",
"db:generate": "cd server && deno task db:generate",
"db:migrate": "cd server && deno task db:migrate"
```

- [ ] **Step 6: Fix the Tauri scaffold hooks**

`src-tauri/tauri.conf.json` already reads `npm run dev` / `npm run build`, but this project uses Deno. Change them to:

```json
"beforeDevCommand": "deno task dev",
"beforeBuildCommand": "deno task build",
```

The README's Android prerequisite note about these two fields can then be deleted.

- [ ] **Step 7: Rewrite the README**

Delete outright: the Podman prerequisite, the "Podman socket" section, the "Ports" table, the "The OpenRouter key" path references to `supabase/functions/.env`, the "Edge Functions" section's `supabase start` instructions, and all three troubleshooting entries (`functions serve` under Podman, `supabase start` container runtime, port already in use). Replace the Supabase 401 entry with one about `VITE_API_URL` pointing at a server that is not running.

Update the Stack table:

| Concern | Choice |
|---|---|
| Backend | Hono on Deno — better-auth, SQLite via Drizzle, oRPC |
| Database | SQLite (`@libsql/client`) with Drizzle ORM and UUIDv7 keys |
| AI | `@tanstack/ai` against OpenRouter, in the server |

Replace the Setup section with:

````markdown
## Setup

```bash
mise install                    # node, deno, java 17, android-sdk
deno install                    # frontend dependencies
cd server && cp .env.example .env
```

Set `BETTER_AUTH_SECRET` to at least 32 random characters and `OPENROUTER_API_KEY`
to your key. Then create the database:

```bash
deno task db:migrate            # from the repo root
```

## Running

```bash
deno task server                # API on http://127.0.0.1:8787
deno task dev                   # Vite dev server on http://localhost:1420
deno task test                  # vitest, one shot
```

Both processes are needed. `.env.local` at the repo root points the client at the
server:

```
VITE_API_URL=http://127.0.0.1:8787
```
````

Update the Layout section to match the tree in Task 1, and the Android section's
note about the device reaching the backend: `VITE_API_URL` takes the LAN address,
and `CORS_ORIGIN` in `server/.env` must match wherever the app is served from.

Keep the "key never goes in client code" paragraph — it is still true and still
load-bearing — but point it at `server/.env` and `Deno.env.get` in
`server/ai/openrouter.ts`.

- [ ] **Step 8: Record the deferred image endpoint in `docs/OUT-OF-SCOPE.md`**

Append an entry in the file's existing style:

```markdown
## Serving generated note images

`ai.generateImage` writes a PNG to `server/data/images/<userId>/<noteId>.png` and
records the path, but there is no endpoint to read it back. Nothing in the UI
renders a note image — that was equally true under Supabase Storage, where the
bucket was private and no screen ever fetched from it. Adding a read route is new
functionality, not part of the migration, and it needs a decision about auth on
image URLs (a bearer header cannot ride on an `<img src>`) that is better made
when a screen actually needs one.
```

- [ ] **Step 9: Verify nothing references Supabase any more**

Run: `grep -rn -i "supabase" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs .`
Expected: no hits. (`docs/superpowers/` is excluded because the historical specs legitimately describe the old architecture.)

- [ ] **Step 10: Full verification**

Run: `deno task test`
Expected: PASS, every suite.

Run: `deno task build`
Expected: clean tsc + vite build.

Then a real end-to-end pass, both processes running:
1. `deno task server` and `deno task dev`
2. Sign up at http://localhost:1420 with a new email.
3. Create a deck, add a note, watch cards stream in, save.
4. Review a card and grade it; confirm the count drops.
5. Change the native language in Settings and reload — it persists.
6. Sign out; confirm you land on `/login` and cannot reach `/decks`.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: remove Supabase and document the new stack"
```

---

## Verification checklist

Before calling the migration done, confirm each of these directly:

- [ ] `deno task test` passes, including the ownership suite in `server/router/`.
- [ ] `deno task build` is clean.
- [ ] `grep -rn -i supabase` outside `docs/` and `node_modules/` returns nothing.
- [ ] `server/drizzle/0000_*.sql` contains the partial index with `WHERE suspended = 0`.
- [ ] No procedure input schema anywhere contains a `userId` field:
      `grep -rn "userId" server/router/*.ts` shows it only in `context.userId`, `eq(...userId...)` and insert values.
- [ ] Signing in on one account and requesting another account's deck id returns not-found, verified by the tests in Tasks 4-6.
- [ ] The end-to-end pass in Task 13 Step 10 completes.
