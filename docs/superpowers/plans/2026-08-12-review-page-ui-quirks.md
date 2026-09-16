# Review Page UI Quirks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make review transitions discard the previous card's revealed UI, remove the amber card glow, and add deliberate spacing above pronunciation playback.

**Architecture:** Keep the server-backed due queue and grade mutation unchanged. Scope reveal state to the active card ID and key the active review subtree by that ID, while relying on the shared `Card` surface styling and a route-local spacing wrapper.

**Tech Stack:** React 19, TanStack Query, TanStack Router, Tailwind CSS 4, Vitest, Testing Library, Deno tasks

## Global Constraints

- Use `deno` for every package-management and script command.
- Do not change server, schema, FSRS scheduling, query invalidation, or pronunciation playback behavior.
- Preserve a revealed card after a grade failure so the same rating can be retried.
- Keep pronunciation spacing local to the review page.

---

### Task 1: Review-card surface and pronunciation spacing

**Files:**
- Modify: `src/routes/-routes.test.ts`
- Modify: `src/components/image-cue-review-card.test.tsx`
- Modify: `src/routes/_authed.review.$deckId.tsx`
- Modify: `src/components/image-cue-review-card.tsx`

**Interfaces:**
- Consumes: the shared `Card` default ring and the existing mocked `PronunciationControl` test element.
- Produces: prompt cards without a primary-colored shadow and a review-only `mt-6` pronunciation wrapper.

- [ ] **Step 1: Write failing visual regression assertions**

In `src/components/image-cue-review-card.test.tsx`, extend the initial prompt test with assertions against the rendered card surface:

```tsx
const prompt = container.querySelector('[data-slot="card"]') as HTMLElement;
expect(prompt.className).not.toContain("shadow-[");
expect(prompt.className).not.toContain("ring-0");
```

Capture `container` from `render` for that test. In `src/routes/-routes.test.ts`, add an ordinary review test that renders and reveals the card, then asserts:

```tsx
const prompt = container.querySelector('[data-slot="card"]') as HTMLElement;
expect(prompt.className).not.toContain("shadow-[");
expect(prompt.className).not.toContain("ring-0");

const control = screen.getByTestId("pronunciation-control");
expect(control.parentElement?.className).toContain("mt-6");
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
deno task test src/routes/-routes.test.ts src/components/image-cue-review-card.test.tsx
```

Expected: FAIL because prompt cards still include the arbitrary primary shadow and `ring-0`, and the pronunciation control has no `mt-6` parent.

- [ ] **Step 3: Implement the minimal styling change**

In both review renderers, replace:

```tsx
<Card className="ring-0 shadow-[0_12px_32px_-16px_var(--primary)]">
```

with:

```tsx
<Card>
```

In the review route, wrap the pronunciation control without changing the reusable component:

```tsx
<div className="mt-6">
  <PronunciationControl key={card.id} card={card} autoplay={autoplay} />
</div>
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
deno task test src/routes/-routes.test.ts src/components/image-cue-review-card.test.tsx
```

Expected: both test files PASS with no warnings.

- [ ] **Step 5: Commit the visual fixes**

```bash
git add src/routes/-routes.test.ts src/components/image-cue-review-card.test.tsx src/routes/_authed.review.\$deckId.tsx src/components/image-cue-review-card.tsx
git commit -m "fix(ui): refine review card presentation"
```

---

### Task 2: Card-identity-scoped reveal state

**Files:**
- Modify: `src/routes/-routes.test.ts`
- Modify: `src/routes/_authed.review.$deckId.tsx`

**Interfaces:**
- Consumes: `card.id`, the existing server-backed `cards[0]` queue position, and `grade.mutateAsync`.
- Produces: `revealedCardId: string | null`, a derived `revealed` boolean, and an active-card subtree keyed by `card.id`.

- [ ] **Step 1: Write the failing transition regression test**

Import `act` from Testing Library. Add a route test that keeps the grade promise unresolved while the mocked due query advances:

```tsx
it("hides and replaces the previous review as soon as the active card changes", async () => {
  sessionMock.mockReturnValue({ user: { ttsAutoplay: true } });
  let dueCards = [
    REVIEW_CARD,
    {
      ...REVIEW_CARD,
      id: "card-2",
      noteId: "note-2",
      front: "Die Banane ist gelb.",
      back: "The banana is yellow.",
    },
  ];
  dueCardsMock.mockImplementation(() => ({
    data: dueCards,
    isLoading: false,
    isError: false,
    error: null,
  }));

  let finishGrade!: () => void;
  const pendingGrade = new Promise<undefined>((resolve) => {
    finishGrade = () => resolve(undefined);
  });
  gradeMock.mockReturnValue(pendingGrade);

  const view = renderReview();
  fireEvent.click(screen.getByRole("button", { name: "Show answer" }));
  fireEvent.click(screen.getByRole("button", { name: "Good" }));

  dueCards = dueCards.slice(1);
  view.rerender(createElement(ReviewPage));

  expect(screen.getByText("Die Banane ist gelb.")).toBeTruthy();
  expect(screen.queryByText("I eat a banana.")).toBeNull();
  expect(screen.queryByTestId("pronunciation-control")).toBeNull();
  expect(screen.getByRole("button", { name: "Show answer" })).toBeTruthy();
  expect(view.container.querySelectorAll('[data-slot="card"]')).toHaveLength(1);

  await act(async () => {
    finishGrade();
    await pendingGrade;
  });
});
```

- [ ] **Step 2: Run the route test and verify RED**

Run:

```bash
deno task test src/routes/-routes.test.ts
```

Expected: FAIL because the card-independent `revealed` boolean exposes the second card's answer and pronunciation control while the grade promise is pending.

- [ ] **Step 3: Scope reveal state and the rendered subtree to card identity**

Replace the boolean state with:

```tsx
const [revealedCardId, setRevealedCardId] = useState<string | null>(null);
```

After resolving `card`, derive:

```tsx
const revealed = revealedCardId === card.id;
```

Update every reveal callback to call `setRevealedCardId(card.id)`, and clear it only after a successful grade with `setRevealedCardId(null)`. Insert this opening element immediately before the existing `card.imageCue` branch:

```tsx
<div key={card.id}>
```

Insert its closing `</div>` immediately after the existing revealed rating
grid. The prompt branch, pronunciation control, and rating grid must all be
children of this keyed element.

Do not clear `revealedCardId` in the mutation failure branch.

- [ ] **Step 4: Run the route test and verify GREEN**

Run:

```bash
deno task test src/routes/-routes.test.ts
```

Expected: PASS, including the existing ordinary and image-cued pronunciation lifecycle cases.

- [ ] **Step 5: Commit the transition fix**

```bash
git add src/routes/-routes.test.ts src/routes/_authed.review.\$deckId.tsx
git commit -m "fix(review): scope revealed state to active card"
```

---

### Task 3: Full verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: all changes from Tasks 1 and 2.
- Produces: evidence that tests, types, route generation, and production bundling remain healthy.

- [ ] **Step 1: Run the complete test suite**

```bash
deno task test
```

Expected: all test files and tests PASS with no failures.

- [ ] **Step 2: Run the production build**

```bash
deno task build
```

Expected: route generation, TypeScript checking, and the Vite production build complete successfully.

- [ ] **Step 3: Inspect the final diff**

```bash
git diff HEAD~2 --check
git status --short
git log -3 --oneline
```

Expected: no whitespace errors; only the approved spec, plan, tests, and review-page implementation are changed; the worktree is clean after the implementation commits.
