# Durable Card Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make card generation a server-owned job backed by a persisted draft row, so leaving `/add` no longer kills it, reopening resumes the stream, and an unfinished generation can be saved, discarded, or left for later.

**Architecture:** A `drafts` table holds one row per user. `drafts.start` inserts the row and spawns a detached job in an in-process registry (`server/ai/jobs.ts`); the job persists milestones and publishes events to subscribers through a small async channel. `drafts.watch` is an oRPC event iterator that hands a late joiner the job's in-memory snapshot and then tails it. The image becomes a second, concurrent stage of the same job, started from `imagePrompt` — which the model now emits *before* the cards — and settled under the write lock against whatever the draft has become.

**Tech Stack:** Deno + Hono + oRPC 1.14.14 on the server, Drizzle over libSQL/SQLite, `@tanstack/ai` against OpenRouter, React 19 + TanStack Router/Query on the client, Vitest for everything.

**Spec:** `docs/superpowers/specs/2026-08-08-durable-card-generation-design.md`. Read it before starting; every task below implements a numbered section of it.

## Global Constraints

- **Use `deno` for all package management and script execution.** Never `npm`, `npx`, `yarn` or `pnpm` (`AGENTS.md`).
- **Run the suite with `deno task test`** (Vitest, one shot). It covers `src/**/*.test.ts`, `src/**/*.test.tsx` and `server/**/*.test.ts`.
- **Type-check the server with `deno task check:api`** after any server change.
- **Never nest `withWriteLock` inside `withWriteLock`.** It is a promise chain (`server/db/write-lock.ts`); a nested call appends to the queue and then awaits it while the outer call still holds it — an unrecoverable deadlock, not a slow path. Inside a locked section use the raw `db` handle directly.
- **Wrap every `db.transaction(...)` and every write likely to be issued alongside one in `withWriteLock`.**
- **No procedure may take a `userId` from its input.** The only source is `context.userId`, established by the `authed` middleware (`server/router/base.ts`).
- **A row that does not exist and a row owned by someone else are reported identically** — `throw notFound(...)`.
- Server files use explicit `.ts` extensions on relative imports. Client files use the `@/` alias for `src` and `~server` for type-only server imports.
- The client must never import a server module for anything but types.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `server/ai/channel.ts` | Single-consumer async channel with tail coalescing. The callback→iterator bridge a detached producer needs. |
| `server/ai/channel.test.ts` | Its tests. |
| `server/ai/jobs.ts` | The job registry: start, subscribe, abort, retarget, boot reconcile, and the two stages. |
| `server/ai/jobs.test.ts` | Its tests. |
| `server/router/drafts.ts` | The six draft procedures. |
| `server/router/drafts.test.ts` | Their tests. |
| `src/lib/api/session-error.ts` | `asSessionError`, lifted out of `src/lib/api/ai.ts` so both AI and draft calls share one copy. |
| `src/lib/api/drafts.ts` | Query/mutation options over the draft procedures, plus `watchDraft`. |
| `src/lib/draft-state.ts` | The reducer. Replaces `generation-state.ts`. |
| `src/lib/draft-state.test.ts` | Its tests. |
| `src/lib/draft-status.ts` | Status-line text. Replaces `generation-status.ts`. |
| `src/lib/draft-status.test.ts` | Its tests. |
| `src/lib/watch-draft.ts` | Drives `watchDraft` into the reducer, reconnecting on a dropped stream. |
| `src/lib/watch-draft.test.ts` | Its tests. |
| `src/components/draft-indicator.tsx` | The dot + status word beside the `Add` nav entry. |
| `src/routes/_authed.add.test.tsx` | One route test: a `generating` draft resumes instead of showing the form. |

**Modified**

`server/db/schema.ts` · `server/db/schema.test.ts` · `server/drizzle/` (generated migration) · `server/ai/schemas.ts` · `server/ai/schemas.test.ts` · `server/ai/generate-note.ts` · `server/ai/generate-note.test.ts` · `server/images.ts` · `server/images.test.ts` · `server/main.ts` · `server/router/base.ts` · `server/router/index.ts` · `server/router/ai.ts` · `server/router/ai.test.ts` · `server/router/notes.ts` · `server/router/notes.test.ts` · `src/lib/api/ai.ts` · `src/lib/api/notes.ts` · `src/routes/_authed.add.tsx` · `src/components/app-sidebar.tsx` · `src/routes/_authed.tsx` · `README.md`

**Deleted**

`src/lib/generation-state.ts` · `src/lib/generation-state.test.ts` · `src/lib/generation-status.ts` · `src/lib/generation-status.test.ts` · `src/lib/run-generation.ts` · `src/lib/run-generation.test.ts` · `src/lib/run-draft-image.ts` · `src/lib/run-draft-image.test.ts` · `src/components/generation-status.tsx`

**Task order and why it is safe.** Tasks 1–7 are additive on the server: the existing `ai.generateNote` / `ai.generateDraftImage` procedures keep working, so the app compiles and runs throughout. Tasks 8–9 add unused client modules. Task 10 is the cutover — `notes.save`'s input change and the `/add` rewrite cannot be separated, because each breaks the other's types. Tasks 11–13 clean up behind it.

---

### Task 1: The `drafts` table

Implements spec §1.1.

**Files:**
- Modify: `server/db/schema.ts`
- Modify: `server/db/schema.test.ts`
- Create: `server/drizzle/0001_*.sql` (generated — do not hand-write)

**Interfaces:**
- Consumes: nothing.
- Produces: `drafts` table; types `Draft`, `DraftStatus`, `DraftImageStatus`, `DraftClassification`, `DraftCard`.

- [ ] **Step 1: Write the failing tests**

Append to `server/db/schema.test.ts` (it already seeds user `u1` in `beforeEach`; add `drafts` to the existing import from `./schema.ts`):

```ts
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
        classification: { domain: "language", language: "de", partOfSpeech: "noun" },
        cards: [{ aspect: "meaning", front: "die Banane", back: null, hint: null }],
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

  it("allows only one draft per user", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();

    const values = {
      userId: "u1",
      deckId: deck.id,
      sourceText: "x",
      status: "generating" as const,
    };
    await db.insert(drafts).values(values);

    await expect(db.insert(drafts).values(values)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("drops the draft when its deck goes", async () => {
    const [deck] = await db
      .insert(decks)
      .values({ userId: "u1", name: "German" })
      .returning();
    await db.insert(drafts).values({
      userId: "u1",
      deckId: deck.id,
      sourceText: "x",
      status: "generating",
    });

    await db.delete(decks).where(eq(decks.id, deck.id));

    expect(await db.select().from(drafts)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test server/db/schema.test.ts`
Expected: FAIL — `drafts` is not exported from `./schema.ts`.

- [ ] **Step 3: Add the table**

Append to `server/db/schema.ts`, after `reviewLogs`:

```ts
export type DraftStatus = "generating" | "ready" | "failed";
export type DraftImageStatus = "none" | "generating" | "ready" | "failed";

/** Restated rather than imported from `../ai/schemas.ts`, the same way
 *  `NoteMetadata` restates `partOfSpeech`: the database layer describes what
 *  it stores and does not depend on the AI layer to do it. */
export type DraftClassification = {
  domain: string;
  language: string | null;
  partOfSpeech: string | null;
};

/** A card inside a draft. Every field is nullable because a draft holds
 *  half-written cards while `status` is "generating"; once it is "ready" the
 *  job has written validated cards and nothing but `hint` is null. */
export type DraftCard = {
  aspect: string | null;
  front: string | null;
  back: string | null;
  hint?: string | null;
};

/**
 * The one unsaved generation a user may have in flight.
 *
 * `userId` is unique, so "at most one draft" is a database constraint rather
 * than something the UI is trusted to uphold — two tabs racing `drafts.start`
 * produce one draft and one rejection.
 *
 * `status` describes the cards and `imageStatus` describes the picture, and
 * they are deliberately independent: the two generation stages run
 * concurrently and routinely finish in either order.
 */
export const drafts = sqliteTable("drafts", {
  id: text("id").primaryKey().$defaultFn(uuidv7),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  // Cascades: a draft for a deck that no longer exists could never be saved.
  deckId: text("deck_id")
    .notNull()
    .references(() => decks.id, { onDelete: "cascade" }),
  sourceText: text("source_text").notNull(),
  status: text("status").$type<DraftStatus>().notNull(),
  classification: text("classification", { mode: "json" })
    .$type<DraftClassification | null>(),
  cards: text("cards", { mode: "json" })
    .$type<DraftCard[]>()
    .notNull()
    .$defaultFn(() => []),
  imagePrompt: text("image_prompt"),
  imageStatus: text("image_status")
    .$type<DraftImageStatus>()
    .notNull()
    .$defaultFn(() => "none"),
  draftImageId: text("draft_image_id"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
```

and add to the type exports at the bottom of the file:

```ts
export type Draft = typeof drafts.$inferSelect;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test server/db/schema.test.ts`
Expected: PASS (the whole file, including the pre-existing cases).

- [ ] **Step 5: Generate the migration**

Run: `deno task db:generate`
Expected: a new `server/drizzle/0001_*.sql` creating `drafts` with a unique index on `user_id`. Read it and confirm it creates only that table — nothing else in the schema changed.

Then apply it locally: `deno task db:migrate`

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.ts server/db/schema.test.ts server/drizzle
git commit -m "feat(db): add the drafts table"
```

---

### Task 2: `channel.ts`

Implements spec §2.1.

**Files:**
- Create: `server/ai/channel.ts`
- Test: `server/ai/channel.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type Channel<T> = {
    push(value: T): void;
    close(): void;
    fail(error: unknown): void;
    [Symbol.asyncIterator](): AsyncGenerator<T>;
  };
  export function channel<T>(
    canReplace?: (previous: T, next: T) => boolean,
  ): Channel<T>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `server/ai/channel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { channel } from "./channel.ts";

/** Drains an iterable into an array. */
async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of source) out.push(value);
  return out;
}

describe("channel", () => {
  it("delivers values pushed before anyone started reading", async () => {
    const ch = channel<number>();
    ch.push(1);
    ch.push(2);
    ch.close();

    expect(await drain(ch)).toEqual([1, 2]);
  });

  it("delivers values pushed while a reader is waiting", async () => {
    const ch = channel<number>();
    const read = drain(ch);

    // A tick, so the reader is genuinely parked on its promise.
    await Promise.resolve();
    ch.push(1);
    ch.push(2);
    ch.close();

    expect(await read).toEqual([1, 2]);
  });

  it("replaces the tail when canReplace says so", async () => {
    const ch = channel<{ type: string; n: number }>(
      (previous, next) => previous.type === "cards" && next.type === "cards",
    );
    ch.push({ type: "cards", n: 1 });
    ch.push({ type: "cards", n: 2 });
    ch.push({ type: "cards", n: 3 });
    ch.close();

    expect(await drain(ch)).toEqual([{ type: "cards", n: 3 }]);
  });

  it("never coalesces across a differing event", async () => {
    const ch = channel<{ type: string; n: number }>(
      (previous, next) => previous.type === "cards" && next.type === "cards",
    );
    ch.push({ type: "cards", n: 1 });
    ch.push({ type: "done", n: 0 });
    ch.push({ type: "cards", n: 2 });
    ch.close();

    expect(await drain(ch)).toEqual([
      { type: "cards", n: 1 },
      { type: "done", n: 0 },
      { type: "cards", n: 2 },
    ]);
  });

  it("yields everything already queued before reporting a failure", async () => {
    const ch = channel<number>();
    ch.push(1);
    ch.fail(new Error("boom"));

    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const value of ch) seen.push(value);
      })(),
    ).rejects.toThrow("boom");
    expect(seen).toEqual([1]);
  });

  it("ignores pushes after close", async () => {
    const ch = channel<number>();
    ch.push(1);
    ch.close();
    ch.push(2);

    expect(await drain(ch)).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test server/ai/channel.test.ts`
Expected: FAIL — cannot resolve `./channel.ts`.

- [ ] **Step 3: Write the implementation**

Create `server/ai/channel.ts`:

```ts
/**
 * A single-consumer async queue: a producer pushes, one iterator drains.
 *
 * `generate-note.ts` needs nothing like this — it is pulled by a synchronous
 * `.next()` loop, and the 2026-08-07 spec was right to refuse a queue for
 * that. A detached job has no such driver: it runs on its own schedule and
 * subscribers appear and vanish underneath it, so the callback-to-iterator
 * bridge is real here.
 *
 * `canReplace` is how a producer that emits full snapshots avoids an
 * unbounded queue behind a stalled reader. When it returns true the incoming
 * value REPLACES the tail rather than being appended. Dropping the oldest
 * would lose terminal events and blocking the producer would let a slow
 * client slow down generation, so replacing the tail is the only one of the
 * three that is both bounded and lossless in the sense that matters.
 *
 * One iterator per channel. Two would share `wake`, and the second would
 * strand the first.
 */
export type Channel<T> = {
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
  [Symbol.asyncIterator](): AsyncGenerator<T>;
};

export function channel<T>(
  canReplace: (previous: T, next: T) => boolean = () => false,
): Channel<T> {
  const queue: T[] = [];
  let closed = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;

  function signal() {
    const resolve = wake;
    wake = null;
    resolve?.();
  }

  return {
    push(value) {
      if (closed) return;
      const last = queue.length - 1;
      if (last >= 0 && canReplace(queue[last], value)) queue[last] = value;
      else queue.push(value);
      signal();
    },

    close() {
      if (closed) return;
      closed = true;
      signal();
    },

    fail(error) {
      if (closed) return;
      closed = true;
      // Not thrown until the queue is drained: a failure must not swallow
      // events the producer already reported.
      failure = error ?? new Error("channel failed");
      signal();
    },

    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) yield queue.shift() as T;
        if (closed) {
          if (failure !== null) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test server/ai/channel.test.ts`
Expected: PASS, six tests.

- [ ] **Step 5: Commit**

```bash
git add server/ai/channel.ts server/ai/channel.test.ts
git commit -m "feat(ai): add a coalescing async channel"
```

---

### Task 3: `imagePrompt` first, and the `image-prompt` event

Implements spec §3.1.

**Files:**
- Modify: `server/ai/schemas.ts`
- Modify: `server/ai/generate-note.ts`
- Modify: `server/ai/generate-note.test.ts`
- Check: `server/ai/schemas.test.ts` (existing cases must stay green unchanged)

**Interfaces:**
- Consumes: `streamWithRetry`, `projectCards` from `server/ai/generate.ts` (unchanged).
- Produces: `GenerationEvent` gains `| { type: "image-prompt"; prompt: string | null }`.

- [ ] **Step 1: Write the failing tests**

Read `server/ai/generate-note.test.ts` first — it drives the generator with a fake `ModelCalls`. Add these cases inside its existing `describe`, using the same helpers the file already defines for building a fake:

