# German Seed Devtools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free, deterministic German account seed to TanStack Devtools with production-shaped cloze cards, checked-in images, and ready-to-play pronunciation audio.

**Architecture:** Keep declarative seed content and binary fixtures in a focused `server/devtools` module. A development-only `debug.seedGerman` procedure copies those fixtures into the authenticated account’s private media directories, inserts the deck/notes/cards transactionally, and replaces an existing exact-name `German` deck only after the client confirms. A separate Devtools plugin drives the two-step confirmation flow and invalidates application queries after success.

**Tech Stack:** Deno, TypeScript, Drizzle SQLite, oRPC, TanStack Query, TanStack React Devtools, Vitest, Testing Library, `espeak-ng`, `ffmpeg`, and the built-in image generation skill for one-time PNG fixture creation.

## Global Constraints

- Use `deno` for package management and project scripts; never use `npm`, `npx`, `yarn`, or `pnpm`.
- The seed action is protected by authentication and `context.devtoolsEnabled`.
- The seed action never calls OpenRouter, ElevenLabs, or another paid provider.
- Seed cards must use the existing cloze/image-cue validators and `ttsTextForCard` contract.
- Media must be copied into account-scoped storage and served through the existing authenticated routes.
- Replacement must be scoped to the signed-in account’s exact-name `German` deck and must preserve other accounts and differently named decks.
- Follow red-green-refactor: write each failing test, run it to observe the intended failure, implement the smallest change, then rerun focused and broad checks.

---

## File map

Create `server/devtools/german-seed.ts` for the declarative deck/note/card/media fixture and its import-time validation. Create `server/devtools/seed-assets/german/` for three PNG note images and the pronunciation MP3s. Extend `server/router/debug.ts` and `server/router/debug.test.ts` for the protected seed procedure and its database/media behavior. Extend `server/router/base.ts` only with narrowly-scoped test seams for seed media I/O if needed. Extend `server/images.ts` and `server/audio.ts` with safe owner-scoped removal helpers used during replacement cleanup, each with focused tests.

Create `src/components/german-seed-devtools-panel.tsx` and its test. Extend `src/lib/api/debug.ts`, `src/components/mnimi-devtools.tsx`, and `src/components/mnimi-devtools.test.tsx` for the mutation and second plugin. Update the development-tools section of `README.md` with the new action and its confirmation behavior.

---

### Task 1: Create deterministic media fixtures

**Files:**
- Create: `server/devtools/seed-assets/german/banana.png`
- Create: `server/devtools/seed-assets/german/apple.png`
- Create: `server/devtools/seed-assets/german/house.png`
- Create: `server/devtools/seed-assets/german/banana-meaning.mp3`
- Create: `server/devtools/seed-assets/german/banana-gender.mp3`
- Create: `server/devtools/seed-assets/german/banana-plural.mp3`
- Create: `server/devtools/seed-assets/german/apple-meaning.mp3`
- Create: `server/devtools/seed-assets/german/apple-gender.mp3`
- Create: `server/devtools/seed-assets/german/apple-plural.mp3`
- Create: `server/devtools/seed-assets/german/house-meaning.mp3`
- Create: `server/devtools/seed-assets/german/house-gender.mp3`
- Create: `server/devtools/seed-assets/german/house-plural.mp3`

**Interfaces:**
- Produces stable PNG and MP3 files referenced by `german-seed.ts`.

- [ ] **Step 1: Generate the three image assets once**

Use the imagegen skill, one generation per concept, with square, realistic educational-reference prompts: a single banana, a single apple, and a single house; no text, letters, labels, watermark, or translation. Inspect each result and copy the chosen PNG into the exact repository paths above. The images must be usable as note images and must not contain written language.

- [ ] **Step 2: Generate free German pronunciation assets**

For each exact German sentence used by the seed cards, run the local German voice and encode a stable MP3:

```bash
mkdir -p server/devtools/seed-assets/german/.generated-wav
espeak-ng -v de -s 145 -w server/devtools/seed-assets/german/.generated-wav/banana-meaning.wav "Das ist eine Banane."
ffmpeg -y -i server/devtools/seed-assets/german/.generated-wav/banana-meaning.wav -codec:a libmp3lame -b:a 128k server/devtools/seed-assets/german/banana-meaning.mp3
```

Repeat with the nine fixture sentences and remove the intermediate `.generated-wav` directory after validating the MP3 files. Keep the sentence-to-file mapping in the TypeScript fixture so a future asset refresh cannot silently mismatch audio and cards.

