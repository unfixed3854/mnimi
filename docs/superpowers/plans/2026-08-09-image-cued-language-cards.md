# Image-Cued Language Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make newly generated language-production cards use the note image as their preferred question-side cue, with a stored native-language hint as automatic and on-demand fallback, while preserving all existing cards.

**Architecture:** Persist an explicit `imageCue` boolean on each card, defaulting to false for legacy rows. The generation contract and both server write boundaries enforce that image-cued cards belong to an image-backed language note and contain an inline fallback hint; the editor exposes that decision, and a focused review component renders the image-first transforming card without inferring behavior from aspect labels.

**Tech Stack:** Deno tasks, TypeScript, React 19, TanStack Router/Query/AI, Hono/oRPC, Zod, Drizzle SQLite, Testing Library, Vitest, Tailwind v4, ts-fsrs.

## Global Constraints

- Use `deno` for every package, script, build, migration, and test command; never use npm, npx, yarn, or pnpm.
- Do not add a dependency; use the existing React, Base UI, Zod, Drizzle, and test stack.
- Only newly generated language cards may set `imageCue: true`; the database default must keep every existing card false.
- Automatic language generation stays production-only; do not add German-to-native-language recognition cards.
- Set `imageCue: true` only when the deletion hides the vocabulary item or an inflected form and the generated note has a non-null image prompt.
- Gender/article deletions, non-language cards, and notes without an intended image use `imageCue: false`.
- Every image-cued card must contain exactly one valid cloze with a nonempty inline native-language hint.
- An image failure must degrade to that stored hint; it must never make a saved card unanswerable.
- Existing cards and new non-image-cued cards retain the current two-card reveal and post-reveal image behavior.
- The primary review layout is narrow Android: image above sentence inside one transforming card; do not use a side-by-side thumbnail layout.
- Keep FSRS columns, grading behavior, review logs, the partial due index, and the note-id index unchanged.
- Each task is test-first and ends in its own conventional commit.

---

### Task 1: Persist the legacy-safe card flag

**Files:**
- Modify: `server/db/schema.ts`
- Modify: `server/db/schema.test.ts`
- Modify: `server/db/migrations.test.ts`
- Create: `server/drizzle/0003_image_cue.sql`
- Create: `server/drizzle/meta/0003_snapshot.json`
- Modify: `server/drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: the existing Drizzle `cards` table and migration replay harness.
- Produces: `cards.imageCue: boolean`, stored as SQLite `image_cue integer not null default false`; `Card` and `CardRow` acquire the field through Drizzle inference.

- [ ] **Step 1: Write failing schema and migration assertions**

In `server/db/schema.test.ts`, extend the boolean round-trip test so a card inserted without the new field proves the default:

```ts
expect(card.suspended).toBe(false);
expect(card.imageCue).toBe(false);
expect(card.due).toBeInstanceOf(Date);
```

In `server/db/migrations.test.ts`, rename the migration test to describe the latest additive migration, then add these assertions after replaying the final migration:

```ts
expect(row.card_type).toBe("basic");
expect(row.image_cue).toBe(0);