```ts
it("announces the image prompt as soon as the cards key proves it complete", async () => {
  const events = await collect(
    generateNote(INPUT, fakeCalls({
      classification: CLASSIFICATION,
      deltas: [
        `{"imagePrompt":"a ripe`,
        ` banana"`,
        `,"cards":[`,
        `{"aspect":"meaning","front":"die Banane","back":"banana"}]}`,
      ],
    })),
  );

  const prompts = events.filter((e) => e.type === "image-prompt");
  expect(prompts).toEqual([{ type: "image-prompt", prompt: "a ripe banana" }]);

  // It must arrive before any card, which is the entire point of the reorder.
  expect(events.findIndex((e) => e.type === "image-prompt")).toBeLessThan(
    events.findIndex((e) => e.type === "cards"),
  );
});

it("announces a null prompt too — no picture wanted is a decision", async () => {
  const events = await collect(
    generateNote(INPUT, fakeCalls({
      classification: CLASSIFICATION,
      deltas: [
        `{"imagePrompt":null,"cards":[`,
        `{"aspect":"meaning","front":"entropy","back":"disorder"}]}`,
      ],
    })),
  );

  expect(events.filter((e) => e.type === "image-prompt")).toEqual([
    { type: "image-prompt", prompt: null },
  ]);
});

it("re-announces the prompt after a retry discards the first attempt", async () => {
  const events = await collect(
    generateNote(INPUT, fakeCalls({
      classification: CLASSIFICATION,
      attempts: [
        // Fails validation: cards is empty.
        [`{"imagePrompt":"first","cards":[]}`],
        [
          `{"imagePrompt":"second","cards":[`,
          `{"aspect":"meaning","front":"f","back":"b"}]}`,
        ],
      ],
    })),
  );

  expect(
    events.filter((e) => e.type === "image-prompt").map((e) => e.prompt),
  ).toEqual(["first", "second"]);
  expect(events.findIndex((e) => e.type === "retry")).toBeGreaterThan(0);
});
```

If `fakeCalls` in the existing file does not yet support a multi-attempt `attempts` array, extend it — it should return a `generate` that yields the next attempt's deltas on each call.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test server/ai/generate-note.test.ts`
Expected: FAIL — no `image-prompt` event is ever yielded.

- [ ] **Step 3: Reorder the schema**

In `server/ai/schemas.ts`, swap the two keys of `generatedNoteSchema` and replace the leading comment:

```ts
export const generatedNoteSchema = z.object({
  // `imagePrompt` first so the model emits it first: JSON keys arrive in
  // schema order, and the prompt is the input to a generation stage that runs
  // CONCURRENTLY with the cards. Emitting it first buys the whole
  // card-writing duration as image head start, for the ~20 tokens of prompt
  // the model writes before the first card.
  //
  // The 2026-07-30 spec ordered these the other way, correctly, when the
  // image was fired by the client after `done` and nothing could start early.
  //
  // "" is normalised to null here, at the boundary where the model's output
  // is parsed, so every downstream site agrees on what "no image wanted"
  // means. Leaving "" as a distinct legal value made a note with an empty
  // prompt permanently `imageFailed`, with no attempt ever made and no way
  // to clear it.
  imagePrompt: z.string().nullish().transform((v) => v || null),
  cards: z.array(generatedCardSchema).min(1),
});
```

- [ ] **Step 4: Emit the event**

In `server/ai/generate-note.ts`, add the member to the union:

```ts
export type GenerationEvent =
  | { type: "classified"; classification: Classification }
  | { type: "image-prompt"; prompt: string | null }
  | { type: "cards"; cards: PartialCard[] }
  | { type: "retry" }
  | { type: "done"; classification: Classification; generation: GeneratedNote };
```

and replace the `.next()` loop body with:

```ts
  let lastSnapshot = "";
  let promptEmitted = false;
  let step = await stream.next();
  while (!step.done) {
    if (step.value.type === "retry") {
      lastSnapshot = "";
      // The discarded attempt's prompt is discarded with it. Whoever acted on
      // it is responsible for superseding that work; see jobs.ts.
      promptEmitted = false;
      yield { type: "retry" };
    } else {
      const parsed = parsePartialJSON(step.value.raw) as
        | { imagePrompt?: unknown; cards?: unknown }
        | undefined;

      // A JSON string value can still grow until the next key starts, so
      // `imagePrompt` is final exactly when `cards` has appeared — no
      // heuristic, no waiting for a closing quote we cannot see.
      if (!promptEmitted && parsed && "cards" in parsed) {
        promptEmitted = true;
        const prompt = typeof parsed.imagePrompt === "string" && parsed.imagePrompt
          ? parsed.imagePrompt
          : null;
        yield { type: "image-prompt", prompt };
      }

      const cards = projectCards(parsed);
      const snapshot = JSON.stringify(cards);
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        yield { type: "cards", cards };
      }
    }
    step = await stream.next();
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno task test server/ai server/router/ai.test.ts`
Expected: PASS. `server/ai/schemas.test.ts` must pass **unchanged** — reordering object keys does not change what Zod accepts. If a case there asserts key order, that assertion was testing the old comment, not behaviour; update it to the new order and say so in the commit.

- [ ] **Step 6: Type-check and commit**

```bash
deno task check:api
git add server/ai/schemas.ts server/ai/generate-note.ts server/ai/generate-note.test.ts
git commit -m "feat(ai): emit the image prompt before the cards"
```

---

### Task 4: The job registry and the cards stage

Implements spec §2.2, §2.3, §3.2 (cards half).

**Files:**
- Create: `server/ai/jobs.ts`
- Test: `server/ai/jobs.test.ts`

**Interfaces:**
- Consumes: `channel` (Task 2), `generateNote` / `GenerationEvent` (Task 3), `drafts` / `Draft` (Task 1), `withWriteLock`.
- Produces:
  ```ts
  export type DraftEvent =
    | { type: "snapshot"; draft: Draft }
    | { type: "classified"; classification: Classification }
    | { type: "image-prompt"; prompt: string | null }
    | { type: "cards"; cards: PartialCard[] }
    | { type: "retry" }
    | { type: "done"; classification: Classification; generation: GeneratedNote }
    | { type: "image"; status: DraftImageStatus; draftImageId: string | null }
    | { type: "failed"; message: string };

  export type JobDeps = {
    db: Db;
    modelCalls: ModelCalls;
    generateImageBytes: (prompt: string) => Promise<Uint8Array>;
    writeDraftImage: (userId: string, bytes: Uint8Array) => Promise<string>;
    claimDraftImage: (u: string, draftId: string, noteId: string) => Promise<string>;
    removeDraftImage: (userId: string, draftId: string) => Promise<void>;
  };

  export function startGenerationJob(
    deps: JobDeps, draft: Draft, nativeLanguage: string,
  ): Promise<void>;
  export function subscribe(draftId: string): AsyncGenerator<DraftEvent> | null;
  export function hasJob(draftId: string): boolean;
  export function abortJob(draftId: string): void;
  export function claimJobForNote(draftId: string, noteId: string): boolean;
  export async function reconcileOrphanedDrafts(db: Db): Promise<number>;
  ```
  (`startImageJob` arrives in Task 5.)

- [ ] **Step 1: Write the failing tests**

Create `server/ai/jobs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { decks, drafts, user } from "../db/schema.ts";
import type { Draft } from "../db/schema.ts";
import {
  abortJob,
  hasJob,
  reconcileOrphanedDrafts,
  startGenerationJob,
  subscribe,
} from "./jobs.ts";
import type { DraftEvent, JobDeps } from "./jobs.ts";
import type { ModelCalls } from "./generate-note.ts";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => void;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values({
    id: "u1",
    name: "Ada",
    email: "ada@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterEach(() => close());

const CLASSIFICATION = { domain: "language", language: "de", partOfSpeech: "noun" };
const CARD = { aspect: "meaning", front: "die Banane", back: "banana", hint: null };

/** A ModelCalls that emits a whole generation from canned deltas. */
function fakeModelCalls(deltas: string[]): ModelCalls {
  return {
    classify: async () => CLASSIFICATION,
    // eslint-disable-next-line require-yield
    async *generate() {
      for (const delta of deltas) yield delta;
      return { imagePrompt: "a ripe banana", cards: [CARD] };
    },
  };
}

const DELTAS = [
  `{"imagePrompt":"a ripe banana"`,
  `,"cards":[`,
  `{"aspect":"meaning","front":"die Banane","back":"banana"}]}`,
];

/** Deps whose image half never fires: these tests are about the cards stage. */
function deps(overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    db,
    modelCalls: fakeModelCalls(DELTAS),
    generateImageBytes: vi.fn(async () => new Uint8Array([1])),
    writeDraftImage: vi.fn(async () => "img-1"),
    claimDraftImage: vi.fn(async () => "u1/n1.png"),
    removeDraftImage: vi.fn(async () => {}),
    ...overrides,
  };
}

async function seedDraft(): Promise<Draft> {
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
    })
    .returning();
  return draft;
}

async function drain(source: AsyncIterable<DraftEvent>): Promise<DraftEvent[]> {
  const out: DraftEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

describe("startGenerationJob", () => {
  it("runs to completion and persists the result", async () => {
    const draft = await seedDraft();
    await startGenerationJob(deps(), draft, "en");

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row.status).toBe("ready");
    expect(row.classification).toEqual(CLASSIFICATION);
    expect(row.cards).toEqual([CARD]);
    expect(row.imagePrompt).toBe("a ripe banana");
    expect(hasJob(draft.id)).toBe(false);
  });

  it("gives every subscriber the same events, starting with a snapshot", async () => {
    const draft = await seedDraft();
    const run = startGenerationJob(deps(), draft, "en");

    const a = subscribe(draft.id);
    const b = subscribe(draft.id);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const [seenA, seenB] = await Promise.all([drain(a!), drain(b!), run]);
    expect(seenA[0].type).toBe("snapshot");
    expect(seenB[0].type).toBe("snapshot");
    expect(seenA.map((e) => e.type)).toEqual(seenB.map((e) => e.type));
    expect(seenA.at(-1)?.type).toBe("done");
  });

  it("returns null from subscribe when no job is running", async () => {
    const draft = await seedDraft();
    expect(subscribe(draft.id)).toBeNull();
  });

  it("records a failure on the row and reports it to subscribers", async () => {
    const draft = await seedDraft();
    const failing: ModelCalls = {
      classify: async () => {
        throw new Error("provider exploded");
      },
      async *generate() {
        return {};
      },
    };
    const run = startGenerationJob(deps({ modelCalls: failing }), draft, "en");
    const seen = subscribe(draft.id);
    const [events] = await Promise.all([drain(seen!), run]);

    expect(events.at(-1)).toEqual({ type: "failed", message: "Generation failed" });

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row.status).toBe("failed");
    // The provider's own words never reach the row, and so never reach a screen.
    expect(row.error).toBe("Generation failed");
  });

  it("stops writing once the job is aborted", async () => {
    const draft = await seedDraft();
    const run = startGenerationJob(deps(), draft, "en");
    abortJob(draft.id);
    await run;

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row.status).toBe("generating");
  });
});

describe("reconcileOrphanedDrafts", () => {
  it("fails a row that was still generating when the process died", async () => {
    const draft = await seedDraft();

    expect(await reconcileOrphanedDrafts(db)).toBe(1);

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row.status).toBe("failed");
    expect(row.error).toBe("The server restarted while this was generating.");
  });

  it("leaves a ready draft ready when only its image was in flight", async () => {
    const draft = await seedDraft();
    await db
      .update(drafts)
      .set({ status: "ready", imageStatus: "generating" })
      .where(eq(drafts.id, draft.id));

    await reconcileOrphanedDrafts(db);

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row.status).toBe("ready");
    expect(row.imageStatus).toBe("failed");
    expect(row.error).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test server/ai/jobs.test.ts`
Expected: FAIL — cannot resolve `./jobs.ts`.

- [ ] **Step 3: Write the implementation**

Create `server/ai/jobs.ts`. (The image stage is stubbed here and filled in by Task 5 — `startImageStage` exists but does nothing yet, so the tests above pass without a live image.)

