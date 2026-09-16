# Preselect Deck on Add-Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Add a card" link on an empty deck's page carry that deck into `/add` so it's preselected, instead of dropping the user at a blank deck picker (GitHub issue #14).

**Architecture:** Carry the deck id through a `deckId` search param on `/add`, following the existing `redirect` search-param pattern on `login.tsx`/`signup.tsx` (`validateSearch` + `Route.useSearch()`). `AddPage` seeds its `deckId` state from that param and reconciles it to `""` once the real deck list loads if the id doesn't match anything (stale/deleted deck). The deck detail page's empty-state link passes its own `deckId` on the `Link`.

**Tech Stack:** React 19, TypeScript, TanStack Router (file-based routes, `validateSearch`/`useSearch`), Vitest.

Full design: `docs/superpowers/specs/2026-08-08-add-card-preselect-deck-design.md`.

## Global Constraints

- Search param name is `deckId` (string), on the `/add` route (`_authed.add.tsx`).
- `validateSearch` keeps `deckId` only when it's a `string`; otherwise returns `{}` — same shape as `login.tsx`/`signup.tsx`'s `redirect` param.
- `AddPage`'s deck `Select` stays exactly as editable as it is today — the search param only supplies the *initial* value of `deckId` state, never re-applied after mount.
- If the preselected `deckId` doesn't match any deck once `decks` (from `useDecks()`) has loaded, reset `deckId` back to `""` so the picker falls back to its placeholder.
- Only the deck detail page's empty-state "Add a card" link (`_authed.decks.$deckId.tsx`) passes `deckId`. The nav sidebar's "Add" item (`nav-items.ts`) and the homepage's "Add a card" button (`_authed.index.tsx`) are unchanged — they have no deck in context.
- This repo does not render-test page components (see `README.md`'s "Tests are Vitest over the pure logic and over the server's procedures" and the absence of any `*.test.tsx` under `src/routes/`); route-level `validateSearch`/`beforeLoad` logic is tested directly in `src/routes/-routes.test.ts` by calling `Route.options.<fn>!(...)`. Follow that same pattern for the new `validateSearch` — don't add a render test for `AddPage` or `DeckPage`.
- Verify with `deno task test` (vitest) and `deno task build` (tsr generate + `tsc` + vite build — the project's typecheck), matching CI.

---

### Task 1: `/add` accepts and applies a `deckId` search param

**Files:**
- Modify: `src/routes/_authed.add.tsx`
- Test: `src/routes/-routes.test.ts`

**Interfaces:**
- Produces: `Route.options.validateSearch(search: Record<string, unknown>): { deckId?: string }` on the `/add` route. `AddPage`'s `deckId` state is seeded from `Route.useSearch().deckId ?? ""` and reconciled to `""` in a `useEffect` once `decks` (from the existing `useDecks()` call) has loaded and doesn't contain that id. Consumed by Task 2, which supplies `deckId` on the `Link`'s `search` prop.

- [ ] **Step 1: Write the failing tests**

In `src/routes/-routes.test.ts`, add the import alongside the existing route imports (after the `SignupRoute` import on line 9):

```ts
import { Route as AddRoute } from "@/routes/_authed.add";
```

Add a new `describe` block, e.g. after the `/signup beforeLoad guard` block and before `describe("route directory invariant", ...)`:

```ts
describe("/add validateSearch", () => {
  it("keeps a string deckId", () => {
    expect(AddRoute.options.validateSearch!({ deckId: "deck-1" })).toEqual({
      deckId: "deck-1",
    });
  });

  it("returns nothing when deckId is absent", () => {
    expect(AddRoute.options.validateSearch!({})).toEqual({});
  });

  it("drops a non-string deckId", () => {
    expect(AddRoute.options.validateSearch!({ deckId: 42 })).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test src/routes/-routes.test.ts`
Expected: FAIL — `AddRoute.options.validateSearch` is `undefined` (not a function) because `_authed.add.tsx` doesn't define it yet.

- [ ] **Step 3: Implement the search param and preselection**

In `src/routes/_authed.add.tsx`, change the route definition (currently line 33):

```ts
export const Route = createFileRoute("/_authed/add")({ component: AddPage });
```

to:

```ts
export const Route = createFileRoute("/_authed/add")({
  validateSearch: (search: Record<string, unknown>): { deckId?: string } =>
    typeof search.deckId === "string" ? { deckId: search.deckId } : {},
  component: AddPage,
});
```

Then, inside `AddPage` (currently lines 35-47), read the search param and seed `deckId` from it, and add the reconciling effect. Replace:

```ts
function AddPage() {
  const navigate = useNavigate();
  const { data: decks } = useDecks();
  const session = useSession();
  const saveNote = useSaveNote();

  const [text, setText] = useState("");
  const [deckId, setDeckId] = useState("");
  const [generation, dispatch] = useReducer(
    generationReducer,
    initialGenerationState,
  );
  const abortRef = useRef<AbortController | null>(null);

  // Navigating away mid-generation would otherwise leave the request — and the
  // server's generation running behind it — with nothing left to consume it.
  // Hooks stay unconditional and above the early return below.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);
```

with:

```ts
function AddPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { data: decks } = useDecks();
  const session = useSession();
  const saveNote = useSaveNote();

  const [text, setText] = useState("");
  const [deckId, setDeckId] = useState(search.deckId ?? "");
  const [generation, dispatch] = useReducer(
    generationReducer,
    initialGenerationState,
  );
  const abortRef = useRef<AbortController | null>(null);

  // Navigating away mid-generation would otherwise leave the request — and the
  // server's generation running behind it — with nothing left to consume it.
  // Hooks stay unconditional and above the early return below.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // A deckId carried in from a deck's "Add a card" link (see
  // _authed.decks.$deckId.tsx) can point at a deck that's since been
  // deleted. Once the real list loads, drop an id that isn't in it so the
  // Select falls back to its placeholder instead of holding a value it
  // can't resolve to a label.
  useEffect(() => {
    if (decks && deckId && !decks.some((deck) => deck.id === deckId)) {
      setDeckId("");
    }
  }, [decks, deckId]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test src/routes/-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `deno task build`
Expected: succeeds with no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/routes/_authed.add.tsx src/routes/-routes.test.ts
git commit -m "feat(add): preselect deck via a deckId search param"
```

---

### Task 2: Deck page's empty-state link passes its deck id

**Files:**
- Modify: `src/routes/_authed.decks.$deckId.tsx:140-142`

**Interfaces:**
- Consumes: `/add`'s `deckId` search param from Task 1.

- [ ] **Step 1: Wire the link**

In `src/routes/_authed.decks.$deckId.tsx`, change (currently lines 140-142):

```tsx
<Button render={<Link to="/add" />} className="mt-5">
  Add a card
</Button>
```

to:

```tsx
<Button render={<Link to="/add" search={{ deckId }} />} className="mt-5">
  Add a card
</Button>
```

`deckId` is already in scope here from `const { deckId } = Route.useParams();` at the top of `DeckPage`.

- [ ] **Step 2: Full verification pass**

Run: `deno task test` (whole suite — confirms nothing else regressed)
Run: `deno task build`
Expected: both succeed.

- [ ] **Step 3: Manual smoke check**

Run `deno task dev`, sign in, open a deck with zero notes, click "Add a card", and confirm the deck dropdown on `/add` already shows that deck's name selected (not the "Choose a deck…" placeholder), and that it can still be changed to a different deck. Also confirm the nav sidebar's "Add" item and the homepage's "Add a card" button still land on `/add` with the placeholder unselected.

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authed.decks.\$deckId.tsx
git commit -m "feat(decks): preselect the deck when adding a card from its empty state"
```
