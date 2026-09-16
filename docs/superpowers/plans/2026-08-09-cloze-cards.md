# Cloze Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace isolated `front → back` flashcard pairs with cloze deletions — a sentence with one hidden span — across every note domain.

**Architecture:** A dependency-free Deno workspace package (`@mnimi/shared`) owns the markup parser. The server imports it to validate generated and user-edited cards and to derive a new `cards.card_type` column; the browser imports it to render blanks, reveals and a live editor preview. `back` becomes nullable, since a cloze card's answer lives inside `front`.

**Tech Stack:** Deno 2.9 workspaces, Drizzle ORM + libSQL, Zod 4, oRPC, React 19, TanStack Router, Vitest 4, Tailwind 4.

Spec: `docs/superpowers/specs/2026-08-09-cloze-cards-design.md`

## Global Constraints

- **Use `deno` for all package management and script execution.** Never `npm`, `npx`, `yarn` or `pnpm` (`AGENTS.md`).
- Run tests with `deno task test` (Vitest), and server type-checking with `deno task check:api`.
- **`@mnimi/shared` has zero dependencies.** No React, no JSX, no imports from `src/` or `server/`, and an empty/absent `imports` map in its `deno.json`. It is type-checked by `deno task check:api`, which has no DOM or React types.
- **Client code may import server modules type-only** — enforced by `src/lib/server-boundary.test.ts`. `@mnimi/shared` is not `~server/…`, so value imports from it are fine.
- Server modules import each other with explicit `.ts` extensions (`./rule-packs.ts`); `src/` modules import without extensions (`@/lib/draft-state`).
- Commit messages follow the existing convention: `feat:`, `fix(scope):`, `chore:`, `docs:`.
- **Component tests use plain Vitest matchers, not `jest-dom`.** `@testing-library/jest-dom` is a dependency but is never set up — `vitest.config.ts` has no `setupFiles` and no existing test imports it. Follow `src/components/draft-indicator.test.tsx`: `afterEach(cleanup)` at the top, `expect(...).toBeTruthy()` rather than `toBeInTheDocument()`, `expect(screen.queryByText(...)).toBeNull()` for absence, and `container.textContent` for whole-render assertions. Do **not** add a setup file as part of this work.
- Component tests import through the `@/` alias (`@/components/cloze-text`), matching the existing tests.
- **This plan refines two names from the spec.** The spec's single `parseClozePartial` becomes the clearer pair `parseCloze` (strict) + `stripPartialCloze` (lenient tail-trimming). Same behaviour, two focused functions.

---

### Task 1: The `@mnimi/shared` package and the cloze parser

**Files:**
- Create: `shared/deno.json`
- Create: `shared/cloze.ts`
- Create: `shared/cloze.test.ts`
- Modify: `deno.json` (workspace array)
- Modify: `vite.config.ts` (alias)
- Modify: `vitest.config.ts` (alias + test include glob)
- Modify: `tsconfig.json` (paths)

**Interfaces:**
- Consumes: nothing.
- Produces: `parseCloze(text: string): ClozeSegments | null`, `stripPartialCloze(text: string): string`, `hasClozeMarkup(text: string): boolean`, and `type ClozeSegments = { before: string; answer: string; hint: string | null; after: string }`. Every later task imports from `"@mnimi/shared"`.

Both resolution paths were verified against this repo before this plan was written: `deno check` resolves the workspace member, and the Vite alias resolves the bare specifier `@mnimi/shared`. Add the config in this task and both hold.

- [ ] **Step 1: Create the package manifest**

`shared/deno.json` — note there is no `imports` map, which is the zero-dependency constraint made mechanical:

```json
{
  "name": "@mnimi/shared",
  "version": "0.1.0",
  "exports": {
    ".": "./cloze.ts"
  }
}
```

- [ ] **Step 2: Register the workspace member**

In `deno.json`, change the `workspace` array (line 2) from `["./server"]` to:

```json
  "workspace": ["./server", "./shared"],
```

- [ ] **Step 3: Wire the alias for the browser build and tests**

In `vite.config.ts`, inside `resolve.alias`, add a third entry after `"~server"`:

```ts
      "@mnimi/shared": path.resolve(__dirname, "./shared/cloze.ts"),
```

In `vitest.config.ts`, add the same line inside `resolve.alias`, and extend the `test.include` array so tests in the new package actually run — the current globs cover only `src/` and `server/`:

```ts
    include: [
      "shared/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "server/**/*.test.ts",
    ],
```

In `tsconfig.json`, add to `compilerOptions.paths`:

```json
      "@mnimi/shared": ["./shared/cloze.ts"]
```

- [ ] **Step 4: Write the failing test**

Create `shared/cloze.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hasClozeMarkup, parseCloze, stripPartialCloze } from "./cloze.ts";

describe("parseCloze", () => {
  it("splits a deletion with a hint into segments", () => {
    expect(parseCloze("Ich mag {{c1::Bananen::banany}} zum Frühstück.")).toEqual({
      before: "Ich mag ",
      answer: "Bananen",
      hint: "banany",
      after: " zum Frühstück.",
    });
  });

  it("reads a deletion with no hint", () => {
    expect(parseCloze("Ich mag {{c1::Bananen}} zum Frühstück.")).toEqual({
      before: "Ich mag ",
      answer: "Bananen",
      hint: null,
      after: " zum Frühstück.",
    });
  });

  it("keeps a deletion at the very start of the sentence", () => {
    expect(parseCloze("{{c1::Die}} Banane ist gelb.")).toEqual({
      before: "",
      answer: "Die",
      hint: null,
      after: " Banane ist gelb.",
    });
  });

  it("returns null for text with no markup", () => {
    expect(parseCloze("die Banane")).toBeNull();
  });

  it("rejects an empty answer", () => {
    expect(parseCloze("Ich mag {{c1::}} zum Frühstück.")).toBeNull();
  });

  it("rejects a whitespace-only answer", () => {
    expect(parseCloze("Ich mag {{c1::   }} zum Frühstück.")).toBeNull();
  });

  it("rejects an unclosed deletion", () => {
    expect(parseCloze("Ich mag {{c1::Bananen")).toBeNull();
  });

  it("rejects two deletions in one card", () => {
    expect(parseCloze("{{c1::Ich}} mag {{c2::Bananen}}.")).toBeNull();
  });

  it("rejects a third :: section", () => {
    expect(parseCloze("Ich mag {{c1::Bananen::banany::extra}}.")).toBeNull();
  });

  it("treats an empty hint as no hint", () => {
    expect(parseCloze("Ich mag {{c1::Bananen::}}.")?.hint).toBeNull();
  });
});

describe("stripPartialCloze", () => {
  it("drops an incomplete deletion at the tail", () => {
    expect(stripPartialCloze("Ich mag {{c1::Ban")).toBe("Ich mag ");
  });

  it("drops a bare opening brace pair", () => {
    expect(stripPartialCloze("Ich mag {{")).toBe("Ich mag ");
  });

  it("leaves text with no markup alone", () => {
    expect(stripPartialCloze("Ich mag Bananen.")).toBe("Ich mag Bananen.");
  });

  it("keeps a completed deletion untouched", () => {
    expect(stripPartialCloze("Ich mag {{c1::Bananen}} zum")).toBe(
      "Ich mag {{c1::Bananen}} zum",
    );
  });
});

describe("hasClozeMarkup", () => {
  it("is true as soon as an opening brace pair appears", () => {
    expect(hasClozeMarkup("Ich mag {{")).toBe(true);
  });

  it("is false for plain text", () => {
    expect(hasClozeMarkup("die Banane")).toBe(false);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `deno task test shared/cloze.test.ts`
Expected: FAIL — cannot resolve `./cloze.ts`.

- [ ] **Step 6: Write the implementation**

Create `shared/cloze.ts`:

```ts
/**
 * Anki-compatible cloze markup, shared by the server (which validates it and
 * derives `cards.card_type` from it) and the browser (which renders it).
 *
 * Pure logic with zero dependencies on purpose: this module is type-checked by
 * `deno task check:api` alongside the server, where no DOM or React types
 * exist, so a UI import fails CI as a type error rather than as a review note.
 */