```ts
import { and, eq, or } from "drizzle-orm";
import { channel } from "./channel.ts";
import type { Channel } from "./channel.ts";
import { generateNote } from "./generate-note.ts";
import type { ModelCalls } from "./generate-note.ts";
import type { Classification, GeneratedNote, PartialCard } from "./schemas.ts";
import { drafts } from "../db/schema.ts";
import type { Draft, DraftImageStatus } from "../db/schema.ts";
import type { Db } from "../db/index.ts";
import { withWriteLock } from "../db/write-lock.ts";

/**
 * What a watcher sees. `snapshot` is the whole row, so a late joiner never
 * replays; everything after it is a delta on that.
 *
 * `failed` is an EVENT, deliberately reversing the 2026-08-07 spec's decision
 * to throw instead. That spec was right when the iterator *was* the
 * generation. `subscribe` observes a job that may have failed before this
 * request existed, so a throw would assert "watching failed" — a different
 * fact, and the one the client's reconnect logic keys on. A thrown error out
 * of a watch now means exactly one thing: the connection broke.
 */
export type DraftEvent =
  | { type: "snapshot"; draft: Draft }
  | { type: "classified"; classification: Classification }
  | { type: "image-prompt"; prompt: string | null }
  | { type: "cards"; cards: PartialCard[] }
  | { type: "retry" }
  | { type: "done"; classification: Classification; generation: GeneratedNote }
  | { type: "image"; status: DraftImageStatus; draftImageId: string | null }
  | { type: "failed"; message: string };

/** Every seam that reaches a model or the disk, injected so a test drives a
 *  whole job without either. */
export type JobDeps = {
  db: Db;
  modelCalls: ModelCalls;
  generateImageBytes: (prompt: string) => Promise<Uint8Array>;
  writeDraftImage: (userId: string, bytes: Uint8Array) => Promise<string>;
  claimDraftImage: (
    userId: string,
    draftId: string,
    noteId: string,
  ) => Promise<string>;
  removeDraftImage: (userId: string, draftId: string) => Promise<void>;
};

type Job = {
  /** The job's own view of the row, kept current so a subscriber can be
   *  handed a snapshot without a database round trip. */
  draft: Draft;
  subscribers: Set<Channel<DraftEvent>>;
  abort: AbortController;
  /** Bumped whenever an image attempt is superseded. A result carrying an
   *  older number is discarded rather than written. */
  imageAttempt: number;
  /** Every image attempt ever started, awaited before the job is dropped. */
  imageStages: Promise<void>[];
  /** Set synchronously by `claimJobForNote` when a note is saved while the
   *  picture is still rendering. */
  noteId: string | null;
};

/**
 * Process-local, which is exactly right for this deployment: one Deno
 * process, one SQLite file, `Deno.serve` with no clustering. If that ever
 * stops being true, this map is the only thing that has to change.
 */
const jobs = new Map<string, Job>();

/** Full snapshots supersede each other, so a queued one may be replaced. */
const coalesceCards = (previous: DraftEvent, next: DraftEvent) =>
  previous.type === "cards" && next.type === "cards";

export function hasJob(draftId: string): boolean {
  return jobs.has(draftId);
}

export function abortJob(draftId: string): void {
  jobs.get(draftId)?.abort.abort();
}

/**
 * Redirects a running image stage from its draft onto a note.
 *
 * Synchronous, and called by `notes.save` from inside its write-lock section,
 * so the stage's own locked settle cannot interleave: see the spec's §3.3.
 * Returns true when there was something to redirect, which is how `save`
 * knows not to mark the note `imageFailed`.
 */
export function claimJobForNote(draftId: string, noteId: string): boolean {
  const job = jobs.get(draftId);
  if (!job || job.draft.imageStatus !== "generating") return false;
  job.noteId = noteId;
  return true;
}

/**
 * Attaches to a running job, or returns null if there is none.
 *
 * Registration and the snapshot read happen in the same synchronous block
 * before the generator is returned, which is what makes "subscribe" atomic:
 * nothing can be published between the two, so no event is ever lost to the
 * gap, and the caller's `hasJob`-then-`subscribe` race disappears because the
 * lookup is in here.
 */
export function subscribe(draftId: string): AsyncGenerator<DraftEvent> | null {
  const job = jobs.get(draftId);
  if (!job) return null;

  const ch = channel<DraftEvent>(coalesceCards);
  job.subscribers.add(ch);
  const snapshot = job.draft;

  return (async function* () {
    try {
      yield { type: "snapshot", draft: snapshot };
      yield* ch;
    } finally {
      // A closed tab must not leave a channel accumulating events forever.
      job.subscribers.delete(ch);
    }
  })();
}

function publish(job: Job, event: DraftEvent) {
  for (const ch of job.subscribers) ch.push(event);
}

/** Persists a change and mirrors it onto the job's snapshot. Never call this
 *  from inside a `withWriteLock` section — it takes the lock itself. */
async function patch(deps: JobDeps, job: Job, values: Partial<Draft>) {
  await withWriteLock(() =>
    deps.db.update(drafts).set(values).where(eq(drafts.id, job.draft.id))
  );
  job.draft = { ...job.draft, ...values };
}

/** Filled in by Task 5. */
function startImageStage(_deps: JobDeps, _job: Job, _prompt: string): void {}

export function startGenerationJob(
  deps: JobDeps,
  draft: Draft,
  nativeLanguage: string,
): Promise<void> {
  const job: Job = {
    draft,
    subscribers: new Set(),
    abort: new AbortController(),
    imageAttempt: 0,
    imageStages: [],
    noteId: null,
  };
  jobs.set(draft.id, job);
  return run(deps, job, nativeLanguage);
}

async function run(deps: JobDeps, job: Job, nativeLanguage: string) {
  try {
    const events = generateNote(
      { text: job.draft.sourceText, nativeLanguage },
      deps.modelCalls,
    );

    for await (const event of events) {
      // Checked per event rather than passed into the model call: the point
      // of an abort is to stop WRITING, and a discarded draft's row is gone.
      if (job.abort.signal.aborted) return;

      switch (event.type) {
        case "classified":
          await patch(deps, job, { classification: event.classification });
          publish(job, event);
          break;

        case "image-prompt":
          await patch(deps, job, {
            imagePrompt: event.prompt,
            imageStatus: event.prompt ? "generating" : "none",
          });
          publish(job, event);
          if (event.prompt) startImageStage(deps, job, event.prompt);
          break;

        case "cards":
          // In memory only. A snapshot every few deltas is what the polling
          // design was rejected for; the row gets the validated cards once.
          job.draft = { ...job.draft, cards: event.cards };
          publish(job, event);
          break;

        case "retry":
          // The discarded attempt's image prompt goes with it, so anything
          // started from it is superseded here rather than allowed to land.
          job.imageAttempt++;
          job.draft = { ...job.draft, cards: [] };
          publish(job, event);
          break;

        case "done":
          await patch(deps, job, {
            status: "ready",
            classification: event.classification,
            cards: event.generation.cards,
            imagePrompt: event.generation.imagePrompt,
          });
          publish(job, event);
          // Safety net: if the model never emitted a `cards` key mid-stream —
          // malformed output that still validated at the end — no
          // `image-prompt` event fired and no stage started.
          if (event.generation.imagePrompt && job.draft.imageStatus === "none") {
            await patch(deps, job, { imageStatus: "generating" });
            startImageStage(deps, job, event.generation.imagePrompt);
          }
          break;
      }
    }
  } catch (error) {
    // The provider's own words stay in the log. The row holds only what is
    // safe to render, the same split `ai.generateNote` made.
    console.error("draft generation failed", error);
    if (!job.abort.signal.aborted) {
      const message = "Generation failed";
      await patch(deps, job, { status: "failed", error: message });
      publish(job, { type: "failed", message });
    }
  } finally {
    // The image routinely outlives the cards now, and `claimJobForNote` has
    // to be able to find the job until it settles.
    await Promise.all(job.imageStages);
    jobs.delete(job.draft.id);
    for (const ch of job.subscribers) ch.close();
  }
}

const RESTARTED = "The server restarted while this was generating.";

/**
 * Every in-flight job died with the process. The two columns are reconciled
 * independently because the two stages are independent: a draft whose cards
 * finished and whose picture was still rendering comes back `ready` with a
 * failed image and a working retry, not failed outright.
 */
export async function reconcileOrphanedDrafts(db: Db): Promise<number> {
  const orphaned = await db
    .select()
    .from(drafts)
    .where(or(eq(drafts.status, "generating"), eq(drafts.imageStatus, "generating")));

  for (const draft of orphaned) {
    await withWriteLock(() =>
      db
        .update(drafts)
        .set({
          status: draft.status === "generating" ? "failed" : draft.status,
          error: draft.status === "generating" ? RESTARTED : draft.error,
          imageStatus: draft.imageStatus === "generating" ? "failed" : draft.imageStatus,
        })
        .where(eq(drafts.id, draft.id))
    );
  }

  return orphaned.length;
}

/** Reconciles a single row read outside the boot sweep — a `generating` row
 *  with no live job behind it. Returns the row as it now stands. */
export async function reconcileDraft(db: Db, draft: Draft): Promise<Draft> {
  if (draft.status !== "generating" && draft.imageStatus !== "generating") {
    return draft;
  }
  const values = {
    status: draft.status === "generating" ? ("failed" as const) : draft.status,
    error: draft.status === "generating" ? RESTARTED : draft.error,
    imageStatus:
      draft.imageStatus === "generating" ? ("failed" as const) : draft.imageStatus,
  };
  await withWriteLock(() =>
    db.update(drafts).set(values).where(and(eq(drafts.id, draft.id)))
  );
  return { ...draft, ...values };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test server/ai/jobs.test.ts`
Expected: PASS, seven tests.

If "stops writing once the job is aborted" is flaky, the abort landed after the first `patch`. Make the fake `classify` await a promise the test resolves, so the abort is deterministic — do not weaken the assertion.

- [ ] **Step 5: Type-check and commit**

```bash
deno task check:api
git add server/ai/jobs.ts server/ai/jobs.test.ts
git commit -m "feat(ai): run card generation as a detached job"
```

---

### Task 5: The image stage and the retarget settle

Implements spec §3.2 (image half) and §3.3.

**Files:**
- Modify: `server/ai/jobs.ts`
- Modify: `server/ai/jobs.test.ts`
- Modify: `server/images.ts` (add `removeDraftImage`, `setNoteImageFailed`)
- Modify: `server/images.test.ts`

**Interfaces:**
- Consumes: `JobDeps` (Task 4).
- Produces: `startImageJob(deps, draft): Promise<void>` for `drafts.retryImage`; `removeDraftImage(userId, draftId)` and `setNoteImageFailed(db, userId, noteId, failed)` from `server/images.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `server/images.test.ts`:

```ts
describe("removeDraftImage", () => {
  it("deletes the file and tolerates it already being gone", async () => {
    const { removeDraftImage, writeDraftImage } = await import("./images.ts");
    const draftId = await writeDraftImage("u1", PNG);

    await removeDraftImage("u1", draftId);
    expect(existsSync(join(dir, "drafts", "u1", `${draftId}.png`))).toBe(false);

    // A discard racing a sweep must not throw.
    await expect(removeDraftImage("u1", draftId)).resolves.toBeUndefined();
  });
});
```

Add to `server/ai/jobs.test.ts`:

```ts
describe("the image stage", () => {
  it("stores the picture on the draft when the draft is still there", async () => {
    const draft = await seedDraft();
    await startGenerationJob(
      deps({ writeDraftImage: vi.fn(async () => "img-1") }),
      draft,
      "en",
    );

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row.imageStatus).toBe("ready");
    expect(row.draftImageId).toBe("img-1");
  });

  it("records a failed picture without touching the cards", async () => {
    const draft = await seedDraft();
    await startGenerationJob(
      deps({
        generateImageBytes: vi.fn(async () => {
          throw new Error("image provider exploded");
        }),
      }),
      draft,
      "en",
    );

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row.status).toBe("ready");
    expect(row.cards).toEqual([CARD]);
    expect(row.imageStatus).toBe("failed");
  });

  it("claims the picture onto the note when the draft was saved first", async () => {
    const draft = await seedDraft();
    const claimDraftImage = vi.fn(async () => "u1/note-1.png");
    // Held open so the save lands while the image is still rendering.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const run = startGenerationJob(
      deps({
        claimDraftImage,
        generateImageBytes: vi.fn(async () => {
          await gate;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    // Wait until the stage is genuinely in flight, then simulate save.
    await vi.waitFor(() => expect(hasJob(draft.id)).toBe(true));
    await vi.waitFor(async () => {
      const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
      expect(row.imageStatus).toBe("generating");
    });
    expect(claimJobForNote(draft.id, "note-1")).toBe(true);
    await db.delete(drafts).where(eq(drafts.id, draft.id));
    release();
    await run;

    expect(claimDraftImage).toHaveBeenCalledWith("u1", expect.any(String), "note-1");
  });

  it("deletes the picture when the draft was discarded", async () => {
    const draft = await seedDraft();
    const removeDraftImage = vi.fn(async () => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const run = startGenerationJob(
      deps({
        removeDraftImage,
        generateImageBytes: vi.fn(async () => {
          await gate;
          return new Uint8Array([1]);
        }),
      }),
      draft,
      "en",
    );

    await vi.waitFor(async () => {
      const [row] = await db.select().from(drafts).where(eq(drafts.id, draft.id));
      expect(row.imageStatus).toBe("generating");
    });
    await db.delete(drafts).where(eq(drafts.id, draft.id));
    release();
    await run;

    expect(removeDraftImage).toHaveBeenCalledWith("u1", expect.any(String));
  });
});
```

Import `claimJobForNote` and `startImageJob` at the top of the test file alongside the others.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test server/ai/jobs.test.ts server/images.test.ts`
Expected: FAIL — `imageStatus` stays `"generating"`; `removeDraftImage` is not exported.

- [ ] **Step 3: Add the two `images.ts` helpers**

In `server/images.ts`, after `claimDraftImage`:

```ts
/** Deletes a draft's file. A miss is not an error: a discard racing the sweep,
 *  or a stage settling after its file was already claimed, both land here. */
export async function removeDraftImage(
  userId: string,
  draftId: string,
): Promise<void> {
  try {
    await Deno.remove(`${DRAFTS_DIR}/${userId}/${draftId}.png`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * Records — or clears — "a picture was wanted and did not arrive" on a note.
 *
 * A read-modify-write on a JSON column, and deliberately WITHOUT its own
 * write lock: one caller runs inside a locked section already (the image
 * stage's settle) and nesting `withWriteLock` deadlocks. Callers that are not
 * already holding it must wrap this.
 */
export async function setNoteImageFailed(
  db: Db,
  userId: string,
  noteId: string,
  failed: boolean,
): Promise<void> {
  const [row] = await db
    .select({ metadata: notes.metadata })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);
  if (!row) return;

  const { imageFailed: _dropped, ...rest } = row.metadata;
  await db
    .update(notes)
    .set({ metadata: failed ? { ...rest, imageFailed: true } : rest })
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)));
}
```

Then replace `setImageFailed` in `server/router/ai.ts` with a call to it, keeping the lock at that call site:

```ts
import { setNoteImageFailed, writeImage, writeDraftImage } from "../images.ts";

async function setImageFailed(
  context: { db: Db },
  userId: string,
  noteId: string,
  failed: boolean,
) {
  await withWriteLock(() =>
    setNoteImageFailed(context.db, userId, noteId, failed)
  );
}
```

- [ ] **Step 4: Implement the image stage**

In `server/ai/jobs.ts`, replace the stub with:

```ts
function startImageStage(deps: JobDeps, job: Job, prompt: string): void {
  const attempt = ++job.imageAttempt;
  job.imageStages.push(
    runImageStage(deps, job, prompt, attempt).catch((error) => {
      // The settle already reported every failure it could classify; this
      // catch exists so an unexpected one cannot become an unhandled
      // rejection that takes the process down.
      console.error("draft image stage failed", error);
    }),
  );
}

async function runImageStage(
  deps: JobDeps,
  job: Job,
  prompt: string,
  attempt: number,
) {
  let bytes: Uint8Array;
  try {
    bytes = await deps.generateImageBytes(prompt);
  } catch (error) {
    console.error("draft image generation failed", error);
    if (attempt !== job.imageAttempt || job.abort.signal.aborted) return;
    await patch(deps, job, { imageStatus: "failed" });
    publish(job, { type: "image", status: "failed", draftImageId: null });
    return;
  }

  // A retry discarded the attempt this prompt came from. The bytes were paid
  // for the moment the request went out — OpenRouter's image endpoint takes
  // no abort signal — so discarding on arrival is the honest description of
  // what happens, and retries are rare enough not to warrant more.
  if (attempt !== job.imageAttempt) return;

  const draftImageId = await deps.writeDraftImage(job.draft.userId, bytes);

  // The settle. One locked read-then-write, which is what makes this and
  // `notes.save` unable to interleave: whichever takes the lock first, the
  // other sees a settled world. See the spec's §3.3.
  //
  // Every write in here uses `deps.db` directly. Calling `patch` would nest
  // withWriteLock inside itself and deadlock.
  await withWriteLock(async () => {
    const [row] = await deps.db
      .select()
      .from(drafts)
      .where(eq(drafts.id, job.draft.id))
      .limit(1);

    if (row) {
      await deps.db
        .update(drafts)
        .set({ imageStatus: "ready", draftImageId })
        .where(eq(drafts.id, job.draft.id));
      job.draft = { ...job.draft, imageStatus: "ready", draftImageId };
      publish(job, { type: "image", status: "ready", draftImageId });
      return;
    }

    // The row is gone. Either it was saved — in which case `claimJobForNote`
    // left us a destination — or it was discarded and this file has no owner.
    if (job.noteId) {
      try {
        const imagePath = await deps.claimDraftImage(
          job.draft.userId,
          draftImageId,
          job.noteId,
        );
        await deps.db
          .update(notes)
          .set({ imagePath })
          .where(eq(notes.id, job.noteId));
      } catch (error) {
        // The bytes exist but could not be attached. The note is still a
        // valid note; it just has no picture, and its screen offers a retry.
        console.error("could not attach the image to its note", error);
        await setNoteImageFailed(deps.db, job.draft.userId, job.noteId, true);
      }
      return;
    }

    await deps.removeDraftImage(job.draft.userId, draftImageId);
  });
}
```

Add to `jobs.ts`'s imports: `notes` from `../db/schema.ts`, and
`setNoteImageFailed` from `../images.ts`.

Then add the image-only job used by `drafts.retryImage`:

```ts
/**
 * Restarts just the picture, for a draft whose cards are already settled.
 *
 * A full Job rather than a bare promise, so a retry is subscribable and
 * `claimJobForNote` can retarget it exactly like a first attempt.
 */
export function startImageJob(deps: JobDeps, draft: Draft): Promise<void> {
  const existing = jobs.get(draft.id);
  if (existing) {
    if (!existing.draft.imagePrompt) return Promise.resolve();
    startImageStage(deps, existing, existing.draft.imagePrompt);
    return Promise.all(existing.imageStages).then(() => {});
  }

  if (!draft.imagePrompt) return Promise.resolve();

  const job: Job = {
    draft: { ...draft, imageStatus: "generating" },
    subscribers: new Set(),
    abort: new AbortController(),
    imageAttempt: 0,
    imageStages: [],
    noteId: null,
  };
  jobs.set(draft.id, job);

  return (async () => {
    try {
      await patch(deps, job, { imageStatus: "generating" });
      startImageStage(deps, job, job.draft.imagePrompt!);
      await Promise.all(job.imageStages);
    } finally {
      jobs.delete(job.draft.id);
      for (const ch of job.subscribers) ch.close();
    }
  })();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno task test server/ai/jobs.test.ts server/images.test.ts server/router/ai.test.ts`
Expected: PASS. `server/router/ai.test.ts` must be green unchanged — `setImageFailed` kept its signature.

- [ ] **Step 6: Type-check and commit**

```bash
deno task check:api
git add server/ai/jobs.ts server/ai/jobs.test.ts server/images.ts server/images.test.ts server/router/ai.ts
git commit -m "feat(ai): generate the draft image as a concurrent job stage"
```

---

### Task 6: The `drafts` router

Implements spec §4.1 and §4.2 (everything except `notes.save`).

**Files:**
- Create: `server/router/drafts.ts`
- Test: `server/router/drafts.test.ts`
- Modify: `server/router/base.ts` (move `assertOwnsDeck` here; add job deps to `AppContext`)
- Modify: `server/router/notes.ts` (import `assertOwnsDeck` from `base.ts`)
- Modify: `server/router/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 4, 5.
- Produces: `draftsRouter` with `current`, `start`, `watch`, `update`, `discard`, `retryImage`; `AppContext` gains `removeDraftImage?`.

- [ ] **Step 1: Write the failing tests**

Create `server/router/drafts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer } from "./testing.ts";
import { decksRouter } from "./decks.ts";
import { draftsRouter } from "./drafts.ts";
import { drafts } from "../db/schema.ts";
import type { ModelCalls } from "../ai/generate-note.ts";
import type { AppContext } from "./base.ts";

let server: Awaited<ReturnType<typeof createTestServer>>;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

const CLASSIFICATION = { domain: "language", language: "de", partOfSpeech: "noun" };
const CARD = { aspect: "meaning", front: "die Banane", back: "banana", hint: null };

function fakeCalls(): ModelCalls {
  return {
    classify: async () => CLASSIFICATION,
    async *generate() {
      yield `{"imagePrompt":null,"cards":[`;
      yield `{"aspect":"meaning","front":"die Banane","back":"banana"}]}`;
      return { imagePrompt: null, cards: [CARD] };
    },
  };
}

/** Context with every model and disk seam replaced. */
function draftContext(base: AppContext): AppContext {
  return {
    ...base,
    modelCalls: fakeCalls(),
    generateImageBytes: vi.fn(async () => new Uint8Array([1])),
    writeDraftImage: vi.fn(async () => "img-1"),
    claimDraftImage: vi.fn(async () => "u/n.png"),
    removeDraftImage: vi.fn(async () => {}),
  };
}

async function seedDeck(context: AppContext) {
  return await call(decksRouter.create, { name: "German" }, { context });
}

describe("drafts.start", () => {
  it("creates the draft and runs the generation to completion", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);

    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );

    await vi.waitFor(async () => {
      const [row] = await server.db.select().from(drafts).where(eq(drafts.id, draftId));
      expect(row.status).toBe("ready");
    });

    const [row] = await server.db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row.userId).toBe(ada.userId);
    expect(row.sourceText).toBe("die Banane");
    expect(row.cards).toEqual([CARD]);
    expect(row.imageStatus).toBe("none");
  });

  it("refuses a second draft while one exists", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);

    await call(draftsRouter.start, { deckId: deck.id, text: "a" }, { context });
    await expect(
      call(draftsRouter.start, { deckId: deck.id, text: "b" }, { context }),
    ).rejects.toThrow(ORPCError);
  });

  it("refuses another user's deck before spending a generation", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const bobDeck = await seedDeck(bob.context);
    const context = draftContext(ada.context);

    await expect(
      call(draftsRouter.start, { deckId: bobDeck.id, text: "a" }, { context }),
    ).rejects.toThrow(ORPCError);
    expect(context.modelCalls).toBeDefined();
    expect(await server.db.select().from(drafts)).toHaveLength(0);
  });
});