const columns = await client.execute("PRAGMA table_info(cards)");
const names = columns.rows.map((column) => String(column.name));
expect(names).toContain("image_cue");
```

Keep the existing distinctive FSRS assertions and both index assertions intact. Update the setup comment to say the database is built through `0002`, where `back` is nullable and `card_type` already exists, before applying the new migration.

- [ ] **Step 2: Run the database tests and verify they fail**

Run:

```bash
deno task test server/db/schema.test.ts server/db/migrations.test.ts
```

Expected: FAIL because `card.imageCue` and the `image_cue` SQL column do not exist.

- [ ] **Step 3: Add the Drizzle column**

In the `cards` table in `server/db/schema.ts`, place the new field beside `cardType` because both describe card presentation:

```ts
cardType: text("card_type").$type<CardType>().notNull().default("basic"),
// Explicit retrieval-cue policy. False is legacy behavior, so adding the
// column cannot put an existing scheduled card into a new review flow.
imageCue: integer("image_cue", { mode: "boolean" }).notNull().default(false),
hint: text("hint"),
```

- [ ] **Step 4: Generate the named migration**

Run:

```bash
deno task db:generate --name=image_cue
```

Expected: Drizzle creates `server/drizzle/0003_image_cue.sql`, updates `server/drizzle/meta/_journal.json`, and writes `server/drizzle/meta/0003_snapshot.json`. Inspect the SQL and require this additive statement rather than a table recreation:

```sql
ALTER TABLE `cards` ADD `image_cue` integer DEFAULT false NOT NULL;
```

- [ ] **Step 5: Run the focused database verification**

Run:

```bash
deno task test server/db/schema.test.ts server/db/migrations.test.ts
deno task check:api
```

Expected: both test files PASS and the API type-check exits 0.

- [ ] **Step 6: Commit the persistence unit**

```bash
git add server/db/schema.ts server/db/schema.test.ts server/db/migrations.test.ts server/drizzle/0003_image_cue.sql server/drizzle/meta/0003_snapshot.json server/drizzle/meta/_journal.json
git commit -m "feat(db): persist image cue policy"
```

---

### Task 2: Carry and validate cue policy through generation and save

**Files:**
- Modify: `server/ai/card-rules.ts`
- Create: `server/ai/card-rules.test.ts`
- Modify: `server/ai/schemas.ts`
- Modify: `server/ai/schemas.test.ts`
- Modify: `server/ai/generate.ts`
- Modify: `server/ai/generate.test.ts`
- Modify: `server/ai/generate-note.ts`
- Modify: `server/ai/generate-note.test.ts`
- Modify: `server/ai/rule-packs.ts`
- Modify: `server/ai/rule-packs.test.ts`
- Modify: `server/ai/model-calls.test.ts`
- Modify: `server/ai/jobs.test.ts`
- Modify: `server/db/schema.ts`
- Modify: `server/db/schema.test.ts`
- Modify: `server/router/drafts.ts`
- Modify: `server/router/drafts.test.ts`
- Modify: `server/router/ai.test.ts`
- Modify: `server/router/concurrency.test.ts`
- Modify: `server/router/notes.ts`
- Modify: `server/router/notes.test.ts`
- Modify: `server/router/cards.test.ts`
- Modify: `src/lib/draft-state.ts`
- Modify: `src/lib/draft-state.test.ts`
- Modify: `src/lib/draft-status.test.ts`
- Modify: `src/lib/api/drafts.test.ts`
- Modify: `src/components/card-editor.test.tsx`
- Modify: `src/components/streaming-cards.test.tsx`
- Modify: `src/routes/-_authed.add.test.tsx`
- Modify: `src/routes/_authed.add.tsx`

**Interfaces:**
- Consumes: `parseCloze(front)`, the existing one-retry generation path, draft JSON, `notes.save`, and `cards.due`.
- Produces: `GeneratedCard.imageCue: boolean`; `PartialCard.imageCue: boolean | null`; `DraftCard.imageCue: boolean | null`; `generatedNoteSchemaFor(classification)`; shared `imageCueHasFallback(card)` and `imageCuesMatchContext(cards, domain, imagePrompt)` predicates; persisted and due-card `imageCue` values.

- [ ] **Step 1: Add failing rule and schema tests**

In `server/ai/schemas.test.ts`, add `imageCue: false` to every existing complete card fixture. Add these focused cases, using a language classification and a concept classification:

```ts
const LANGUAGE = { domain: "language", language: "de", partOfSpeech: "noun" };
const CONCEPT = { domain: "concept", language: null, partOfSpeech: null };

it("accepts an image cue with a cloze fallback hint", () => {
  const card = {
    aspect: "plural",
    front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
    back: "I see two bananas.",
    hint: null,
    imageCue: true,
  };
  expect(generatedCardSchema.safeParse(card).success).toBe(true);
  expect(
    generatedNoteSchemaFor(LANGUAGE).safeParse({
      imagePrompt: "two bananas",
      cards: [card],
    }).success,
  ).toBe(true);
});

it("rejects an image cue without an inline fallback hint", () => {
  const result = generatedCardSchema.safeParse({
    ...CLOZE,
    imageCue: true,
    front: "Ich sehe zwei {{c1::Bananen}}.",
  });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result.error?.issues)).toContain("fallback hint");
});

it("rejects image cues outside an image-backed language note", () => {
  const card = {
    ...CLOZE,
    imageCue: true,
    front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
  };
  expect(
    generatedNoteSchemaFor(LANGUAGE).safeParse({ imagePrompt: null, cards: [card] })
      .success,
  ).toBe(false);
  expect(
    generatedNoteSchemaFor(CONCEPT).safeParse({ imagePrompt: "Poseidon", cards: [card] })
      .success,
  ).toBe(false);
});
```

In `server/ai/rule-packs.test.ts`, add assertions that the base pack defaults `imageCue` to false, the language pack says production remains the only direction, the lexical and plural examples use `imageCue: true` plus inline hints, and the gender example uses `imageCue: false`.

Create `server/ai/card-rules.test.ts` with the shared-predicate matrix:

```ts
import { describe, expect, it } from "vitest";
import {
  imageCueHasFallback,
  imageCuesMatchContext,
} from "./card-rules.ts";

