# Create a deck from the "Add a card" deck selection

Let a user create a deck without leaving `/add`, by adding a "+ New deck…"
entry to the deck picker and an inline name field behind it. GitHub issue
#15.

## Problem

`_authed.add.tsx` requires a deck before it will generate anything — the
Generate button is `disabled={!text.trim() || !deckId}`. The only control
offered is a `Select` over `useDecks()`, and the only way to create a deck
is `_authed.decks.index.tsx`.

Two consequences:

- **A new user is stuck.** With no decks, the `Select` has no items. There
  is nothing to pick, no hint that decks are the missing piece, and no way
  forward from this screen.
- **Wanting a new deck costs the page.** A user who decides mid-capture that
  this card belongs in a new deck has to navigate to `/decks`, create it,
  and come back — losing whatever they had typed.

The server side already exists: `decks.create` (`server/router/decks.ts`)
takes `{ name, description? }` and returns the inserted deck, and
`useCreateDeck` (`src/lib/api/decks.ts`) wraps it. This is a client-side UI
gap only.

## Approach

Extract the picker into `src/components/deck-picker.tsx`, a presentational
component that owns both modes — selecting an existing deck and creating a
new one — and give it the create affordance.

`_authed.add.tsx` keeps the data wiring and passes it down:

```tsx
<DeckPicker
  decks={decks}
  value={deckId}
  onValueChange={setPicked}
  onCreate={(name) => createDeck.mutateAsync({ name })}
  creating={createDeck.isPending}
  error={
    createDeck.error instanceof Error
      ? createDeck.error.message
      : createDeck.isError
        ? "Failed to create deck"
        : null
  }
/>
```

Two reasons for the extraction. `_authed.add.tsx` is already ~330 lines
carrying generation, draft-image, and save flows; a mode-switching picker
does not belong inline in it. And a props-only component is directly
testable with React Testing Library without query-client scaffolding, which
is how components are tested in this repo (`auth-form.test.tsx`,
`page.test.tsx`, `generated-image.test.tsx`).

The `deckId` derivation added by the preselect work
(`2026-08-08-add-card-preselect-deck-design.md`) is unchanged:

```ts
const [picked, setPicked] = useState<string | null>(null);
const candidate = picked ?? search.deckId ?? "";
const deckId = decks?.some((deck) => deck.id === candidate) ? candidate : "";
```

It keeps doing its job here, and incidentally neutralizes the sentinel value
below: an id absent from `decks` can never resolve into `deckId`.

### 1. Modes

`DeckPicker` holds one piece of state and derives the rest:

```ts
const [creating, setCreating] = useState(false);
const noDecks = decks?.length === 0;
const showCreator = creating || noDecks;
```

Deriving rather than storing the zero-deck case matters. After the first
deck is created, `noDecks` flips false on its own and `creating` is reset,
so the component returns to select mode without a second reconciliation
step. `decks === undefined` (list still in flight) is deliberately *not*
the zero-deck case — `undefined?.length === 0` is `false`, so a loading
list shows the ordinary placeholder and the creator does not flash open
before the decks arrive.

### 2. Select mode (`!showCreator`)

Today's `Select`, plus one extra item at the end of the list:

```tsx
const NEW_DECK = "__new__";
...
<SelectItem value={NEW_DECK}>+ New deck…</SelectItem>
```

`onValueChange` intercepts it rather than treating it as a deck:

```tsx
onValueChange={(value) => {
  if (value === NEW_DECK) {
    setCreating(true);
    return;
  }
  onValueChange(value ?? "");
}}
```

The sentinel therefore never reaches `picked`, and so never reaches
`deckId`, the `Select`'s own `value`, or the Save payload. Base UI closes
the popup on select, but the `Select` subtree unmounts in the same commit
that opens the creator, so its return-focus logic resolves against a
detached trigger and the interaction does not land in the creator's
input. See "Out of scope" below.

The sentinel is a module-level constant in `deck-picker.tsx`. Deck ids are
server-generated, so `"__new__"` cannot collide with one; the `!== NEW_DECK`
check runs before anything else regardless.

The `items` prop that maps ids to trigger labels keeps listing only real
decks. The sentinel never survives as a value, so no label is ever needed
for it.

### 3. Creator mode (`showCreator`)

A text input in the same slot as the `Select`, inside a `<form>` so Enter
submits — the same pattern `_authed.decks.index.tsx` uses for its create
field:

```tsx
<form onSubmit={(e) => { e.preventDefault(); void handleCreate(); }}>
  <Label htmlFor="new-deck-name">Deck</Label>
  <Input id="new-deck-name" placeholder="New deck name" ... />
  <Button type="submit" disabled={!trimmed || creating}>
    {creating ? "Creating…" : "Create"}
  </Button>
  {!noDecks && (
    <Button type="button" variant="outline" onClick={() => setCreating(false)}>
      Cancel
    </Button>
  )}
</form>
```

