# Remove Passive Inventory Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove passive collection-total numerals from mobile section headers while preserving counts that inform study actions and progress.

**Architecture:** Leave the shared `SectionHeader` interface unchanged because it is still a valid general-purpose layout primitive. Each affected screen will stop passing a passive `detail` value; no data fetching, navigation, or state logic changes. Existing focused screen tests will cover the absence of inventory totals and the presence of useful due/review counts.

**Tech Stack:** Expo Router, React Native, TypeScript, NativeWind, Jest, React Native Testing Library, Deno.

**Spec:** `docs/superpowers/specs/2026-08-18-remove-passive-inventory-counts-design.md`

## Global Constraints

- Use `deno` for every package-management and script command; do not use npm, npx, yarn, or pnpm.
- Remove only passive inventory totals: `Your decks`, deck `Notes`, and note `Cards` must not receive numeric `SectionHeader` details.
- Preserve counts with direct decision or progress value: Today due count, deck review call-to-action due count, and active Review remaining-card count.
- Do not change data queries, navigation, loading/error/empty states, accessibility roles, or the `SectionHeader` public API.

---

### Task 1: Remove passive inventory totals with regression coverage

**Files:**
- Modify: `apps/mobile/src/features/decks/DeckListScreen.tsx:107`
- Modify: `apps/mobile/src/features/decks/DeckDetailScreen.tsx:106`
- Modify: `apps/mobile/src/features/notes/NoteScreen.tsx:160`
- Modify: `apps/mobile/__tests__/deck-list-screen.test.tsx`
- Modify: `apps/mobile/__tests__/deck-detail-screen.test.tsx`
- Modify: `apps/mobile/__tests__/note-screen.test.tsx`
- Modify: `apps/mobile/__tests__/today-screen.test.tsx`
- Modify: `apps/mobile/__tests__/review-screen.test.tsx`

**Interfaces:**
- Consumes: Existing `SectionHeader({ title, detail?, trailing?, className? })` calls, screen component render APIs, and their mocked query hooks.
- Produces: Title-only collection headers and regression coverage proving passive totals are absent while useful due/review counts still render.

- [ ] **Step 1: Add failing assertions for the three passive totals and the retained activity counts**

  Add these assertions to the existing tests, using the current fixture values rather than creating new test-only APIs:

  ```tsx
  // deck-list-screen.test.tsx — after rendering one German deck
  expect(view.queryByText("Your decks")).toBeTruthy();
  expect(view.queryByText("1")).toBeNull();
  ```

  ```tsx
  // deck-detail-screen.test.tsx — with one note and mockDueCount = 3
  expect(view.getByText("Notes")).toBeTruthy();
  expect(view.queryByText("1")).toBeNull();
  expect(view.getByRole("button", { name: "Review 3 due" })).toBeTruthy();
  ```

  ```tsx
  // note-screen.test.tsx — render a note with its existing card fixture
  expect(view.getByText("Cards")).toBeTruthy();
  expect(view.queryByText("1")).toBeNull();
  ```

  ```tsx
  // today-screen.test.tsx — with mockDueCount = 7
  expect(view.getByText("7")).toBeTruthy();
  expect(view.getByText("cards due")).toBeTruthy();
  ```

  ```tsx
  // review-screen.test.tsx — with the existing one-card fixture
  expect(view.getByText("1 left · meaning")).toBeTruthy();
  ```

  The existing fixtures do not otherwise render a bare `"1"`; keep these assertions exact so they fail while the header detail is present and pass once it is removed. Do not add test-only production props or weaken the check by only testing that the screen renders.

- [ ] **Step 2: Run the focused tests and verify they fail for the intended reason**

  Run:

  ```bash
  deno task mobile:test --runInBand apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/today-screen.test.tsx apps/mobile/__tests__/review-screen.test.tsx
  ```

  Expected: FAIL because the three current `SectionHeader detail={...}` values still render as bare totals. The Today and Review retained-count assertions should already pass.