- [ ] **Step 3: Inspect the generated assets**

Run:

```bash
file server/devtools/seed-assets/german/*.png server/devtools/seed-assets/german/*.mp3
ffprobe -v error -show_entries format=duration:stream=codec_name,codec_type -of default=noprint_wrappers=1 server/devtools/seed-assets/german/*.mp3
```

Expected: three readable PNG files and nine non-empty MP3 files with an audio stream. Commit the assets:

```bash
git add server/devtools/seed-assets/german
git commit -m "feat: add deterministic German seed media"
```

---

### Task 2: Define and validate the German seed fixture

**Files:**
- Create: `server/devtools/german-seed.ts`
- Create: `server/devtools/german-seed.test.ts`

**Interfaces:**
- Produces `GERMAN_SEED_NAME = "German"`.
- Produces `GERMAN_SEED`, whose notes are `{ sourceText, imageAsset, imagePrompt, cards }` and whose cards are `{ aspect, front, back, hint, imageCue, audioAsset }`.

- [ ] **Step 1: Write the failing fixture tests**

Assert there are exactly three notes named `die Banane`, `der Apfel`, and `das Haus`; each note has an image asset and prompt; each note has three cards with aspects `meaning`, `gender`, and `plural`; every card has exactly one valid cloze deletion; every card’s `ttsTextForCard({ domain: "language", language: "de" }, card)` is non-null; and every `imageCue: true` card has an inline cloze hint and belongs to a note with an image prompt.

Use these card patterns so the fixture exercises the language rule pack:

```ts
{ aspect: "meaning", front: "Das ist eine {{c1::Banane::banana}}.", back: "This is a banana.", hint: null, imageCue: true, audioAsset: "banana-meaning.mp3" }
{ aspect: "gender", front: "{{c1::Die::feminine article}} Banane ist gelb.", back: "The banana is yellow.", hint: null, imageCue: false, audioAsset: "banana-gender.mp3" }
{ aspect: "plural", front: "Ich sehe zwei {{c1::Bananen::bananas}}.", back: "I see two bananas.", hint: null, imageCue: true, audioAsset: "banana-plural.mp3" }
```

Use the corresponding natural German sentences and English translations for `Apfel`/`Äpfel` and `Haus`/`Häuser`, preserving the same three aspects and asset naming scheme.

- [ ] **Step 2: Run the fixture test to verify it fails**

Run `deno task test -- server/devtools/german-seed.test.ts`.

Expected: FAIL because the fixture module and its exported constants do not exist.

- [ ] **Step 3: Implement the declarative fixture**

Import `parseCloze`/`clozeMarkupIsWellFormed`, `imageCueHasFallback`, `imageCuesMatchContext`, and `ttsTextForCard`. Store `domain: "language"`, `language: "de"`, and `metadata: { partOfSpeech: "noun", imagePrompt }` as fixture values. Validate every card at module load with the same predicates used by the generation/save paths, and throw an explanatory error if an asset reference or card invariant is invalid.

- [ ] **Step 4: Run the focused test and commit**

Run `deno task test -- server/devtools/german-seed.test.ts` and expect PASS. Then commit:

```bash
git add server/devtools/german-seed.ts server/devtools/german-seed.test.ts
git commit -m "feat: define German cloze seed fixture"
```

---

### Task 3: Add media cleanup primitives

**Files:**
- Modify: `server/images.ts`
- Modify: `server/audio.ts`
- Create or extend: `server/images.test.ts`
- Create or extend: `server/write-audio.test.ts`

**Interfaces:**
- Produces `removeImage(relativePath: string): Promise<void>` and `removeAudio(relativePath: string): Promise<void>`.
- Both helpers ignore a missing file and reject unexpected filesystem errors.

- [ ] **Step 1: Write failing cleanup tests**

Create temp-root tests that write a known file, remove it successfully, remove it a second time without error, and verify an injected/unexpected filesystem error is not swallowed. Use the modules’ existing environment-before-import pattern so tests never write into the repository’s normal `data` directory.

- [ ] **Step 2: Run focused tests and verify failure**

Run `deno task test -- server/images.test.ts server/write-audio.test.ts`.

Expected: FAIL because the removal exports do not exist.

- [ ] **Step 3: Implement the minimal helpers**

Resolve paths only from the module-owned media roots and the already-generated relative paths. Catch only `Deno.errors.NotFound`; rethrow every other error.