const hinted = {
  front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
  back: "I see two bananas.",
  imageCue: true,
};

describe("imageCueHasFallback", () => {
  it("requires a real cloze hint only when imageCue is true", () => {
    expect(imageCueHasFallback(hinted)).toBe(true);
    expect(imageCueHasFallback({
      ...hinted,
      front: "Ich sehe zwei {{c1::Bananen}}.",
    })).toBe(false);
    expect(imageCueHasFallback({ ...hinted, front: "plain text" })).toBe(false);
    expect(imageCueHasFallback({
      ...hinted,
      front: "Ich sehe zwei {{c1::Bananen}}.",
      imageCue: false,
    })).toBe(true);
  });
});

describe("imageCuesMatchContext", () => {
  it("allows cues only for image-backed language notes", () => {
    expect(imageCuesMatchContext([hinted], "language", "two bananas")).toBe(true);
    expect(imageCuesMatchContext([hinted], "concept", "two bananas")).toBe(false);
    expect(imageCuesMatchContext([hinted], "language", null)).toBe(false);
    expect(imageCuesMatchContext(
      [{ ...hinted, imageCue: false }],
      "concept",
      null,
    )).toBe(true);
  });
});
```

- [ ] **Step 2: Add failing projection, router, and persistence tests**

In `server/ai/generate.test.ts`, change the partial projection expectations to include `imageCue: null`, then add:

```ts
it("projects imageCue once the boolean arrives", () => {
  expect(
    projectCards({
      cards: [{ aspect: "plural", front: "f", back: "b", imageCue: true }],
    }),
  ).toEqual([
    { aspect: "plural", front: "f", back: "b", imageCue: true },
  ]);
});
```

In `server/router/notes.test.ts`, add one successful image-backed language save and three refusals:

```ts
const IMAGE_CARD = {
  aspect: "plural",
  front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
  back: "I see two bananas.",
  hint: null,
  imageCue: true,
};

it("persists an image cue on an image-backed language card", async () => {
  const ada = await server.signIn("ada@example.com");
  const draft = await seedDraft(ada.context, ada.userId, {
    cards: [IMAGE_CARD],
    imagePrompt: "two bananas",
  });
  const note = await call(
    notesRouter.save,
    { draftId: draft.id, cards: [IMAGE_CARD] },
    { context: ada.context },
  );
  const [saved] = await server.db.select().from(cards).where(eq(cards.noteId, note.id));
  expect(saved.imageCue).toBe(true);
});
```

The refusal cases must prove `BAD_REQUEST` for: `imageCue: true` with a null draft image prompt; a concept classification; and a cloze with no inline hint. In `server/router/drafts.test.ts`, mirror the same rules for `drafts.update`. In `server/router/cards.test.ts`, seed one card with `imageCue: true` and assert `cards.due` returns it unchanged beside `hasImage`.

- [ ] **Step 3: Run the new server tests and verify they fail**

Run:

```bash
deno task test server/ai/card-rules.test.ts server/ai/schemas.test.ts server/ai/rule-packs.test.ts server/ai/generate.test.ts server/router/notes.test.ts server/router/drafts.test.ts server/router/cards.test.ts
```

Expected: FAIL because the contracts, predicates, router fields, and prompt rules do not exist.

- [ ] **Step 4: Add shared image-cue invariants**

Extend `server/ai/card-rules.ts` without changing the existing cloze and answer predicates:

```ts
export type ImageCueCardShape = CardShape & { imageCue: boolean };

export const IMAGE_CUE_NEEDS_HINT =
  "An image-cued card requires one cloze with a native-language fallback hint.";

export const IMAGE_CUE_NEEDS_LANGUAGE_IMAGE =
  "Image cues require a language note with a non-empty image prompt.";

export function imageCueHasFallback(card: ImageCueCardShape): boolean {
  if (!card.imageCue) return true;
  return parseCloze(card.front)?.hint != null;
}