- [ ] **Step 3: Remove only the `detail` props from the three collection headers**

  Make the JSX render the existing component with title-only calls:

  ```tsx
  // DeckListScreen.tsx
  <SectionHeader title="Your decks" />

  // DeckDetailScreen.tsx
  <SectionHeader title="Notes" />

  // NoteScreen.tsx
  <SectionHeader title="Cards" />
  ```

  Do not remove `decks`, `notes`, or `cards` variables: each remains necessary for list/empty-state rendering, editing, and save-button state. Do not edit `SectionHeader.tsx`; its optional `detail` remains supported for unrelated callers.

- [ ] **Step 4: Format the modified source and focused test files**

  Run:

  ```bash
  deno fmt apps/mobile/src/features/decks/DeckListScreen.tsx apps/mobile/src/features/decks/DeckDetailScreen.tsx apps/mobile/src/features/notes/NoteScreen.tsx apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/today-screen.test.tsx apps/mobile/__tests__/review-screen.test.tsx
  ```

- [ ] **Step 5: Re-run the focused tests and verify the passive/active distinction**

  Run:

  ```bash
  deno task mobile:test --runInBand apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/today-screen.test.tsx apps/mobile/__tests__/review-screen.test.tsx
  ```

  Expected: PASS. The deck, deck-detail, and note section-header totals are absent; `Review 3 due`, Today’s due count, and `1 left · meaning` remain present.

- [ ] **Step 6: Commit the implementation and regression coverage**

  ```bash
  git add apps/mobile/src/features/decks/DeckListScreen.tsx apps/mobile/src/features/decks/DeckDetailScreen.tsx apps/mobile/src/features/notes/NoteScreen.tsx apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/today-screen.test.tsx apps/mobile/__tests__/review-screen.test.tsx
  git commit -m "style(mobile): remove passive inventory counts"
  ```

### Task 2: Run the repository verification gates and inspect the final diff

**Files:**
- Verify: `apps/mobile/src/features/decks/DeckListScreen.tsx`
- Verify: `apps/mobile/src/features/decks/DeckDetailScreen.tsx`
- Verify: `apps/mobile/src/features/notes/NoteScreen.tsx`
- Verify: `apps/mobile/__tests__/deck-list-screen.test.tsx`
- Verify: `apps/mobile/__tests__/deck-detail-screen.test.tsx`
- Verify: `apps/mobile/__tests__/note-screen.test.tsx`
- Verify: `apps/mobile/__tests__/today-screen.test.tsx`
- Verify: `apps/mobile/__tests__/review-screen.test.tsx`

**Interfaces:**
- Consumes: The completed presentation-only screen updates and focused regression tests.
- Produces: Evidence that the mobile app remains buildable and its checks pass without whitespace errors.

- [ ] **Step 1: Run the full repository test suite**

  Run:

  ```bash
  deno task test
  ```

  Expected: PASS.

- [ ] **Step 2: Run formatting and type checks**

  Run:

  ```bash
  deno fmt --check apps/mobile/src/features/decks/DeckListScreen.tsx apps/mobile/src/features/decks/DeckDetailScreen.tsx apps/mobile/src/features/notes/NoteScreen.tsx apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/today-screen.test.tsx apps/mobile/__tests__/review-screen.test.tsx
  deno task check
  ```

  Expected: PASS.

- [ ] **Step 3: Run the production Android build**

  Run:

  ```bash
  deno task build
  ```

  Expected: PASS. The root `build` task delegates to `build:android`.

- [ ] **Step 4: Check whitespace and review the final scope**

  Run:

  ```bash
  git diff --check HEAD~1..HEAD
  git show --check --stat --oneline HEAD
  git status --short
  ```

  Expected: no whitespace errors; the implementation commit contains only the three screen edits and their focused tests; no unrelated working-tree changes are present.
