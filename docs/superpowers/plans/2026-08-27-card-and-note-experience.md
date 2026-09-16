# Card and Saved Note Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the disabled-form saved-note screen with a polished reading experience and add complete, atomic card creation, correction, reset, and deletion.

**Architecture:** Add a versioned, transactional saved-note mutation boundary on the server and a pure local card-draft model on mobile. Compose focused presentation, editor, read-view, and edit-view components under `NoteScreen`; preserve server authority for card validity, FSRS state, and media lifecycle while keeping an entire edit session local until one explicit save.

**Tech Stack:** Bun 1.3.13, TypeScript 6, Expo SDK 57, React Native 0.86, Expo Router, React Query/oRPC, NativeWind, React Native Reusables, Drizzle ORM/libSQL, Zod, Vitest, Jest, React Native Testing Library, ts-fsrs.

**Spec:** `docs/superpowers/specs/2026-08-27-card-and-note-experience-design.md`

## Global Constraints

- Read `AGENTS.md`, the north star, and the linked specification before editing.
- Use `bun` for package management and every script or CLI invocation. Do not use Deno, npm, npx, Yarn, or pnpm.
- Run the complete repository test suite with `bun run test`; do not substitute raw `bun test`.
- Add no dependency. The existing Expo Router, React Native primitives, dialogs, Drizzle, Zod, and test libraries cover the work.
- Keep source code, UI copy, tests, specifications, plans, and commit messages in English.
- Keep `sourceText` and note-image editing out of scope.
- Keep card `aspect` as open text. Do not introduce an enum or a closed mapping.
- Never show raw `{{c1::...}}` syntax in saved-note read mode or normal editing.
- Always show an existing inline cloze hint before reveal, including when `imageCue` is true. Do not add a `Text hint` action.
- Preserve card IDs, FSRS columns, and review logs for ordinary edits. Reset them only through the explicit reset operation.
- Make card and note deletion permanent, confirmed, ownership-scoped, and media-aware.
- Keep a note after its final card is deleted.
- Use semantic theme classes, 48 px minimum touch targets, safe-area spacing, keyboard reachability, enlarged-text layouts, and non-color state cues.
- Keep all application behavior outside this slice unchanged, including draft generation, Review grading, Today, decks, authentication, and settings.
- Follow TDD for each task and use conventional commits with explicitly staged paths.

## File Structure

The implementation adds or changes these focused units:

- `apps/mobile/src/lib/native-cloze.ts`: parse, edit-range, and serialize cloze text without UI dependencies.
- `apps/mobile/src/lib/card-draft.ts`: hydrate, validate, diff, and serialize a complete local note-edit session.
- `apps/mobile/src/api/notes.ts`: public note/card transport types and React Query hooks.
- `apps/mobile/src/components/card-presentation.tsx`: shared basic/cloze inspection and reveal semantics.
- `apps/mobile/src/components/card-edit-form.tsx`: one card's learner-facing editor and preview.
- `apps/mobile/src/components/add-card-dialog.tsx`: basic-versus-cloze selection.
- `apps/mobile/src/hooks/use-unsaved-changes.ts`: navigation guard for dirty edit sessions.
- `apps/mobile/src/features/notes/note-read-view.tsx`: saved-note inspection, image state, empty state, and note actions.
- `apps/mobile/src/features/notes/note-edit-view.tsx`: card forms, confirmations, conflict state, and sticky save composition.
- `apps/mobile/src/features/notes/note-screen.tsx`: query and mutation orchestration only.
- `apps/server/db/schema.ts` and generated Drizzle migration files: note revision.
- `apps/server/router/notes.ts`: versioned get/update/delete procedures and transaction orchestration.
- `apps/server/router/note-card-operations.ts`: operation validation, initial/reset scheduling values, and media decisions.

---

### Task 1: Add the pure cloze and note-edit draft model

**Files:**
- Modify: `apps/mobile/src/api/notes.ts`
- Modify: `apps/mobile/src/lib/native-cloze.ts`
- Create: `apps/mobile/src/lib/card-draft.ts`
- Create: `apps/mobile/__tests__/native-cloze.test.ts`
- Create: `apps/mobile/__tests__/card-draft.test.ts`

**Interfaces:**
- Consumes: Existing `parseCloze(front)` semantics and saved-note card fields.
- Produces: `TextRange`, `EditableCloze`, `NoteCard`, `NoteDetails`, `CardDraft`, `NoteEditDraft`, `parseEditableCloze`, `updateEditableClozeSentence`, `serializeEditableCloze`, `hydrateNoteEditDraft`, `createCardDraft`, `validateCardDraft`, `isNoteEditDirty`, and `buildNoteUpdateInput`.

- [ ] **Step 1: Export the complete mobile note transport types**

  Extend `apps/mobile/src/api/notes.ts` before changing hooks. Keep `EditableCard`, then replace its private note types with these exported contracts:

  ```ts
  export type CardType = "basic" | "cloze";
  export type CardAudioStatus =
    | "pending"
    | "generating"
    | "ready"
    | "failed"
    | null;

  export type NoteSummary = {
    id: string;
    deckId: string;
    sourceText: string;
  };

  export type NoteCard = EditableCard & {
    id: string;
    cardType: CardType;
    audioEligible: boolean;
    hasAudio: boolean;
    audioStatus: CardAudioStatus;
  };

  export type NoteDetails = {
    note: NoteSummary & {
      revision: number;
      domain: string;
      language: string | null;
      imagePath: string | null;
      metadata: { imagePrompt?: string | null };
    };
    cards: NoteCard[];
    imageGenerating: boolean;
  };

  export type NoteUpdateInput = {
    noteId: string;
    expectedRevision: number;
    creates: Array<{ clientKey: string; card: EditableCard }>;
    updates: Array<{ cardId: string; card: EditableCard }>;
    deleteCardIds: string[];
    resetCardIds: string[];
  };
  ```

  Make the existing `useNote` and `noteHasActiveAudio` use these exported types without changing runtime behavior.

- [ ] **Step 2: Write failing cloze-edit tests**

  Create `apps/mobile/__tests__/native-cloze.test.ts` with these cases:

  ```ts
  import {
    parseEditableCloze,
    serializeEditableCloze,
    updateEditableClozeSentence,
  } from "../src/lib/native-cloze";

  describe("editable native cloze", () => {
    const parsed = {
      sentence: "Ich mag Bananen.",
      answerRange: { start: 8, end: 15 },
      hint: "banany",
    };

    it("hydrates storage markup into plain learner-facing fields", () => {
      expect(
        parseEditableCloze("Ich mag {{c1::Bananen::banany}}."),
      ).toEqual(parsed);
    });

    it("serializes a valid selection without leaking an empty hint", () => {
      expect(serializeEditableCloze(parsed)).toBe(
        "Ich mag {{c1::Bananen::banany}}.",
      );
      expect(serializeEditableCloze({ ...parsed, hint: "" })).toBe(
        "Ich mag {{c1::Bananen}}.",
      );
    });

    it("moves a selection when text is inserted before it", () => {
      expect(updateEditableClozeSentence(parsed, "Heute: Ich mag Bananen."))
        .toEqual({
          ...parsed,
          sentence: "Heute: Ich mag Bananen.",
          answerRange: { start: 15, end: 22 },
        });
    });

    it("keeps a selection when text changes after it", () => {
      expect(updateEditableClozeSentence(parsed, "Ich mag Bananen sehr."))
        .toEqual({ ...parsed, sentence: "Ich mag Bananen sehr." });
    });

    it("invalidates a selection when the hidden answer is edited", () => {
      expect(updateEditableClozeSentence(parsed, "Ich mag Äpfel."))
        .toEqual({
          ...parsed,
          sentence: "Ich mag Äpfel.",
          answerRange: null,
        });
    });

    it("refuses delimiters that cannot round-trip through storage", () => {
      expect(serializeEditableCloze({
        sentence: "A {{ broken",
        answerRange: { start: 0, end: 1 },
        hint: "cue",
      })).toBeNull();
      expect(serializeEditableCloze({
        sentence: "Answer",
        answerRange: { start: 0, end: 6 },
        hint: "bad::hint",
      })).toBeNull();
    });
  });
  ```

- [ ] **Step 3: Run the cloze tests and verify the intended failure**

  Run:

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/native-cloze.test.ts
  ```

  Expected: FAIL because the three editable-cloze exports do not exist.

- [ ] **Step 4: Implement cloze hydration, range adjustment, and serialization**

  Add these public types and functions to `apps/mobile/src/lib/native-cloze.ts`, retaining the existing `parseCloze` behavior:

  ```ts
  export type TextRange = { start: number; end: number };
  export type EditableCloze = {
    sentence: string;
    answerRange: TextRange | null;
    hint: string;
  };

  export function parseEditableCloze(front: string): EditableCloze | null {
    const parsed = parseCloze(front);
    if (!parsed) return null;
    return {
      sentence: `${parsed.before}${parsed.answer}${parsed.after}`,
      answerRange: {
        start: parsed.before.length,
        end: parsed.before.length + parsed.answer.length,
      },
      hint: parsed.hint ?? "",
    };
  }

  function commonPrefixLength(left: string, right: string): number {
    let index = 0;
    while (index < left.length && index < right.length && left[index] === right[index]) {
      index += 1;
    }
    return index;
  }

  function commonSuffixLength(left: string, right: string, prefix: number): number {
    let count = 0;
    while (
      count < left.length - prefix &&
      count < right.length - prefix &&
      left[left.length - 1 - count] === right[right.length - 1 - count]
    ) count += 1;
    return count;
  }

  export function updateEditableClozeSentence(
    current: EditableCloze,
    sentence: string,
  ): EditableCloze {
    const range = current.answerRange;
    if (!range) return { ...current, sentence };
    const prefix = commonPrefixLength(current.sentence, sentence);
    const suffix = commonSuffixLength(current.sentence, sentence, prefix);
    const oldChangeEnd = current.sentence.length - suffix;
    const delta = sentence.length - current.sentence.length;
    if (oldChangeEnd <= range.start) {
      return {
        ...current,
        sentence,
        answerRange: { start: range.start + delta, end: range.end + delta },
      };
    }
    if (prefix >= range.end) return { ...current, sentence };
    return { ...current, sentence, answerRange: null };
  }

  export function serializeEditableCloze(model: EditableCloze): string | null {
    const range = model.answerRange;
    if (!range || range.start < 0 || range.end > model.sentence.length || range.start >= range.end) {
      return null;
    }
    const before = model.sentence.slice(0, range.start);
    const answer = model.sentence.slice(range.start, range.end);
    const after = model.sentence.slice(range.end);
    const hint = model.hint.trim();
    if (
      !answer.trim() ||
      [before, answer, after, hint].some((part) =>
        part.includes("{{") || part.includes("}}") || part.includes("::")
      )
    ) return null;
    return `${before}{{c1::${answer}${hint ? `::${hint}` : ""}}}${after}`;
  }
  ```

- [ ] **Step 5: Write failing note-draft tests**

  Create `apps/mobile/__tests__/card-draft.test.ts`. Use one basic and one cloze `NoteCard`, then pin these behaviors:

  ```ts
  import {
    buildNoteUpdateInput,
    createCardDraft,
    hydrateNoteEditDraft,
    isNoteEditDirty,
    validateCardDraft,
  } from "../src/lib/card-draft";
  import type { NoteDetails } from "../src/api/notes";

  const details: NoteDetails = {
    note: {
      id: "note-1",
      deckId: "deck-1",
      sourceText: "Haus",
      revision: 4,
      domain: "language",
      language: "de",
      imagePath: "u/note-1.png",
      metadata: { imagePrompt: "a house" },
    },
    cards: [
      {
        id: "card-1",
        cardType: "cloze",
        aspect: "past_tense",
        front: "Ich sehe ein {{c1::Haus::dom}}.",
        back: "Widzę dom.",
        imageCue: true,
        audioEligible: true,
        hasAudio: true,
        audioStatus: "ready",
      },
      {
        id: "card-2",
        cardType: "basic",
        aspect: "definition",
        front: "What is a house?",
        back: "A building used as a home.",
        imageCue: false,
        audioEligible: false,
        hasAudio: false,
        audioStatus: null,
      },
    ],
    imageGenerating: false,
  };

  it("hydrates raw cloze into a clean draft and starts clean", () => {
    const draft = hydrateNoteEditDraft(details);
    expect(draft.cards[0]).toMatchObject({
      kind: "cloze",
      sentence: "Ich sehe ein Haus.",
      answerRange: { start: 13, end: 17 },
      hint: "dom",
      back: "Widzę dom.",
    });
    expect(isNoteEditDirty(draft)).toBe(false);
  });

  it("keeps aspects open and validates card-type rules", () => {
    const card = createCardDraft("cloze", "new-1");
    expect(card.aspect).toBe("Fill in the blank");
    expect(validateCardDraft(card, { imageCueAllowed: true })).toMatchObject({
      sentence: expect.any(String),
      answerRange: expect.any(String),
    });
  });

  it("builds explicit create, update, delete, and reset operations", () => {
    const draft = hydrateNoteEditDraft(details);
    const existing = { ...draft.cards[0], aspect: "arbitrary focus", resetProgress: true };
    const created = {
      ...createCardDraft("basic", "new-1"),
      aspect: "physics definition",
      question: "What is inertia?",
      answer: "Resistance to a change in motion.",
    };
    const input = buildNoteUpdateInput({ ...draft, cards: [existing, created] });
    expect(input).toEqual({
      noteId: "note-1",
      expectedRevision: 4,
      creates: [{
        clientKey: "new-1",
        card: {
          aspect: "physics definition",
          front: "What is inertia?",
          back: "Resistance to a change in motion.",
          imageCue: false,
        },
      }],
      updates: [{
        cardId: "card-1",
        card: {
          aspect: "arbitrary focus",
          front: "Ich sehe ein {{c1::Haus::dom}}.",
          back: "Widzę dom.",
          imageCue: true,
        },
      }],
      deleteCardIds: ["card-2"],
      resetCardIds: ["card-1"],
    });
  });
  ```

- [ ] **Step 6: Run the note-draft tests and verify they fail**

  Run:

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/native-cloze.test.ts __tests__/card-draft.test.ts
  ```

  Expected: cloze tests PASS; card-draft tests FAIL because `card-draft.ts` does not exist.