export function imageCuesMatchContext(
  cards: ImageCueCardShape[],
  domain: string,
  imagePrompt: string | null,
): boolean {
  return !cards.some((card) => card.imageCue) ||
    (domain === "language" && imagePrompt !== null);
}
```

- [ ] **Step 5: Extend the generated and partial schemas**

In `server/ai/schemas.ts`, import `imageCueHasFallback`, `imageCuesMatchContext`, and their messages. Add the required field to `generatedCardSchema`, followed by the shared refinement:

```ts
imageCue: z.boolean(),
```

```ts
.refine(imageCueHasFallback, {
  message: IMAGE_CUE_NEEDS_HINT,
  path: ["front"],
})
```

Keep `generatedNoteSchema` as the provider-facing structural schema, then add the classification-aware factory used for final validation:

```ts
export function generatedNoteSchemaFor(classification: Classification) {
  return generatedNoteSchema.refine(
    (note) =>
      imageCuesMatchContext(
        note.cards,
        classification.domain,
        note.imagePrompt,
      ),
    { message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE, path: ["cards"] },
  );
}
```

Extend the streaming type:

```ts
export type PartialCard = {
  aspect: string | null;
  front: string | null;
  back: string | null;
  imageCue: boolean | null;
};
```

In `server/ai/generate.ts`, add a boolean projector and include it in every partial card:

```ts
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
```

```ts
return cards.map((card) => ({
  aspect: stringOrNull(card?.aspect),
  front: stringOrNull(card?.front),
  back: stringOrNull(card?.back),
  imageCue: booleanOrNull(card?.imageCue),
}));
```

In `server/ai/generate-note.ts`, replace `generatedNoteSchema` in `streamWithRetry` with `generatedNoteSchemaFor(classification)`. Keep `generatedNoteSchema` in `server/ai/model-calls.ts` so TanStack AI still receives the complete structural output schema, including the required boolean.

- [ ] **Step 6: Write the exact generation policy**

In `BASE_PACK`, add:

```text
- Every card has an imageCue boolean. Set it to false unless a domain rule
  below explicitly tells you that the note image is the question-side cue.
```

In `LANGUAGE_PACK`, keep the production-only rule and replace the ambiguous examples with explicit card-shaped examples conveying these exact facts:

```text
- Keep generation production-only. Do not generate a reverse card that asks
  for the learner's native-language translation.
- When imagePrompt is non-null and the deletion hides the vocabulary item or
  one of its inflected forms, set imageCue to true and ALWAYS keep the native-
  language meaning as the inline fallback hint:
    front: Das ist eine {{c1::Banane::banana}}.
    imageCue: true
    front: Ich sehe zwei {{c1::Bananen::bananas}}.
    imageCue: true
- When the target word stays visible and only grammar is deleted, do not use
  the image as the cue:
    front: {{c1::Die}} Banane ist gelb.
    imageCue: false
- If imagePrompt is null, every card has imageCue: false and an ambiguous
  lexical deletion still needs its native-language inline hint.