describe("drafts.current", () => {
  it("returns null when there is no draft, and the row when there is", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    expect(await call(draftsRouter.current, {}, { context })).toBeNull();

    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );

    const current = await call(draftsRouter.current, {}, { context });
    expect(current?.id).toBe(draftId);
  });

  it("never returns another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    await call(draftsRouter.start, { deckId: deck.id, text: "a" }, { context: adaContext });

    expect(
      await call(draftsRouter.current, {}, { context: draftContext(bob.context) }),
    ).toBeNull();
  });
});

describe("drafts.watch", () => {
  it("hands a settled draft its snapshot and stops", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );

    await vi.waitFor(async () => {
      const [row] = await server.db.select().from(drafts).where(eq(drafts.id, draftId));
      expect(row.status).toBe("ready");
    });

    const events = [];
    for await (const event of await call(draftsRouter.watch, { draftId }, { context })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("snapshot");
  });

  it("refuses another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context: adaContext },
    );

    await expect(
      (async () => {
        for await (
          const _ of await call(
            draftsRouter.watch,
            { draftId },
            { context: draftContext(bob.context) },
          )
        ) { /* drained for the rejection */ }
      })(),
    ).rejects.toThrow(ORPCError);
  });
});

describe("drafts.update", () => {
  it("stores edited cards and a changed deck", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const other = await call(decksRouter.create, { name: "Greek" }, { context });
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const [row] = await server.db.select().from(drafts).where(eq(drafts.id, draftId));
      expect(row.status).toBe("ready");
    });

    await call(
      draftsRouter.update,
      {
        draftId,
        deckId: other.id,
        cards: [{ aspect: "meaning", front: "edited", back: "banana", hint: null }],
      },
      { context },
    );

    const [row] = await server.db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row.cards[0].front).toBe("edited");
    expect(row.deckId).toBe(other.id);
  });

  it("refuses another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context: adaContext },
    );

    await expect(
      call(
        draftsRouter.update,
        { draftId, cards: [{ aspect: "a", front: "f", back: "b", hint: null }] },
        { context: draftContext(bob.context) },
      ),
    ).rejects.toThrow(ORPCError);
  });
});

describe("drafts.discard", () => {
  it("removes the row and its picture", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const [row] = await server.db.select().from(drafts).where(eq(drafts.id, draftId));
      expect(row.status).toBe("ready");
    });
    await server.db
      .update(drafts)
      .set({ imageStatus: "ready", draftImageId: "img-1" })
      .where(eq(drafts.id, draftId));

    await call(draftsRouter.discard, { draftId }, { context });

    expect(await server.db.select().from(drafts)).toHaveLength(0);
    expect(context.removeDraftImage).toHaveBeenCalledWith(ada.userId, "img-1");
  });

  it("refuses another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context: adaContext },
    );

    await expect(
      call(draftsRouter.discard, { draftId }, { context: draftContext(bob.context) }),
    ).rejects.toThrow(ORPCError);
    expect(await server.db.select().from(drafts)).toHaveLength(1);
  });
});

describe("drafts.retryImage", () => {
  it("regenerates from the stored prompt", async () => {
    const ada = await server.signIn("ada@example.com");
    const context = draftContext(ada.context);
    const deck = await seedDeck(context);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "die Banane" },
      { context },
    );
    await vi.waitFor(async () => {
      const [row] = await server.db.select().from(drafts).where(eq(drafts.id, draftId));
      expect(row.status).toBe("ready");
    });
    await server.db
      .update(drafts)
      .set({ imagePrompt: "a ripe banana", imageStatus: "failed" })
      .where(eq(drafts.id, draftId));

    await call(draftsRouter.retryImage, { draftId }, { context });

    await vi.waitFor(async () => {
      const [row] = await server.db.select().from(drafts).where(eq(drafts.id, draftId));
      expect(row.imageStatus).toBe("ready");
      expect(row.draftImageId).toBe("img-1");
    });
    expect(context.generateImageBytes).toHaveBeenCalledWith("a ripe banana");
  });

  it("refuses another user's draft", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const adaContext = draftContext(ada.context);
    const deck = await seedDeck(adaContext);
    const { draftId } = await call(
      draftsRouter.start,
      { deckId: deck.id, text: "a" },
      { context: adaContext },
    );

    await expect(
      call(draftsRouter.retryImage, { draftId }, { context: draftContext(bob.context) }),
    ).rejects.toThrow(ORPCError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test server/router/drafts.test.ts`
Expected: FAIL — cannot resolve `./drafts.ts`.

- [ ] **Step 3: Move `assertOwnsDeck` into `base.ts` and widen `AppContext`**

Cut `assertOwnsDeck` out of `server/router/notes.ts` and paste it into `server/router/base.ts` (it needs `and`, `eq` from `drizzle-orm`, `decks` from `../db/schema.ts`, and `Db`). Export it. In `notes.ts`, import it from `./base.ts`.

Add to `AppContext` in `base.ts`:

```ts
  /** Overridden in tests so no file is ever removed from disk. */
  removeDraftImage?: (userId: string, draftId: string) => Promise<void>;
```

- [ ] **Step 4: Write the router**

Create `server/router/drafts.ts`:

```ts
import * as z from "zod";
import { and, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { assertOwnsDeck, authed, notFound } from "./base.ts";
import type { AuthedContext } from "./base.ts";
import { drafts, user } from "../db/schema.ts";
import type { Draft } from "../db/schema.ts";
import { withWriteLock } from "../db/write-lock.ts";
import { openRouterCalls } from "../ai/model-calls.ts";
import { generateImageBytes } from "./ai.ts";
import {
  claimDraftImage,
  removeDraftImage,
  writeDraftImage,
} from "../images.ts";
import {
  abortJob,
  reconcileDraft,
  startGenerationJob,
  startImageJob,
  subscribe,
} from "../ai/jobs.ts";
import type { JobDeps } from "../ai/jobs.ts";

/** Every seam a job needs, resolved from the context so a test can replace
 *  any of them and nothing ever reaches a model or the disk. */
function jobDeps(context: AuthedContext): JobDeps {
  return {
    db: context.db,
    modelCalls: context.modelCalls ?? openRouterCalls,
    generateImageBytes: context.generateImageBytes ?? generateImageBytes,
    writeDraftImage: context.writeDraftImage ?? writeDraftImage,
    claimDraftImage: context.claimDraftImage ?? claimDraftImage,
    removeDraftImage: context.removeDraftImage ?? removeDraftImage,
  };
}

/** Reads this user's draft by id, or reports it missing. Ownership is checked
 *  here and nowhere else, so no procedure can forget it. */
async function ownDraft(context: AuthedContext, draftId: string): Promise<Draft> {
  const [draft] = await context.db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, context.userId)))
    .limit(1);
  if (!draft) throw notFound("Draft not found");
  return draft;
}

const draftCardSchema = z.object({
  aspect: z.string().min(1),
  front: z.string(),
  back: z.string(),
  hint: z.string().nullable(),
});

const current = authed.handler(async ({ context }) => {
  const [draft] = await context.db
    .select()
    .from(drafts)
    .where(eq(drafts.userId, context.userId))
    .limit(1);
  return draft ?? null;
});

const start = authed
  .input(
    z.object({
      deckId: z.uuidv7(),
      text: z.string().min(1).max(200),
    }),
  )
  .handler(async ({ input, context }) => {
    await assertOwnsDeck(context.db, context.userId, input.deckId);

    // The generation prompt needs it and the client must not be able to
    // choose it, so it comes from the row rather than from the input.
    const [owner] = await context.db
      .select({ nativeLanguage: user.nativeLanguage })
      .from(user)
      .where(eq(user.id, context.userId))
      .limit(1);

    // Check-then-insert inside ONE locked section, so two concurrent starts
    // serialise here rather than racing to the unique index. The index is
    // still the real guarantee; this is what turns a violation into a clean
    // CONFLICT instead of a driver error string.
    const draft = await withWriteLock(async () => {
      const [existing] = await context.db
        .select({ id: drafts.id })
        .from(drafts)
        .where(eq(drafts.userId, context.userId))
        .limit(1);
      if (existing) {
        throw new ORPCError("CONFLICT", {
          message: "You already have a draft in progress",
        });
      }

      const [inserted] = await context.db
        .insert(drafts)
        .values({
          userId: context.userId,
          deckId: input.deckId,
          sourceText: input.text,
          status: "generating",
        })
        .returning();
      return inserted;
    });

    // Deliberately not awaited: the job outliving this request is the whole
    // feature. Its own `catch` records the failure on the row, so there is
    // nothing here that could be lost by letting it run.
    void startGenerationJob(
      jobDeps(context),
      draft,
      owner?.nativeLanguage ?? "en",
    );

    return { draftId: draft.id };
  });

const watch = authed
  .input(z.object({ draftId: z.uuidv7() }))
  .handler(async function* ({ input, context }) {
    const draft = await ownDraft(context, input.draftId);

    // The lookup is inside `subscribe`, so there is no window between
    // "is there a job?" and "attach to it".
    const live = subscribe(draft.id);
    if (live) {
      yield* live;
      return;
    }

    // No job. Either the generation settled — in which case the row is the
    // whole truth — or the process restarted underneath it.
    yield {
      type: "snapshot" as const,
      draft: await reconcileDraft(context.db, draft),
    };
  });