- [ ] **Step 7: Implement the discriminated card-draft model**

  Create `apps/mobile/src/lib/card-draft.ts` with these public contracts:

  ```ts
  export type CardDraftBase = {
    key: string;
    persistedId: string | null;
    aspect: string;
    imageCue: boolean;
    resetProgress: boolean;
  };
  export type BasicCardDraft = CardDraftBase & {
    kind: "basic";
    question: string;
    answer: string;
  };
  export type ClozeCardDraft = CardDraftBase & EditableCloze & {
    kind: "cloze";
    back: string;
  };
  export type CardDraft = BasicCardDraft | ClozeCardDraft;
  export type NoteEditDraft = {
    noteId: string;
    revision: number;
    originalCards: NoteCard[];
    cards: CardDraft[];
  };
  export type CardDraftErrors = Partial<Record<
    "aspect" | "question" | "answer" | "sentence" | "answerRange" | "hint",
    string
  >>;
  ```

  Implement the following behavior exactly:

  ```ts
  export function createCardDraft(
    kind: CardDraft["kind"],
    key: string,
  ): CardDraft {
    const base = { key, persistedId: null, imageCue: false, resetProgress: false };
    return kind === "basic"
      ? { ...base, kind, aspect: "Question and answer", question: "", answer: "" }
      : {
          ...base,
          kind,
          aspect: "Fill in the blank",
          sentence: "",
          answerRange: null,
          hint: "",
          back: "",
        };
  }

  export function validateCardDraft(
    card: CardDraft,
    context: { imageCueAllowed: boolean },
  ): CardDraftErrors {
    const errors: CardDraftErrors = {};
    if (!card.aspect.trim()) errors.aspect = "Describe what this card practises.";
    if (card.kind === "basic") {
      if (!card.question.trim()) errors.question = "Enter a question.";
      if (!card.answer.trim()) errors.answer = "Enter an answer.";
      return errors;
    }
    if (!card.sentence.trim()) errors.sentence = "Enter a sentence.";
    if (!serializeEditableCloze(card)) errors.answerRange = "Select the text to hide.";
    if (card.imageCue && !context.imageCueAllowed) {
      errors.hint = "Image prompts require a language note with an intended image.";
    } else if (card.imageCue && !card.hint.trim()) {
      errors.hint = "Add the text cue shown with this image.";
    }
    return errors;
  }
  ```

  Hydrate `basic` from `front`/`back`; hydrate `cloze` with `parseEditableCloze`.
  Give every persisted draft `key: card.id` and `persistedId: card.id`; this is
  what lets server validation identities map back to the correct form without
  another lookup table.
  Serialize basic to `front: question.trim()` and `back: answer.trim()`.
  Serialize cloze with `serializeEditableCloze` and normalize an empty back to
  `null`. Build updates only when serialized persisted fields changed. Build
  deletes from persisted IDs absent from the current card list and resets from
  current persisted cards with `resetProgress: true`. Compare the current draft
  to its hydrated originals for `isNoteEditDirty`, including additions,
  deletions, field edits, and reset flags. Card reordering is not part of this
  slice; new cards append and existing relative order is never changed.

- [ ] **Step 8: Re-run focused tests and mobile type checking**

  Run:

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/native-cloze.test.ts __tests__/card-draft.test.ts
  bun run mobile:check
  ```

  Expected: PASS.

- [ ] **Step 9: Commit the pure edit model**

  ```bash
  git add apps/mobile/src/api/notes.ts apps/mobile/src/lib/native-cloze.ts apps/mobile/src/lib/card-draft.ts apps/mobile/__tests__/native-cloze.test.ts apps/mobile/__tests__/card-draft.test.ts
  git commit -m "feat(mobile): add structured card edit model"
  ```

### Task 2: Version notes and stabilize saved-note reads

**Files:**
- Modify: `apps/server/db/schema.ts`
- Modify: `apps/server/db/schema.test.ts`
- Modify: `apps/server/db/migrations.test.ts`
- Modify: `apps/server/router/notes.ts`
- Modify: `apps/server/router/notes.test.ts`
- Create: `apps/server/drizzle/0006_note_revision.sql`
- Create: `apps/server/drizzle/meta/0006_snapshot.json`
- Modify: `apps/server/drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: Existing `notes` and `cards` schema, generated Drizzle migration workflow, `notes.get`.
- Produces: `notes.revision: number`, migration `0006_note_revision`, and stable saved-note card order by creation time and ID.

- [ ] **Step 1: Write failing schema and read-order tests**

  Add this assertion to the existing schema round-trip test after inserting a note:

  ```ts
  expect(note.revision).toBe(0);
  ```

  Add a `notes.get` test that deliberately gives the older-created card a later
  due date, then requires content order:

  ```ts
  it("returns revision and cards in stable creation order instead of due order", async () => {
    const ada = await server.signIn("stable-order@example.com");
    const draft = await seedDraft(ada.context, ada.userId, { imagePrompt: null });
    const saved = await call(notesRouter.save, { draftId: draft.id, cards: CARDS }, {
      context: ada.context,
    });
    const rows = await server.db.select().from(cards).where(eq(cards.noteId, saved.id));
    await server.db.update(cards).set({ due: new Date(2_000) }).where(eq(cards.id, rows[0].id));
    await server.db.update(cards).set({ due: new Date(1_000) }).where(eq(cards.id, rows[1].id));

    const result = await call(notesRouter.get, { noteId: saved.id }, { context: ada.context });

    expect(result.note.revision).toBe(0);
    expect(result.cards.map((card) => card.id)).toEqual(rows.map((card) => card.id));
    expect(result.cards.map((card) => card.cardType)).toEqual(["basic", "basic"]);
  });
  ```

- [ ] **Step 2: Run focused server tests and confirm failure**

  ```bash
  bun run --cwd apps/server vitest run db/schema.test.ts router/notes.test.ts
  ```

  Expected: FAIL because `notes.revision` does not exist and `notes.get` still orders by `due`.

- [ ] **Step 3: Add `revision` to the Drizzle schema**

  Add this field beside `createdAt` in the `notes` table:

  ```ts
  revision: integer("revision").notNull().default(0),
  ```

- [ ] **Step 4: Generate the named migration with Bun**

  Run from the repository root:

  ```bash
  bun run --cwd apps/server db:generate -- --name note_revision
  ```

  Expected generated SQL in `apps/server/drizzle/0006_note_revision.sql`:

  ```sql
  ALTER TABLE `notes` ADD `revision` integer DEFAULT 0 NOT NULL;
  ```

  Inspect the generated snapshot and journal. Do not hand-edit generated JSON.

- [ ] **Step 5: Make migration replay tests target migrations by name**

  The current first test assumes the final migration is the hint-removal
  migration. Replace its `[allButLast, last]` split with:

  ```ts
  const targetIndex = tags.indexOf("0005_tearful_punisher");
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  const beforeTarget = tags.slice(0, targetIndex);
  const target = tags[targetIndex];
  for (const tag of beforeTarget) await applyMigration(client, tag);
  // existing pre-0005 seed setup stays here
  await applyMigration(client, target);
  ```

  Add a second migration replay test which applies every journal entry, seeds a
  note immediately before `0006_note_revision`, applies that migration, and
  asserts:

  ```ts
  expect(row.revision).toBe(0);
  expect(row.source_text).toBe("die Banane");
  expect(row.metadata).toBe("{}");
  ```

- [ ] **Step 6: Stabilize `notes.get` ordering**

  Change only the note-detail card ordering:

  ```ts
  .orderBy(asc(cards.createdAt), asc(cards.id));
  ```

  Keep review queries ordered by `due`. Because the returned note row is spread
  unchanged, it now includes `revision`; `audioCardView` already preserves
  `cardType` while removing only `audioPath`.

- [ ] **Step 7: Run migration, schema, router, and type checks**

  ```bash
  bun run --cwd apps/server vitest run db/schema.test.ts db/migrations.test.ts router/notes.test.ts
  bun run server:check
  ```

  Expected: PASS.

- [ ] **Step 8: Commit the revision boundary**

  ```bash
  git add apps/server/db/schema.ts apps/server/db/schema.test.ts apps/server/db/migrations.test.ts apps/server/router/notes.ts apps/server/router/notes.test.ts apps/server/drizzle/0006_note_revision.sql apps/server/drizzle/meta/0006_snapshot.json apps/server/drizzle/meta/_journal.json
  git commit -m "feat(server): version saved notes"
  ```

### Task 3: Implement atomic card creation, update, reset, and deletion

**Files:**
- Create: `apps/server/router/note-card-operations.ts`
- Create: `apps/server/router/note-card-operations.test.ts`
- Modify: `apps/server/router/notes.ts`
- Modify: `apps/server/router/notes.test.ts`
- Modify: `apps/server/tts/jobs.ts`
- Modify: `apps/server/tts/jobs.test.ts`