```

- [ ] **Step 7: Carry the field through draft storage and both write boundaries**

In `server/db/schema.ts`, extend `DraftCard`:

```ts
export type DraftCard = {
  aspect: string | null;
  front: string | null;
  back: string | null;
  imageCue: boolean | null;
  hint?: string | null;
};
```

In `server/router/drafts.ts` and `server/router/notes.ts`, add `imageCue: z.boolean()` to complete card inputs and refine each card with `imageCueHasFallback`. After loading the draft and before writing, reject a card set that fails its note context. In `notes.save`, use the already resolved `classification` and the required input cards:

```ts
if (
  !imageCuesMatchContext(
    input.cards,
    classification.domain,
    draft.imagePrompt,
  )
) {
  throw new ORPCError("BAD_REQUEST", {
    message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
  });
}
```

In `drafts.update`, validate only when cards were supplied, and use `"concept"` for a draft whose classification never landed:

```ts
if (
  input.cards &&
  !imageCuesMatchContext(
    input.cards,
    draft.classification?.domain ?? "concept",
    draft.imagePrompt,
  )
) {
  throw new ORPCError("BAD_REQUEST", {
    message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
  });
}
```

In `notes.save`, include the persisted field:

```ts
imageCue: card.imageCue,
```

The due query spreads the Drizzle card row and therefore needs no mapping change; retain its existing `{ ...row.card, hasImage }` return.

- [ ] **Step 8: Carry complete and partial values through the browser state**

In `src/lib/draft-state.ts`, seed failed hand-written cards with `imageCue: false`. The reducer already spreads partial edits and replaces cards from events, so no new action is required.

In `src/routes/_authed.add.tsx`, preserve the value when converting a settled `DraftCard` into a `GeneratedCard` and when sending save input:

```ts
imageCue: card.imageCue ?? false,
```

Add `imageCue: false` to non-image fixtures and fallbacks throughout the files listed for this task. Add `imageCue: true` only to fixtures with both a non-null image prompt and an inline cloze hint. Update `server/ai/jobs.test.ts`, `server/ai/generate-note.test.ts`, `server/ai/model-calls.test.ts`, `server/router/drafts.test.ts`, `server/router/ai.test.ts`, `server/router/concurrency.test.ts`, `src/lib/draft-state.test.ts`, `src/lib/draft-status.test.ts`, `src/lib/api/drafts.test.ts`, `src/components/card-editor.test.tsx`, `src/components/streaming-cards.test.tsx`, and `src/routes/-_authed.add.test.tsx` so every complete card matches the new required shape. Partial streaming fixtures use `imageCue: null` until the boolean arrives.

- [ ] **Step 9: Run focused and whole-project verification**

Run:

```bash
deno task test server/ai/card-rules.test.ts server/ai/schemas.test.ts server/ai/generate.test.ts server/ai/generate-note.test.ts server/ai/rule-packs.test.ts server/ai/model-calls.test.ts server/ai/jobs.test.ts server/router/drafts.test.ts server/router/notes.test.ts server/router/cards.test.ts server/router/ai.test.ts server/router/concurrency.test.ts src/lib/draft-state.test.ts src/lib/draft-status.test.ts src/lib/api/drafts.test.ts src/components/card-editor.test.tsx src/components/streaming-cards.test.tsx src/routes/-_authed.add.test.tsx
deno task check:api
deno task build
```

`server/ai/card-rules.test.ts` directly tests `imageCueHasFallback` and `imageCuesMatchContext`; it covers true with a hint, true without a hint, true with non-cloze input, false without a hint, language plus prompt, concept plus prompt, and language plus null prompt. Expected: all tests PASS, API check exits 0, and the client build succeeds.

- [ ] **Step 10: Commit the end-to-end contract**

```bash
git add server/ai/card-rules.ts server/ai/card-rules.test.ts server/ai/schemas.ts server/ai/schemas.test.ts server/ai/generate.ts server/ai/generate.test.ts server/ai/generate-note.ts server/ai/generate-note.test.ts server/ai/rule-packs.ts server/ai/rule-packs.test.ts server/ai/model-calls.test.ts server/ai/jobs.test.ts server/db/schema.ts server/db/schema.test.ts server/router/drafts.ts server/router/drafts.test.ts server/router/notes.ts server/router/notes.test.ts server/router/cards.test.ts server/router/ai.test.ts server/router/concurrency.test.ts src/lib/draft-state.ts src/lib/draft-state.test.ts src/lib/draft-status.test.ts src/lib/api/drafts.test.ts src/components/card-editor.test.tsx src/components/streaming-cards.test.tsx src/routes/_authed.add.tsx src/routes/-_authed.add.test.tsx
git commit -m "feat(ai): generate explicit image cue cards"
```

---

### Task 3: Make image cues editable and validate drafts locally

**Files:**
- Modify: `src/components/cloze-text.tsx`
- Modify: `src/components/cloze-text.test.tsx`
- Modify: `src/components/card-face.tsx`
- Modify: `src/components/card-face.test.tsx`
- Modify: `src/components/card-editor.tsx`
- Modify: `src/components/card-editor.test.tsx`
- Modify: `src/lib/draft-state.ts`
- Modify: `src/lib/draft-state.test.ts`
- Modify: `src/routes/_authed.add.tsx`
- Modify: `src/routes/-_authed.add.test.tsx`

**Interfaces:**
- Consumes: `GeneratedCard.imageCue`, `DraftState.classification`, `DraftState.imagePrompt`, and `parseCloze(front)`.
- Produces: `ClozeText({ segments, reveal?, showHint? })`; `CardFront({ front, showHint? })`; `CardEditor({ card, canUseImageCue, onChange, onRemove })`; local saveability enforcement for image cues.

- [ ] **Step 1: Write failing hint-suppression and editor tests**

In `src/components/cloze-text.test.tsx`, add:

```tsx
it("suppresses a stored hint when the image is the cue", () => {
  const { container } = render(
    <ClozeText segments={WITH_HINT} showHint={false} />,
  );
  expect(container.textContent).toBe("Ich mag ____ zum Frühstück.");
});
```

In `src/components/card-face.test.tsx`, prove `CardFront` forwards the option. In `src/components/card-editor.test.tsx`, use an image-cued card with an inline hint and assert:

```tsx
expect(
  (screen.getByLabelText("Use picture as prompt") as HTMLInputElement).checked,
).toBe(true);
expect(screen.getByTestId("cloze-preview").textContent).toBe(
  "Ich mag ____ zum Frühstück.",
);
fireEvent.click(screen.getByLabelText("Use picture as prompt"));
expect(onChange).toHaveBeenCalledWith({ imageCue: false });
```

Add a second editor test with `canUseImageCue={false}` that proves the control is absent, and a third with `imageCue: true` but no inline hint that proves the targeted text `Picture prompts need a native-language fallback hint inside the deletion.` appears.

- [ ] **Step 2: Write failing draft-saveability tests**

In `src/lib/draft-state.test.ts`, construct settled states and assert:

```ts
expect(isSavable(loaded({
  status: "ready",
  classification: CLASSIFICATION,
  imagePrompt: "a banana",
  cards: [{
    aspect: "plural",
    front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
    back: "I see two bananas.",
    hint: null,
    imageCue: true,
  }],
}))).toBe(true);
```

Mirror it with no inline hint, a null image prompt, and a concept classification; each must be false. A card with the same hinted cloze and `imageCue: false` remains savable.

- [ ] **Step 3: Run the focused UI-state tests and verify they fail**

Run:

```bash
deno task test src/components/cloze-text.test.tsx src/components/card-face.test.tsx src/components/card-editor.test.tsx src/lib/draft-state.test.ts
```

Expected: FAIL because `showHint`, `canUseImageCue`, the checkbox, targeted error, and local invariants do not exist.

- [ ] **Step 4: Add reusable hint suppression**

Change `ClozeText` to default to current behavior and render a rule when a stored hint is intentionally suppressed:

```tsx
export function ClozeText({
  segments,
  reveal = false,
  showHint = true,
}: {
  segments: ClozeSegments;
  reveal?: boolean;
  showHint?: boolean;
}) {
  // existing before/reveal/after structure
  const prompt = showHint && segments.hint ? `[${segments.hint}]` : "____";
  // render `prompt` in the existing muted italic span
}
```

Extend `CardFront` without changing its default callers:

```tsx
export function CardFront({
  front,
  showHint = true,
}: {
  front: string;
  showHint?: boolean;
}) {
  const segments = parseCloze(front);
  return segments
    ? <ClozeText segments={segments} showHint={showHint} />
    : <>{front}</>;
}
```

- [ ] **Step 5: Add the editor control and preview state**

Extend `CardEditor` with `canUseImageCue: boolean`. Under the front/preview area, render a native checkbox only when `canUseImageCue` is true:

```tsx
<label className="flex items-center gap-2 px-2.5 text-sm text-muted-foreground">
  <input
    type="checkbox"
    checked={card.imageCue}
    onChange={(event) => onChange({ imageCue: event.target.checked })}
  />
  Use picture as prompt