/** One deletion, split into the parts a renderer needs. */
export type ClozeSegments = {
  before: string;
  answer: string;
  hint: string | null;
  after: string;
};

/** `.*?` rather than `[^}]*` so an answer may contain a lone `}`; the lazy
 *  quantifier stops at the first `}}`. There is deliberately no escape
 *  mechanism — a sentence containing a literal `::` or `}}` is unsupported,
 *  and `parseCloze` rejects it rather than mis-parsing it. */
const DELETION = /\{\{c\d+::(.*?)\}\}/g;

/** Cheap test for "the author was trying to write a deletion". Callers pair
 *  this with `parseCloze` to tell malformed markup apart from plain text:
 *  markup present but unparseable is an error, markup absent is a basic card. */
export function hasClozeMarkup(text: string): boolean {
  return text.includes("{{");
}

/**
 * Strict parse. Returns segments for exactly one well-formed deletion, or
 * `null` for anything else — no markup, malformed markup, two deletions, or an
 * empty answer. `null` is not an error by itself; it means "not a cloze card".
 */
export function parseCloze(text: string): ClozeSegments | null {
  const matches = [...text.matchAll(DELETION)];
  if (matches.length !== 1) return null;

  const [match] = matches;
  const parts = match[1].split("::");
  if (parts.length > 2) return null;

  const answer = parts[0];
  if (answer.trim() === "") return null;

  const hint = parts[1]?.trim() ? parts[1] : null;
  const start = match.index ?? 0;

  return {
    before: text.slice(0, start),
    answer,
    hint,
    after: text.slice(start + match[0].length),
  };
}

/**
 * Lenient companion for text still streaming from the model. Drops a trailing
 * deletion that has been opened but not yet closed, so a half-arrived
 * `Ich mag {{c1::Ban` renders as `Ich mag ` instead of flashing brace noise
 * across the streaming list on every delta.
 */