**Interfaces:**
- Consumes: `notes.revision`, existing card validation rules, `withWriteLock`, `reviewLogs`, `ttsTextForCard`, `generateNoteAudio`, and `context.removeAudio`.
- Produces: `noteUpdateInput`, `initialScheduling(now)`, `validateOperationSets(input)`, `notes.update`, explicit card-local error data, one atomic mixed-operation transaction, and stale-audio-job invalidation.

- [ ] **Step 1: Write failing pure operation tests**

  Create `apps/server/router/note-card-operations.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";
  import {
    initialScheduling,
    noteUpdateInput,
    validateOperationSets,
  } from "./note-card-operations.ts";

  const basic = {
    aspect: "arbitrary domain focus",
    front: "Question",
    back: "Answer",
    imageCue: false,
  };

  describe("saved-note card operations", () => {
    it("uses the persisted new-card scheduling defaults", () => {
      const now = new Date("2026-08-27T10:00:00Z");
      expect(initialScheduling(now)).toEqual({
        due: now,
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
    });

    it("accepts open aspects and an empty final card set", () => {
      expect(noteUpdateInput.safeParse({
        noteId: "018f4f5c-1111-7111-8111-111111111111",
        expectedRevision: 2,
        creates: [],
        updates: [],
        deleteCardIds: ["018f4f5c-2222-7222-8222-222222222222"],
        resetCardIds: [],
      }).success).toBe(true);
    });

    it("rejects duplicate and intersecting operation identities", () => {
      const input = {
        noteId: "018f4f5c-1111-7111-8111-111111111111",
        expectedRevision: 2,
        creates: [{ clientKey: "new-1", card: basic }],
        updates: [{
          cardId: "018f4f5c-2222-7222-8222-222222222222",
          card: basic,
        }],
        deleteCardIds: ["018f4f5c-2222-7222-8222-222222222222"],
        resetCardIds: [],
      };
      expect(() => validateOperationSets(input)).toThrow(
        "A card cannot be updated and deleted in the same save",
      );
    });
  });
  ```

- [ ] **Step 2: Run the operation tests and verify they fail**

  ```bash
  bun run --cwd apps/server vitest run router/note-card-operations.test.ts
  ```

  Expected: FAIL because the operations module does not exist.

- [ ] **Step 3: Implement operation schemas and reset values**

  Create `apps/server/router/note-card-operations.ts`. Export a transport-only
  card schema, then run the existing semantic rules in `validateEditableCard`
  so failures can carry a card identity:

  ```ts
  import * as z from "zod";
  import { ORPCError } from "@orpc/server";
  import {
    BASIC_CARD_NEEDS_BACK,
    cardHasAnAnswer,
    clozeMarkupIsWellFormed,
    IMAGE_CUE_NEEDS_HINT,
    imageCueHasFallback,
    MALFORMED_CLOZE,
  } from "../ai/card-rules.ts";

  export const editableCardInput = z.object({
    aspect: z.string().transform((value) => value.trim()),
    front: z.string().transform((value) => value.trim()),
    back: z.string().transform((value) => value.trim()).nullable(),
    imageCue: z.boolean(),
  });

  const createOperation = z.object({
    clientKey: z.string().min(1).max(100),
    card: editableCardInput,
  });
  const updateOperation = z.object({
    cardId: z.uuidv7(),
    card: editableCardInput,
  });

  export const noteUpdateInput = z.object({
    noteId: z.uuidv7(),
    expectedRevision: z.number().int().nonnegative(),
    creates: z.array(createOperation),
    updates: z.array(updateOperation),
    deleteCardIds: z.array(z.uuidv7()),
    resetCardIds: z.array(z.uuidv7()),
  });

  export function initialScheduling(now: Date) {
    return {
      due: now,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      lastReview: null,
    };
  }
  ```

  Implement `validateOperationSets` with `Set` size checks for client keys and
  every card-ID array. Allow an ID in `updates` and `resetCardIds`, but reject
  every intersection with `deleteCardIds`. Implement:

  ```ts
  export function validateEditableCard(
    card: z.infer<typeof editableCardInput>,
    identity: { clientKey?: string; cardId?: string },
  ): void {
    const fail = (
      field: "aspect" | "front" | "back",
      message: string,
    ): never => {
      throw new ORPCError("BAD_REQUEST", {
        message,
        data: { ...identity, field },
      });
    };
    if (!card.aspect) fail("aspect", "Describe what this card practises.");
    if (!card.front) fail("front", "Enter the card prompt.");
    if (!clozeMarkupIsWellFormed(card)) fail("front", MALFORMED_CLOZE);
    if (!imageCueHasFallback(card)) fail("front", IMAGE_CUE_NEEDS_HINT);
    if (!cardHasAnAnswer(card)) fail("back", BASIC_CARD_NEEDS_BACK);
  }
  ```

- [ ] **Step 4: Re-run the pure operation tests**

  ```bash
  bun run --cwd apps/server vitest run router/note-card-operations.test.ts
  ```

  Expected: PASS.

- [ ] **Step 5: Write failing router tests for the complete transaction**

  Add a `describe("notes.update")` block to `apps/server/router/notes.test.ts`.
  Seed a note through `notes.save`, then add tests with these exact outcomes:

  ```ts
  it("atomically creates, updates, resets, and deletes cards", async () => {
    const ada = await server.signIn("update-note@example.com");
    const draft = await seedDraft(ada.context, ada.userId, { imagePrompt: null });
    const note = await call(notesRouter.save, { draftId: draft.id, cards: CARDS }, {
      context: ada.context,
    });
    const before = await server.db.select().from(cards).where(eq(cards.noteId, note.id));
    await server.db.insert(reviewLogs).values({
      cardId: before[0].id,
      userId: ada.userId,
      rating: 3,
      state: 2,
      due: new Date(10),
      stability: 4,
      difficulty: 5,
      elapsedDays: 6,
      lastElapsedDays: 6,
      scheduledDays: 7,
      learningSteps: 1,
      review: new Date(9),
    });

    const result = await call(notesRouter.update, {
      noteId: note.id,
      expectedRevision: 0,
      creates: [{ clientKey: "new-1", card: {
        aspect: "chemistry",
        front: "What is oxidation?",
        back: "Loss of electrons.",
        imageCue: false,
      } }],
      updates: [{ cardId: before[0].id, card: {
        aspect: "past tense",
        front: "Corrected question",
        back: "Corrected answer",
        imageCue: false,
      } }],
      deleteCardIds: [before[1].id],
      resetCardIds: [before[0].id],
    }, { context: ada.context });

    expect(result.note.revision).toBe(1);
    expect(result.createdIds).toEqual([
      { clientKey: "new-1", cardId: expect.any(String) },
    ]);
    expect(result.cards.map((card) => card.aspect)).toEqual([
      "past tense",
      "chemistry",
    ]);
    const reset = result.cards[0];
    expect(reset).toMatchObject({ reps: 0, lapses: 0, state: 0, lastReview: null });
    expect(await server.db.select().from(reviewLogs).where(eq(reviewLogs.cardId, reset.id)))
      .toHaveLength(0);
  });
  ```

  Add separate tests which assert:

  - An update without reset preserves distinctive FSRS values and review logs.
  - Deleting the only card returns an empty `cards` array and leaves the note.
  - A stale `expectedRevision` rejects with `code: "CONFLICT"` and changes no row.
  - Another user's note and card IDs reject as `NOT_FOUND` without revealing existence.
  - A card invalid under cloze/image rules returns `BAD_REQUEST` with its `cardId`
    or `clientKey` in error data.
  - A delete fault injected with `failingDeleteFrom(context.db, cards)` after
    the create, update, and reset branches rolls back the preceding insert,
    content update, reset-log deletion, and revision increment.

- [ ] **Step 6: Run the router tests and verify they fail**

  ```bash
  bun run --cwd apps/server vitest run router/notes.test.ts
  ```

  Expected: FAIL because `notesRouter.update` does not exist.

- [ ] **Step 7: Implement `notes.update` as one locked transaction**

  In `apps/server/router/notes.ts`, import the operation helpers, `reviewLogs`,
  `removeAudio`, and `initialScheduling`. Define a reusable private
  `loadNoteDetails(db, userId, noteId)` which performs the existing owned note
  lookup, stable card lookup, and public audio projection. Make `get` call it.

  Import `inArray` from Drizzle, `removeAudio` from `../audio.ts`,
  `reviewLogs` from the schema, and `invalidateCardAudioJob` from the TTS jobs
  module. Implement the handler in this order:

  ```ts
  const update = authed
    .input(noteUpdateInput)
    .handler(async ({ input, context }) => {
      validateOperationSets(input);
      for (const operation of input.creates) {
        validateEditableCard(operation.card, { clientKey: operation.clientKey });
      }
      for (const operation of input.updates) {
        validateEditableCard(operation.card, { cardId: operation.cardId });
      }

      const now = new Date();
      const changed = await withWriteLock(() =>
        context.db.transaction(async (tx) => {
          const [note] = await tx.select().from(notes).where(and(
            eq(notes.id, input.noteId),
            eq(notes.userId, context.userId),
          )).limit(1);
          if (!note) throw notFound("Note not found");
          if (note.revision !== input.expectedRevision) {
            throw new ORPCError("CONFLICT", {
              message: "This note changed somewhere else. Reload it before saving.",
            });
          }

          const existing = await tx.select().from(cards).where(and(
            eq(cards.noteId, note.id),
            eq(cards.userId, context.userId),
          ));
          const byId = new Map(existing.map((card) => [card.id, card]));
          const referenced = [
            ...input.updates.map(({ cardId }) => cardId),
            ...input.deleteCardIds,
            ...input.resetCardIds,
          ];
          if (referenced.some((cardId) => !byId.has(cardId))) {
            throw notFound("Card not found");
          }

          const updateById = new Map(input.updates.map((operation) => [operation.cardId, operation.card]));
          const deleteIds = new Set(input.deleteCardIds);
          const resultingCards = [
            ...existing.filter((card) => !deleteIds.has(card.id)).map((card) =>
              updateById.get(card.id) ?? card
            ),
            ...input.creates.map(({ card }) => card),
          ];
          if (!imageCuesMatchContext(
            resultingCards,
            note.domain,
            note.metadata.imagePrompt ?? null,
          )) {
            throw new ORPCError("BAD_REQUEST", {
              message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
            });
          }

          const createdIds: Array<{ clientKey: string; cardId: string }> = [];
          const audioPathsToRemove: string[] = [];
          const audioCardIdsToGenerate: string[] = [];
          const audioJobsToInvalidate = new Set<string>();

          for (const { cardId, card } of input.updates) {
            const previous = byId.get(cardId)!;
            const previousText = ttsTextForCard(note, previous);
            const nextText = ttsTextForCard(note, card);
            const textChanged = previousText !== nextText;
            if (textChanged) {
              audioJobsToInvalidate.add(cardId);
              if (previous.audioPath) audioPathsToRemove.push(previous.audioPath);
              if (nextText !== null) audioCardIdsToGenerate.push(cardId);
            }
            await tx.update(cards).set({
              ...card,
              cardType: parseCloze(card.front) ? "cloze" : "basic",
              ...(textChanged
                ? {
                    audioPath: null,
                    audioStatus: nextText === null ? null : "pending",
                  }
                : {}),
            }).where(and(
              eq(cards.id, cardId),
              eq(cards.noteId, note.id),
              eq(cards.userId, context.userId),
            ));
          }

          for (const [index, { clientKey, card }] of input.creates.entries()) {
            const cardId = uuidv7();
            const text = ttsTextForCard(note, card);
            await tx.insert(cards).values({
              id: cardId,
              noteId: note.id,
              userId: context.userId,
              ...card,
              cardType: parseCloze(card.front) ? "cloze" : "basic",
              audioStatus: text === null ? null : "pending",
              createdAt: new Date(now.getTime() + index),
              ...initialScheduling(now),
            });
            createdIds.push({ clientKey, cardId });
            if (text !== null) audioCardIdsToGenerate.push(cardId);
          }

          if (input.resetCardIds.length > 0) {
            await tx.delete(reviewLogs).where(and(
              inArray(reviewLogs.cardId, input.resetCardIds),
              eq(reviewLogs.userId, context.userId),
            ));
            await tx.update(cards).set(initialScheduling(now)).where(and(
              inArray(cards.id, input.resetCardIds),
              eq(cards.noteId, note.id),
              eq(cards.userId, context.userId),
            ));
          }

          if (input.deleteCardIds.length > 0) {
            for (const cardId of input.deleteCardIds) {
              const previous = byId.get(cardId)!;
              audioJobsToInvalidate.add(cardId);
              if (previous.audioPath) audioPathsToRemove.push(previous.audioPath);
            }
            await tx.delete(cards).where(and(
              inArray(cards.id, input.deleteCardIds),
              eq(cards.noteId, note.id),
              eq(cards.userId, context.userId),
            ));
          }

          await tx.update(notes).set({ revision: note.revision + 1 }).where(and(
            eq(notes.id, note.id),
            eq(notes.userId, context.userId),
          ));
          for (const cardId of audioJobsToInvalidate) {
            invalidateCardAudioJob(cardId);
          }
          return {
            createdIds,
            audioPathsToRemove,
            audioCardIdsToGenerate,
          };
        })
      );

      await settleAudioChanges(context, changed);
      const details = await loadNoteDetails(context.db, context.userId, input.noteId);
      return { ...details, createdIds: changed.createdIds };
    });
  ```

  `settleAudioChanges` removes collected paths with
  `context.removeAudio ?? removeAudio` using `Promise.allSettled`, logs each
  failure as `note card audio cleanup failed`, then starts (without awaiting)
  `generateNoteAudio(context.db, context.userId, audioCardIdsToGenerate)` and
  logs an unexpected outer rejection as `note audio generation failed`.
  Audio cleanup or generation failure must not reject the already committed
  note update.