const update = authed
  .input(
    z.object({
      draftId: z.uuidv7(),
      deckId: z.uuidv7().optional(),
      cards: z.array(draftCardSchema).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const draft = await ownDraft(context, input.draftId);
    if (draft.status === "generating") {
      // The job owns `cards` until it is done; a write here would be
      // overwritten by the next snapshot without anyone noticing.
      throw new ORPCError("CONFLICT", {
        message: "This draft is still generating",
      });
    }
    if (input.deckId) {
      await assertOwnsDeck(context.db, context.userId, input.deckId);
    }

    await withWriteLock(() =>
      context.db
        .update(drafts)
        .set({
          ...(input.deckId ? { deckId: input.deckId } : {}),
          ...(input.cards ? { cards: input.cards } : {}),
        })
        .where(eq(drafts.id, draft.id))
    );

    return { ok: true };
  });

const discard = authed
  .input(z.object({ draftId: z.uuidv7() }))
  .handler(async ({ input, context }) => {
    const draft = await ownDraft(context, input.draftId);

    // Abort first: a stage that settles after the row is gone takes the
    // "discarded" branch and deletes its own file, which is what keeps a
    // discard-during-generation from orphaning bytes.
    abortJob(draft.id);
    await withWriteLock(() =>
      context.db.delete(drafts).where(eq(drafts.id, draft.id))
    );

    if (draft.draftImageId) {
      await (context.removeDraftImage ?? removeDraftImage)(
        context.userId,
        draft.draftImageId,
      );
    }

    return { ok: true };
  });

const retryImage = authed
  .input(z.object({ draftId: z.uuidv7() }))
  .handler(async ({ input, context }) => {
    const draft = await ownDraft(context, input.draftId);
    if (!draft.imagePrompt) {
      throw new ORPCError("CONFLICT", {
        message: "This draft has no picture to generate",
      });
    }

    void startImageJob(jobDeps(context), draft);
    return { ok: true };
  });

export const draftsRouter = { current, start, watch, update, discard, retryImage };
```

Register it in `server/router/index.ts`:

```ts
import { draftsRouter } from "./drafts.ts";

export const router = {
  decks: decksRouter,
  drafts: draftsRouter,
  notes: notesRouter,
  cards: cardsRouter,
  ai: aiRouter,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno task test server/router`
Expected: PASS, including `notes.test.ts` and `ai.test.ts` unchanged.

- [ ] **Step 6: Type-check and commit**

```bash
deno task check:api
git add server/router
git commit -m "feat(api): add the drafts router"
```

---

### Task 7: Sweep exemption and boot reconcile

Implements spec §1.4 (wiring) and §1.5.

**Files:**
- Modify: `server/images.ts`
- Modify: `server/images.test.ts`
- Modify: `server/main.ts`

**Interfaces:**
- Consumes: `reconcileOrphanedDrafts` (Task 4).
- Produces: `sweepDrafts(maxAgeMs, referenced: Set<string>, now?: number)`.

- [ ] **Step 1: Write the failing test**

Add to `server/images.test.ts`, inside the existing `sweepDrafts` describe:

```ts
it("keeps a file a live draft still points at, however old", async () => {
  const { sweepDrafts, writeDraftImage } = await import("./images.ts");
  const kept = await writeDraftImage("u1", PNG);
  const dropped = await writeDraftImage("u1", PNG);

  const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const id of [kept, dropped]) {
    utimesSync(join(dir, "drafts", "u1", `${id}.png`), ancient, ancient);
  }

  const deleted = await sweepDrafts(24 * 60 * 60 * 1000, new Set([kept]));

  expect(deleted).toBe(1);
  expect(existsSync(join(dir, "drafts", "u1", `${kept}.png`))).toBe(true);
  expect(existsSync(join(dir, "drafts", "u1", `${dropped}.png`))).toBe(false);
});
```

Update the file's existing `sweepDrafts` calls to pass `new Set()` as the second argument.

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/images.test.ts`
Expected: FAIL — the referenced file is deleted; `deleted` is 2.

- [ ] **Step 3: Teach the sweep about live drafts**

In `server/images.ts`, change the signature and add the skip. Replace the doc comment's second paragraph too:

```ts
/**
 * Drafts are the only orphan class this design creates: `notes.save` claims
 * after its transaction commits, so a failed save leaves the file here rather
 * than at a note path no row points at. A discarded draft whose file delete
 * failed lands here too.
 *
 * `referenced` is the set of ids live `drafts` rows point at. A draft row has
 * no TTL — there is at most one per user and the user decides when it goes —
 * so an age check alone would delete the picture out from under a day-old
 * draft.
 *
 * Exported as a plain function, and taking `now`, so it is tested against a
 * temp directory rather than against a clock.
 */
export async function sweepDrafts(
  maxAgeMs: number,
  referenced: Set<string>,
  now: number = Date.now(),
): Promise<number> {
```

and inside the per-file loop, immediately after `if (!entry.isFile) continue;`:

```ts
      if (referenced.has(entry.name.replace(/\.png$/, ""))) continue;
```

- [ ] **Step 4: Wire `main.ts`**

Replace `server/main.ts`'s sweep block:

```ts
import { createApp } from "./app.ts";
import { auth } from "./auth.instance.ts";
import { db } from "./db/index.ts";
import { drafts } from "./db/schema.ts";
import { isNotNull } from "drizzle-orm";
import { sweepDrafts } from "./images.ts";
import { reconcileOrphanedDrafts } from "./ai/jobs.ts";

const port = Number(Deno.env.get("PORT") ?? 8787);
const app = createApp({ db, auth });

/** A draft image nobody claimed and no draft row points at is dead weight.
 *  Generous, because the only cost of keeping one an hour longer is disk. */
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function sweep() {
  const rows = await db
    .select({ draftImageId: drafts.draftImageId })
    .from(drafts)
    .where(isNotNull(drafts.draftImageId));
  const referenced = new Set(rows.map((row) => row.draftImageId as string));
  await sweepDrafts(DRAFT_MAX_AGE_MS, referenced);
}

function scheduleSweep() {
  sweep().catch((error) => console.error("draft sweep failed", error));
}

// Every job died with the last process. Nothing pretends to still be running.
reconcileOrphanedDrafts(db)
  .then((count) => {
    if (count > 0) console.log(`reconciled ${count} orphaned draft(s)`);
  })
  .catch((error) => console.error("draft reconcile failed", error));

scheduleSweep();
setInterval(scheduleSweep, SWEEP_INTERVAL_MS);

Deno.serve({ port }, app.fetch);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno task test server`
Expected: PASS.

- [ ] **Step 6: Type-check and commit**

```bash
deno task check:api
git add server/images.ts server/images.test.ts server/main.ts
git commit -m "feat(server): reconcile orphaned drafts and exempt live ones from the sweep"
```

---

### Task 8: Client transport — `drafts.ts` and `watch-draft.ts`

Implements spec §5.2. Both modules are unused until Task 10; that is deliberate.

**Files:**
- Create: `src/lib/api/session-error.ts`
- Create: `src/lib/api/drafts.ts`
- Create: `src/lib/watch-draft.ts`
- Test: `src/lib/watch-draft.test.ts`
- Modify: `src/lib/api/ai.ts` (import `asSessionError` from its new home)

**Interfaces:**
- Consumes: `orpc` / `client` from `@/lib/orpc`; `DraftEvent` from `~server/ai/jobs`.
- Produces:
  ```ts
  // src/lib/api/drafts.ts
  export type { Draft, DraftCard, DraftStatus, DraftImageStatus } from "~server/db/schema";
  export type { DraftEvent } from "~server/ai/jobs";
  export function useCurrentDraft(): UseQueryResult<Draft | null>;
  export function useStartDraft(): UseMutationResult<...>;
  export function useDiscardDraft(): UseMutationResult<...>;
  export function useRetryDraftImage(): UseMutationResult<...>;
  export function updateDraft(input: {
    draftId: string; deckId?: string; cards?: DraftCard[];
  }): Promise<{ ok: true }>;
  export function watchDraft(
    draftId: string, signal: AbortSignal,
  ): AsyncGenerator<DraftEvent>;
  export const draftsKey: () => readonly unknown[];

  // src/lib/watch-draft.ts
  export const MAX_RECONNECTS = 3;
  export function runDraftWatch(
    draftId: string,
    open: (draftId: string, signal: AbortSignal) => AsyncIterable<DraftEvent>,
    dispatch: (event: DraftEvent) => void,
    signal: AbortSignal,
    sleep?: (ms: number) => Promise<void>,
  ): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/watch-draft.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { MAX_RECONNECTS, runDraftWatch } from "@/lib/watch-draft";
import { SessionExpiredError } from "@/lib/session-expired";
import type { DraftEvent } from "@/lib/api/drafts";

const SNAPSHOT = { type: "snapshot" } as unknown as DraftEvent;
const DONE = { type: "done" } as unknown as DraftEvent;

/** Never actually waits — reconnect backoff is not what these test. */
const noSleep = async () => {};

function stream(...events: DraftEvent[]) {
  return async function* () {
    for (const event of events) yield event;
  }();
}

describe("runDraftWatch", () => {
  it("dispatches every event and stops on a clean end", async () => {
    const dispatch = vi.fn();
    const open = vi.fn(() => stream(SNAPSHOT, DONE));

    await runDraftWatch("d1", open, dispatch, new AbortController().signal, noSleep);

    expect(open).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.map(([e]) => e)).toEqual([SNAPSHOT, DONE]);
  });

  it("reopens the stream when the connection drops", async () => {
    const dispatch = vi.fn();
    const open = vi
      .fn()
      .mockImplementationOnce(() =>
        (async function* () {
          yield SNAPSHOT;
          throw new Error("connection lost");
        })()
      )
      .mockImplementationOnce(() => stream(DONE));

    await runDraftWatch("d1", open, dispatch, new AbortController().signal, noSleep);

    expect(open).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map(([e]) => e)).toEqual([SNAPSHOT, DONE]);
  });

  it("gives up after the reconnect budget and says so", async () => {
    const dispatch = vi.fn();
    const open = vi.fn(() =>
      (async function* (): AsyncGenerator<DraftEvent> {
        throw new Error("connection lost");
      })()
    );

    await runDraftWatch("d1", open, dispatch, new AbortController().signal, noSleep);

    expect(open).toHaveBeenCalledTimes(MAX_RECONNECTS + 1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "failed",
      message: expect.stringContaining("connection"),
    });
  });

  it("says nothing when the user cancelled", async () => {
    const dispatch = vi.fn();
    const controller = new AbortController();
    const open = vi.fn(() =>
      (async function* (): AsyncGenerator<DraftEvent> {
        controller.abort();
        throw new Error("aborted");
      })()
    );

    await runDraftWatch("d1", open, dispatch, controller.signal, noSleep);

    expect(open).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not reconnect when the session is gone", async () => {
    const dispatch = vi.fn();
    const open = vi.fn(() =>
      (async function* (): AsyncGenerator<DraftEvent> {
        throw new SessionExpiredError();
      })()
    );

    await runDraftWatch("d1", open, dispatch, new AbortController().signal, noSleep);

    expect(open).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test src/lib/watch-draft.test.ts`
Expected: FAIL — cannot resolve `@/lib/watch-draft`.

- [ ] **Step 3: Extract `asSessionError`**

Create `src/lib/api/session-error.ts` with the function moved verbatim from `src/lib/api/ai.ts` (including its comment), then in `ai.ts` delete the local copy and `import { asSessionError } from "@/lib/api/session-error";`.

- [ ] **Step 4: Write the draft API module**

Create `src/lib/api/drafts.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "@/lib/orpc";
import { asSessionError } from "@/lib/api/session-error";

// Type-only, so no server module reaches the browser bundle. The wire shape
// is the router's own type; `RouterClient<AppRouter>` keeps the two ends in
// agreement without either restating the other.
export type {
  Draft,
  DraftCard,
  DraftImageStatus,
  DraftStatus,
} from "~server/db/schema";
export type { DraftEvent } from "~server/ai/jobs";

// The `export type` lines above re-export for consumers; these import the same
// types for use inside this module. Both are type-only.
import type { DraftCard } from "~server/db/schema";
import type { DraftEvent } from "~server/ai/jobs";

export const draftsKey = () => orpc.drafts.key();

export function useCurrentDraft() {
  return useQuery(orpc.drafts.current.queryOptions({ input: {} }));
}

export function useStartDraft() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.drafts.start.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: draftsKey() }),
    }),
  );
}

export function useDiscardDraft() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.drafts.discard.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: draftsKey() }),
    }),
  );
}

export function useRetryDraftImage() {
  return useMutation(orpc.drafts.retryImage.mutationOptions({}));
}

/** A plain call rather than a mutation hook: the autosave debounce fires from
 *  a timer that deliberately outlives the component, so binding it to a
 *  hook's lifecycle would defeat the point. */
export async function updateDraft(input: {
  draftId: string;
  deckId?: string;
  cards?: DraftCard[];
}) {
  try {
    return await client.drafts.update(input);
  } catch (error) {
    throw await asSessionError(error);
  }
}

export async function* watchDraft(
  draftId: string,
  signal: AbortSignal,
): AsyncGenerator<DraftEvent> {
  try {
    const events = await client.drafts.watch({ draftId }, { signal });
    for await (const event of events) yield event;
  } catch (error) {
    // A throw out of a watch means one thing — the connection broke — because
    // the server reports a failed generation as an event. `runDraftWatch`
    // relies on that to decide between reconnecting and giving up.
    throw await asSessionError(error);
  }
}
```

- [ ] **Step 5: Write `watch-draft.ts`**

Create `src/lib/watch-draft.ts`:

```ts
import { SessionExpiredError } from "@/lib/session-expired";
import type { DraftEvent } from "@/lib/api/drafts";

/** How many times a dropped stream is reopened before the UI is told. */
export const MAX_RECONNECTS = 3;

const BACKOFF_MS = [500, 1500, 4000];

const DROPPED =
  "The connection dropped and could not be restored — reopen this page to try again.";

/**
 * Drives a draft watch into the reducer, reopening it when the stream drops.
 *
 * Reconnecting is only correct because the job outlives the connection. Under
 * the old design the work died with the request, so a drop was a real failure
 * and the honest response was the hand-editable fallback. Now the only thing
 * a drop tells us is that this socket is gone.
 *
 * That rests on the server's contract: a *failed generation* arrives as a
 * `failed` EVENT, and a throw means the transport broke. Reconnecting on a
 * thrown error is therefore never reconnecting to something that will not
 * come back.
 *
 * `signal.aborted` is checked rather than the error's name or type because
 * that is the one thing guaranteed to be true regardless of how oRPC's
 * `RPCLink` happens to report the abort.
 */
export async function runDraftWatch(
  draftId: string,
  open: (draftId: string, signal: AbortSignal) => AsyncIterable<DraftEvent>,
  dispatch: (event: DraftEvent) => void,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      // A clean end means the server has nothing left to report: the draft is
      // settled. Nothing to reconnect to.
      for await (const event of open(draftId, signal)) dispatch(event);
      return;
    } catch (error) {
      // A cancel is not a failure, and the reducer has already been reset.
      if (signal.aborted) return;
      // The route guard is already navigating to /login. Reporting a
      // generation failure here would offer the wrong remedy for the one
      // failure that has a real fix.
      if (error instanceof SessionExpiredError) return;

      if (attempt >= MAX_RECONNECTS) {
        dispatch({ type: "failed", message: DROPPED });
        return;
      }
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    }
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `deno task test src/lib/watch-draft.test.ts`
Expected: PASS, five tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api/session-error.ts src/lib/api/drafts.ts src/lib/api/ai.ts src/lib/watch-draft.ts src/lib/watch-draft.test.ts
git commit -m "feat(client): add draft transport with reconnecting watch"
```

---

### Task 9: The reducer and the status line

Implements spec §5.1. Still unused; Task 10 wires it in.

**Files:**
- Create: `src/lib/draft-state.ts`
- Test: `src/lib/draft-state.test.ts`
- Create: `src/lib/draft-status.ts`
- Test: `src/lib/draft-status.test.ts`

**Interfaces:**
- Consumes: `Draft`, `DraftCard`, `DraftEvent` from `@/lib/api/drafts`.
- Produces:
  ```ts
  export type DraftState =
    | { status: "loading" }
    | { status: "none" }
    | {
        status: "generating" | "ready" | "failed";
        draftId: string;
        deckId: string;
        text: string;
        startedAt: number;
        classification: DraftClassification | null;
        cards: DraftCard[];
        retried: boolean;
        imagePrompt: string | null;
        imageStatus: DraftImageStatus;
        draftImageId: string | null;
        error: string | null;
      };
  export type DraftAction =
    | DraftEvent
    | { type: "loaded"; draft: Draft | null }
    | { type: "edit-card"; index: number; patch: Partial<DraftCard> }
    | { type: "remove-card"; index: number }
    | { type: "deck-changed"; deckId: string };
  export const initialDraftState: DraftState;
  export function draftReducer(s: DraftState, a: DraftAction): DraftState;
  export function isSavable(state: DraftState): boolean;

  // draft-status.ts
  export function formatElapsed(ms: number): string;
  export function draftStatusText(state: DraftState): string;
  ```

- [ ] **Step 1: Write the failing reducer tests**

Create `src/lib/draft-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { draftReducer, initialDraftState, isSavable } from "@/lib/draft-state";
import type { DraftState } from "@/lib/draft-state";
import type { Draft } from "@/lib/api/drafts";

const CLASSIFICATION = { domain: "language", language: "de", partOfSpeech: "noun" };

const ROW: Draft = {
  id: "d1",
  userId: "u1",
  deckId: "deck-1",
  sourceText: "die Banane",
  status: "generating",
  classification: null,
  cards: [],
  imagePrompt: null,
  imageStatus: "none",
  draftImageId: null,
  error: null,
  createdAt: new Date(1000),
};

/** The state a generating draft has just been loaded into. */
function loaded(overrides: Partial<Draft> = {}): DraftState {
  return draftReducer(initialDraftState, {
    type: "loaded",
    draft: { ...ROW, ...overrides },
  });
}

describe("draftReducer", () => {
  it("starts loading and settles on none when there is no draft", () => {
    expect(initialDraftState).toEqual({ status: "loading" });
    expect(
      draftReducer(initialDraftState, { type: "loaded", draft: null }),
    ).toEqual({ status: "none" });
  });

  it("seeds every field from the row", () => {
    const state = loaded({ status: "ready", classification: CLASSIFICATION });
    expect(state).toMatchObject({
      status: "ready",
      draftId: "d1",
      deckId: "deck-1",
      text: "die Banane",
      startedAt: 1000,
      classification: CLASSIFICATION,
      retried: false,
    });
  });

  it("re-seeds from a snapshot event, so a reconnect cannot drift", () => {
    const state = draftReducer(loaded(), {
      type: "snapshot",
      draft: { ...ROW, status: "ready", cards: [{ aspect: "a", front: "f", back: "b", hint: null }] },
    });
    expect(state).toMatchObject({ status: "ready" });
    expect(state.status !== "loading" && state.status !== "none" && state.cards).toHaveLength(1);
  });

  it("applies classification, prompt, cards and completion in order", () => {
    let state = loaded();
    state = draftReducer(state, { type: "classified", classification: CLASSIFICATION });
    state = draftReducer(state, { type: "image-prompt", prompt: "a ripe banana" });
    state = draftReducer(state, {
      type: "cards",
      cards: [{ aspect: "meaning", front: null, back: null }],
    });
    state = draftReducer(state, {
      type: "done",
      classification: CLASSIFICATION,
      generation: {
        imagePrompt: "a ripe banana",
        cards: [{ aspect: "meaning", front: "die Banane", back: "banana", hint: null }],
      },
    });

    expect(state).toMatchObject({
      status: "ready",
      classification: CLASSIFICATION,
      imagePrompt: "a ripe banana",
      imageStatus: "generating",
    });
  });

  it("clears the cards on a retry but keeps the clock and the classification", () => {
    let state = loaded();
    state = draftReducer(state, { type: "classified", classification: CLASSIFICATION });
    state = draftReducer(state, {
      type: "cards",
      cards: [{ aspect: "meaning", front: "x", back: null }],
    });
    state = draftReducer(state, { type: "retry" });

    expect(state).toMatchObject({
      status: "generating",
      cards: [],
      retried: true,
      startedAt: 1000,
      classification: CLASSIFICATION,
    });
  });

  it("falls back to a hand-editable card on failure, never a dead end", () => {
    const state = draftReducer(loaded(), {
      type: "failed",
      message: "Generation failed",
    });

    expect(state).toMatchObject({
      status: "failed",
      cards: [{ aspect: "meaning", front: "die Banane", back: "", hint: null }],
    });
    expect(state.status === "failed" && state.error).toContain(
      "you can still write the card yourself",
    );
  });

  it("keeps a failure from clobbering cards that already arrived", () => {
    let state = loaded({ status: "ready" });
    state = draftReducer(state, {
      type: "done",
      classification: CLASSIFICATION,
      generation: {
        imagePrompt: null,
        cards: [{ aspect: "meaning", front: "die Banane", back: "banana", hint: null }],
      },
    });
    state = draftReducer(state, { type: "failed", message: "The connection dropped" });

    expect(state.status === "failed" && state.cards).toHaveLength(1);
    expect(state.status === "failed" && state.cards[0].back).toBe("banana");
  });

  it("tracks the picture independently of the cards", () => {
    let state = loaded({ status: "ready", imageStatus: "generating" });
    state = draftReducer(state, {
      type: "image",
      status: "ready",
      draftImageId: "img-1",
    });
    expect(state).toMatchObject({
      status: "ready",
      imageStatus: "ready",
      draftImageId: "img-1",
    });
  });

  it("edits and removes cards only once they are editable", () => {
    const generating = draftReducer(loaded(), {
      type: "edit-card",
      index: 0,
      patch: { front: "nope" },
    });
    expect(generating).toMatchObject({ status: "generating", cards: [] });

    let ready = loaded({
      status: "ready",
      cards: [
        { aspect: "a", front: "f1", back: "b1", hint: null },
        { aspect: "b", front: "f2", back: "b2", hint: null },
      ],
    });
    ready = draftReducer(ready, { type: "edit-card", index: 0, patch: { front: "edited" } });
    ready = draftReducer(ready, { type: "remove-card", index: 1 });

    expect(ready.status === "ready" && ready.cards).toEqual([
      { aspect: "a", front: "edited", back: "b1", hint: null },
    ]);
  });
});

describe("isSavable", () => {
  it("is false while generating, while blank, and while empty", () => {
    expect(isSavable(loaded())).toBe(false);
    expect(
      isSavable(loaded({ status: "ready", cards: [] })),
    ).toBe(false);
    expect(
      isSavable(loaded({
        status: "ready",
        cards: [{ aspect: "a", front: " ", back: "b", hint: null }],
      })),
    ).toBe(false);
  });

  it("is true for a ready draft with complete cards, image or no image", () => {
    expect(
      isSavable(loaded({
        status: "ready",
        imageStatus: "generating",
        cards: [{ aspect: "a", front: "f", back: "b", hint: null }],
      })),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test src/lib/draft-state.test.ts`
Expected: FAIL — cannot resolve `@/lib/draft-state`.

- [ ] **Step 3: Write the reducer**

Create `src/lib/draft-state.ts`:

```ts
import type {
  Draft,
  DraftCard,
  DraftEvent,
  DraftImageStatus,
} from "@/lib/api/drafts";
import type { DraftClassification } from "~server/db/schema";

export type DraftState =
  | { status: "loading" }
  | { status: "none" }
  | {
      status: "generating" | "ready" | "failed";
      draftId: string;
      deckId: string;
      text: string;
      /** The row's createdAt, so the clock survives a reload rather than
       *  restarting from whenever this tab happened to open. */
      startedAt: number;
      classification: DraftClassification | null;
      cards: DraftCard[];
      /** True once a validation failure discarded a first attempt. */
      retried: boolean;
      imagePrompt: string | null;
      imageStatus: DraftImageStatus;
      draftImageId: string | null;
      error: string | null;
    };

export type LiveDraftState = Extract<
  DraftState,
  { status: "generating" | "ready" | "failed" }
>;

export type DraftAction =
  | DraftEvent
  | { type: "loaded"; draft: Draft | null }
  | { type: "edit-card"; index: number; patch: Partial<DraftCard> }
  | { type: "remove-card"; index: number }
  | { type: "deck-changed"; deckId: string };

export const initialDraftState: DraftState = { status: "loading" };

function isLive(state: DraftState): state is LiveDraftState {
  return state.status !== "loading" && state.status !== "none";
}

/** The whole row, projected onto the state. Used for both the initial load and
 *  every `snapshot`, so a reconnect can only ever converge on the server. */
function fromRow(draft: Draft): LiveDraftState {
  return {
    status: draft.status,
    draftId: draft.id,
    deckId: draft.deckId,
    text: draft.sourceText,
    startedAt: new Date(draft.createdAt).getTime(),
    classification: draft.classification,
    cards: draft.cards,
    retried: false,
    imagePrompt: draft.imagePrompt,
    imageStatus: draft.imageStatus,
    draftImageId: draft.draftImageId,
    error: draft.error,
  };
}

export function draftReducer(
  state: DraftState,
  action: DraftAction,
): DraftState {
  switch (action.type) {
    case "loaded":
      return action.draft ? fromRow(action.draft) : { status: "none" };

    case "snapshot":
      return fromRow(action.draft);

    case "classified":
      if (!isLive(state)) return state;
      return { ...state, classification: action.classification };

    case "image-prompt":
      if (!isLive(state)) return state;
      return {
        ...state,
        imagePrompt: action.prompt,
        imageStatus: action.prompt ? "generating" : "none",
      };

    case "cards":
      if (state.status !== "generating") return state;
      return { ...state, cards: action.cards };

    case "retry":
      if (state.status !== "generating") return state;
      // Everything on screen came from an attempt that failed validation, so
      // it is discarded. The clock keeps running: the wait is the real wait.
      return { ...state, cards: [], retried: true };

    case "done":
      if (!isLive(state)) return state;
      return {
        ...state,
        status: "ready",
        classification: action.classification,
        cards: action.generation.cards,
        imagePrompt: action.generation.imagePrompt,
        imageStatus: action.generation.imagePrompt ? "generating" : "none",
        error: null,
      };

    case "image":
      if (!isLive(state)) return state;
      return {
        ...state,
        imageStatus: action.status,
        draftImageId: action.draftImageId ?? state.draftImageId,
      };

    case "failed":
      if (!isLive(state)) return state;
      // Never a dead end: fall through to something editable. Cards that
      // already arrived are kept — a connection that dropped after `done`
      // must not cost the user a finished generation.
      return {
        ...state,
        status: "failed",
        cards: state.cards.length > 0
          ? state.cards
          : [{ aspect: "meaning", front: state.text, back: "", hint: null }],
        error: `${action.message} — you can still write the card yourself.`,
      };

    case "edit-card":
      if (state.status === "generating" || !isLive(state)) return state;
      return {
        ...state,
        cards: state.cards.map((card, index) =>
          index === action.index ? { ...card, ...action.patch } : card,
        ),
      };

    case "remove-card":
      if (state.status === "generating" || !isLive(state)) return state;
      return {
        ...state,
        cards: state.cards.filter((_, index) => index !== action.index),
      };

    case "deck-changed":
      if (!isLive(state)) return state;
      return { ...state, deckId: action.deckId };
  }
}

/** Save is gated on the cards alone. A picture still rendering does not block
 *  it: the note commits without one and the running stage is redirected onto
 *  it (see the spec's §3.3). */
export function isSavable(state: DraftState): boolean {
  if (!isLive(state) || state.status === "generating") return false;
  if (state.cards.length === 0) return false;
  return state.cards.every(
    (card) => (card.front ?? "").trim() !== "" && (card.back ?? "").trim() !== "",
  );
}
```

- [ ] **Step 4: Run the reducer tests**

Run: `deno task test src/lib/draft-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the status tests**

Create `src/lib/draft-status.test.ts`. Port the existing `src/lib/generation-status.test.ts` cases across — same phase wording, same `front !== null` aspect rule, same underscore humanisation, same `formatElapsed` cases at `0:07`, `1:05`, `10:00` — building states with the `loaded()` helper shape from `draft-state.test.ts`, plus:

```ts
it("says nothing at all when there is no draft", () => {
  expect(draftStatusText({ status: "loading" })).toBe("");
  expect(draftStatusText({ status: "none" })).toBe("");
});

it("reports a ready draft by its card count", () => {
  expect(
    draftStatusText(loaded({
      status: "ready",
      cards: [{ aspect: "a", front: "f", back: "b", hint: null }],
    })),
  ).toBe("1 card ready");
});
```

- [ ] **Step 6: Write `draft-status.ts`**

Create `src/lib/draft-status.ts` by porting `src/lib/generation-status.ts` verbatim, with three changes: it imports `DraftState` from `@/lib/draft-state`; `formatElapsed` is unchanged; and `draftStatusText` switches on the new statuses:

```ts
export function draftStatusText(state: DraftState): string {
  switch (state.status) {
    case "loading":
    case "none":
      return "";

    case "generating": {
      if (state.retried && state.cards.length === 0) {
        return "That came back malformed — trying once more…";
      }
      if (!state.classification) return "Working out what this is…";

      const current = state.cards[state.cards.length - 1];
      // Name the aspect only once `front` has started arriving, which proves
      // the aspect string itself finished streaming. Otherwise a half-written
      // label leaks out as "Writing the gen card…".
      if (current?.aspect && current.front !== null) {
        return `Writing the ${humanizeAspect(current.aspect)} card…`;
      }
      return `${describeClassification(state.classification)} — writing cards…`;
    }

    case "failed":
      return "Generation failed";

    case "ready":
      return `${state.cards.length} ${
        state.cards.length === 1 ? "card" : "cards"
      } ready`;
  }
}
```

`describeClassification` and `humanizeAspect` come across unchanged.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `deno task test src/lib`
Expected: PASS, with `generation-state.test.ts` and `generation-status.test.ts` still green — they are deleted in Task 10, not here.

- [ ] **Step 8: Commit**

```bash
git add src/lib/draft-state.ts src/lib/draft-state.test.ts src/lib/draft-status.ts src/lib/draft-status.test.ts
git commit -m "feat(client): add the draft reducer and status line"
```

---

### Task 10: The cutover

Implements spec §4.1 (`notes.save`), §5.1, §5.3, §5.5. This is one task because `notes.save`'s input change and the `/add` rewrite each break the other's types; a reviewer cannot accept one without the other.

**Files:**
- Modify: `server/router/notes.ts`
- Modify: `server/router/notes.test.ts`
- Modify: `src/lib/api/notes.ts`
- Modify: `src/routes/_authed.add.tsx`
- Create: `src/routes/_authed.add.test.tsx`
- Delete: `src/lib/generation-state.ts`, `src/lib/generation-state.test.ts`, `src/lib/generation-status.ts`, `src/lib/generation-status.test.ts`, `src/lib/run-generation.ts`, `src/lib/run-generation.test.ts`, `src/lib/run-draft-image.ts`, `src/lib/run-draft-image.test.ts`, `src/components/generation-status.tsx`
- Create: `src/components/draft-status.tsx` (the status line, moved and renamed)

**Interfaces:**
- Consumes: everything from Tasks 6, 8, 9.
- Produces: `notes.save({ draftId, cards })`.

- [ ] **Step 1: Write the failing server tests**

Rewrite `server/router/notes.test.ts`'s `notes.save` describe against drafts. Replace its `seedNote`-style setup with a helper that creates a ready draft directly:

```ts
async function seedDraft(
  context: AppContext,
  userId: string,
  overrides: Partial<typeof drafts.$inferInsert> = {},
) {
  const deck = await call(decksRouter.create, { name: "German" }, { context });
  const [draft] = await server.db
    .insert(drafts)
    .values({
      userId,
      deckId: deck.id,
      sourceText: "die Banane",
      status: "ready",
      classification: CLASSIFICATION,
      cards: CARDS,
      imagePrompt: "a banana",
      ...overrides,
    })
    .returning();
  return draft;
}
```

Then the cases:

```ts
it("promotes the draft into a note and deletes the draft", async () => {
  const ada = await server.signIn("ada@example.com");
  const draft = await seedDraft(ada.context, ada.userId);

  const note = await call(
    notesRouter.save,
    { draftId: draft.id, cards: CARDS },
    { context: ada.context },
  );

  expect(note.userId).toBe(ada.userId);
  expect(note.sourceText).toBe("die Banane");
  expect(note.deckId).toBe(draft.deckId);
  expect(note.metadata.partOfSpeech).toBe("noun");
  expect(note.metadata.imagePrompt).toBe("a banana");

  expect(await server.db.select().from(cards).where(eq(cards.noteId, note.id)))
    .toHaveLength(2);
  expect(await server.db.select().from(drafts)).toHaveLength(0);
});

it("saves the client's cards, not the row's, so an in-flight edit is never lost", async () => {
  const ada = await server.signIn("ada@example.com");
  const draft = await seedDraft(ada.context, ada.userId);

  const note = await call(
    notesRouter.save,
    {
      draftId: draft.id,
      cards: [{ aspect: "meaning", front: "edited", back: "banana", hint: null }],
    },
    { context: ada.context },
  );

  const saved = await server.db.select().from(cards).where(eq(cards.noteId, note.id));
  expect(saved).toHaveLength(1);
  expect(saved[0].front).toBe("edited");
});

it("claims a picture that is already there", async () => {
  const ada = await server.signIn("ada@example.com");
  const draft = await seedDraft(ada.context, ada.userId, {
    imageStatus: "ready",
    draftImageId: "img-1",
  });
  const claimDraftImage = vi.fn(async (u: string, _d: string, noteId: string) =>
    `${u}/${noteId}.png`
  );

  const note = await call(
    notesRouter.save,
    { draftId: draft.id, cards: CARDS },
    { context: { ...ada.context, claimDraftImage } },
  );

  expect(claimDraftImage).toHaveBeenCalledWith(ada.userId, "img-1", note.id);
  expect(note.imagePath).toBe(`${ada.userId}/${note.id}.png`);
  expect(note.metadata.imageFailed).toBeUndefined();
});

it("marks the picture failed when one was wanted and never arrived", async () => {
  const ada = await server.signIn("ada@example.com");
  const draft = await seedDraft(ada.context, ada.userId, { imageStatus: "failed" });

  const note = await call(
    notesRouter.save,
    { draftId: draft.id, cards: CARDS },
    { context: ada.context },
  );

  expect(note.metadata.imageFailed).toBe(true);
});

it("records no failure when no picture was ever wanted", async () => {
  const ada = await server.signIn("ada@example.com");
  const draft = await seedDraft(ada.context, ada.userId, { imagePrompt: null });

  const note = await call(
    notesRouter.save,
    { draftId: draft.id, cards: CARDS },
    { context: ada.context },
  );

  expect(note.metadata.imageFailed).toBeUndefined();
});

it("records generationFailed for a hand-written draft", async () => {
  const ada = await server.signIn("ada@example.com");
  const draft = await seedDraft(ada.context, ada.userId, {
    status: "failed",
    error: "Generation failed",
  });

  const note = await call(
    notesRouter.save,
    { draftId: draft.id, cards: CARDS },
    { context: ada.context },
  );

  expect(note.metadata.generationFailed).toBe(true);
});

it("refuses a draft that is still generating", async () => {
  const ada = await server.signIn("ada@example.com");
  const draft = await seedDraft(ada.context, ada.userId, { status: "generating" });

  await expect(
    call(notesRouter.save, { draftId: draft.id, cards: CARDS }, { context: ada.context }),
  ).rejects.toThrow(ORPCError);
});

it("refuses another user's draft", async () => {
  const ada = await server.signIn("ada@example.com");
  const bob = await server.signIn("bob@example.com");
  const draft = await seedDraft(bob.context, bob.userId);

  await expect(
    call(notesRouter.save, { draftId: draft.id, cards: CARDS }, { context: ada.context }),
  ).rejects.toThrow(ORPCError);
  expect(await server.db.select().from(notes)).toHaveLength(0);
});
```

Keep the existing transaction-rollback case (`failingInsertInto`) — adapt only its input to `{ draftId, cards }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test server/router/notes.test.ts`
Expected: FAIL — `save` rejects `draftId` as an unknown key.

- [ ] **Step 3: Rewrite `notes.save`**

In `server/router/notes.ts`, replace `saveNoteInput`, `save` and `attachImage`:

```ts
const saveNoteInput = z.object({
  draftId: z.uuidv7(),
  // The one field the client is authoritative for. Sending it explicitly
  // means an autosave debounce still in flight can never cost an edit.
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
});

/** What a note records when the classify pass never completed. */
const UNCLASSIFIED = { domain: "concept", language: null, partOfSpeech: null };

const save = authed
  .input(saveNoteInput)
  .handler(async ({ input, context }) => {
    const [draft] = await context.db
      .select()
      .from(drafts)
      .where(
        and(eq(drafts.id, input.draftId), eq(drafts.userId, context.userId)),
      )
      .limit(1);
    if (!draft) throw notFound("Draft not found");
    if (draft.status === "generating") {
      throw new ORPCError("CONFLICT", { message: "This draft is still generating" });
    }

    const now = new Date();
    // Generated here rather than left to the column default so the image's
    // destination path is known before anything is written.
    const noteId = uuidv7();
    const classification = draft.classification ?? UNCLASSIFIED;

    const note = await withWriteLock(() =>
      context.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(notes)
          .values({
            id: noteId,
            userId: context.userId,
            deckId: draft.deckId,
            sourceText: draft.sourceText,
            domain: classification.domain,
            language: classification.language,
            metadata: {
              partOfSpeech: classification.partOfSpeech,
              imagePrompt: draft.imagePrompt,
              ...(draft.status === "failed" ? { generationFailed: true } : {}),
            },
          })
          .returning();

        await tx.insert(cards).values(
          input.cards.map((card) => ({
            noteId: inserted.id,
            userId: context.userId,
            aspect: card.aspect,
            front: card.front,
            back: card.back,
            hint: card.hint,
            due: now,
          })),
        );

        return inserted;
      })
    );

    return await settleImage(context, note, draft.id);
  });