export function stripPartialCloze(text: string): string {
  const open = text.lastIndexOf("{{");
  if (open === -1) return text;
  if (text.includes("}}", open)) return text;
  return text.slice(0, open);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `deno task test shared/cloze.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 8: Verify the server can resolve the package**

Run: `deno task check:api`
Expected: no errors. This proves the workspace member is registered correctly before any server code depends on it.

- [ ] **Step 9: Commit**

```bash
git add shared deno.json vite.config.ts vitest.config.ts tsconfig.json
git commit -m "feat(shared): add @mnimi/shared with the cloze markup parser"
```

---

### Task 2: Schema — `card_type` column and nullable `back`

**Files:**
- Modify: `server/db/schema.ts:144-180` (the `cards` table)
- Create: `server/db/schema.test.ts`
- Create: `server/drizzle/0002_*.sql` (generated, do not hand-write)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export type CardType = "basic" | "cloze"` from `server/db/schema.ts`; `cards.cardType` (defaults `"basic"`) and `cards.back` now `string | null` on the inferred `Card` type.

Note for the implementer: tests build their database with `pushSQLiteSchema(schema, db)` (`server/db/testing.ts:38`), which pushes the Drizzle schema directly and never reads the migration files. So a green test suite does **not** prove the migration is correct — Step 5 checks it separately.

- [ ] **Step 1: Write the failing test**

Create `server/db/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTestDb } from "./testing.ts";

/** `PRAGMA table_info` is the shape as SQLite actually built it, which is what
 *  a migration has to reproduce — asserting on the Drizzle object would only
 *  restate the source file. */
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/db/schema.test.ts`
Expected: FAIL — `card_type` is undefined, and `back` has `notnull: 1`.

- [ ] **Step 3: Change the schema**

In `server/db/schema.ts`, add the exported type above the `cards` table:

```ts
/** A cloze card hides one span inside `front`; a basic card is a plain
 *  front/back pair. Derived from the markup at save time, never asked of the
 *  model — see `server/router/notes.ts`. */
export type CardType = "basic" | "cloze";
```

Then, inside the `cards` table definition, replace the `back` line (line 156) and add `cardType` immediately after it:

```ts
    front: text("front").notNull(),
    // Nullable: a cloze card's answer is inside `front`, so a `back` holding it
    // too would be two fields to edit and two to disagree. For a cloze row this
    // carries the sentence's meaning where one applies, and is null otherwise.
    back: text("back"),
    cardType: text("card_type").$type<CardType>().notNull().default("basic"),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test server/db/schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Generate and inspect the migration**

Run: `deno task db:generate`

This writes `server/drizzle/0002_<name>.sql`. Open it and confirm two things, because dropping a NOT NULL in SQLite forces Drizzle to recreate the table rather than `ALTER` it:

1. It adds `card_type` with `NOT NULL DEFAULT 'basic'`.
2. If it recreates `cards`, the copy carries **every** column across — including the FSRS scheduling state (`due`, `stability`, `difficulty`, `elapsed_days`, `scheduled_days`, `learning_steps`, `reps`, `lapses`, `state`, `last_review`) — and recreates both indexes (`cards_due_idx` with its `WHERE suspended = 0` clause, and `cards_note_id_idx`).

If any column or index is missing from the recreation, fix the generated SQL by hand before continuing. Losing scheduling state would silently reset every card's review history.

- [ ] **Step 6: Run the whole suite**

Run: `deno task test`
Expected: PASS. Existing card-writing tests still pass because `back` going nullable only widens what is accepted.

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.ts server/db/schema.test.ts server/drizzle
git commit -m "feat(db): add cards.card_type and make back nullable"
```

---

### Task 3: Validate cloze markup in the generation schema

**Files:**
- Create: `server/ai/card-rules.ts`
- Modify: `server/ai/schemas.ts:16-22` (`generatedCardSchema`)
- Create: `server/ai/schemas.test.ts`

**Interfaces:**
- Consumes: `parseCloze`, `hasClozeMarkup` from `@mnimi/shared` (Task 1).
- Produces: from `server/ai/card-rules.ts` — `type CardShape = { front: string; back: string | null }`, `clozeMarkupIsWellFormed(card: CardShape): boolean`, `cardHasAnAnswer(card: CardShape): boolean`, and the message constants `MALFORMED_CLOZE` and `BASIC_CARD_NEEDS_BACK`. **Task 5 imports all four** — they are defined once, here.
- Produces: `generatedCardSchema` now rejects malformed markup and a basic card with no back; `GeneratedCard.back` is `string | null`.

The two rules are extracted into `card-rules.ts` rather than written inline, because Task 5 applies the identical predicates and identical user-facing messages to the router's input schema. Two schemas, one definition of what a well-formed card is.

This rides the existing one-retry correction loop for free: `parseWithRetry` / `streamWithRetry` in `server/ai/generate.ts` already feed a failed schema's `error.issues` back to the model verbatim via `validationFeedback`, so a malformed deletion becomes a self-correcting retry rather than a hard failure.

- [ ] **Step 1: Write the failing test**

Create `server/ai/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generatedCardSchema } from "./schemas.ts";

const CLOZE = {
  aspect: "meaning",
  front: "Ich mag {{c1::Bananen::banany}} zum Frühstück.",
  back: "Lubię banany na śniadanie.",
  hint: null,
};

describe("generatedCardSchema", () => {
  it("accepts a well-formed cloze card", () => {
    expect(generatedCardSchema.safeParse(CLOZE).success).toBe(true);
  });

  it("accepts a cloze card with no back", () => {
    expect(generatedCardSchema.safeParse({ ...CLOZE, back: null }).success).toBe(
      true,
    );
  });

  it("normalises an empty back to null", () => {
    const parsed = generatedCardSchema.parse({ ...CLOZE, back: "" });
    expect(parsed.back).toBeNull();
  });

  it("accepts a basic card with a back", () => {
    const basic = { aspect: "meaning", front: "Poseidon", back: "sea god", hint: null };
    expect(generatedCardSchema.safeParse(basic).success).toBe(true);
  });

  it("rejects a basic card with no back", () => {
    const basic = { aspect: "meaning", front: "Poseidon", back: null, hint: null };
    expect(generatedCardSchema.safeParse(basic).success).toBe(false);
  });

  it("rejects malformed markup rather than treating it as plain text", () => {
    const broken = { ...CLOZE, front: "Ich mag {{c1::}} zum Frühstück." };
    expect(generatedCardSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects two deletions in one card", () => {
    const two = { ...CLOZE, front: "{{c1::Ich}} mag {{c2::Bananen}}." };
    expect(generatedCardSchema.safeParse(two).success).toBe(false);
  });

  it("explains the failure in a way the retry loop can act on", () => {
    const broken = { ...CLOZE, front: "Ich mag {{c1::Bananen" };
    const result = generatedCardSchema.safeParse(broken);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("cloze");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/ai/schemas.test.ts`
Expected: FAIL — malformed markup currently parses fine, and a null back is rejected.

- [ ] **Step 3: Write the shared card rules**

Create `server/ai/card-rules.ts`:

```ts
import { hasClozeMarkup, parseCloze } from "@mnimi/shared";

/**
 * What "a well-formed card" means, defined once.
 *
 * Two schemas enforce these rules on the same shape from opposite directions —
 * `generatedCardSchema` on what the model returns, `saveNoteInput` on what the
 * client sends — and the messages are user-visible in one case and fed back to
 * the model as correction feedback in the other. Writing them twice would let
 * the two drift into disagreeing about what is legal.
 */
export type CardShape = { front: string; back: string | null };

export const MALFORMED_CLOZE =
  "Malformed cloze deletion. Write exactly one {{c1::answer}} or " +
  "{{c1::answer::hint}} per card, with a non-empty answer.";

export const BASIC_CARD_NEEDS_BACK = "A card with no cloze deletion needs a back.";

/** Markup that was started must be finished. Text with no braces at all is a
 *  basic card and passes trivially. */
export function clozeMarkupIsWellFormed(card: CardShape): boolean {
  return !hasClozeMarkup(card.front) || parseCloze(card.front) !== null;
}

/** A cloze card's answer is inside its front; a basic card's is its back. A
 *  card with neither has no answer at all. */
export function cardHasAnAnswer(card: CardShape): boolean {
  return parseCloze(card.front) !== null || card.back !== null;
}
```

- [ ] **Step 4: Apply them to the generation schema**

In `server/ai/schemas.ts`, add the import at the top:

```ts
import {
  BASIC_CARD_NEEDS_BACK,
  cardHasAnAnswer,
  clozeMarkupIsWellFormed,
  MALFORMED_CLOZE,
} from "./card-rules.ts";
```

Replace `generatedCardSchema` (lines 16-22) with:

```ts
export const generatedCardSchema = z
  .object({
    aspect: z.string().min(1),
    front: z.string().min(1),
    // Nullable for cloze cards, whose answer is inside `front`. "" is
    // normalised to null here, at the parse boundary, so no downstream site
    // has to decide whether an empty string means "no meaning line".
    back: z.string().nullish().transform((v) => v || null),
    hint: z.string().nullish().transform((v) => v ?? null),
  })
  .refine(clozeMarkupIsWellFormed, { message: MALFORMED_CLOZE, path: ["front"] })
  .refine(cardHasAnAnswer, { message: BASIC_CARD_NEEDS_BACK, path: ["back"] });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno task test server/ai/schemas.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the whole suite and the type check**

Run: `deno task test && deno task check:api`
Expected: PASS. If `server/ai/generate-note.test.ts` fails, its fixture cards are basic cards missing a `back` — give them one rather than weakening the schema.

- [ ] **Step 7: Commit**

```bash
git add server/ai/card-rules.ts server/ai/schemas.ts server/ai/schemas.test.ts
git commit -m "feat(ai): validate cloze markup in the generation schema"
```

---

### Task 4: Rewrite the rule packs to generate cloze

**Files:**
- Modify: `server/ai/rule-packs.ts:3-38` (`BASE_PACK` and `LANGUAGE_PACK`)
- Modify: `server/ai/rule-packs.test.ts`

**Interfaces:**
- Consumes: nothing at runtime — these are prompt strings.
- Produces: no API change. `selectRulePacks` and `buildSystemPrompt` keep their current signatures.

Cloze goes in `BASE_PACK` because it applies to **every** domain, not just language notes. `selectRulePacks` is untouched: `base` still always applies and `language` still layers on top only for language notes.

- [ ] **Step 1: Write the failing test**

Add to `server/ai/rule-packs.test.ts`, inside the existing `describe("buildSystemPrompt")` block:

```ts
  it("teaches the cloze markup to every domain, not just language notes", () => {
    for (const note of [conceptNote, languageNote]) {
      const prompt = buildSystemPrompt(note);
      expect(prompt).toContain("{{c1::");
      expect(prompt.toLowerCase()).toContain("cloze");
    }
  });

  it("asks for one deletion per card", () => {
    expect(buildSystemPrompt(conceptNote).toLowerCase()).toContain(
      "exactly one",
    );
  });

  it("no longer asks for isolated recognition and production pairs", () => {
    expect(buildSystemPrompt(languageNote).toLowerCase()).not.toContain(
      "recognition goes",
    );
  });

  it("shows the hint living inside the deletion", () => {
    expect(buildSystemPrompt(conceptNote)).toContain("::");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/ai/rule-packs.test.ts`
Expected: FAIL — the packs mention neither cloze nor the markup, and still contain "Recognition goes".

- [ ] **Step 3: Rewrite `BASE_PACK`**

In `server/ai/rule-packs.ts`, replace `BASE_PACK` entirely:

```ts
export const BASE_PACK = `
You write flashcards that a human will actually be able to learn from.

Write cloze deletion cards. A cloze card is a full sentence with exactly one
span hidden, and the learner restores the hidden span:

  Ich mag {{c1::Bananen::banany}} zum Frühstück.
  Poseidon's Roman counterpart is {{c1::Neptune}}.

The text before and after the deletion is what makes the card teachable — a
fact tested inside a sentence that shows it in use is recalled in use, while an
isolated pair is only ever recalled as a lookup.

Markup rules:
- Put the whole sentence in "front", with the hidden span wrapped as
  {{c1::answer}}. Always number it c1.
- Exactly one deletion per card. If a sentence deserves two, write two cards
  with two different sentences.
- A hint goes inside the braces as a third section: {{c1::answer::hint}}.
  Write the hint in the learner's native language. Supply one whenever the
  blank would otherwise admit several correct answers — it is what makes a card
  answerable the first time it is ever seen.
- Never write a literal "::" or "}}" inside a sentence; the markup has no
  escape mechanism and the card will be rejected.

Rules that always apply:
- Minimum information principle: one card tests exactly one fact. If a card
  needs "and" to describe what it asks, split it.
- The sentence around the blank must make the answer inferable in principle.
  Never write a sentence so bare that several answers fit and no hint narrows
  it.
- Never write a card answerable by elimination or by the shape of the question.
- Keep sentences short and natural. A sentence long enough to need a comma
  splice is usually two cards.
- Do not invent facts. If you are unsure of a detail, leave it out rather than
  guessing.
- "back" is optional. Use it only to carry the meaning of the sentence where
  that helps; leave it null otherwise. Never repeat the hidden answer in it.
- Each card carries an "aspect" label naming what it tests. Use a short
  lowercase noun such as meaning, definition, relation, cause, formula,
  origin, example.
`.trim();
```

- [ ] **Step 4: Rewrite `LANGUAGE_PACK`**

Replace `LANGUAGE_PACK` entirely. The recognition/production pair rule is gone — that rule is what produced the isolated cards this change exists to remove:

```ts
export const LANGUAGE_PACK = `
This note is a language-learning item. Additional rules apply.

- Every sentence you write is in the TARGET language, never the learner's.
  The hidden span is the thing being learned; the rest of the sentence is the
  context that teaches it.
- Use "back" for the sentence's meaning in the learner's native language, so a
  learner who restores the blank can still check they understood the sentence.
- Test production, not recognition. The learner should have to produce the
  target-language form, with the native-language hint inside the deletion
  standing in for the meaning they start from:
    Ich mag {{c1::Bananen::banany}} zum Frühstück.
- If the language marks grammatical gender on this word, test it by deleting
  the article alone, in a sentence where the article is unambiguous:
    {{c1::Die}} Banane ist gelb.
- If the word inflects in a way a learner must memorise (plural, irregular
  past, principal parts), write a sentence that FORCES that form and delete it:
    Ich habe zwei {{c1::Bananen}} gekauft.
- Keep every other word in the sentence simpler than the word being tested. A
  sentence containing three unknown words teaches nothing.
- The image represents the real-world thing the word denotes. It must never
  contain written words, and must never depict a translation. A picture of a
  banana teaches "die Banane"; the English word "banana" does not.
- Use the aspect labels: meaning, production, gender, plural, conjugation,
  pronunciation.
`.trim();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno task test server/ai/rule-packs.test.ts`
Expected: PASS — the four new tests plus the eight existing ones. The existing "does not leak vocabulary rules into a concept note" and "always states the minimum information principle" assertions must still pass; if the latter fails, the phrase "minimum information" was dropped from `BASE_PACK` in Step 3.

- [ ] **Step 6: Commit**

```bash
git add server/ai/rule-packs.ts server/ai/rule-packs.test.ts
git commit -m "feat(ai): generate cloze cards in place of isolated pairs"
```

---

### Task 5: Derive `card_type` on the save path

**Files:**
- Modify: `server/router/notes.ts:16-26` (input schema) and `:97-107` (card insert)
- Modify: `server/router/drafts.ts:51-54` (`draftCardSchema`)
- Modify: `server/router/notes.test.ts`

**Interfaces:**
- Consumes: `parseCloze` from `@mnimi/shared` (Task 1); `cards.cardType` from Task 2; and from `server/ai/card-rules.ts` (Task 3) — `clozeMarkupIsWellFormed`, `cardHasAnAnswer`, `MALFORMED_CLOZE`, `BASIC_CARD_NEEDS_BACK`.
- Produces: `notes.save` accepts `back: string | null` and writes `cardType`. No new exports.

**Do not re-declare the two validation predicates or their message strings here** — import them from `server/ai/card-rules.ts`, which Task 3 created for exactly this second caller.

This is the guard that matters most: a user can hand-type `{{c1::}}` in the editor, and this is where it is rejected rather than persisted as a card that renders an empty blank forever.

- [ ] **Step 1: Write the failing test**

Add to `server/router/notes.test.ts`. Place it beside the existing `describe("notes.save")` block, and reuse the file's existing `seedDraft` helper and sign-in flow exactly as the neighbouring tests do:

```ts
describe("notes.save and cloze cards", () => {
  it("stores a cloze card as cloze, with a null back allowed", async () => {
    const { context, userId } = await server.signIn("cloze@example.com");
    const draft = await seedDraft(context, userId);

    const note = await call(
      notesRouter.save,
      {
        draftId: draft.id,
        cards: [
          {
            aspect: "production",
            front: "Ich mag {{c1::Bananen::banany}} zum Frühstück.",
            back: null,
            hint: null,
          },
        ],
      },
      { context },
    );

    const [saved] = await server.db
      .select()
      .from(cards)
      .where(eq(cards.noteId, note.id));

    expect(saved.cardType).toBe("cloze");
    expect(saved.back).toBeNull();
    expect(saved.front).toContain("{{c1::Bananen::banany}}");
  });

  it("stores a card with no deletion as basic", async () => {
    const { context, userId } = await server.signIn("basic@example.com");
    const draft = await seedDraft(context, userId);

    const note = await call(
      notesRouter.save,
      {
        draftId: draft.id,
        cards: [
          { aspect: "meaning", front: "Poseidon", back: "sea god", hint: null },
        ],
      },
      { context },
    );

    const [saved] = await server.db
      .select()
      .from(cards)
      .where(eq(cards.noteId, note.id));

    expect(saved.cardType).toBe("basic");
    expect(saved.back).toBe("sea god");
  });

  it("rejects malformed markup instead of saving an empty blank", async () => {
    const { context, userId } = await server.signIn("broken@example.com");
    const draft = await seedDraft(context, userId);

    await expect(
      call(
        notesRouter.save,
        {
          draftId: draft.id,
          cards: [
            { aspect: "production", front: "Ich mag {{c1::}}.", back: null, hint: null },
          ],
        },
        { context },
      ),
    ).rejects.toThrow();
  });

  it("rejects a basic card with no back", async () => {
    const { context, userId } = await server.signIn("noback@example.com");
    const draft = await seedDraft(context, userId);

    await expect(
      call(
        notesRouter.save,
        {
          draftId: draft.id,
          cards: [{ aspect: "meaning", front: "Poseidon", back: null, hint: null }],
        },
        { context },
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test server/router/notes.test.ts`
Expected: FAIL — `back: null` is rejected by the current input schema, and `cardType` does not exist on the saved row.

- [ ] **Step 3: Change the input schema and the insert**

In `server/router/notes.ts`, add the imports beside the existing ones:

```ts
import { parseCloze } from "@mnimi/shared";
import {
  BASIC_CARD_NEEDS_BACK,
  cardHasAnAnswer,
  clozeMarkupIsWellFormed,
  MALFORMED_CLOZE,
} from "../ai/card-rules.ts";
```

Replace `saveNoteInput`'s card object (lines 16-25) with:

```ts
  cards: z
    .array(
      z
        .object({
          aspect: z.string().min(1),
          front: z.string().min(1),
          back: z.string().min(1).nullable(),
          hint: z.string().nullable(),
        })
        // The editor is a free-text field, so a hand-typed "{{c1::}}" reaches
        // here as readily as a generated card does. Rejecting it at the
        // boundary is what stops a card that renders a permanently empty blank
        // from being written and scheduled. Same rules as the generation
        // schema, from the same module, so the two cannot drift.
        .refine(clozeMarkupIsWellFormed, { message: MALFORMED_CLOZE, path: ["front"] })
        .refine(cardHasAnAnswer, { message: BASIC_CARD_NEEDS_BACK, path: ["back"] }),
    )
    .min(1),
```

Then, in the `tx.insert(cards).values(...)` call (lines 97-107), add the derived column:

```ts
        await tx.insert(cards).values(
          input.cards.map((card) => ({
            noteId: inserted.id,
            userId: context.userId,
            aspect: card.aspect,
            front: card.front,
            back: card.back,
            hint: card.hint,
            // Derived, never asked of the model: a card claiming "basic" while
            // containing braces is a state this makes unrepresentable.
            cardType: parseCloze(card.front) ? ("cloze" as const) : ("basic" as const),
            due: now,
          })),
        );
```

- [ ] **Step 4: Let a draft autosave a null back**

In `server/router/drafts.ts`, change `draftCardSchema`'s `back` (line 53) so an in-progress cloze card can be autosaved before it has a meaning line:

```ts
  back: z.string().nullable(),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno task test server/router/notes.test.ts server/router/drafts.test.ts`
Expected: PASS. The existing `CARDS` fixture (`server/router/notes.test.ts:30-33`) is two basic cards with backs, so it keeps saving as `basic`.

- [ ] **Step 6: Run the whole suite and the type check**

Run: `deno task test && deno task check:api`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/router/notes.ts server/router/drafts.ts server/router/notes.test.ts
git commit -m "feat(api): derive card_type from cloze markup on save"
```

---

### Task 6: The `ClozeText` renderer

**Files:**
- Create: `src/components/cloze-text.tsx`
- Create: `src/components/cloze-text.test.tsx`

**Interfaces:**
- Consumes: `ClozeSegments` from `@mnimi/shared` (Task 1).
- Produces: `<ClozeText segments={ClozeSegments} reveal?: boolean />`. Tasks 7, 8 and 9 all render through this one component.

The package stays pure logic; this is where segments become JSX, and it is the only such place.

- [ ] **Step 1: Write the failing test**

Create `src/components/cloze-text.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { parseCloze } from "@mnimi/shared";
import { ClozeText } from "@/components/cloze-text";

afterEach(cleanup);

const WITH_HINT = parseCloze("Ich mag {{c1::Bananen::banany}} zum Frühstück.")!;
const NO_HINT = parseCloze("Ich mag {{c1::Bananen}} zum Frühstück.")!;

describe("ClozeText", () => {
  it("hides the answer and shows the hint in its place", () => {
    const { container } = render(<ClozeText segments={WITH_HINT} />);

    expect(container.textContent).toBe("Ich mag [banany] zum Frühstück.");
    expect(screen.queryByText("Bananen")).toBeNull();
  });

  it("shows a blank rule when there is no hint", () => {
    const { container } = render(<ClozeText segments={NO_HINT} />);

    expect(container.textContent).toBe("Ich mag ____ zum Frühstück.");
    expect(screen.queryByText("Bananen")).toBeNull();
  });

  it("fills the answer in when revealed", () => {
    const { container } = render(<ClozeText segments={WITH_HINT} reveal />);

    expect(container.textContent).toBe("Ich mag Bananen zum Frühstück.");
    expect(screen.queryByText("[banany]")).toBeNull();
  });

  it("wraps the answer in its own element so it can be styled", () => {
    render(<ClozeText segments={WITH_HINT} reveal />);

    expect(screen.getByText("Bananen").tagName).toBe("SPAN");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test src/components/cloze-text.test.tsx`
Expected: FAIL — cannot resolve `./cloze-text`.

- [ ] **Step 3: Write the component**

Create `src/components/cloze-text.tsx`:

```tsx
import type { ClozeSegments } from "@mnimi/shared";

/**
 * The one place cloze segments become JSX. `@mnimi/shared` stays pure logic
 * and knows nothing about React; this decides what a blank looks like, and
 * every display site — review, note detail, streaming list, editor preview —
 * goes through here so a blank looks the same everywhere.
 *
 * The hint renders INSIDE the blank rather than after the sentence: it is
 * needed at the point of retrieval, and moving the reader's eye to the end of
 * the line to find it defeats the purpose.
 */
export function ClozeText({
  segments,
  reveal = false,
}: {
  segments: ClozeSegments;
  reveal?: boolean;
}) {
  return (
    <>
      {segments.before}
      {reveal ? (
        <span className="text-primary underline decoration-primary/40 underline-offset-4">
          {segments.answer}
        </span>
      ) : (
        <span className="italic text-muted-foreground">
          {segments.hint ? `[${segments.hint}]` : "____"}
        </span>
      )}
      {segments.after}
    </>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test src/components/cloze-text.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/cloze-text.tsx src/components/cloze-text.test.tsx
git commit -m "feat(ui): add the ClozeText renderer"
```

---

### Task 7: Card faces, and the review screen

**Files:**
- Create: `src/components/card-face.tsx`
- Create: `src/components/card-face.test.tsx`
- Modify: `src/routes/_authed.review.$deckId.tsx:135-164`

**Interfaces:**
- Consumes: `ClozeText` (Task 6); `parseCloze` from `@mnimi/shared` (Task 1).
- Produces: `<CardFront front={string} />` and `<CardBack front={string} back={string | null} />`, both from `src/components/card-face.tsx`. Task 8 reuses `CardBack`.

Extracting the two faces into their own component is what makes this testable — the route itself needs router and query context to render, while the faces need neither, and the branch on card type should exist in exactly one place.

- [ ] **Step 1: Write the failing test**

Create `src/components/card-face.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CardBack, CardFront } from "@/components/card-face";

afterEach(cleanup);

const CLOZE_FRONT = "Ich mag {{c1::Bananen::banany}} zum Frühstück.";

describe("CardFront", () => {
  it("blanks the deletion on a cloze card", () => {
    const { container } = render(<CardFront front={CLOZE_FRONT} />);

    expect(container.textContent).toBe("Ich mag [banany] zum Frühstück.");
  });

  it("shows a basic card's front verbatim", () => {
    const { container } = render(<CardFront front="Poseidon" />);

    expect(container.textContent).toBe("Poseidon");
  });
});

describe("CardBack", () => {
  it("fills the deletion in and shows the meaning beneath it", () => {
    render(<CardBack front={CLOZE_FRONT} back="Lubię banany na śniadanie." />);

    expect(screen.getByText("Bananen")).toBeTruthy();
    expect(screen.getByText("Lubię banany na śniadanie.")).toBeTruthy();
  });

  it("shows only the completed sentence when there is no meaning line", () => {
    const { container } = render(<CardBack front={CLOZE_FRONT} back={null} />);

    expect(container.textContent).toBe("Ich mag Bananen zum Frühstück.");
  });

  it("shows a basic card's back", () => {
    const { container } = render(<CardBack front="Poseidon" back="sea god" />);

    expect(container.textContent).toBe("sea god");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test src/components/card-face.test.tsx`
Expected: FAIL — cannot resolve `./card-face`.

- [ ] **Step 3: Write the component**

Create `src/components/card-face.tsx`:

```tsx
import { parseCloze } from "@mnimi/shared";
import { ClozeText } from "./cloze-text";

/**
 * The two faces of a card, with the basic/cloze branch in one place.
 *
 * These take the raw strings rather than a card row so the same components
 * serve a saved card, a draft card mid-edit, and a test — none of which agree
 * on what else a "card" carries.
 */
export function CardFront({ front }: { front: string }) {
  const segments = parseCloze(front);

  return segments ? <ClozeText segments={segments} /> : <>{front}</>;
}

/**
 * For a cloze card the back is DERIVED — the same sentence with the deletion
 * filled in — because the answer lives in `front`. `back` is then an optional
 * meaning line rendered beneath it as supporting text, never as the answer.
 */
export function CardBack({
  front,
  back,
}: {
  front: string;
  back: string | null;
}) {
  const segments = parseCloze(front);

  if (!segments) return <>{back}</>;

  return (
    <>
      <ClozeText segments={segments} reveal />
      {back && (
        <span className="mt-3 block text-base font-normal opacity-80">
          {back}
        </span>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test src/components/card-face.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire the review screen**

In `src/routes/_authed.review.$deckId.tsx`, add the imports:

```ts
import { parseCloze } from "@mnimi/shared";
import { CardBack, CardFront } from "@/components/card-face";
```

Replace the front face (line 137, `{card.front}`) with:

```tsx
          <CardFront front={card.front} />
```

Replace the back face (line 151, `{card.back}`) with:

```tsx
              <CardBack front={card.front} back={card.back} />
```

And fix the image `alt` (line 160), which currently reads `card.back` — for a cloze row the back is a meaning line or null, so the answer is the right description:

```tsx
                alt={parseCloze(card.front)?.answer ?? card.back ?? ""}
```

- [ ] **Step 6: Verify the app builds and the suite passes**

Run: `deno task test && deno task build`
Expected: PASS. The build is what catches `card.back` now being `string | null` at any site still assuming a string.

- [ ] **Step 7: Commit**

```bash
git add src/components/card-face.tsx src/components/card-face.test.tsx src/routes/_authed.review.\$deckId.tsx
git commit -m "feat(ui): render cloze blanks and reveals in review"
```

---

### Task 8: Note detail and the streaming list

**Files:**
- Modify: `src/routes/_authed.notes.$noteId.tsx:114-118`
- Modify: `src/components/streaming-cards.tsx:59-67`
- Create: `src/components/streaming-cards.test.tsx`

**Interfaces:**
- Consumes: `CardBack` (Task 7); `stripPartialCloze`, `parseCloze` from `@mnimi/shared` (Task 1).
- Produces: no new exports.

Two display surfaces with opposite needs. The note detail screen is a browse view, not a test, so it reveals. The streaming list receives text mid-arrival, so it must tolerate markup that is still being written.

- [ ] **Step 1: Write the failing test**

Create `src/components/streaming-cards.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StreamingCards } from "@/components/streaming-cards";

afterEach(cleanup);

describe("StreamingCards", () => {
  it("hides a half-arrived deletion instead of flashing brace noise", () => {
    const { container } = render(
      <StreamingCards
        cards={[{ aspect: "production", front: "Ich mag {{c1::Ban", back: null }]}
      />,
    );

    expect(container.textContent).toContain("Ich mag");
    expect(container.textContent).not.toContain("{{");
    expect(container.textContent).not.toContain("Ban");
  });

  it("blanks a deletion once it is complete", () => {
    render(
      <StreamingCards
        cards={[
          {
            aspect: "production",
            front: "Ich mag {{c1::Bananen::banany}} zum",
            back: null,
          },
        ]}
      />,
    );

    expect(screen.getByText("[banany]")).toBeTruthy();
    expect(screen.queryByText("Bananen")).toBeNull();
  });

  it("shows plain text untouched", () => {
    const { container } = render(
      <StreamingCards
        cards={[{ aspect: "meaning", front: "Poseidon", back: "sea god" }]}
      />,
    );

    expect(container.textContent).toContain("Poseidon");
    expect(container.textContent).toContain("sea god");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test src/components/streaming-cards.test.tsx`
Expected: FAIL — the raw `{{c1::Ban` is rendered verbatim.

- [ ] **Step 3: Make the streaming field cloze-aware**

In `src/components/streaming-cards.tsx`, add the imports:

```ts
import { parseCloze, stripPartialCloze } from "@mnimi/shared";
import { ClozeText } from "./cloze-text";
```

Replace the body of `StreamingField` (lines 59-67) with:

```tsx
function StreamingField({ value }: { value: string | null | undefined }) {
  if (value === null || value === undefined) return <Skeleton className="h-8 w-full" />;

  // A deletion arrives one character at a time, so for a few deltas the text
  // holds an opening brace pair and nothing else. Trimming that unfinished
  // tail keeps the row readable instead of flickering "{{c1::Ban" as it grows.
  const segments = parseCloze(value);

  return (
    <p className="flex h-8 items-center px-2.5 py-1 text-base md:text-sm">
      {segments ? <ClozeText segments={segments} /> : stripPartialCloze(value)}
    </p>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test src/components/streaming-cards.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Reveal cloze on the note detail screen**

In `src/routes/_authed.notes.$noteId.tsx`, add the import:

```ts
import { CardBack, CardFront } from "@/components/card-face";
```

Replace the two card lines (116-117):

```tsx
                <p className="mt-1 font-medium">
                  <CardFront front={card.front} />
                </p>
                <p className="text-muted-foreground">
                  <CardBack front={card.front} back={card.back} />
                </p>
```

- [ ] **Step 6: Verify the suite and the build**

Run: `deno task test && deno task build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/streaming-cards.tsx src/components/streaming-cards.test.tsx src/routes/_authed.notes.\$noteId.tsx
git commit -m "feat(ui): render cloze in the note screen and streaming list"
```

---

### Task 9: The editor — live preview and the savability rule

**Files:**
- Modify: `src/components/card-editor.tsx`
- Create: `src/components/card-editor.test.tsx`
- Modify: `src/lib/draft-state.ts:69,204-210`
- Modify: `src/lib/draft-state.test.ts`
- Modify: `src/routes/_authed.add.tsx:341-352,359-366,383-392`

**Interfaces:**
- Consumes: `CardFront` (Task 7); `parseCloze` from `@mnimi/shared` (Task 1).
- Produces: `isSavable` keeps its signature `(state: DraftState) => boolean` with widened behaviour.

The preview is what makes malformed markup visible *before* a card is saved and scheduled — it costs almost nothing on top of a renderer that had to exist anyway. Since the hint now lives inside the markup, it becomes editable for the first time; today `hint` is generated and has no editor field at all.

- [ ] **Step 1: Write the failing editor test**

Create `src/components/card-editor.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CardEditor } from "@/components/card-editor";

afterEach(cleanup);

const CLOZE = {
  aspect: "production",
  front: "Ich mag {{c1::Bananen::banany}} zum Frühstück.",
  back: null,
  hint: null,
};

describe("CardEditor", () => {
  it("keeps the raw markup in the editable field", () => {
    render(<CardEditor card={CLOZE} onChange={vi.fn()} onRemove={vi.fn()} />);

    const front = screen.getByLabelText("Front") as HTMLInputElement;
    expect(front.value).toBe(CLOZE.front);
  });

  it("previews what the card will look like in review", () => {
    render(<CardEditor card={CLOZE} onChange={vi.fn()} onRemove={vi.fn()} />);

    expect(screen.getByTestId("cloze-preview").textContent).toBe(
      "Ich mag [banany] zum Frühstück.",
    );
  });

  it("warns when the markup is malformed", () => {
    render(
      <CardEditor
        card={{ ...CLOZE, front: "Ich mag {{c1::}}." }}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText(/check the deletion/i)).toBeTruthy();
    expect(screen.queryByTestId("cloze-preview")).toBeNull();
  });

  it("shows no preview for a basic card", () => {
    render(
      <CardEditor
        card={{ aspect: "meaning", front: "Poseidon", back: "sea god", hint: null }}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("cloze-preview")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test src/components/card-editor.test.tsx`
Expected: FAIL — there is no preview element.

- [ ] **Step 3: Add the preview to the editor**

In `src/components/card-editor.tsx`, add the imports:

```ts
import { hasClozeMarkup, parseCloze } from "@mnimi/shared";
import { CardFront } from "./card-face";
```

Replace the `<CardContent>` block (lines 42-53) with:

```tsx
      <CardContent className="space-y-2">
        <Input
          aria-label="Front"
          value={card.front}
          onChange={(e) => onChange({ front: e.target.value })}
        />

        {/* Raw markup above, rendered result below. The preview reuses the
            review screen's own renderer, so what it shows is what the card
            will be — and malformed markup is visible here, before the card is
            saved and scheduled, rather than as a permanently empty blank. */}
        {hasClozeMarkup(card.front) &&
          (parseCloze(card.front) ? (
            <p
              data-testid="cloze-preview"
              className="px-2.5 text-sm text-muted-foreground"
            >
              <CardFront front={card.front} />
            </p>
          ) : (
            <p className="px-2.5 text-sm text-destructive">
              Check the deletion — one {"{{c1::answer}}"} per card, with a
              non-empty answer.
            </p>
          ))}

        <Input
          aria-label="Back"
          value={card.back ?? ""}
          placeholder={parseCloze(card.front) ? "Meaning (optional)" : undefined}
          onChange={(e) => onChange({ back: e.target.value })}
        />
      </CardContent>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test src/components/card-editor.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing savability test**

Add to `src/lib/draft-state.test.ts`, following the file's existing pattern for building a ready state:

```ts
describe("isSavable with cloze cards", () => {
  it("accepts a cloze card with no back", () => {
    const state = readyStateWith([
      {
        aspect: "production",
        front: "Ich mag {{c1::Bananen::banany}} zum Frühstück.",
        back: null,
        hint: null,
      },
    ]);

    expect(isSavable(state)).toBe(true);
  });

  it("still requires a back on a basic card", () => {
    const state = readyStateWith([
      { aspect: "meaning", front: "Poseidon", back: "", hint: null },
    ]);

    expect(isSavable(state)).toBe(false);
  });

  it("rejects a card whose front is empty", () => {
    const state = readyStateWith([
      { aspect: "meaning", front: "", back: "sea god", hint: null },
    ]);

    expect(isSavable(state)).toBe(false);
  });
});
```

Add the helper near the top of the file if one does not already exist, matching however the file currently constructs a live ready state:

```ts
function readyStateWith(cards: DraftCard[]): DraftState {
  return { ...readyState, cards };
}
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `deno task test src/lib/draft-state.test.ts`
Expected: FAIL — a cloze card with a null back is currently unsavable.

- [ ] **Step 7: Widen the savability rule**

In `src/lib/draft-state.ts`, add the import:

```ts
import { parseCloze } from "@mnimi/shared";
```

Replace `isSavable` (lines 204-210):

```ts
export function isSavable(state: DraftState): boolean {
  if (!isLive(state) || state.status === "generating") return false;
  if (state.cards.length === 0) return false;

  return state.cards.every((card) => {
    const front = (card.front ?? "").trim();
    if (front === "") return false;

    // A cloze card's answer is inside its front, so it needs no back. A basic
    // card without a back is a card with no answer at all.
    if (parseCloze(front)) return true;
    return (card.back ?? "").trim() !== "";
  });
}
```

Also update the hand-editable fallback card at line 69 — the one a failed generation leaves behind. It stays a basic card, but its back is now `null` rather than `""`:

```ts
      : [{ aspect: "meaning", front: text, back: null, hint: null }],
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `deno task test src/lib/draft-state.test.ts`
Expected: PASS.

- [ ] **Step 9: Update the add screen**

In `src/routes/_authed.add.tsx`, three changes.

The `CardEditor` props (lines 344-349) must stop coercing a null back to `""`, which would make every cloze card look like it has an empty meaning line:

```tsx
            card={{
              aspect: card.aspect ?? "",
              front: card.front ?? "",
              back: card.back ?? null,
              hint: card.hint ?? null,
            }}
```

The validation copy (lines 359-366) no longer describes the rule:

```tsx
          <AlertDescription>
            Every card needs a front, and every card without a{" "}
            {"{{c1::deletion}}"} needs a back — fill in or remove the blank
            ones.
          </AlertDescription>
```

And the save mutation (lines 385-390) must send `null` rather than `""`, so the server's "a basic card needs a back" refinement sees the real state:

```tsx
                  cards: state.cards.map((card) => ({
                    aspect: card.aspect ?? "",
                    front: (card.front ?? "").trim(),
                    back: (card.back ?? "").trim() || null,
                    hint: card.hint ?? null,
                  })),
```

- [ ] **Step 10: Run the full suite, the type check and the build**

Run: `deno task test && deno task check:api && deno task build`
Expected: all PASS. If `src/routes/-_authed.add.test.tsx` fails, its `CARDS` fixture (line 137) is a basic card and should still pass — a failure there means the savability rule or the null-back plumbing is wrong, not the fixture.

- [ ] **Step 11: Commit**

```bash
git add src/components/card-editor.tsx src/components/card-editor.test.tsx src/lib/draft-state.ts src/lib/draft-state.test.ts src/routes/_authed.add.tsx
git commit -m "feat(ui): preview cloze markup in the editor and allow a null back"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the card description**

`README.md` describes the app's card model in its opening sections and lists the repository layout around line 370. Read both, then:

1. Update any description of cards as front/back pairs to describe cloze deletions, using `Ich mag {{c1::Bananen::banany}} zum Frühstück.` as the example.
2. Add `shared/` to the repository layout block, described as "cloze markup parser, shared by server and client".
3. If the layout block lists `server/ai/` contents, leave them as they are — no files were added there.

- [ ] **Step 2: Verify no stale claims remain**

Run: `grep -n "recognition\|production\|front/back\|front and back" README.md`

Read each hit and correct any that still describe the isolated-pair model.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe cloze cards in the README"
```

---

## Verification

After Task 10, confirm the whole change from a clean state:

```bash
deno task test && deno task check:api && deno task build
```

All three must pass. Then apply the migration to the real database and confirm it lands:

```bash
deno task db:migrate
```

Manual check worth doing once, since no automated test covers the full loop: run `deno task dev`, capture a German noun on `/add`, confirm the generated cards are sentences with blanks, save, then review the deck and confirm the blank hides the answer and the reveal fills it in.