- [ ] **Step 8: Make an in-flight audio job incapable of attaching stale speech**

  Add a generation counter beside the existing `jobs` map in
  `apps/server/tts/jobs.ts`:

  ```ts
  const generations = new Map<string, number>();

  export function invalidateCardAudioJob(cardId: string): void {
    generations.set(cardId, (generations.get(cardId) ?? 0) + 1);
    jobs.delete(cardId);
  }
  ```

  At the start of `generateCardAudio`, capture
  `const generation = generations.get(cardId) ?? 0` and define
  `const current = () => (generations.get(cardId) ?? 0) === generation`.
  Check `current()` immediately after synthesis and immediately after writing.
  If it is false after writing, remove the just-written path and return. In the
  catch block, return without setting `audioStatus: "failed"` when
  `current()` is false. Keep the existing `jobs.get(cardId) === job` guard in
  `finally`, so an invalidated old promise cannot delete the newer job entry.

  Add a deterministic deferred-synthesis test to `tts/jobs.test.ts`: mock two
  synthesis calls with separate deferred promises, start the old-front job,
  invalidate it, update the card to new text with `audioStatus: "pending"`, and
  start the replacement job. Resolve the old synthesis first and assert the
  writer has not been called. Resolve the replacement and assert the writer was
  called exactly once with the new bytes, the final row points to the new path,
  and the old job never changes the replacement status to `failed`.

- [ ] **Step 9: Export the procedure and run focused tests**

  Export `update` from `notesRouter`:

  ```ts
  export const notesRouter = { get, listByDeck, save, update };
  ```

  Then run:

  ```bash
  bun run --cwd apps/server vitest run router/note-card-operations.test.ts router/notes.test.ts router/concurrency.test.ts tts/jobs.test.ts
  bun run server:check
  ```

  Expected: PASS. Existing save/grade concurrency and late-audio cleanup tests
  remain green.

- [ ] **Step 10: Commit the atomic update boundary**

  ```bash
  git add apps/server/router/note-card-operations.ts apps/server/router/note-card-operations.test.ts apps/server/router/notes.ts apps/server/router/notes.test.ts apps/server/tts/jobs.ts apps/server/tts/jobs.test.ts
  git commit -m "feat(server): update saved note cards atomically"
  ```

### Task 4: Delete whole notes with revision and media safety

**Files:**
- Modify: `apps/server/router/notes.ts`
- Modify: `apps/server/router/notes.test.ts`

**Interfaces:**
- Consumes: `notes.revision`, `withWriteLock`, note/card cascade keys, `context.removeImage`, `context.removeAudio`, and the late-job cleanup behavior.
- Produces: `notes.delete({ noteId, expectedRevision }) -> { id, deckId }`.

- [ ] **Step 1: Write failing delete tests**

  Add `describe("notes.delete")` with tests for success, wrong ownership,
  conflict, and cleanup. The success case must seed real stored paths but inject
  removers:

  ```ts
  const removeImage = vi.fn(async () => undefined);
  const removeAudio = vi.fn(async () => undefined);
  const result = await call(notesRouter.delete, {
    noteId: note.id,
    expectedRevision: 0,
  }, { context: { ...ada.context, removeImage, removeAudio } });

  expect(result).toEqual({ id: note.id, deckId: draft.deckId });
  expect(await server.db.select().from(notes).where(eq(notes.id, note.id)))
    .toHaveLength(0);
  expect(await server.db.select().from(cards).where(eq(cards.noteId, note.id)))
    .toHaveLength(0);
  expect(removeImage).toHaveBeenCalledWith(`${ada.userId}/${note.id}.png`);
  expect(removeAudio).toHaveBeenCalledWith(expect.stringMatching(/\.mp3$/));
  ```

  The conflict test must update `notes.revision` to `1`, call with `0`, expect
  `CONFLICT`, and assert the note, cards, and media-remover calls remain intact.
  The ownership test must return `NOT_FOUND` for another user's note.

- [ ] **Step 2: Run the focused tests and verify failure**

  ```bash
  bun run --cwd apps/server vitest run router/notes.test.ts
  ```

  Expected: FAIL because `notesRouter.delete` does not exist.

- [ ] **Step 3: Implement revision-guarded note deletion**

  Add:

  ```ts
  const deleteNote = authed
    .input(z.object({
      noteId: z.uuidv7(),
      expectedRevision: z.number().int().nonnegative(),
    }))
    .handler(async ({ input, context }) => {
      const removed = await withWriteLock(() =>
        context.db.transaction(async (tx) => {
          const [note] = await tx.select().from(notes).where(and(
            eq(notes.id, input.noteId),
            eq(notes.userId, context.userId),
          )).limit(1);
          if (!note) throw notFound("Note not found");
          if (note.revision !== input.expectedRevision) {
            throw new ORPCError("CONFLICT", {
              message: "This note changed somewhere else. Reload it before deleting.",
            });
          }
          const noteCards = await tx.select({ audioPath: cards.audioPath })
            .from(cards)
            .where(and(eq(cards.noteId, note.id), eq(cards.userId, context.userId)));
          await tx.delete(notes).where(and(
            eq(notes.id, note.id),
            eq(notes.userId, context.userId),
          ));
          return {
            id: note.id,
            deckId: note.deckId,
            imagePath: note.imagePath,
            audioPaths: noteCards.flatMap(({ audioPath }) => audioPath ? [audioPath] : []),
          };
        })
      );

      const cleanup = [
        ...(removed.imagePath
          ? [(context.removeImage ?? removeImage)(removed.imagePath)]
          : []),
        ...removed.audioPaths.map((path) =>
          (context.removeAudio ?? removeAudio)(path)
        ),
      ];
      for (const result of await Promise.allSettled(cleanup)) {
        if (result.status === "rejected") {
          console.error("note media cleanup failed", result.reason);
        }
      }
      return { id: removed.id, deckId: removed.deckId };
    });
  ```

  Export it under the approved RPC name:

  ```ts
  export const notesRouter = { get, listByDeck, save, update, delete: deleteNote };
  ```

- [ ] **Step 4: Verify cascade, cleanup failure, and late-job regressions**

  Add one test whose injected removers reject and assert the mutation still
  succeeds after database deletion. Then run:

  ```bash
  bun run --cwd apps/server vitest run router/notes.test.ts router/decks.test.ts ai/jobs.test.ts tts/jobs.test.ts
  bun run server:check
  ```

  Expected: PASS. Existing late image/audio jobs continue removing output when
  their owner disappeared.

- [ ] **Step 5: Commit whole-note deletion**

  ```bash
  git add apps/server/router/notes.ts apps/server/router/notes.test.ts
  git commit -m "feat(server): delete notes with media cleanup"
  ```

### Task 5: Add mobile update/delete hooks and typed mutation errors

**Files:**
- Modify: `apps/mobile/src/api/notes.ts`
- Modify: `apps/mobile/__tests__/query-invalidation.test.tsx`
- Create: `apps/mobile/__tests__/note-api.test.ts`

**Interfaces:**
- Consumes: `NoteDetails`, `NoteUpdateInput`, `orpc.notes.update`, `orpc.notes.delete`, and React Query invalidation.
- Produces: `NoteUpdateResult`, `NoteMutationIssue`, `noteMutationIssue(error)`, `useUpdateNote()`, and `useDeleteNote()`.

- [ ] **Step 1: Write failing API error-shape tests**

  Create `apps/mobile/__tests__/note-api.test.ts`:

  ```ts
  import { noteMutationIssue } from "../src/api/notes";

  describe("saved note mutation errors", () => {
    it("recognizes a revision conflict without depending on an error class", () => {
      expect(noteMutationIssue({
        code: "CONFLICT",
        message: "This note changed somewhere else.",
      })).toEqual({
        kind: "conflict",
        message: "This note changed somewhere else.",
      });
    });

    it("preserves a card-local server validation identity", () => {
      expect(noteMutationIssue({
        code: "BAD_REQUEST",
        message: "Malformed cloze deletion.",
        data: { cardId: "card-1", field: "front" },
      })).toEqual({
        kind: "card",
        cardKey: "card-1",
        field: "front",
        message: "Malformed cloze deletion.",
      });
    });

    it("normalizes an ordinary network error", () => {
      expect(noteMutationIssue(new Error("Network request failed"))).toEqual({
        kind: "general",
        message: "Network request failed",
      });
    });
  });
  ```

- [ ] **Step 2: Extend the query-invalidation mock and add failing hook tests**

  Add `update` and `delete` mutation options to the existing mocked notes API:

  ```ts
  notes: {
    key: () => ["notes"],
    save: { mutationOptions: (options: unknown) => options },
    update: { mutationOptions: (options: unknown) => options },
    delete: { mutationOptions: (options: unknown) => options },
  },
  ```

  Import `useUpdateNote` and `useDeleteNote`, then assert each hook invalidates
  `notes`, `cards`, and `decks`; delete does not invalidate drafts because it
  cannot consume or mutate a draft.