</label>
```

Render the preview with `<CardFront front={card.front} showHint={!card.imageCue} />`. When `card.imageCue` is true, add the quiet label `Picture cue · text hint kept as fallback`. When `parseCloze(card.front)?.hint` is null, render the targeted destructive message and do not claim the preview is valid.

In `_authed.add.tsx`, pass:

```tsx
canUseImageCue={
  state.classification?.domain === "language" && state.imagePrompt !== null
}
```

- [ ] **Step 6: Enforce the same rules in `isSavable` and improve page copy**

Inside the per-card branch of `isSavable`, parse once and add:

```ts
const cloze = parseCloze(front);
if (card.imageCue) {
  if (state.classification?.domain !== "language") return false;
  if (state.imagePrompt === null) return false;
  if (!cloze?.hint) return false;
}
if (cloze) return true;
return (card.back ?? "").trim() !== "";
```

Change the add-page invalid-card alert to include the specific third rule:

```text
Every card needs a front; basic cards need a back; picture-prompted cards also need an inline fallback hint.
```

- [ ] **Step 7: Run the editor and add-flow tests**

Run:

```bash
deno task test src/components/cloze-text.test.tsx src/components/card-face.test.tsx src/components/card-editor.test.tsx src/lib/draft-state.test.ts src/routes/-_authed.add.test.tsx
deno task build
```

Expected: all tests PASS and the production build succeeds.

- [ ] **Step 8: Commit the editable cue policy**

```bash
git add src/components/cloze-text.tsx src/components/cloze-text.test.tsx src/components/card-face.tsx src/components/card-face.test.tsx src/components/card-editor.tsx src/components/card-editor.test.tsx src/lib/draft-state.ts src/lib/draft-state.test.ts src/routes/_authed.add.tsx src/routes/-_authed.add.test.tsx
git commit -m "feat(ui): make picture prompts editable"
```

---

### Task 4: Report actual generated-image display status

**Files:**
- Modify: `src/components/generated-image.tsx`
- Modify: `src/components/generated-image.test.tsx`

**Interfaces:**
- Consumes: `useGeneratedImage(scope, id, present)` and the existing object-URL lifecycle.
- Produces: exported `GeneratedImageStatus = "absent" | "loading" | "ready" | "error"`; optional `onStatusChange(status)` prop that reports fetch and `<img>` display outcomes without changing existing callers.

- [ ] **Step 1: Write failing status tests**

Extend `src/components/generated-image.test.tsx` with a status spy. Cover all four states:

```tsx
it("reports absent when no image is attached", () => {
  queryMock.mockReturnValue({ data: undefined, isError: false });
  const onStatusChange = vi.fn();
  renderImage({
    scope: "notes",
    id: "n1",
    present: false,
    alt: "banana",
    onStatusChange,
  });
  expect(onStatusChange).toHaveBeenLastCalledWith("absent");
});
```

For a present image with no blob, expect `loading`. For `isError: true`, expect `error`. For a returned blob, wait for the `<img>`, fire `load`, and expect `ready`; then fire `error` and expect `error` plus a collapsed image.

- [ ] **Step 2: Run the component test and verify it fails**

Run:

```bash
deno task test src/components/generated-image.test.tsx
```

Expected: FAIL because the status type and callback prop do not exist.

- [ ] **Step 3: Implement stable load-state reporting**

Export:

```ts
export type GeneratedImageStatus = "absent" | "loading" | "ready" | "error";
```

Add the optional prop:

```ts
onStatusChange?: (status: GeneratedImageStatus) => void;
```

Track the browser element separately from the blob query:

```ts
const [elementStatus, setElementStatus] = useState<"loading" | "ready" | "error">(
  "loading",
);