/**
 * Attaches the picture and retires the draft, in ONE locked section.
 *
 * That is what makes this and a running image stage's own settle unable to
 * interleave: whichever takes the write lock first, the other sees a settled
 * world (see the spec's §3.3). Every write in here uses `context.db`
 * directly — calling anything that takes the lock itself would deadlock.
 */
async function settleImage(
  context: AuthedContext,
  note: typeof notes.$inferSelect,
  draftId: string,
) {
  return await withWriteLock(async () => {
    const [draft] = await context.db
      .select()
      .from(drafts)
      .where(eq(drafts.id, draftId))
      .limit(1);

    let result = note;

    if (draft?.imageStatus === "ready" && draft.draftImageId) {
      try {
        const imagePath = await (context.claimDraftImage ?? claimDraftImage)(
          context.userId,
          draft.draftImageId,
          note.id,
        );
        await context.db
          .update(notes)
          .set({ imagePath })
          .where(eq(notes.id, note.id));
        result = { ...note, imagePath };
      } catch (error) {
        // NotFound is expected: swept, or already claimed. Anything else is a
        // real I/O fault and worth telling apart from that.
        if (error instanceof Deno.errors.NotFound) {
          console.error("draft image was swept or already claimed", error);
        } else {
          console.error("could not claim the draft image", error);
        }
        await setNoteImageFailed(context.db, context.userId, note.id, true);
        result = { ...note, metadata: { ...note.metadata, imageFailed: true } };
      }
    } else if (claimJobForNote(draftId, note.id)) {
      // The picture is still rendering. The stage now writes straight onto
      // the note, so this is not a failure and must not be recorded as one.
    } else if (draft?.imagePrompt != null) {
      await setNoteImageFailed(context.db, context.userId, note.id, true);
      result = { ...note, metadata: { ...note.metadata, imageFailed: true } };
    }

    await context.db.delete(drafts).where(eq(drafts.id, draftId));
    return result;
  });
}
```

Update the imports at the top of `notes.ts`: add `ORPCError` from `@orpc/server`, `drafts` from `../db/schema.ts`, `setNoteImageFailed` alongside `claimDraftImage` from `../images.ts`, and `claimJobForNote` from `../ai/jobs.ts`. Delete `markImageFailed` and `assertOwnsDeck` (the latter moved to `base.ts` in Task 6).

- [ ] **Step 4: Run the server tests**

Run: `deno task test server && deno task check:api`
Expected: PASS.

- [ ] **Step 5: Point the client mutation at the new input**

In `src/lib/api/notes.ts`, add the drafts key to the invalidations so the sidebar indicator clears:

```ts
import { draftsKey } from "@/lib/api/drafts";

      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.notes.key() });
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() });
        queryClient.invalidateQueries({ queryKey: draftsKey() });
      },