- [ ] **Step 3: Run focused tests and verify failure**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/note-api.test.ts __tests__/query-invalidation.test.tsx
  ```

  Expected: FAIL because the normalizer and hooks do not exist.

- [ ] **Step 4: Implement typed hooks and error normalization**

  Add these types and pure normalizer to `apps/mobile/src/api/notes.ts`:

  ```ts
  export type NoteUpdateResult = NoteDetails & {
    createdIds: Array<{ clientKey: string; cardId: string }>;
  };

  export type NoteMutationIssue =
    | { kind: "conflict"; message: string }
    | {
        kind: "card";
        cardKey: string;
        field: "aspect" | "front" | "back";
        message: string;
      }
    | { kind: "general"; message: string };

  export function noteMutationIssue(error: unknown): NoteMutationIssue {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      data?: { cardId?: unknown; clientKey?: unknown; field?: unknown };
    };
    const message = typeof candidate?.message === "string"
      ? candidate.message
      : "Couldn't save this note.";
    if (candidate?.code === "CONFLICT") return { kind: "conflict", message };
    const cardKey = typeof candidate?.data?.cardId === "string"
      ? candidate.data.cardId
      : typeof candidate?.data?.clientKey === "string"
      ? candidate.data.clientKey
      : null;
    const field = candidate?.data?.field;
    if (
      cardKey &&
      (field === "aspect" || field === "front" || field === "back")
    ) {
      return { kind: "card", cardKey, field, message };
    }
    return { kind: "general", message };
  }
  ```

  Implement hooks with existing React Query patterns:

  ```ts
  export function useUpdateNote() {
    const queryClient = useQueryClient();
    return useMutation<NoteUpdateResult, Error, NoteUpdateInput>(
      orpc.notes.update.mutationOptions({
        onSuccess: () => Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
        ]),
      }) as never,
    );
  }

  export function useDeleteNote() {
    const queryClient = useQueryClient();
    return useMutation<
      { id: string; deckId: string },
      Error,
      { noteId: string; expectedRevision: number }
    >(orpc.notes.delete.mutationOptions({
      onSuccess: () => Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
      ]),
    }) as never);
  }
  ```

  Remove `draftId`/`useSaveNote` behavior only from the saved-note screen in a
  later task; keep `useSaveNote` for Add.

- [ ] **Step 5: Re-run API tests and type checking**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/note-api.test.ts __tests__/query-invalidation.test.tsx
  bun run mobile:check
  ```

  Expected: PASS.

- [ ] **Step 6: Commit the mobile mutation boundary**

  ```bash
  git add apps/mobile/src/api/notes.ts apps/mobile/__tests__/query-invalidation.test.tsx apps/mobile/__tests__/note-api.test.ts
  git commit -m "feat(mobile): add saved note mutation hooks"
  ```

### Task 6: Build the reusable card presentation

**Files:**
- Create: `apps/mobile/src/components/card-presentation.tsx`
- Create: `apps/mobile/__tests__/card-presentation.test.tsx`
- Modify: `apps/mobile/src/components/card-face.tsx`

**Interfaces:**
- Consumes: `NoteCard`, existing `CardFront`, `CardBack`, semantic UI card primitives, and an optional image/footer slot.
- Produces: `formatAspectLabel(aspect)`, `CardPresentationModel`, and `CardPresentation({ card, mode, revealed?, image?, footer? })`.

- [ ] **Step 1: Write failing presentation tests**

  Create `apps/mobile/__tests__/card-presentation.test.tsx`:

  ```tsx
  import { render } from "@testing-library/react-native";
  import {
    CardPresentation,
    formatAspectLabel,
  } from "../src/components/card-presentation";
  import { View } from "react-native";

  function MockImage({ accessibilityLabel }: { accessibilityLabel: string }) {
    return <View accessibilityLabel={accessibilityLabel} />;
  }

  const cloze = {
    id: "card-1",
    cardType: "cloze" as const,
    aspect: "past_tense",
    front: "Ich wohne im {{c1::Haus::dom}}.",
    back: "Mieszkam w domu.",
    imageCue: true,
  };

  describe("CardPresentation", () => {
    it("formats an open aspect mechanically rather than through an enum", () => {
      expect(formatAspectLabel("  arbitrary_domain-focus  ")).toBe(
        "Arbitrary domain focus",
      );
    });

    it("shows prompt hint and full answer in inspection mode", async () => {
      const view = await render(
        <CardPresentation card={cloze} mode="inspection" />,
      );
      expect(view.getByText("Past tense")).toBeTruthy();
      expect(view.getByText("Fill in the blank")).toBeTruthy();
      expect(view.getByText("[dom]", { exact: false })).toBeTruthy();
      expect(view.getByText("Haus")).toBeTruthy();
      expect(view.getByText("Mieszkam w domu.", { exact: false })).toBeTruthy();
      expect(view.getByText("Uses the note image as a cue")).toBeTruthy();
    });

    it("keeps the hint visible beside an image slot", async () => {
      const view = await render(
        <CardPresentation
          card={cloze}
          image={<MockImage accessibilityLabel="House image cue" />}
          mode="review"
          revealed={false}
        />,
      );
      expect(view.getByLabelText("House image cue")).toBeTruthy();
      expect(view.getByText("[dom]", { exact: false })).toBeTruthy();
      expect(view.queryByText("Haus")).toBeNull();
    });
  });
  ```

  Add a basic-card test proving inspection mode labels question and answer
  without any cloze markup.

- [ ] **Step 2: Run the presentation tests and verify failure**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/card-presentation.test.tsx
  ```

  Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement learner-facing labels and card modes**

  Create `card-presentation.tsx` with this public contract:

  ```tsx
  export type CardPresentationModel = Pick<
    NoteCard,
    "id" | "cardType" | "aspect" | "front" | "back" | "imageCue"
  >;

  type CardPresentationProps = {
    card: CardPresentationModel;
    mode: "inspection" | "review";
    revealed?: boolean;
    image?: ReactNode;
    footer?: ReactNode;
  };

  export function formatAspectLabel(aspect: string): string {
    const readable = aspect.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    return readable ? `${readable[0].toUpperCase()}${readable.slice(1)}` : "Card";
  }
  ```

  Render one semantic `Card` with:

  - Aspect and `Question and answer`/`Fill in the blank` metadata.
  - The optional `image` before text.
  - In inspection mode, separate quiet `Prompt` and `Answer` labels. For a
    cloze, use `CardFront` for the hinted prompt and `CardBack` for the revealed
    sentence plus optional back. For a basic card, render `front` once below
    `Prompt` and `back` once below `Answer`; do not use the basic `CardBack`
    branch, which would repeat the question.
  - In review mode, use `CardFront` while unrevealed and `CardBack` while
    revealed. Never suppress the hint based on image status.
  - `Uses the note image as a cue` only in inspection mode when `imageCue` is
    true; do not repeat the large image there.
  - The optional footer after answer content.

  Keep `CardFront` and `CardBack` small and presentation-only. Give their root
  text explicit `text-body leading-[24px]` classes and preserve the existing
  muted hint and emphasized revealed answer.

- [ ] **Step 4: Re-run component tests and related review regressions**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/card-presentation.test.tsx __tests__/review-screen.test.tsx
  bun run mobile:check
  ```

  Expected: PASS. `ReviewScreen` still uses its current component and behavior.

- [ ] **Step 5: Commit the shared presentation**

  ```bash
  git add apps/mobile/src/components/card-presentation.tsx apps/mobile/src/components/card-face.tsx apps/mobile/__tests__/card-presentation.test.tsx
  git commit -m "feat(mobile): add learner-facing card presentation"
  ```

### Task 7: Add sticky screen actions and a dirty-navigation guard

**Files:**
- Modify: `apps/mobile/src/components/screen.tsx`
- Modify: `apps/mobile/__tests__/screen-scroll.test.tsx`
- Create: `apps/mobile/src/hooks/use-unsaved-changes.ts`
- Create: `apps/mobile/__tests__/use-unsaved-changes.test.tsx`

**Interfaces:**
- Consumes: `Screen` safe-area/keyboard behavior and Expo Router's `useNavigation`.
- Produces: `Screen.footer?: ReactNode` and `useUnsavedChanges({ dirty })` returning `confirming`, `requestLeave`, `keepEditing`, and `discardAndLeave`.

- [ ] **Step 1: Write failing sticky-footer coverage**

  Extend `screen-scroll.test.tsx`:

  ```tsx
  it("keeps a sticky footer outside the scroll content and inside keyboard safety", async () => {
    const view = await render(
      <Screen footer={<Text accessibilityLabel="sticky-save">Save changes</Text>}>
        <Text>Editor</Text>
      </Screen>,
    );
    expect(view.getByTestId("screen-scroll-content").findAllByProps({
      accessibilityLabel: "sticky-save",
    })).toHaveLength(0);
    expect(view.getByTestId("screen-footer").props.className).toContain("border-t");
    expect(view.getByLabelText("sticky-save")).toBeTruthy();
  });
  ```

- [ ] **Step 2: Write failing navigation-guard tests**

  Mock `expo-router.useNavigation` with an object that captures the
  `beforeRemove` listener and dispatched actions. Render a hook harness and pin:

  ```ts
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(result.current.confirming).toBe(true);
  act(() => result.current.keepEditing());
  expect(navigation.dispatch).not.toHaveBeenCalled();

  act(() => listener(event));
  act(() => result.current.discardAndLeave());
  expect(navigation.dispatch).toHaveBeenCalledWith(event.data.action);
  ```

  Also prove `dirty: false` never prevents navigation and
  `requestLeave(callback)` uses the same confirmation for explicit Cancel or
  back-link actions.

- [ ] **Step 3: Run focused tests and verify failure**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/screen-scroll.test.tsx __tests__/use-unsaved-changes.test.tsx
  ```

  Expected: FAIL because `Screen.footer` and the hook do not exist.

- [ ] **Step 4: Add a footer slot without weakening existing screen behavior**

  Extend `ScreenProps` with `footer?: ReactNode`. Inside the existing
  `KeyboardAvoidingView`, keep the `ScrollView` unchanged and render after it:

  ```tsx
  {footer
    ? (
      <View
        className="border-t border-border bg-background py-sm"
        testID="screen-footer"
      >
        {footer}
      </View>
    )
    : null}
  ```

  Import `ReactNode` and `View`. Keep current safe-area edges,
  `keyboardShouldPersistTaps`, `grow gap-md pb-xl`, and iOS keyboard avoidance.

- [ ] **Step 5: Implement the reusable dirty-navigation hook**

  Create `use-unsaved-changes.ts`:

  ```ts
  import { useCallback, useEffect, useRef, useState } from "react";
  import { useNavigation } from "expo-router";

  export function useUnsavedChanges({ dirty }: { dirty: boolean }) {
    const navigation = useNavigation();
    const pending = useRef<null | (() => void)>(null);
    const allowNext = useRef(false);
    const [confirming, setConfirming] = useState(false);

    const requestLeave = useCallback((action: () => void) => {
      if (!dirty) return action();
      pending.current = action;
      setConfirming(true);
    }, [dirty]);

    const keepEditing = useCallback(() => {
      pending.current = null;
      setConfirming(false);
    }, []);

    const discardAndLeave = useCallback(() => {
      const action = pending.current;
      pending.current = null;
      setConfirming(false);
      if (!action) return;
      allowNext.current = true;
      action();
      queueMicrotask(() => {
        allowNext.current = false;
      });
    }, []);

    useEffect(() => navigation.addListener("beforeRemove", (event) => {
      if (!dirty || allowNext.current) return;
      event.preventDefault();
      requestLeave(() => navigation.dispatch(event.data.action));
    }), [dirty, navigation, requestLeave]);

    return { confirming, requestLeave, keepEditing, discardAndLeave };
  }
  ```

  Ensure the returned listener cleanup from `addListener` is returned by the
  effect. The pending navigation action lives only in a ref and cannot trigger
  a stale re-render.

- [ ] **Step 6: Re-run focused tests and type checking**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/screen-scroll.test.tsx __tests__/use-unsaved-changes.test.tsx
  bun run mobile:check
  ```

  Expected: PASS.

