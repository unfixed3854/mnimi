# Preselect deck on "Add a card" from a deck page

Make the "Add a card" link on an empty deck's page carry that deck into
`/add` so it's preselected, instead of dropping the user back at a blank
deck picker. GitHub issue #14.

## Problem

`_authed.decks.$deckId.tsx`'s empty-notes state links to `/add` with no
context:

```tsx
<Button render={<Link to="/add" />} className="mt-5">
  Add a card
</Button>
```

`AddPage` (`_authed.add.tsx`) always starts with `deckId: ""`, so a user who
opened this from inside a deck has to re-pick that same deck from the
dropdown before they can generate anything.

## Approach

Carry the deck id through a `deckId` search param on `/add`, following the
existing `redirect` search-param pattern on `login.tsx`/`signup.tsx`
(`validateSearch` + `Route.useSearch()`).

### 1. `_authed.add.tsx`

Add `validateSearch`:

```ts
validateSearch: (search: Record<string, unknown>): { deckId?: string } =>
  typeof search.deckId === "string" ? { deckId: search.deckId } : {},
```

In `AddPage`, derive `deckId` from the search param, the user's own pick,
and the loaded deck list, instead of a bare `useState("")`:

```ts
const search = Route.useSearch();
const [picked, setPicked] = useState<string | null>(null);
const candidate = picked ?? search.deckId ?? "";
const deckId = decks?.some((deck) => deck.id === candidate) ? candidate : "";
```

`deckId` can only ever be non-empty once `candidate` is confirmed present in
`decks` — so a stale link to a deck that's since been deleted, or `decks`
still being in flight, both resolve straight to `""` (placeholder) rather
than holding an id `Select` can't render a label for. (An earlier version
of this design used `useState(search.deckId ?? "")` plus a `useEffect` that
reconciled it against `decks` after the fact; that let an unvalidated id
sit in state — and be read by the Generate/Save flow — for the render or
two before the effect fired. Deriving `deckId` closes that window instead
of patching it after the fact.)

`onValueChange` calls `setPicked(value ?? "")` rather than setting `deckId`
directly. This only changes the *default* — the `Select` stays exactly as
editable as it is today: once the user picks anything (including clearing
the selection), `picked` becomes a definite string, which short-circuits
the `??` fallback to `search.deckId` for the rest of the session.

### 2. `_authed.decks.$deckId.tsx`

Pass the current deck's id on the empty-state link:

```tsx
<Button render={<Link to="/add" search={{ deckId }} />} className="mt-5">
  Add a card
</Button>
```

### 3. Other entry points — unchanged

The nav sidebar's "Add" item (`nav-items.ts`) and the homepage's "Add a
card" button (`_authed.index.tsx`) keep linking to `/add` with no search
param. Neither has a deck in context, so they keep landing on the blank
picker, as today.

## Edge cases

- **Stale/deleted deck id in the URL** (bookmarked link, deck deleted in
  another tab): `deckId` is derived as `decks?.some((deck) => deck.id ===
  candidate) ? candidate : ""` rather than stored and reconciled after the
  fact, so an id absent from the loaded list resolves straight to `""` —
  the placeholder shows, and the raw id never leaks into the `Select`'s
  `value` or into the Generate/Save flow.
- **`decks` still loading when the page mounts**: also covered by the same
  derivation — `decks?.some(...)` is `undefined` (not `true`) while
  `decks` itself is `undefined`, so `deckId` resolves to `""` and the
  placeholder shows until the list loads and the candidate is confirmed,
  at which point it flips to selected. (An earlier version of this spec
  claimed this case was "no issue" because the raw id would render
  immediately; that undercounted a real bug — Base UI's `Select` renders
  an unresolved value as the raw id string, not the placeholder or a
  deck name. The derivation above is what actually avoids it.)
- **User manually edits the picker after landing with a preselected deck**:
  `onValueChange` calls `setPicked(value ?? "")`, which permanently
  overrides the URL-seeded candidate — the search param only supplies the
  initial value, it isn't re-applied afterward.

## Out of scope

- Wiring a `deckId` search param into the nav/homepage entry points — they
  have no deck context to preselect from.
- Persisting the last-used deck across sessions — this is only about
  carrying context that's already known at the point of navigation.

## Testing

Following this repo's convention (page components aren't render-tested here
— see `git log`'s absence of an `add.test.tsx`/`decks.$deckId.test.tsx`;
route-level `validateSearch`/`beforeLoad` logic is tested directly in
`src/routes/-routes.test.ts`), add cases there for `/add`'s new
`validateSearch`, mirroring the existing `/login` and `/signup` coverage:

- A string `deckId` in `search` is kept.
- A missing `deckId` returns `{}`.
- A non-string `deckId` (e.g. from a malformed URL) is dropped, returning
  `{}`.
