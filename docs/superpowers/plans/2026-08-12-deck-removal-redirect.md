# Deck Removal Redirect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redirect successful deck-detail deletion to `/decks`, replacing the deleted route before cache invalidation can render missing-deck content.

**Architecture:** Give `useRemoveDeck` an optional async success callback and await it before invalidating related caches. `DeckRemoveDialog` supplies its existing `onRemoved` callback, while the detail route implements that callback with history-replacing navigation.

**Tech Stack:** TypeScript, React, TanStack Router, TanStack Query, Vitest, Testing Library, Deno tasks

## Global Constraints

- Keep the existing missing-deck explanation for direct stale URLs.
- Failed deletion leaves the dialog open and does not navigate.
- Successful detail deletion navigates to `/decks` with history replacement before cache invalidation.
- Use `deno` for every package-management and script command.

## File Structure

- Create `src/lib/api/decks.test.ts` for removal-hook sequencing coverage.
- Modify `src/lib/api/decks.ts` to sequence an optional success callback before invalidation.
- Modify `src/components/deck-remove-dialog.tsx` and its test to wire that callback through the hook.
- Modify `src/routes/_authed.decks.$deckId.tsx` and `src/routes/-_authed.decks.test.tsx` to require history replacement.

---

### Task 1: Sequence navigation before cache invalidation

**Files:**
- Create: `src/lib/api/decks.test.ts`
- Modify: `src/lib/api/decks.ts`
- Modify: `src/components/deck-remove-dialog.tsx`
- Modify: `src/components/deck-remove-dialog.test.tsx`

**Interfaces:**
- Consumes: `QueryClient`, `QueryClientProvider`, and `DeckRemoveDialogProps.onRemoved?: () => void | Promise<void>`
- Produces: `useRemoveDeck(onSuccess?: () => void | Promise<void>)`, awaiting `onSuccess` before invalidating deck, note, card, and draft queries

- [ ] **Step 1: Write the failing hook-order regression test**

Create `src/lib/api/decks.test.ts` with a real `QueryClient` and mocked RPC boundary. The central test body is:

```tsx
it("completes its success callback before invalidating deck-related caches", async () => {
  mutationMock.mockResolvedValue({ id: "deck-1" });
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  for (const key of [decksKey, notesKey, cardsKey, draftsQueryKey]) {
    queryClient.setQueryData(key, [{ id: "cached" }]);
  }

  let finishNavigation!: () => void;
  const navigationFinished = new Promise<void>((resolve) => {
    finishNavigation = resolve;
  });
  const onSuccess = vi.fn(() => navigationFinished);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(() => useRemoveDeck(onSuccess), { wrapper });

  const removal = result.current.mutateAsync({ deckId: "deck-1" });
  await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));

  for (const key of [decksKey, notesKey, cardsKey, draftsQueryKey]) {
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  }

  finishNavigation();
  await removal;

  for (const key of [decksKey, notesKey, cardsKey, draftsQueryKey]) {
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  }
});
```

Mock `orpc.decks.remove.mutationOptions` by combining `mutationFn: mutationMock` with the supplied options. Provide literal keys for `orpc.decks.key()`, `orpc.notes.key()`, `orpc.cards.key()`, and mocked `draftsKey()`. The production changes caught are omitting the callback or invalidating before it completes.

- [ ] **Step 2: Run the hook test and verify RED**

Run: `deno task test -- src/lib/api/decks.test.ts`

Expected: FAIL because `useRemoveDeck` accepts no callback and invalidates immediately.

- [ ] **Step 3: Implement minimal callback sequencing**

Change `src/lib/api/decks.ts` to:

```ts
export function useRemoveDeck(
  onSuccess?: () => void | Promise<void>,
) {
  const queryClient = useQueryClient();

  return useMutation(
    orpc.decks.remove.mutationOptions({
      onSuccess: async () => {
        await onSuccess?.();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
          queryClient.invalidateQueries({ queryKey: draftsKey() }),
        ]);
      },
    }),
  );
}
```

In `src/components/deck-remove-dialog.tsx`, use `useRemoveDeck(onRemoved)` and remove `await onRemoved?.()` after `mutateAsync`. Update the hook double in `deck-remove-dialog.test.tsx` to accept the callback and await it after `removeMutateAsync` resolves, preserving the existing success, failure, retry, and pending assertions.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `deno task test -- src/lib/api/decks.test.ts src/components/deck-remove-dialog.test.tsx`

Expected: both files PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/api/decks.test.ts src/lib/api/decks.ts src/components/deck-remove-dialog.tsx src/components/deck-remove-dialog.test.tsx
git commit -m "fix(decks): sequence removal redirect before cache refresh"
```

---

### Task 2: Replace the deleted detail route in browser history

**Files:**
- Modify: `src/routes/-_authed.decks.test.tsx`
- Modify: `src/routes/_authed.decks.$deckId.tsx`

**Interfaces:**
- Consumes: `DeckRemoveDialogProps.onRemoved` and `Route.useNavigate()`
- Produces: `navigate({ to: "/decks", replace: true })` after successful detail deletion

- [ ] **Step 1: Tighten the existing route regression test**

Replace its navigation expectation with:

```ts
expect(navigateMock).toHaveBeenCalledWith({
  to: "/decks",
  replace: true,
});
```

The production change caught is omitting history replacement, which lets Back reopen the deleted URL.

- [ ] **Step 2: Run the route test and verify RED**

Run: `deno task test -- src/routes/-_authed.decks.test.tsx`

Expected: FAIL because the route currently supplies only `{ to: "/decks" }`.

- [ ] **Step 3: Implement history-replacing navigation**

In `src/routes/_authed.decks.$deckId.tsx`, use:

```tsx
onRemoved={() => navigate({ to: "/decks", replace: true })}
```

- [ ] **Step 4: Run the route test and verify GREEN**

Run: `deno task test -- src/routes/-_authed.decks.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run `deno task test`, followed by `deno task build`.

Expected: all Vitest tests pass and the production build completes without type or route-generation errors.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/routes/-_authed.decks.test.tsx 'src/routes/_authed.decks.$deckId.tsx'
git commit -m "fix(decks): replace deleted detail route"
```