- [ ] **Step 7: Commit the guarded screen shell**

  ```bash
  git add apps/mobile/src/components/screen.tsx apps/mobile/__tests__/screen-scroll.test.tsx apps/mobile/src/hooks/use-unsaved-changes.ts apps/mobile/__tests__/use-unsaved-changes.test.tsx
  git commit -m "feat(mobile): support guarded sticky edit screens"
  ```

### Task 8: Build learner-facing card editing components

**Files:**
- Create: `apps/mobile/src/components/add-card-dialog.tsx`
- Create: `apps/mobile/src/components/card-edit-form.tsx`
- Create: `apps/mobile/__tests__/card-edit-form.test.tsx`
- Modify: `apps/mobile/src/components/text-field.tsx`

**Interfaces:**
- Consumes: `CardDraft`, `CardDraftErrors`, `TextRange`, `CardPresentation`, `SelectionDialog`, `ConfirmDialog`, `TextField`, and existing Switch/Button primitives.
- Produces: `AddCardDialog({ open, onOpenChange, onSelect })` and `CardEditForm({ card, errors, imageCueAllowed, autoFocus?, onChange, onDelete, onReset })`.

  Use this exact controlled form contract:

  ```tsx
  export type CardEditFormProps = {
    card: CardDraft;
    errors: CardDraftErrors;
    serverError?: string;
    imageCueAllowed: boolean;
    autoFocus?: boolean;
    onChange: (card: CardDraft) => void;
    onDelete: () => void;
    onReset: () => void;
  };
  ```

- [ ] **Step 1: Write failing card-editor interaction tests**

  Create `card-edit-form.test.tsx` with `AppProviders` around dialog cases. Pin:

  ```tsx
  it("edits an open aspect and a basic card without technical fields", async () => {
    const onChange = jest.fn();
    const card = {
      ...createCardDraft("basic", "new-1"),
      question: "What is inertia?",
      answer: "Resistance to motion change.",
    };
    const view = await render(
      <CardEditForm
        card={card}
        errors={{}}
        imageCueAllowed={false}
        onChange={onChange}
        onDelete={jest.fn()}
        onReset={jest.fn()}
      />,
    );
    expect(view.getByLabelText("Learning focus")).toBeTruthy();
    expect(view.getByLabelText("Question")).toBeTruthy();
    expect(view.getByLabelText("Answer")).toBeTruthy();
    expect(view.queryByText("Front")).toBeNull();
    expect(view.queryByText("Back")).toBeNull();
  });

  it("creates a cloze selection without showing storage markup", async () => {
    const card = {
      ...createCardDraft("cloze", "new-1"),
      sentence: "Ich wohne im Haus.",
      hint: "dom",
    };
    const onChange = jest.fn();
    const view = await render(
      <CardEditForm
        card={card}
        errors={{}}
        imageCueAllowed
        onChange={onChange}
        onDelete={jest.fn()}
        onReset={jest.fn()}
      />,
    );
    await fireEvent(view.getByLabelText("Sentence"), "selectionChange", {
      nativeEvent: { selection: { start: 13, end: 17 } },
    });
    await fireEvent.press(view.getByRole("button", { name: "Hide selection" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      answerRange: { start: 13, end: 17 },
    }));
    expect(view.queryByText("{{c1::", { exact: false })).toBeNull();
  });
  ```

  Add tests proving:

  - The hint remains visible in the preview while image cue is selected.
  - Image cue is hidden for a basic card and unavailable in invalid context.
  - Persisted cards expose reset; new cards do not.
  - Delete and reset call callbacks but do not mutate by themselves.
  - Card-local errors render with `accessibilityRole="alert"`.
  - `AddCardDialog` returns exactly `"basic"` or `"cloze"`.

- [ ] **Step 2: Run focused tests and verify failure**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/card-edit-form.test.tsx
  ```

  Expected: FAIL because the editor components do not exist.

- [ ] **Step 3: Let `TextField` expose normal TextInput selection events**

  No new prop is required: `TextFieldProps` already extends `TextInput` props.
  Add a regression assertion to `shared-components.test.tsx` that
  `onSelectionChange` reaches the underlying input, then keep `TextField`
  implementation unchanged unless the test reveals a prop is being swallowed.

- [ ] **Step 4: Implement the card-type selection dialog**

  Compose the existing `SelectionDialog`:

  ```tsx
  const options = [
    { value: "basic", label: "Question and answer" },
    { value: "cloze", label: "Fill in the blank" },
  ] as const;

  export function AddCardDialog({ open, onOpenChange, onSelect }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (kind: "basic" | "cloze") => void;
  }) {
    return (
      <SelectionDialog
        open={open}
        options={[...options]}
        title="Choose a card type"
        value=""
        onOpenChange={onOpenChange}
        onValueChange={(value) => onSelect(value as "basic" | "cloze")}
      />
    );
  }
  ```

- [ ] **Step 5: Implement `CardEditForm` as a controlled component**

  Render a semantic card with `Learning focus` first. For `basic`, render
  `Question` and `Answer`. For `cloze`, keep a local pending `TextRange` from
  `onSelectionChange`, and render:

  ```tsx
  <TextField
    autoFocus={autoFocus}
    error={errors.sentence}
    label="Sentence"
    multiline
    value={card.sentence}
    onChangeText={(sentence) => {
      setPendingSelection(null);
      onChange(updateEditableClozeSentence(card, sentence));
    }}
    onSelectionChange={({ nativeEvent }) =>
      setPendingSelection(nativeEvent.selection)}
  />
  <PrimaryButton
    disabled={!pendingSelection || pendingSelection.start === pendingSelection.end}
    variant="outline"
    onPress={() => pendingSelection && onChange({
      ...card,
      answerRange: pendingSelection,
    })}
  >
    Hide selection
  </PrimaryButton>
  <TextField
    error={errors.hint}
    label="Text cue"
    value={card.hint}
    onChangeText={(hint) => onChange({ ...card, hint })}
  />
  <TextField
    label="Translation or explanation (optional)"
    multiline
    value={card.back}
    onChangeText={(back) => onChange({ ...card, back })}
  />
  ```

  Show the selected answer as learner-facing text, for example
  `Hidden answer: Haus`, and offer `Clear hidden answer`. Show image cue only
  for `cloze` when `imageCueAllowed`; its label is `Use the note image as the
  main cue`. Render `CardPresentation` in inspection mode from the serialized
  valid draft. If invalid, render the plain sentence preview without markup.

  Apply `autoFocus` to `Question` for a new basic card and `Sentence` for a new
  cloze card, not to the prefilled learning-focus field. Clear the pending
  native selection whenever sentence text changes so `Hide selection` can
  never apply stale offsets.

  At the bottom, render `Reset progress` only when `persistedId !== null`, and
  `Delete card` for every card. When `resetProgress` is true, label the first
  action `Keep existing progress` and expose selected state without relying on
  color. Both actions call parent callbacks; confirmations remain owned by the
  edit view so only one dialog is mounted. Render `serverError`, when supplied,
  as a card-local `accessibilityRole="alert"` after the local field errors.

- [ ] **Step 6: Re-run editor, presentation, and shared-component tests**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/card-edit-form.test.tsx __tests__/card-presentation.test.tsx __tests__/shared-components.test.tsx
  bun run mobile:check
  ```

  Expected: PASS.

- [ ] **Step 7: Commit the controlled editor components**

  ```bash
  git add apps/mobile/src/components/add-card-dialog.tsx apps/mobile/src/components/card-edit-form.tsx apps/mobile/src/components/text-field.tsx apps/mobile/__tests__/card-edit-form.test.tsx apps/mobile/__tests__/shared-components.test.tsx
  git commit -m "feat(mobile): add learner-facing card editor"
  ```

### Task 9: Build the saved-note reading view

**Files:**
- Create: `apps/mobile/src/features/notes/note-read-view.tsx`
- Create: `apps/mobile/__tests__/note-read-view.test.tsx`

**Interfaces:**
- Consumes: `NoteDetails`, `PageHeader`, `GeneratedImage`, `CardPresentation`, `PronunciationControl`, `SelectionDialog`, `ConfirmDialog`, `EmptyState`, and semantic buttons.
- Produces: `NoteReadView`, with source, single-image, stable-card, empty-note, retry, and whole-note deletion presentation.

- [ ] **Step 1: Write failing read-view tests**

  Create `apps/mobile/__tests__/note-read-view.test.tsx`. Mock
  `GeneratedImage` and `PronunciationControl` as labelled React Native views,
  and define a complete `NoteDetails` fixture containing one basic and one
  hinted image-cued cloze. Pin these outcomes:

  ```tsx
  it("renders a note as learning content rather than a disabled form", async () => {
    const view = await render(
      <NoteReadView
        details={details}
        deleteError={null}
        deletePending={false}
        imageError={null}
        imagePending={false}
        onAddCard={jest.fn()}
        onDelete={jest.fn()}
        onEdit={jest.fn()}
        onRetryImage={jest.fn()}
      />,
    );

    expect(view.getByRole("header", { name: "Note" })).toBeTruthy();
    expect(view.getByText("Source")).toBeTruthy();
    expect(view.getByText(details.note.sourceText)).toBeTruthy();
    expect(view.getByText("2 cards")).toBeTruthy();
    expect(view.getByText("[dom]", { exact: false })).toBeTruthy();
    expect(view.getByText("Haus")).toBeTruthy();
    expect(view.getByText("Mieszkam w domu.", { exact: false })).toBeTruthy();
    expect(view.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
    expect(view.getAllByLabelText("note-image")).toHaveLength(1);
  });
  ```

  Add tests which prove:

  - `Edit` calls `onEdit` and the back link targets the owning deck.
  - The generated image occurs once, before the cards, while an image-cued card
    still contains `Uses the note image as a cue` and its visible hint.
  - A pronunciation control stays inside the card with the matching ID.
  - Zero cards show `This note has no cards yet` and `Add card`; that action
    calls `onAddCard`.
  - Image generation, retry, and retry-error states keep their current meaning.
  - `More actions` opens a secondary menu; choosing `Delete note` opens a
    destructive confirmation whose copy mentions cards, review history, and
    media; only confirmation calls `onDelete`.
  - A deletion failure appears as an alert and leaves all note content present.

- [ ] **Step 2: Run the read-view tests and verify failure**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/note-read-view.test.tsx
  ```

  Expected: FAIL because `NoteReadView` does not exist.

- [ ] **Step 3: Implement the explicit read-view contract**

  Export this controlled boundary:

  ```tsx
  export type NoteReadViewProps = {
    details: NoteDetails;
    imagePending: boolean;
    imageError: string | null;
    deletePending: boolean;
    deleteError: string | null;
    onEdit: () => void;
    onAddCard: () => void;
    onRetryImage: () => Promise<void>;
    onDelete: () => Promise<void>;
  };
  ```

  Keep only `actionsOpen` and `confirmDelete` as local state. Compose the screen
  in this exact reading order:

  1. `PageHeader` titled `Note`, linked back to `/decks/[deckId]`, with a quiet
     48 px `Edit` trailing action.
  2. `SectionHeader` titled `Source`, followed by `sourceText` as body content.
  3. One optional `Picture` section using the existing generating, ready,
     retryable, and error states. Pass `sourceText` as the generated image alt.
  4. `SectionHeader` titled `Cards`, with detail `1 card` or `${count} cards`.
  5. Stable `details.cards.map(...)` rendering one `CardPresentation` in
     inspection mode per card. Put `PronunciationControl` in that card's
     `footer` only when `audioEligible` is true. Do not pass the large image to
     the card component or repeat it.
  6. For zero cards, `EmptyState` plus a primary `Add card` button.
  7. A quiet `More actions` button opening a `SelectionDialog` with one
     `Delete note` option.

  Use this confirmation text exactly:

  ```tsx
  <ConfirmDialog
    destructive
    pending={deletePending}
    visible={confirmDelete}
    title="Delete this note?"
    message="This permanently deletes the note, all of its cards, review history, picture, and pronunciation audio. This can't be undone."
    confirmLabel="Delete note"
    onCancel={() => setConfirmDelete(false)}
    onConfirm={async () => {
      await onDelete();
      setConfirmDelete(false);
    }}
  />
  ```

  Render `deleteError` with `accessibilityRole="alert"` adjacent to the actions.
  Preserve the existing image retry copy and show `imageError` as an alert.

- [ ] **Step 4: Re-run read and presentation tests**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/note-read-view.test.tsx __tests__/card-presentation.test.tsx
  bun run mobile:check
  ```

  Expected: PASS.

