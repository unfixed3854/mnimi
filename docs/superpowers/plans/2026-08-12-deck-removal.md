# Deck Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users permanently delete an owned deck and all of its contents from the deck list or detail screen after explicit confirmation.

**Architecture:** Add one ownership-scoped oRPC mutation and use the database's existing foreign-key cascades for atomic row deletion. Collect media paths before deletion and clean them up through injected, best-effort filesystem helpers afterward. Expose the mutation through one React Query hook and one shared confirmation component used by both deck routes.

**Tech Stack:** Deno tasks, TypeScript, oRPC, Drizzle/SQLite, React 19, TanStack Query/Router, Base UI Dialog, Vitest, Testing Library.

## Global Constraints

- Use `deno` for all package management and script execution; never use npm, npx, yarn, or pnpm.
- Removal is permanent and includes notes, cards, review history, active drafts, and stored media owned by the deck.
- Missing and foreign-owned deck ids must be indistinguishable to callers.
- Do not report a failed removal after the database deletion has committed solely because best-effort media cleanup failed.

---

### Task 1: Ownership-scoped cascading server deletion

**Files:**
- Modify: `server/router/decks.test.ts`
- Modify: `server/router/decks.ts`
- Modify: `server/router/base.ts`
- Modify: `server/images.ts`
- Modify: `server/audio.ts`

**Interfaces:**
- Consumes: existing `AppContext`, `decks`, `notes`, `cards`, `reviewLogs`, and `drafts` tables.
- Produces: `decksRouter.remove`, accepting `{ deckId: string }` and resolving to `{ id: string }`; optional `AppContext.removeImage(path)` and `AppContext.removeAudio(path)` test seams; exported `removeImage(path)` and `removeAudio(path)` helpers.

- [ ] **Step 1: Write failing server tests**

Add focused `decks.remove` tests that seed a deck with a note, card, review log,
and draft through the real database, then assert all five table rows disappear.
Add separate tests proving the following behavior:

```ts
await expect(call(decksRouter.remove, { deckId: bobDeck.id }, {
  context: ada.context,
})).rejects.toMatchObject({ code: "NOT_FOUND" });

await expect(call(decksRouter.remove, { deckId: uuidv7() }, {
  context: ada.context,
})).rejects.toMatchObject({ code: "NOT_FOUND" });
```

For media cleanup, set known `note.imagePath`, `card.audioPath`, and
`draft.draftImageId`, inject spies through the context, and assert only those
owned paths are passed. Add a cleanup spy that rejects and assert the mutation
still resolves and the deck row remains deleted.

- [ ] **Step 2: Run the server test and verify RED**

Run: `deno task test -- server/router/decks.test.ts`

Expected: FAIL because `decksRouter.remove` does not exist.

- [ ] **Step 3: Add filesystem deletion helpers and context seams**

In `server/images.ts`, export a path-based helper that resolves under
`IMAGES_DIR`, ignores `Deno.errors.NotFound`, and rejects other errors. In
`server/audio.ts`, add the equivalent under `AUDIO_DIR`:

```ts
export async function removeImage(relativePath: string): Promise<void>;
export async function removeAudio(relativePath: string): Promise<void>;
```

Add matching optional functions to `AppContext`. Relative paths come only from
database rows or the server-generated draft path; no client-supplied path is
accepted.

- [ ] **Step 4: Implement the minimal remove procedure**

Select the owned deck and its note/card media paths before deletion. If no owned
deck exists, throw `notFound("Deck not found")`. Delete with both predicates:

```ts
await context.db.delete(decks).where(and(
  eq(decks.id, input.deckId),
  eq(decks.userId, context.userId),
));
```

After the delete resolves, run cleanup with `Promise.allSettled`, using injected
helpers when present and logging rejected cleanup results. Include the draft
image as `drafts/<userId>/<draftImageId>.png` only when `draftImageId` is not
null. Return `{ id: input.deckId }` and export `remove` from `decksRouter`.

- [ ] **Step 5: Run the server test and verify GREEN**

Run: `deno task test -- server/router/decks.test.ts`

Expected: PASS with no unhandled rejection or warning.

- [ ] **Step 6: Commit the server slice**

```bash
git add server/router/decks.ts server/router/decks.test.ts server/router/base.ts server/images.ts server/audio.ts
git commit -m "feat(decks): remove owned decks and contents"
```

---

### Task 2: Client mutation and reusable confirmation dialog

**Files:**
- Create: `src/components/ui/alert-dialog.tsx`
- Create: `src/components/deck-remove-dialog.tsx`
- Create: `src/components/deck-remove-dialog.test.tsx`
- Modify: `src/lib/api/decks.ts`

**Interfaces:**
- Consumes: `decksRouter.remove` through generated `orpc.decks.remove`, Base UI's Dialog primitive, and React Query's query client.
- Produces: `useRemoveDeck()` and `DeckRemoveDialog({ deck, trigger, onRemoved? })`.

- [ ] **Step 1: Write failing component tests**

Mock `useRemoveDeck` and render the shared component with a labeled and an icon
trigger. Test the observable behavior:

```tsx
await user.click(screen.getByRole("button", { name: "Delete German" }));
expect(screen.getByRole("dialog")).toHaveTextContent("German");
expect(screen.getByRole("dialog")).toHaveTextContent(
  /notes, cards, review history, and active draft/i,
);

await user.click(screen.getByRole("button", { name: "Cancel" }));
expect(removeMutateAsync).not.toHaveBeenCalled();
```

