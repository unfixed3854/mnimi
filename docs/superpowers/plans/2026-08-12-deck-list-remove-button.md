# Deck List Remove Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the trash/delete action from the deck list while retaining deck removal on the deck details page.

**Architecture:** Keep the shared `DeckRemoveDialog` and the details-route integration unchanged. Remove only the list route's delete trigger and its icon import, then update the existing route test to encode the new list behavior while preserving detail-page regression coverage.

**Tech Stack:** React, TanStack Router, Vitest, Testing Library, Deno tasks.

## Global Constraints

- Use `deno` for all package management and script execution in this project.
- Do not use `npm`, `npx`, `yarn`, or `pnpm`.
- Deck removal remains available only through the existing details-page `Delete deck` action.

---

### Task 1: Remove the list-page delete entry point

**Files:**
- Modify: `src/routes/-_authed.decks.test.tsx`
- Modify: `src/routes/_authed.decks.index.tsx`

**Interfaces:**
- Consumes: The existing list route's deck links and the existing detail route's shared removal dialog.
- Produces: A deck list with no `Delete <deck name>` buttons, while the detail route continues to expose `Delete deck`.

- [ ] **Step 1: Update the list test to assert the desired behavior**

In the `/decks list removal entry points` test, keep the mocked `LIST_DECKS`
data and render the list page. Replace the two positive button assertions with
these assertions, while keeping the click/link regression focused on the deck
link itself:

```tsx
expect(screen.queryByRole("button", { name: "Delete German" })).toBeNull();
expect(screen.queryByRole("button", { name: "Delete Spanish" })).toBeNull();
expect(screen.getByRole("link", { name: /German/ })).toBeTruthy();
expect(screen.getByRole("link", { name: /Spanish/ })).toBeTruthy();
```

Remove the `fireEvent.click` and `linkClickMock` assertion from that test if
they are no longer used by any remaining test. Leave the detail-route tests
unchanged so they continue checking the retained details-page action and
post-removal navigation.

- [ ] **Step 2: Run the route test and verify it fails for the old behavior**

Run:

```bash
deno task test -- src/routes/-_authed.decks.test.tsx
```

Expected: FAIL in the list test because the current list route still renders
the two delete buttons.

- [ ] **Step 3: Remove the list-only imports and trigger**

In `src/routes/_authed.decks.index.tsx`:

1. Remove `Trash2` from the `lucide-react` import.
2. Remove the `DeckRemoveDialog` import.
3. Delete the `<DeckRemoveDialog ... />` sibling after each deck link.
4. Leave the deck link, row layout, loading/error states, and create-deck flow
   unchanged.

The row should retain only the expanding link inside its flex container:

```tsx
<div className="flex items-center gap-1">
  <Link
    to="/decks/$deckId"
    params={{ deckId: deck.id }}
    className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl px-4 py-4 font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-accent"
  >
    <span className="truncate">{deck.name}</span>
    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
  </Link>
</div>
```

- [ ] **Step 4: Run the focused route tests and verify they pass**

Run:

```bash
deno task test -- src/routes/-_authed.decks.test.tsx
```

Expected: PASS for the list assertions and the unchanged detail-page removal
regression tests.

- [ ] **Step 5: Run the build and inspect the diff**

Run:

```bash
deno task build
git diff --check
git diff -- src/routes/-_authed.decks.test.tsx src/routes/_authed.decks.index.tsx
```

Expected: The build exits successfully, `git diff --check` reports no
whitespace errors, and the diff contains only the list test expectation change
and removal of the list-page delete control/imports. The detail route and
shared dialog are unchanged.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/routes/-_authed.decks.test.tsx src/routes/_authed.decks.index.tsx
git commit -m "fix(decks): remove delete action from deck list"
```