```

- [ ] **Step 6: Move the status component**

`git mv src/components/generation-status.tsx src/components/draft-status.tsx`, rename the export to `DraftStatus`, and change it to take `DraftState` and call `draftStatusText`. `running` becomes `state.status === "generating"`; the `if (state.status === "idle") return null` guard becomes `if (state.status === "loading" || state.status === "none") return null`. Everything else — the `aria-live` split, the `aria-hidden` clock — is unchanged.

- [ ] **Step 7: Rewrite `/add`**

Replace `src/routes/_authed.add.tsx`:

```tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { useDecks } from "@/lib/api/decks";
import { useSaveNote } from "@/lib/api/notes";
import {
  updateDraft,
  useCurrentDraft,
  useDiscardDraft,
  useRetryDraftImage,
  useStartDraft,
  watchDraft,
} from "@/lib/api/drafts";
import { runDraftWatch } from "@/lib/watch-draft";
import {
  draftReducer,
  initialDraftState,
  isSavable,
} from "@/lib/draft-state";
import { CardEditor } from "@/components/card-editor";
import { GeneratedImage } from "@/components/generated-image";
import { DraftStatus } from "@/components/draft-status";
import { StreamingCards } from "@/components/streaming-cards";
import { useElapsed } from "@/hooks/use-elapsed";
import { formatElapsed } from "@/lib/draft-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Page, PageHeader, PageTitle, PageDescription } from "@/components/page";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authed/add")({ component: AddPage });

/** How long typing has to stop before the draft is written back. */
const AUTOSAVE_MS = 1000;