Also assert confirm calls `mutateAsync({ deckId: deck.id })`, pending state
disables confirm, success calls `onRemoved`, and rejection leaves the dialog
open with an error and permits retry.

- [ ] **Step 2: Run the component test and verify RED**

Run: `deno task test -- src/components/deck-remove-dialog.test.tsx`

Expected: FAIL because the shared component does not exist.

- [ ] **Step 3: Build the minimal alert-dialog primitives**

Wrap `@base-ui/react/dialog` in local `AlertDialog`, `AlertDialogTrigger`,
`AlertDialogContent`, `AlertDialogTitle`, `AlertDialogDescription`, and footer
exports. Match the existing `sheet.tsx` portal, focus, backdrop, and transition
patterns, but render a centered destructive confirmation surface.

- [ ] **Step 4: Add the remove hook**

Implement `useRemoveDeck` with `orpc.decks.remove.mutationOptions`. On success,
invalidate `orpc.decks.key()`, `orpc.notes.key()`, `orpc.cards.key()`, and
`draftsKey()`. Await the invalidations so callers navigate only after cache
refresh has begun.

- [ ] **Step 5: Implement the shared dialog**

The component accepts:

```ts
type DeckRemoveDialogProps = {
  deck: Pick<Deck, "id" | "name">;
  trigger: React.ReactElement;
  onRemoved?: () => void | Promise<void>;
};
```

Use a controlled open state, reset stale mutation errors when opening, prevent
closing while pending, and call `onRemoved` only after `mutateAsync` succeeds.
Use the exact warning copy from the design and render mutation errors inside a
destructive `Alert`.

- [ ] **Step 6: Run the component test and verify GREEN**

Run: `deno task test -- src/components/deck-remove-dialog.test.tsx`

Expected: PASS without Base UI accessibility warnings.

- [ ] **Step 7: Commit the reusable client slice**

```bash
git add src/components/ui/alert-dialog.tsx src/components/deck-remove-dialog.tsx src/components/deck-remove-dialog.test.tsx src/lib/api/decks.ts
git commit -m "feat(decks): add removal confirmation"
```

---

### Task 3: Wire removal into both deck screens

**Files:**
- Create: `src/routes/-_authed.decks.test.tsx`
- Modify: `src/routes/_authed.decks.index.tsx`
- Modify: `src/routes/_authed.decks.$deckId.tsx`

**Interfaces:**
- Consumes: `DeckRemoveDialog` and its `onRemoved` callback.
- Produces: list-row and detail-page entry points for deck removal.

- [ ] **Step 1: Write failing route tests**

Mock deck queries and the shared dialog at the route boundary. For the list,
assert each row exposes `Delete <deck name>` and clicking it invokes the dialog
trigger without activating the deck link. For detail, assert a visible `Delete
deck` action is passed to the dialog. Simulate successful removal and assert the
detail page calls router navigation with `{ to: "/decks" }`; assert failure does
not navigate (the shared component owns the displayed error).

- [ ] **Step 2: Run the route test and verify RED**

Run: `deno task test -- src/routes/-_authed.decks.test.tsx`

Expected: FAIL because neither route renders a removal control.

- [ ] **Step 3: Add the list entry point**

Restructure each list item as a positioned flex row where the deck `Link`
remains the primary expanding target and a sibling icon button opens
`DeckRemoveDialog`. Give the button `aria-label={\`Delete ${deck.name}\`}` and a
`Trash2` icon. Because it is a sibling rather than nested inside the link, it
cannot navigate into the deck.

- [ ] **Step 4: Add the detail entry point and navigation**

Render the shared dialog below the primary review action with a destructive
`Delete deck` trigger. Use `Route.useNavigate()` and pass
`onRemoved={() => navigate({ to: "/decks" })}`. Do not navigate before the
mutation resolves.

- [ ] **Step 5: Run route and component tests**

Run: `deno task test -- src/routes/-_authed.decks.test.tsx src/components/deck-remove-dialog.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the route integration**

```bash
git add src/routes/-_authed.decks.test.tsx src/routes/_authed.decks.index.tsx 'src/routes/_authed.decks.$deckId.tsx'
git commit -m "feat(decks): expose removal on deck screens"
```

---

### Task 4: Generated types and full verification

**Files:**
- Modify if generated: `src/routeTree.gen.ts`

**Interfaces:**
- Consumes: all completed feature slices.
- Produces: a verified build and test suite.

- [ ] **Step 1: Generate routes and type-check/build**

Run: `deno task routes:generate`

Run: `deno task build`

Expected: both commands exit 0 with no TypeScript or route-generation errors.

- [ ] **Step 2: Run the full test suite**

Run: `deno task test`

Expected: all tests pass with no unhandled errors or accessibility warnings.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff HEAD~3 --check`

Run: `git status --short`

Confirm that only the planned feature, tests, plan, spec, and generated route
artifact changed, and that no unrelated user changes are included.

- [ ] **Step 4: Commit generated artifacts or verification fixes**

If route generation changed a tracked artifact or verification required a
small focused fix, stage only those files and commit:

```bash
git add src/routeTree.gen.ts
git commit -m "chore: refresh generated routes"
```

If there is no generated diff, do not create an empty commit.