useEffect(() => {
  setElementStatus("loading");
}, [url]);

const status: GeneratedImageStatus = !present
  ? "absent"
  : isError || elementStatus === "error"
    ? "error"
    : url && elementStatus === "ready"
      ? "ready"
      : "loading";

useEffect(() => {
  onStatusChange?.(status);
}, [onStatusChange, status]);
```

Return null for `absent` and `error`. Render the fixed-size skeleton only while
there is no object URL; once `url` exists, render the `<img>` even though its
reported status remains `loading`, because the element must exist before it can
fire the event that advances the status to `ready`:

```tsx
if (status === "absent" || status === "error") return null;
if (!url) return <Skeleton className={className} />;
```

Attach the element events:

```tsx
<img
  src={url}
  alt={alt}
  className={cn("object-cover", className)}
  onLoad={() => setElementStatus("ready")}
  onError={() => setElementStatus("error")}
/>
```

Do not revoke the object URL anywhere except the existing effect cleanup.

- [ ] **Step 4: Run image and full component verification**

Run:

```bash
deno task test src/components/generated-image.test.tsx src/lib/api/images.test.ts
deno task build
```

Expected: tests PASS, the object-URL cleanup assertion still passes, and build exits 0.

- [ ] **Step 5: Commit the image-status seam**

```bash
git add src/components/generated-image.tsx src/components/generated-image.test.tsx
git commit -m "feat(ui): report generated image load status"
```

---

### Task 5: Render the image-first transforming review card

**Files:**
- Create: `src/components/image-cue-review-card.tsx`
- Create: `src/components/image-cue-review-card.test.tsx`
- Modify: `src/routes/_authed.review.$deckId.tsx`

**Interfaces:**
- Consumes: `GeneratedImageStatus`, `GeneratedImage`, `CardFront`, `CardBack`, and a due card containing `{ id, noteId, front, back, hasImage, imageCue }`.
- Produces: `ImageCueReviewCard({ card, revealed, onReveal })`, rendering the image-first prompt and same-card reveal. The route keys it by `card.id`, keeps grading state, and retains the complete legacy branch for `imageCue: false`.

- [ ] **Step 1: Write the failing image-cue review tests**

Create `src/components/image-cue-review-card.test.tsx`. Mock `GeneratedImage` with a small component that calls its supplied `onStatusChange` from an effect and renders its `alt`. Use:

```ts
const CARD = {
  id: "c1",
  noteId: "n1",
  front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
  back: "I see two bananas.",
  hasImage: true,
};
```

Add these assertions as separate tests:

```tsx
expect(screen.getByAltText("bananas")).toBeTruthy();
expect(screen.getByText("____")).toBeTruthy();
expect(screen.queryByText("[bananas]")).toBeNull();
expect(screen.getByRole("button", { name: "Text hint" })).toBeTruthy();
```

Click `Text hint` and expect `[bananas]`. Simulate `absent` and `error` statuses and expect the hint automatically with no `Text hint` action. Click `Show answer` and rerender with `revealed`; expect `Bananen` and `I see two bananas.` inside the same card while the mocked image remains once. Finally, click `Text hint`, rerender the component with `key="c2"` and a second card, and prove the hint returns to its suppressed state.

- [ ] **Step 2: Run the new component test and verify it fails**

Run:

```bash
deno task test src/components/image-cue-review-card.test.tsx
```

Expected: FAIL because `ImageCueReviewCard` does not exist.

- [ ] **Step 3: Implement the focused review component**

Create `src/components/image-cue-review-card.tsx` with this public shape:

```ts
export type ImageCueReviewCardValue = {
  id: string;
  noteId: string;
  front: string;
  back: string | null;
  hasImage: boolean;
};