**Cancel is rendered only when `!noDecks`.** With zero decks there is
nothing to fall back to — the creator *is* the screen's starting state, so
offering Cancel would put the user back at the dead end this change exists
to remove. Cancel leaves `value` untouched, so a user who opens the creator
with a deck already selected returns to exactly that selection.

On success:

```ts
const deck = await onCreate(trimmed);
onValueChange(deck.id);
setCreating(false);
setName("");
```

Selecting the new deck immediately is safe because `useCreateDeck`'s
`onSuccess` returns the `invalidateQueries` promise, and React Query awaits
`onSuccess` before `mutateAsync` resolves. The list has therefore already
refetched by the time `onValueChange(deck.id)` runs, so `deckId`'s
membership check (`decks?.some(...)`) passes on the same render and the
trigger shows the new deck's name — no placeholder flicker in between.

### 4. Errors

A rejected create renders a destructive `Alert` beneath the input, keeps
creator mode open, and keeps the typed name — discarding what the user
typed on failure is the thing `_authed.decks.index.tsx` explicitly avoids,
and the same reasoning applies here. The rejection is caught locally so it
does not surface as an unhandled rejection; the message itself comes from
the `error` prop, which the route derives from `createDeck`.

Submit is disabled while `creating` is true and whenever the trimmed name is
empty. The name is trimmed before being passed to `onCreate`, matching the
decks page.

## Edge cases

- **Zero decks, list still loading.** `decks` is `undefined`, so `noDecks`
  is `false` and the `Select` shows its placeholder. The creator opens only
  once the list has resolved to an empty array.
- **Last deck deleted in another tab.** On refetch `decks` becomes `[]`,
  `noDecks` flips true, and the creator takes over the slot. Any previously
  selected `deckId` has already resolved to `""` via the membership check,
  so Generate stays disabled — consistent, not contradictory.
- **Sentinel picked twice.** Choosing "+ New deck…" while already in
  creator mode is not reachable: the `Select` is unmounted in that mode.
- **Preselected deck via `?deckId=`.** Unaffected. If the id is valid the
  `Select` shows it; opening and cancelling the creator returns to it,
  because Cancel does not touch `value`.
- **Create succeeds but the name duplicates an existing deck.** Allowed —
  the server imposes no uniqueness constraint on deck names, and this change
  does not add one.

## Out of scope

- **Deck descriptions.** `decks.create` accepts an optional `description`,
  but `_authed.decks.index.tsx` does not collect one either. Adding a second
  field to an inline creator embedded in another form is not worth it here.
- **Editing or deleting decks from `/add`.** Creating is what unblocks the
  capture flow; management belongs on `/decks`.
- **Reusing `DeckPicker` on `_authed.decks.index.tsx`.** That screen's form
  is a different shape (always visible, no selection, part of a list page).
  Forcing one component to serve both would make both worse.
- **Uniqueness or naming rules for decks.** Unchanged from today.
- **Focus management across the mode swap.** Neither transition moves
  focus on purpose. Choosing "+ New deck…" unmounts the `Select` in the
  same commit that mounts the creator, so Base UI's return-focus
  resolves against a detached trigger instead of landing in the name
  field; Cancel has the same problem in reverse, leaving focus off the
  `Select` trigger it returns to. A keyboard user has to Tab to reach the
  name field after choosing "+ New deck…". Fixing this means racing Base
  UI's own return-focus microtask, and nobody could verify the result in
  a browser during this change, so it's left as a follow-up.

## Testing

`src/components/deck-picker.test.tsx`, following the RTL conventions in
`auth-form.test.tsx` (explicit `afterEach(cleanup)` — `vitest.config.ts`
sets neither `globals: true` nor a setup file). Props-only means no query
client and no router context is needed; `onCreate` is a `vi.fn()` returning
a resolved deck.

- With decks and no creator open, the `Select` renders and no name input is
  present.
- With `decks={[]}`, the name input renders immediately and no Cancel button
  is offered.
- With `decks={undefined}` (loading), the `Select` renders, not the creator.
- Choosing "+ New deck…" shows the input and does **not** call
  `onValueChange` — asserting the sentinel never escapes the component.
- Submitting a name calls `onCreate` with the trimmed name; once it
  resolves, `onValueChange` fires with the new deck's id and the `Select`
  returns.
- Cancel returns to the `Select` without calling `onCreate`.
- A non-null `error` prop renders the message and leaves the input mounted
  with its typed value intact.
- An empty or whitespace-only name leaves Create disabled.

`_authed.add.tsx` itself is not render-tested, per this repo's convention
for page components; its route-level `validateSearch` coverage in
`src/routes/-routes.test.ts` is unaffected by this change.