- [ ] **Step 5: Commit the reading view**

  ```bash
  git add apps/mobile/src/features/notes/note-read-view.tsx apps/mobile/__tests__/note-read-view.test.tsx
  git commit -m "feat(mobile): redesign saved note reading"
  ```

### Task 10: Compose the guarded note-editing view

**Files:**
- Modify: `apps/mobile/src/components/confirm-dialog.tsx`
- Modify: `apps/mobile/__tests__/shared-components.test.tsx`
- Create: `apps/mobile/src/features/notes/note-edit-view.tsx`
- Create: `apps/mobile/__tests__/note-edit-view.test.tsx`

**Interfaces:**
- Consumes: `NoteEditDraft`, `CardDraftErrors`, `NoteMutationIssue`, `CardEditForm`, `AddCardDialog`, `ConfirmDialog`, `Screen.footer`, and `useUnsavedChanges`.
- Produces: `NoteEditView`, one mounted confirmation at a time, direct add-card entry, and explicit conflict recovery.

- [ ] **Step 1: Let confirmations name the safe alternative**

  Add `cancelLabel?: string` to `ConfirmDialogProps`, default it to `"Cancel"`,
  and render it in `AlertDialogCancel`:

  ```tsx
  <AlertDialogCancel disabled={waiting}>
    <ButtonText>{cancelLabel}</ButtonText>
  </AlertDialogCancel>
  ```

  Add a shared-component test that renders `cancelLabel="Keep editing"` and
  asserts that accessible button label. Existing callers must remain unchanged.

- [ ] **Step 2: Write failing edit-view tests**

  Create a two-card `NoteEditDraft` fixture and render `NoteEditView` inside
  `AppProviders`. Pin the primary flow:

  ```tsx
  it("keeps save reachable and edits learner-facing card fields", async () => {
    const onChangeCard = jest.fn();
    const view = await render(
      <NoteEditView
        draft={draft}
        errorsByKey={{}}
        imageCueAllowed
        saveIssue={null}
        saving={false}
        serverErrorsByKey={{}}
        startAdding={false}
        onAddCard={jest.fn()}
        onCancel={jest.fn()}
        onChangeCard={onChangeCard}
        onClearSaveIssue={jest.fn()}
        onDeleteCard={jest.fn()}
        onReloadLatest={jest.fn()}
        onResetCard={jest.fn()}
        onSave={jest.fn()}
      />,
    );

    expect(view.getByRole("header", { name: "Edit note" })).toBeTruthy();
    expect(view.getByTestId("screen-footer")).toBeTruthy();
    expect(view.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(view.queryByText("{{c1::", { exact: false })).toBeNull();
    await fireEvent.changeText(view.getByLabelText("Learning focus"), "case");
    expect(onChangeCard).toHaveBeenCalled();
  });
  ```

  Add tests which prove:

  - `startAdding` opens card-type selection; selecting either type calls
    `onAddCard`, appends/focuses through the returned key, and closes the dialog.
  - Delete confirmation distinguishes a persisted card from a new unsaved card;
    only confirmation calls `onDeleteCard`.
  - Reset appears only for a persisted card, has separate consequence copy, and
    only confirmation sets it. Pressing `Keep existing progress` clears an
    already-pending reset immediately.
  - Local field errors and `serverErrorsByKey[card.key]` are card-local alerts.
  - A general mutation issue remains visible with the enabled Save action for
    retry.
  - A conflict issue offers `Keep editing` and `Load latest`; the former keeps
    the draft rendered, and the latter calls `onReloadLatest`.
  - Cancel on a dirty draft and a captured Android/back navigation event both
    open `Discard changes?`; `Keep editing` stays and `Discard changes` invokes
    the pending local or navigation action.
  - A clean Cancel calls `onCancel` immediately.

- [ ] **Step 3: Run edit-view tests and verify failure**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/note-edit-view.test.tsx __tests__/shared-components.test.tsx
  ```

  Expected: FAIL because the edit view and custom safe-alternative label do not
  exist.

- [ ] **Step 4: Implement the controlled edit-view boundary**

  Export these props:

  ```tsx
  export type NoteEditViewProps = {
    draft: NoteEditDraft;
    imageCueAllowed: boolean;
    errorsByKey: Record<string, CardDraftErrors>;
    serverErrorsByKey: Record<string, string>;
    saveIssue: NoteMutationIssue | null;
    saving: boolean;
    startAdding: boolean;
    onChangeCard: (key: string, card: CardDraft) => void;
    onAddCard: (kind: CardDraft["kind"]) => string;
    onDeleteCard: (key: string) => void;
    onResetCard: (key: string) => void;
    onCancel: () => void;
    onSave: () => Promise<void>;
    onReloadLatest: () => Promise<void>;
    onClearSaveIssue: () => void;
  };
  ```

  Local state is limited to `adding`, `focusKey`, and one
  `pendingCardAction: { kind: "delete" | "reset"; key: string } | null`.
  Initialize `adding` from `startAdding`. On a card-type choice:

  ```ts
  const key = onAddCard(kind);
  setFocusKey(key);
  setAdding(false);
  ```

  Render `PageHeader` titled `Edit note`, with a quiet `Cancel` trailing button
  calling `guard.requestLeave(onCancel)`. Render a `Cards` section with an
  `Add card` trailing action and one controlled `CardEditForm` per draft card;
  pass `autoFocus={card.key === focusKey}`. When the draft is empty, retain the
  `Add card` action and show `This note has no cards yet`.

  Pass `serverError={serverErrorsByKey[card.key]}` to each `CardEditForm`. When
  a pending delete or reset is confirmed, call the matching parent callback and
  then clear `pendingCardAction`; canceling only clears that local action.

  The `Screen.footer` contains a general error alert when
  `saveIssue?.kind === "general"` and this action:

  ```tsx
  <PrimaryButton
    disabled={!isNoteEditDirty(draft)}
    pending={saving}
    onPress={onSave}
  >
    Save changes
  </PrimaryButton>
  ```

  Mount these confirmation states, with visibility controlled by the local
  action, the guard, and the conflict issue respectively:

  - Persisted delete: `Delete this card?` / `Saving will permanently delete
    this card and its review history.` / `Delete card`.
  - Unsaved delete: `Remove this new card?` / `This unsaved card will be removed
    from this editing session.` / `Remove card`.
  - Reset: `Reset this card's progress?` / `Saving will delete this card's
    review history and make it due now. Its content will stay.` / `Reset
    progress`.
  - Dirty exit: `Discard changes?` / `Your card edits, additions, deletions, and
    pending progress resets will be discarded.` / `Discard changes`, with
    `cancelLabel="Keep editing"`.
  - Conflict: `This note changed elsewhere` / the issue message plus `Your
    local changes are still here.` / `Load latest`, with
    `cancelLabel="Keep editing"`.

  The conflict confirmation calls `onClearSaveIssue` when keeping local work
  and `onReloadLatest` when loading the server snapshot. A card delete clears
  any pending reset by removing the card from the local draft; the pure diff
  builder therefore cannot send both operations. When a persisted card already
  has `resetProgress: true`, its reset action calls `onResetCard` immediately to
  clear the flag; otherwise the action opens the reset confirmation.

- [ ] **Step 5: Re-run edit, guard, and component tests**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/note-edit-view.test.tsx __tests__/card-edit-form.test.tsx __tests__/use-unsaved-changes.test.tsx __tests__/shared-components.test.tsx
  bun run mobile:check
  ```

  Expected: PASS.

- [ ] **Step 6: Commit the editing view**

  ```bash
  git add apps/mobile/src/components/confirm-dialog.tsx apps/mobile/src/features/notes/note-edit-view.tsx apps/mobile/__tests__/note-edit-view.test.tsx apps/mobile/__tests__/shared-components.test.tsx
  git commit -m "feat(mobile): compose saved note editing"
  ```

### Task 11: Integrate reading, editing, conflicts, and deletion in `NoteScreen`

**Files:**
- Modify: `apps/mobile/src/api/notes.ts`
- Modify: `apps/mobile/src/features/notes/note-screen.tsx`
- Modify: `apps/mobile/app/notes/[noteId].tsx`
- Modify: `apps/mobile/__tests__/note-screen.test.tsx`
- Modify: `apps/mobile/__tests__/query-invalidation.test.tsx`

**Interfaces:**
- Consumes: `useNote`, `useUpdateNote`, `useDeleteNote`, `useGenerateNoteImage`, pure draft functions, `NoteReadView`, `NoteEditView`, and Expo Router.
- Produces: A route with only `noteId`, snapshot-safe local editing, exact mutation retries, conflict reload, and replacement navigation after note deletion.

- [ ] **Step 1: Replace obsolete screen tests with failing orchestration tests**

  Update the notes API mock to expose independent update, delete, image, and
  query-refetch functions. Use fixtures with `revision`, `domain`, `language`,
  `cardType`, and public audio fields. Replace assertions about disabled
  `Front`/`Back` inputs and draft re-saving with these flows:

  ```tsx
  it("enters a local edit session and submits one explicit atomic diff", async () => {
    const view = await render(<NoteScreen noteId="note-1" />);
    await fireEvent.press(view.getByRole("button", { name: "Edit" }));
    await fireEvent.changeText(view.getByLabelText("Learning focus"), "grammar");
    await fireEvent.press(view.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith({
      noteId: "note-1",
      expectedRevision: 4,
      creates: [],
      updates: [{
        cardId: "card-1",
        card: expect.objectContaining({ aspect: "grammar" }),
      }],
      deleteCardIds: [],
      resetCardIds: [],
    }));
  });
  ```

  Add tests which prove:

  - Read mode owns the stable `Note` heading and `Source` content, with no
    editable input.
  - Polling can replace the query result while editing without changing any
    local field, local key, pending deletion, or reset flag.
  - Empty-note `Add card` enters edit mode with the type dialog open.
  - Both card types can be created; delete and reset produce their explicit
    operation arrays; deleting the last card still saves.
  - Local validation blocks the mutation, focuses/renders the affected card,
    and preserves every field.
  - A card-local server error is displayed on the card whose persisted ID or
    client key matches the error data.
  - A network failure preserves the draft; pressing Save again sends the same
    `NoteUpdateInput`, including stable client keys.
  - A conflict preserves the draft; `Keep editing` changes nothing; `Load
    latest` requires a successful `refetch` before leaving edit mode.
  - Successful save returns to read mode with the updated query snapshot.
  - Confirmed note deletion calls `{ noteId, expectedRevision }` and routes with
    `router.replace` to `/decks/[deckId]` only after success. Failure does not
    navigate.
  - Loading and missing/error states retain the `Note` heading and safe return;
    a fetch error exposes a working `Retry` action.
  - Image retry behavior and pronunciation-to-card identity remain covered.