function AddPage() {
  const navigate = useNavigate();
  const { data: decks } = useDecks();
  const { data: currentDraft, isPending } = useCurrentDraft();
  const startDraft = useStartDraft();
  const discardDraft = useDiscardDraft();
  const retryImage = useRetryDraftImage();
  const saveNote = useSaveNote();

  const [text, setText] = useState("");
  const [deckId, setDeckId] = useState("");
  const [state, dispatch] = useReducer(draftReducer, initialDraftState);

  // The server is the source of truth for what draft exists; the reducer is
  // the source of truth for what it currently looks like.
  useEffect(() => {
    if (isPending) return;
    dispatch({ type: "loaded", draft: currentDraft ?? null });
  }, [isPending, currentDraft]);

  const draftId = state.status === "loading" || state.status === "none"
    ? null
    : state.draftId;
  const live = state.status !== "loading" && state.status !== "none" &&
    (state.status === "generating" || state.imageStatus === "generating");

  // One watch per draft, for as long as anything about it is still moving.
  // Aborting on unmount closes this socket; it does NOT stop the job, which
  // is the whole point of the feature.
  useEffect(() => {
    if (!draftId || !live) return;
    const controller = new AbortController();
    void runDraftWatch(
      draftId,
      (id, signal) => watchDraft(id, signal),
      dispatch,
      controller.signal,
    );
    return () => controller.abort();
  }, [draftId, live]);

  const editable = state.status === "ready" || state.status === "failed";
  const cardsJson = editable ? JSON.stringify(state.cards) : null;
  const editableDeckId = editable ? state.deckId : null;

  // The timer is deliberately NOT cleared on unmount: `updateDraft` is a
  // plain call, not bound to this component, so navigating away flushes the
  // edit instead of discarding it. Worst case is losing under a second of
  // typing to a killed app, and Save cannot race it because Save sends its
  // cards explicitly.
  const firstAutosave = useRef(true);
  useEffect(() => {
    if (!draftId || cardsJson === null || editableDeckId === null) return;
    if (firstAutosave.current) {
      firstAutosave.current = false;
      return;
    }
    const id = setTimeout(() => {
      void updateDraft({
        draftId,
        deckId: editableDeckId,
        cards: JSON.parse(cardsJson),
      }).catch((error) => console.error("could not save the draft", error));
    }, AUTOSAVE_MS);
    return () => clearTimeout(id);
  }, [draftId, cardsJson, editableDeckId]);

  const imageElapsed = useElapsed(
    state.status !== "loading" && state.status !== "none" ? state.startedAt : null,
    state.status !== "loading" && state.status !== "none" &&
      state.imageStatus === "generating",
  );

  if (state.status === "loading") {
    return (
      <Page width="wide" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </Page>
    );
  }

  if (state.status === "none") {
    return (
      <Page width="wide">
        <PageHeader>
          <PageTitle>Add a card</PageTitle>
          <PageDescription>
            Give it a word or a concept and it'll be written up as cards for
            you to check before saving.
          </PageDescription>
        </PageHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="deck">Deck</Label>
            {/* Base UI represents "nothing selected yet" as null, which is what
                renders the placeholder — deckId stays "" in state so the
                disabled checks below are unchanged. */}
            <Select
              items={decks?.map((deck) => ({ value: deck.id, label: deck.name }))}
              value={deckId || null}
              onValueChange={(value) => setDeckId(value ?? "")}
            >
              <SelectTrigger id="deck" className="w-full">
                <SelectValue placeholder="Choose a deck…" />
              </SelectTrigger>
              <SelectContent>
                {decks?.map((deck) => (
                  <SelectItem key={deck.id} value={deck.id}>
                    {deck.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="source-text">Word or concept</Label>
            <Input
              id="source-text"
              placeholder="die Banane, Poseidon, entropy…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          {startDraft.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {startDraft.error instanceof Error
                  ? startDraft.error.message
                  : "Could not start generating"}
              </AlertDescription>
            </Alert>
          )}

          <Button
            size="lg"
            className="w-full md:w-auto"
            disabled={!text.trim() || !deckId || startDraft.isPending}
            onClick={() => startDraft.mutate({ deckId, text })}
          >
            Generate cards
          </Button>
        </div>
      </Page>
    );
  }

  return (
    <Page width="wide" className="space-y-4">
      <PageHeader className="mb-4">
        <PageTitle>Review cards</PageTitle>
      </PageHeader>
      <DraftStatus state={state} />

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.classification && (
        <p className="text-sm text-muted-foreground">
          Detected: {state.classification.domain}
          {state.classification.language ? ` · ${state.classification.language}` : ""}
        </p>
      )}

      {state.imageStatus === "generating" && (
        // Same className GeneratedImage's own Skeleton state uses, so the box
        // is reserved from the moment generation starts and nothing shifts
        // when the image pops in.
        <Skeleton className="h-48 w-48 rounded-xl" />
      )}

      {state.imageStatus === "ready" && state.draftImageId && (
        <GeneratedImage
          scope="drafts"
          id={state.draftImageId}
          present
          alt={state.text}
          className="h-48 w-48 rounded-xl"
        />
      )}

      {state.imageStatus === "failed" && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>The picture didn't come through.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => retryImage.mutate({ draftId: state.draftId })}
          >
            Try again
          </Button>
        </div>
      )}

      {editable ? (
        state.cards.map((card, index) => (
          <CardEditor
            key={index}
            card={{
              aspect: card.aspect ?? "",
              front: card.front ?? "",
              back: card.back ?? "",
              hint: card.hint ?? null,
            }}
            onChange={(patch) => dispatch({ type: "edit-card", index, patch })}
            onRemove={() => dispatch({ type: "remove-card", index })}
          />
        ))
      ) : (
        <StreamingCards cards={state.cards} />
      )}

      {editable && !isSavable(state) && state.cards.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            Every card needs both a front and a back before you can save — fill
            in or remove the blank ones.
          </AlertDescription>
        </Alert>
      )}

      {saveNote.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {saveNote.error instanceof Error ? saveNote.error.message : "Failed to save"}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-3">
        {editable && (
          <Button
            size="lg"
            disabled={!isSavable(state) || saveNote.isPending}
            onClick={async () => {
              try {
                await saveNote.mutateAsync({
                  draftId: state.draftId,
                  cards: state.cards.map((card) => ({
                    aspect: card.aspect ?? "",
                    front: (card.front ?? "").trim(),
                    back: (card.back ?? "").trim(),
                    hint: card.hint ?? null,
                  })),
                });
              } catch {
                // Already captured in saveNote.error and rendered above;
                // swallow so this is not an unhandled rejection, and do not
                // navigate away on failure.
                return;
              }
              navigate({ to: "/decks/$deckId", params: { deckId: state.deckId } });
            }}
          >
            {saveNote.isPending
              ? "Saving…"
              : state.imageStatus === "generating"
                ? `Save ${state.cards.length} — picture still rendering ${
                    formatElapsed(imageElapsed)
                  }`
                : `Save ${state.cards.length} ${
                    state.cards.length === 1 ? "card" : "cards"
                  }`}
          </Button>
        )}

        <Button
          size="lg"
          variant="outline"
          disabled={discardDraft.isPending}
          onClick={() => discardDraft.mutate({ draftId: state.draftId })}
        >
          Discard
        </Button>
      </div>
    </Page>
  );
}
```

- [ ] **Step 8: Write the route test**

Create `src/routes/_authed.add.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

afterEach(cleanup);

const { draftsMock, decksMock } = vi.hoisted(() => ({
  draftsMock: vi.fn(),
  decksMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/api/decks", () => ({ useDecks: decksMock }));
vi.mock("@/lib/api/notes", () => ({ useSaveNote: () => ({ isPending: false, isError: false }) }));
vi.mock("@/lib/api/drafts", () => ({
  useCurrentDraft: draftsMock,
  useStartDraft: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useDiscardDraft: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryDraftImage: () => ({ mutate: vi.fn() }),
  updateDraft: vi.fn(),
  watchDraft: vi.fn(),
}));
vi.mock("@/lib/watch-draft", () => ({ runDraftWatch: vi.fn(async () => {}) }));

const { Route } = await import("./_authed.add");

function renderAdd() {
  const AddPage = (Route as unknown as { component: () => JSX.Element }).component;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AddPage />
    </QueryClientProvider>,
  );
}

const DRAFT = {
  id: "d1",
  userId: "u1",
  deckId: "deck-1",
  sourceText: "die Banane",
  status: "generating" as const,
  classification: null,
  cards: [],
  imagePrompt: null,
  imageStatus: "none" as const,
  draftImageId: null,
  error: null,
  createdAt: new Date(),
};

describe("/add", () => {
  it("offers the capture form when there is no draft", () => {
    decksMock.mockReturnValue({ data: [{ id: "deck-1", name: "German" }] });
    draftsMock.mockReturnValue({ data: null, isPending: false });

    renderAdd();

    expect(screen.getByLabelText("Word or concept")).toBeInTheDocument();
  });

  it("resumes a generating draft instead of offering the form", () => {
    decksMock.mockReturnValue({ data: [{ id: "deck-1", name: "German" }] });
    draftsMock.mockReturnValue({ data: DRAFT, isPending: false });

    renderAdd();

    expect(screen.queryByLabelText("Word or concept")).not.toBeInTheDocument();
    expect(screen.getByText("Review cards")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 9: Delete what the cutover replaced**

```bash
git rm src/lib/generation-state.ts src/lib/generation-state.test.ts \
       src/lib/generation-status.ts src/lib/generation-status.test.ts \
       src/lib/run-generation.ts src/lib/run-generation.test.ts \
       src/lib/run-draft-image.ts src/lib/run-draft-image.test.ts
```

- [ ] **Step 10: Run everything**

Run: `deno task test`
Expected: PASS, whole suite.

Run: `deno task build`
Expected: a clean `tsc` — this is what proves no deleted module is still imported.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: save notes from drafts and resume generation on /add"
```

---

### Task 11: Retire the client-driven AI procedures

Implements spec §4.1's last paragraph and §5.5.

**Files:**
- Modify: `server/router/ai.ts`
- Modify: `server/router/ai.test.ts`
- Modify: `src/lib/api/ai.ts`

- [ ] **Step 1: Delete the procedures and their tests**

In `server/router/ai.ts` remove `generateNoteProcedure` and `generateDraftImageProcedure`, their imports (`generateNote`, `openRouterCalls`, `writeDraftImage`, `ORPCError` if now unused), and reduce the router to:

```ts
export const aiRouter = {
  generateImage: generateImageProcedure,
};
```

`generateImageBytes` stays exported — `server/router/drafts.ts` imports it.

In `server/router/ai.test.ts` delete the `ai.generateNote` and `ai.generateDraftImage` describes. The `ai.generateImage` cases stay exactly as they are.

- [ ] **Step 2: Delete the client wrappers**

In `src/lib/api/ai.ts` remove `generateNoteStream`, `generateDraftImage`, `CONNECTION_DROPPED_MESSAGE`, and the `GenerationEvent` / `PartialCard` re-exports that no longer have consumers. Keep `generateNoteImage` and the type re-exports `src/lib/api/notes.ts` and `src/components/streaming-cards.tsx` still use.

If `src/lib/api/ai.test.ts` covers the deleted functions, delete those cases; keep whatever covers `generateNoteImage`.

`src/components/streaming-cards.tsx` imports `PartialCard` from `@/lib/api/ai`. Point it at `DraftCard` from `@/lib/api/drafts` instead and widen `StreamingField` to accept `string | null | undefined` — a `DraftCard`'s `hint` is optional and its other fields are already nullable.

- [ ] **Step 3: Run everything**

Run: `deno task test && deno task check:api && deno task build`
Expected: PASS. A `tsc` error here means something still imports a deleted export — fix the import, do not restore the export.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: drop the client-driven generation procedures"
```

---

### Task 12: The sidebar indicator

Implements spec §5.4.

**Files:**
- Create: `src/components/draft-indicator.tsx`
- Modify: `src/components/app-sidebar.tsx`
- Modify: `src/routes/_authed.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/draft-indicator.tsx`:

```tsx
import { useCurrentDraft } from "@/lib/api/drafts";
import { cn } from "@/lib/utils";

/** The word beside `Add` when something is waiting there, or null. */
export function useDraftIndicator(): { label: string; tone: string } | null {
  const { data } = useCurrentDraft();
  if (!data) return null;

  if (data.status === "generating") {
    return { label: "generating…", tone: "bg-primary" };
  }
  if (data.status === "failed") return { label: "failed", tone: "bg-destructive" };
  return { label: "ready", tone: "bg-primary" };
}

/**
 * A dot, plus the status as text for anyone who cannot see it. This is the
 * whole of the "there is something waiting for you" surface — a draft is
 * always reachable at /add, so nothing here needs to be a link of its own.
 */
export function DraftIndicator({ className }: { className?: string }) {
  const indicator = useDraftIndicator();
  if (!indicator) return null;

  return (
    <span className={cn("ml-auto flex items-center gap-1.5", className)}>
      <span className={cn("size-1.5 rounded-full", indicator.tone)} aria-hidden="true" />
      <span className="sr-only">Draft {indicator.label}</span>
    </span>
  );
}
```

- [ ] **Step 2: Render it in both navigations**

In `src/components/app-sidebar.tsx`, inside the `PRIMARY_NAV.map` menu button, after `<span>{label}</span>`:

```tsx
                        {to === "/add" && <DraftIndicator />}
```

In `src/routes/_authed.tsx`'s `BottomNav`, inside the `Button` after `{label}`, with the dot positioned for a stacked tab:

```tsx
                {to === "/add" && <DraftIndicator className="ml-0" />}
```

Import `DraftIndicator` in both files.

- [ ] **Step 3: Verify by hand**

Run: `deno task dev`

Start a generation on `/add`, navigate to `/decks` while it runs, and confirm the dot appears beside `Add` in both the sidebar (desktop width) and the tab bar (narrow the window below 768px). Save the note and confirm the dot clears.

- [ ] **Step 4: Run the suite and commit**

Run: `deno task test && deno task build`

```bash
git add src/components/draft-indicator.tsx src/components/app-sidebar.tsx src/routes/_authed.tsx
git commit -m "feat(ui): flag a waiting draft in both navigations"
```

---

### Task 13: Documentation, and the two things the suite cannot show

Implements spec §8.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the "AI endpoints" section**

Replace it with a description of the job, keeping the section's existing tone. It must cover: `drafts.start` inserting a row and spawning a detached job; `drafts.watch` handing a late joiner a snapshot then tailing; the two concurrent stages and why `imagePrompt` now comes first; `notes.save` taking a `draftId`; and `ai.generateImage` remaining the note-screen retry. Delete every mention of `ai.generateNote` and `ai.generateDraftImage` as client-facing procedures.

Also update:
- the **Layout** tree — add `server/ai/channel.ts`, `server/ai/jobs.ts`, `server/router/drafts.ts`, `src/lib/api/drafts.ts`, `src/lib/draft-state.ts`, `src/lib/draft-status.ts`, `src/lib/watch-draft.ts`; remove `src/lib/run-draft-image.ts` and the `generation-*` modules.
- the **Troubleshooting → Generation fails** paragraph — a failed generation now lands on the draft row and survives a reload; a dropped connection reconnects rather than failing.
- the **Tests** paragraph's test count and its claim that there are no component tests beyond the existing ones.

- [ ] **Step 2: Verify the two properties the suite cannot cover**

Run: `deno task dev`, then check each and record the result in the commit message:

1. **It still streams.** Cards materialise field by field on `/add`. A buffered iterator produces a correct note after one long pause and every test still passes, so this regression is silent.
2. **Leaving really is safe.** Start a generation, navigate to `/decks` before the cards finish, wait, come back to `/add`. The cards must be there — either still streaming or complete — and the picture must have arrived. Then repeat, killing the *server* mid-generation: `/add` must come back with "The server restarted while this was generating." and a hand-editable card, not a spinner.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe generation as a durable job"
```

---

## Self-Review

**Spec coverage.** §1.1 → Task 1. §1.2, §1.3 → Task 10 (lifecycle in the route) and Task 6 (`discard`). §1.4 → Tasks 4 (`reconcileOrphanedDrafts`, `reconcileDraft`) and 7 (boot wiring). §1.5 → Task 7. §2.1 → Task 2. §2.2, §2.3 → Task 4. §3.1 → Task 3. §3.2 → Tasks 4 and 5. §3.3 → Tasks 5 (stage half) and 10 (`save` half). §4.1 → Tasks 6 and 10. §4.2 → Task 6. §5.1 → Tasks 9 and 10. §5.2 → Task 8. §5.3 → Task 10. §5.4 → Task 12. §5.5 → Tasks 10 and 11. §6 error table → covered by the tests in Tasks 4, 5, 6, 8 and 10. §7 → each task's own test step. §8 → Task 13.

**The one trap worth repeating.** `patch` in `jobs.ts` and `setNoteImageFailed` in `images.ts` differ in exactly one way: `patch` takes the write lock itself, `setNoteImageFailed` does not. Both are called from inside locked sections in some places and outside in others, and getting it backwards deadlocks the process rather than failing a test. Each is commented at its definition; the call sites in Tasks 5 and 10 are written to match.

**Type consistency.** `DraftEvent` is defined once, in `server/ai/jobs.ts`, and re-exported type-only through `src/lib/api/drafts.ts`. `DraftCard` is defined once, in `server/db/schema.ts`, and every client module re-exports rather than restates it. `JobDeps` is constructed in exactly one place (`jobDeps` in `server/router/drafts.ts`). `startGenerationJob` / `startImageJob` / `subscribe` / `hasJob` / `abortJob` / `claimJobForNote` / `reconcileDraft` / `reconcileOrphanedDrafts` are the complete `jobs.ts` surface and are spelled identically everywhere they appear.