- [ ] **Step 4: Run focused tests and commit**

Run the same focused command and expect PASS. Commit:

```bash
git add server/images.ts server/audio.ts server/images.test.ts server/write-audio.test.ts
git commit -m "feat: add seed media cleanup helpers"
```

---

### Task 4: Add the protected transactional seed procedure

**Files:**
- Modify: `server/router/debug.ts`
- Modify: `server/router/debug.test.ts`
- Modify: `server/router/base.ts` only if test seams for `writeImage`, `writeAudio`, `removeImage`, or `removeAudio` are required
- Modify: `server/router/index.ts` only if the debug router export needs adjustment

**Interfaces:**
- Produces `debugRouter.seedGerman`, an oRPC procedure accepting `{ replace: boolean }`.
- Returns either `{ status: "needs-confirmation", existingDeckId: string }` or `{ status: "seeded", deckId: string, replaced: boolean, noteCount: 3, cardCount: 9 }`.

- [ ] **Step 1: Write failing server tests**

Extend `server/router/debug.test.ts` with tests that:

1. seed an account with no German deck and assert one owned deck, three notes, nine cards, language metadata, valid cloze cards, `audioStatus: "ready"`, non-null audio paths, non-null note image paths, and no paid-provider calls;
2. call `{ replace: false }` with an existing German deck and assert `needs-confirmation` plus unchanged old rows;
3. call `{ replace: true }` and assert the old owned German rows/media are gone and the new fixture is present;
4. assert a different owned deck and another account’s German deck remain untouched;
5. inject a media write failure and assert old database content remains intact and newly created files are cleaned up; and
6. reject when `devtoolsEnabled` is false.

Use test context seams for media writes/removals so server tests never call image/TTS providers or write uncontrolled files. The fixture itself must be the source of expected card data; do not duplicate all nine cards in the assertions.

- [ ] **Step 2: Run the focused server tests and verify failure**

Run `deno task test -- server/router/debug.test.ts`.

Expected: FAIL because `debugRouter.seedGerman` is not defined.

- [ ] **Step 3: Implement media preparation and cleanup**

Generate all new UUIDv7 IDs first. Read fixture assets from `new URL("./../devtools/seed-assets/german/...", import.meta.url)`. Copy images with `writeImage(userId, noteId, bytes)` and audio with `writeAudio(userId, cardId, bytes)`, or their injected test seams. If any copy fails, remove only files created in this attempt and rethrow.

Before replacement, select all owned exact-name German decks, their notes’ `imagePath` values, and their cards’ `audioPath` values. Keep those paths for post-commit cleanup; do not delete old files before the new transaction is safe.

- [ ] **Step 4: Implement the database transaction**

Inside `withWriteLock`, recheck the exact-name owned German decks. If `replace` is false and one exists, return `needs-confirmation` before media preparation. Otherwise, in one transaction delete existing exact-name owned decks when replacing, insert the new deck, insert three notes with `metadata.imagePrompt`, and insert nine cards with fixture values, `cardType: "cloze"`, `audioStatus: "ready"`, their copied `audioPath`, the copied `imagePath` per note, and `due: new Date()`.

If the transaction fails, remove only newly copied media and leave old database/media state untouched. If it succeeds, remove captured old media paths best-effort and return the seeded counts.

- [ ] **Step 5: Run focused tests, API checks, and commit**

Run `deno task test -- server/router/debug.test.ts` and `deno task check:api`. Expect PASS. Commit:

```bash
git add server/router/debug.ts server/router/debug.test.ts server/router/base.ts server/router/index.ts
git commit -m "feat: add deterministic German seed API"
```

---

### Task 5: Add the client mutation and Devtools panel

**Files:**
- Modify: `src/lib/api/debug.ts`
- Create: `src/components/german-seed-devtools-panel.tsx`
- Create: `src/components/german-seed-devtools-panel.test.tsx`

**Interfaces:**
- Produces `useSeedGerman()` with `mutateAsync({ replace: boolean })`.
- Produces a `GermanSeedDevtoolsPanel` with a `Seed German` button, accessible status output, and browser confirmation before replacement.

- [ ] **Step 1: Write failing component tests**

Mock the typed oRPC debug mutation and render the panel under a real `QueryClientProvider`. Assert:

- the first click calls `{ replace: false }`;
- a `needs-confirmation` result calls `window.confirm` with a clear warning and does not replace when cancelled;
- confirming calls `{ replace: true }`;
- successful creation and replacement show distinct status text;
- the button is disabled while pending; and
- mutation errors are rendered in the status region.