- [ ] **Step 2: Run the screen tests and verify failure**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/note-screen.test.tsx
  ```

  Expected: FAIL because the current screen still uses a disabled `CardEditor`,
  `useSaveNote`, and route-editing flags.

- [ ] **Step 3: Make update success authoritative in the note-detail cache**

  Extend the Task 5 React Query tests with a mocked `setQueryData`. Change
  `useUpdateNote` so its success callback first stores the returned snapshot:

  ```ts
  onSuccess: (result, input) => {
    const detailKey = orpc.notes.get.queryOptions({
      input: { noteId: input.noteId },
    }).queryKey;
    queryClient.setQueryData(detailKey, result);
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
    ]);
  },
  ```

  Keep delete invalidation unchanged. Assert `setQueryData` receives the
  note-detail key and mutation result before invalidations resolve.

- [ ] **Step 4: Replace the old screen editor with explicit mode orchestration**

  Change the public screen contract to:

  ```ts
  export function NoteScreen({ noteId }: { noteId: string })
  ```

  Remove `useSaveNote`, `CardEditor`, `editable`, `draftId`, the hydration
  effect, and the card array state. Keep:

  ```ts
  const noteQuery = useNote(noteId);
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const generateImage = useGenerateNoteImage();
  const [draft, setDraft] = useState<NoteEditDraft | null>(null);
  const [startAdding, setStartAdding] = useState(false);
  const [errorsByKey, setErrorsByKey] = useState<Record<string, CardDraftErrors>>({});
  const [serverErrorsByKey, setServerErrorsByKey] = useState<Record<string, string>>({});
  const [saveIssue, setSaveIssue] = useState<NoteMutationIssue | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const nextLocalKey = useRef(1);
  ```

  Enter edit mode only from an explicit action:

  ```ts
  function beginEditing(addImmediately = false) {
    if (!noteQuery.data) return;
    setDraft(hydrateNoteEditDraft(noteQuery.data));
    setStartAdding(addImmediately);
    setErrorsByKey({});
    setServerErrorsByKey({});
    setSaveIssue(null);
  }
  ```

  Do not run an effect that rehydrates `draft` from query data. This is the
  polling-safety boundary. Implement controlled card change, append, delete,
  and reset functions with functional `setDraft`. New keys are
  `new-${nextLocalKey.current++}` and remain unchanged across retries. A card
  field change also clears that card's prior local and server errors; the next
  Save recomputes local validation from the complete draft.

  Compute image-cue permission once per fetched snapshot:

  ```ts
  const imageCueAllowed = data.note.domain === "language" &&
    data.note.metadata.imagePrompt != null;
  ```

  Save by validating every draft card with that context. Store every non-empty
  error object by card key and do not call the mutation when any exists. On a
  valid draft, build the input once, call `updateNote.mutateAsync(input)`, and
  leave edit mode only on success. Normalize failures with
  `noteMutationIssue`; put a card issue into `serverErrorsByKey[issue.cardKey]`
  and all other issues into `saveIssue`. Never rehydrate or clear the draft on
  failure.

  For conflict reload, call `noteQuery.refetch()`. Only when the returned result
  has `isSuccess` and `data` should the screen clear the local draft and issue.
  Otherwise keep the draft and replace the issue with the retryable general
  message `Couldn't load the latest note. Your changes are still here.`

- [ ] **Step 5: Compose read, edit, image retry, deletion, and fetch recovery**

  In the loaded branch:

  ```tsx
  return draft
    ? (
      <NoteEditView
        draft={draft}
        errorsByKey={errorsByKey}
        imageCueAllowed={imageCueAllowed}
        saveIssue={saveIssue}
        saving={updateNote.isPending}
        serverErrorsByKey={serverErrorsByKey}
        startAdding={startAdding}
        onAddCard={addCard}
        onCancel={() => setDraft(null)}
        onChangeCard={changeCard}
        onClearSaveIssue={() => setSaveIssue(null)}
        onDeleteCard={deleteCardFromDraft}
        onReloadLatest={reloadLatest}
        onResetCard={toggleReset}
        onSave={saveChanges}
      />
    )
    : (
      <NoteReadView
        details={data}
        deleteError={deleteError}
        deletePending={deleteNote.isPending}
        imageError={imageError}
        imagePending={generateImage.isPending}
        onAddCard={() => beginEditing(true)}
        onDelete={removeNote}
        onEdit={() => beginEditing(false)}
        onRetryImage={retryImage}
      />
    );
  ```

  `removeNote` clears its prior error, calls
  `{ noteId: data.note.id, expectedRevision: data.note.revision }`, and only
  then calls:

  ```ts
  router.replace({
    pathname: "/decks/[deckId]",
    params: { deckId: data.note.deckId },
  });
  ```

  On delete failure, normalize to a readable message and keep read mode. Keep
  current image retry behavior. In fetch failure state, retain `PageHeader`
  and `ErrorState`, then add an outline `Retry` button invoking
  `noteQuery.refetch()`.

- [ ] **Step 6: Remove obsolete route parameters**

  Replace `apps/mobile/app/notes/[noteId].tsx` with:

  ```tsx
  import { useLocalSearchParams } from "expo-router";
  import { NoteScreen } from "../../src/features/notes/note-screen";

  export default function NoteRoute() {
    const { noteId } = useLocalSearchParams<{ noteId: string }>();
    return <NoteScreen noteId={noteId} />;
  }
  ```

  Search for stale route flags and remove only saved-note usages:

  ```bash
  rg -n 'draftId|editable' apps/mobile/app/notes apps/mobile/src/features/notes apps/mobile/__tests__/note-screen.test.tsx
  ```

  Expected: no matches. Do not remove the Add flow's separate editable-draft
  behavior or `useSaveNote`.

- [ ] **Step 7: Run the complete focused mobile slice**

  ```bash
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/native-cloze.test.ts __tests__/card-draft.test.ts __tests__/card-presentation.test.tsx __tests__/card-edit-form.test.tsx __tests__/screen-scroll.test.tsx __tests__/use-unsaved-changes.test.tsx __tests__/note-read-view.test.tsx __tests__/note-edit-view.test.tsx __tests__/note-screen.test.tsx __tests__/query-invalidation.test.tsx __tests__/note-api.test.ts
  bun run mobile:check
  ```

  Expected: PASS.

- [ ] **Step 8: Commit the saved-note integration**

  ```bash
  git add apps/mobile/src/api/notes.ts apps/mobile/src/features/notes/note-screen.tsx apps/mobile/app/notes/'[noteId].tsx' apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/query-invalidation.test.tsx
  git commit -m "feat(mobile): enable complete saved note editing"
  ```

### Task 12: Record Android acceptance coverage and verify the complete slice

**Files:**
- Modify: `apps/mobile/e2e/android-smoke.md`

**Interfaces:**
- Consumes: The completed server, shared card presentation, local edit model, read view, edit view, and route.
- Produces: Repeatable Android visual evidence and repository-wide verification.

- [ ] **Step 1: Replace the stale saved-note smoke item**

  Remove the item mentioning `toggle suspension`. Add a `Saved note and cards`
  subsection with this checklist:

  ```md
  ### Saved note and cards

  - [ ] Open a note with a long source, image, basic card, hinted cloze, and
        pronunciation. Confirm the page title is "Note", Source is readable,
        the image occurs once, cards are rendered surfaces, and no raw cloze
        markup or disabled form appears.
  - [ ] Confirm `{{c1::Haus::dom}}` reads as `[dom]` in the prompt and as
        `Haus` after reveal/inspection; the visible `dom` hint remains present
        when the note image is the primary cue.
  - [ ] Edit an existing card without reset, save, and confirm its scheduling
        and review history remain. Then explicitly reset a disposable card and
        confirm it becomes due now with no prior logs.
  - [ ] Add one Question and answer card and one Fill in the blank card. Select
        the hidden answer in the ordinary sentence editor and confirm raw
        `{{c1::...}}` markup never appears.
  - [ ] Delete a saved card, cancel the whole edit session, and confirm the card
        returns. Delete it again and save; confirm the card and its history are
        permanently gone. Delete the final card and confirm the note remains
        with `This note has no cards yet` and `Add card`.
  - [ ] With unsaved changes, exercise header Cancel, Android system Back, and
        a navigation link. Confirm each offers to keep editing or discard the
        complete local session.
  - [ ] Simulate an offline save and a revision conflict. Confirm local fields,
        new-card keys, pending deletions, and reset choices survive; loading the
        latest snapshot is always explicit.
  - [ ] Delete a disposable note from More actions. Cancel once, then confirm;
        verify navigation returns to its deck only after success.
  - [ ] Repeat with the keyboard open, Android font size enlarged, a long
        translation, an absent image, image generation pending, and retryable
        image failure. Confirm the sticky Save action, dialogs, cards, and
        controls do not clip or fall behind system insets.
  ```

- [ ] **Step 2: Run focused server and mobile regression suites**

  ```bash
  bun run --cwd apps/server vitest run db/schema.test.ts db/migrations.test.ts router/note-card-operations.test.ts router/notes.test.ts router/concurrency.test.ts tts/jobs.test.ts ai/jobs.test.ts router/decks.test.ts
  NODE_OPTIONS=--experimental-vm-modules bun run --cwd apps/mobile jest --runInBand __tests__/native-cloze.test.ts __tests__/card-draft.test.ts __tests__/card-presentation.test.tsx __tests__/card-edit-form.test.tsx __tests__/screen-scroll.test.tsx __tests__/use-unsaved-changes.test.tsx __tests__/note-read-view.test.tsx __tests__/note-edit-view.test.tsx __tests__/note-screen.test.tsx __tests__/query-invalidation.test.tsx __tests__/note-api.test.ts __tests__/review-screen.test.tsx
  ```

  Expected: PASS with no updated snapshots hiding failures.

- [ ] **Step 3: Run repository-wide static and automated verification**

  Invoke the verification-before-completion skill, then run from the repository
  root:

  ```bash
  bun run check
  bun run test
  git diff --check
  ```

  Expected: every command exits `0`. Remember that only `bun run test` is the
  accepted full-suite command for this repository.

- [ ] **Step 4: Perform Android emulator visual and interaction QA**

  Build or reuse a development client whose native configuration matches the
  checkout. Select the target explicitly with `adb devices` and pass that
  serial to every ADB command. Run the saved-note checklist above on a narrow
  phone viewport and record screenshots for:

  - Read mode with image plus hinted cloze.
  - Empty note.
  - Basic and cloze editors with keyboard open.
  - Delete, reset, dirty-exit, and conflict dialogs.
  - Enlarged font with a long source and translation.

  Inspect the screenshots, not merely successful taps. Reject clipped text,
  repeated images, hidden hints, raw markup, unreachable sticky actions,
  ambiguous destructive copy, touch targets below 48 px, and content obscured
  by the keyboard or Android navigation area. Record emulator model, Android
  version, app commit, API host, and pass/fail evidence in the PR or handoff.

- [ ] **Step 5: Commit the acceptance checklist**

  ```bash
  git add apps/mobile/e2e/android-smoke.md
  git commit -m "test(mobile): cover saved note card workflows"
  ```

- [ ] **Step 6: Request code review and audit the final branch**

  Invoke the requesting-code-review skill with the design spec and this plan.
  Address findings through the receiving-code-review skill, re-run the affected
  focused tests, then repeat Step 3. Finally run:

  ```bash
  git status --short
  git log --oneline --decorate -12
  ```

  Expected: no uncommitted files, conventional task commits are visible, and
  every acceptance criterion in the linked specification has automated or
  recorded visual evidence.