export function ImageCueReviewCard({
  card,
  revealed,
  onReveal,
}: {
  card: ImageCueReviewCardValue;
  revealed: boolean;
  onReveal: () => void;
})
```

Parse the cloze once. Initialize status from `card.hasImage`, store `textHintRequested`, and derive:

```ts
const [imageStatus, setImageStatus] = useState<GeneratedImageStatus>(
  card.hasImage ? "loading" : "absent",
);
const [textHintRequested, setTextHintRequested] = useState(false);
```

```ts
const imageUnavailable = imageStatus === "absent" || imageStatus === "error";
const showHint = imageUnavailable || textHintRequested;
const nativeCue = segments?.hint ?? "";
```

Render one existing shadcn `Card`. Inside its content, put `GeneratedImage` first with `alt={nativeCue}`, `present={card.hasImage}`, `onStatusChange={setImageStatus}`, and a centered square mobile-friendly class such as `mx-auto mb-6 h-48 w-48 rounded-xl`. Beneath it render:

```tsx
{revealed
  ? <CardBack front={card.front} back={card.back} />
  : <CardFront front={card.front} showHint={showHint} />}
```

While not revealed, show `Text hint` only when the image is `loading` or `ready` and text has not already been requested. Use a quiet `variant="ghost"` button. Put the full-width `Show answer` button below the card and call `onReveal`. Do not render either hint action after reveal.

If `parseCloze` unexpectedly returns null, render the ordinary `CardFront`/`CardBack` content without an image cue; the server prevents this state, but the component must not crash on stale or hand-corrupted data.

- [ ] **Step 4: Integrate without changing the legacy branch**

In `_authed.review.$deckId.tsx`, keep `revealed` and all rating/grade logic in the route. Extract the existing question card, revealed answer card, post-reveal image, and `Show answer` button into the `imageCue === false` branch without changing their markup or copy.

For a true value render:

```tsx
<ImageCueReviewCard
  key={card.id}
  card={card}
  revealed={revealed}
  onReveal={() => setRevealed(true)}
/>
```

Move the rating grid just below the two presentation branches and gate it once with `revealed`. Keep `setRevealed(false)` only after a successful grade. The `key` remount is the explicit reset for image status and temporary text-hint state when the queue head changes.

- [ ] **Step 5: Run review regressions and the production build**

Run:

```bash
deno task test src/components/image-cue-review-card.test.tsx src/components/generated-image.test.tsx src/components/card-face.test.tsx src/components/cloze-text.test.tsx src/lib/fsrs.test.ts server/router/cards.test.ts
deno task build
```

Expected: all tests PASS; image-cued cards use one transforming card; existing card rendering and FSRS logic remain green; build exits 0.

- [ ] **Step 6: Commit the review experience**

```bash
git add src/components/image-cue-review-card.tsx src/components/image-cue-review-card.test.tsx 'src/routes/_authed.review.$deckId.tsx'
git commit -m "feat(review): show images as production cues"
```

---

### Task 6: Align documentation and run release verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the completed generation, editor, persistence, and review behavior.
- Produces: accurate user/developer documentation and one final verified commit.

- [ ] **Step 1: Write the final README wording**

Replace the sentence promising separate meaning and production cards with wording that describes the shipped policy:

```md
Type `die Banane` and you get a picture of the fruit plus production-first
cards for the word, its gender and its plural. When a card asks you to produce
the German word or an inflected form, the picture is shown as the cue; its
native-language cloze hint stays stored as a fallback if the picture is missing
or you request a text hint.
```

Keep the surrounding statement that mnimi is not only a language app. Update the cloze example so every card-shaped JSON or prose example includes the explicit cue distinction: lexical/plural cards are image-cued only with an image prompt; gender and non-language cards are not.

- [ ] **Step 2: Check documentation for stale direction and image claims**

Run:

```bash
rg -n "recognition|production|imageCue|picture|image|hint" README.md server/ai/rule-packs.ts docs/superpowers/specs/2026-08-09-image-cued-language-cards-design.md
```

Expected: no README claim says both recognition and production are generated; rule-pack examples and the spec agree on image-cued lexical/plural cards and non-image-cued gender cards.

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
deno task test
deno task check:api
deno task build
git diff --check
git status --short
```

Expected: all tests PASS, API check exits 0, build exits 0, `git diff --check` prints nothing, and only `README.md` is uncommitted.

- [ ] **Step 4: Commit the documentation**

```bash
git add README.md
git commit -m "docs: explain image-cued production cards"
```

- [ ] **Step 5: Confirm the finished branch state**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: the worktree is clean and the latest commits are the database flag, generation contract, editable prompt, image-status seam, review experience, and documentation units in that order.