- [ ] **Step 2: Run the focused component test and verify failure**

Run `deno task test -- src/components/german-seed-devtools-panel.test.tsx`.

Expected: FAIL because the hook and component do not exist.

- [ ] **Step 3: Implement the typed mutation**

In `src/lib/api/debug.ts`, use `useMutation(orpc.debug.seedGerman.mutationOptions(...))`. On success invalidate `orpc.debug.key()`, `orpc.decks.key()`, `orpc.notes.key()`, `orpc.cards.key()`, and the review query key used by `useDueCards`/`useDueCount`.

- [ ] **Step 4: Implement the panel**

Follow `SrsDevtoolsPanel`’s card/status styling and mutation error handling. On click, call `{ replace: false }`; on `needs-confirmation`, use `window.confirm("Replace the existing German deck and its notes/cards with the deterministic seed?")`; only call `{ replace: true }` after approval. Never ask confirmation when the first call seeds a missing deck.

- [ ] **Step 5: Run focused tests and commit**

Run `deno task test -- src/components/german-seed-devtools-panel.test.tsx` and expect PASS. Commit:

```bash
git add src/lib/api/debug.ts src/components/german-seed-devtools-panel.tsx src/components/german-seed-devtools-panel.test.tsx
git commit -m "feat: add German seed devtools panel"
```

---

### Task 6: Register the plugin and update documentation

**Files:**
- Modify: `src/components/mnimi-devtools.tsx`
- Modify: `src/components/mnimi-devtools.test.tsx`
- Modify: `README.md`

**Interfaces:**
- Produces a second plugin `{ id: "mnimi-german-seed", name: "Seed", render: <GermanSeedDevtoolsPanel /> }` in the existing TanStack Devtools shell.

- [ ] **Step 1: Extend the Devtools test first**

Update the existing mock to expose `orpc.debug.seedGerman` and assert the registered plugin list has both `mnimi-srs` and `mnimi-german-seed`, while the existing SRS plugin still renders unchanged.

- [ ] **Step 2: Run the focused test and verify failure**

Run `deno task test -- src/components/mnimi-devtools.test.tsx`.

Expected: FAIL because only the SRS plugin is currently registered.

- [ ] **Step 3: Register the panel and document the workflow**

Import the new panel, append the plugin to the existing `plugins` array, and add README text explaining that the Devtools `Seed` panel creates the deterministic German fixture and confirms before replacement. Mention that its images/audio are repository fixtures and require no provider credentials.

- [ ] **Step 4: Run focused tests and commit**

Run `deno task test -- src/components/mnimi-devtools.test.tsx src/components/german-seed-devtools-panel.test.tsx` and expect PASS. Commit:

```bash
git add src/components/mnimi-devtools.tsx src/components/mnimi-devtools.test.tsx README.md
git commit -m "feat: expose German seed in TanStack Devtools"
```

---

### Task 7: Run the complete verification suite

**Files:**
- Modify: any implementation/test files only if verification exposes a concrete failure from this feature

- [ ] **Step 1: Run all tests**

Run `deno task test`. Expected: all existing and new tests pass.

- [ ] **Step 2: Run API type-check and production build**

Run `deno task check:api && deno task build`. Expected: both commands exit successfully; the build must include the new Devtools panel without introducing server-only imports into the browser bundle beyond existing type-only router references.

- [ ] **Step 3: Inspect the final diff and status**

Run `git diff HEAD~7 --check` (or the equivalent range if commits were squashed), `git status --short --branch`, and inspect the committed asset list. Expected: no whitespace errors, no generated WAV/temp files, and only scoped feature changes.

- [ ] **Step 4: Commit any verification-only correction**

If a concrete test/build failure required a correction, rerun the affected focused command and commit it with a specific message. Otherwise leave the verified commits intact.

---

## Self-review checklist

- The plan covers the approved spec’s deterministic PNG/MP3 fixtures, cloze validation, image/audio persistence, replacement confirmation, ownership boundaries, cleanup, client invalidation, documentation, and verification.
- No task calls a paid provider during seeding.
- All named interfaces are consistent: `debug.seedGerman`, `{ replace: boolean }`, the two result statuses, `useSeedGerman`, and the `mnimi-german-seed` plugin ID.
- Tests precede production code in every implementation task.
- The only intentional binary-generation exception is one-time repository fixture creation.
