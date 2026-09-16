# Create a deck from the "Add a card" picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user create a deck without leaving `/add`, via a "+ New deck…" entry in the deck picker that swaps the picker for an inline name field.

**Architecture:** Extract the deck `Select` out of `src/routes/_authed.add.tsx` into a new presentational component `src/components/deck-picker.tsx` that owns two modes — pick an existing deck, or create one. The route keeps all data wiring (`useDecks`, `useCreateDeck`) and passes it down as props, so the component is testable with React Testing Library without a query client. Three tasks: extract (behaviour unchanged), wire the route to the extraction (behaviour unchanged), then add the create affordance.

**Tech Stack:** React 19, TypeScript, TanStack Router + Query, Base UI `Select` (via `src/components/ui/select.tsx`), Tailwind, Vitest + jsdom + `@testing-library/react`, Deno as the task runner.

**Spec:** `docs/superpowers/specs/2026-08-08-add-card-create-deck-design.md`. GitHub issue #15.

## Global Constraints

- **Use `deno` for every command.** Never `npm`, `npx`, `yarn`, or `pnpm` (`AGENTS.md`).
- Tests run with `deno task test` (`vitest run`). Typecheck/build is `deno task build`; server typecheck is `deno task check:api`. These are exactly what CI runs (`.github/workflows/ci.yml`).
- `vitest.config.ts` sets neither `globals: true` nor a setup file, so every test file imports its Vitest helpers explicitly and registers `afterEach(cleanup)` itself. Follow `src/components/auth-form.test.tsx`.
- `@testing-library/user-event` is **not** installed. Use `fireEvent` from `@testing-library/react`.
- **Base UI `Select` options do not respond to a bare `fireEvent.click`.** Selecting an option in jsdom requires `pointerDown` → `pointerUp` → `click` on the option element. This was verified empirically against this repo's `Select`; a bare `click` silently does nothing, which would make a "was not called" assertion pass for the wrong reason. Every option-selecting test in this plan uses the three-event sequence via a shared helper.
- Do not change `server/router/decks.ts` or `src/lib/api/decks.ts` — `decks.create` and `useCreateDeck` already do what is needed.
- Deck names are trimmed before submission and may duplicate an existing deck's name. No uniqueness rule is being added.

---

### Task 1: Extract `DeckPicker` (select mode only)

Move the existing deck `Select` into its own component, with no behaviour change and no create affordance yet. The route is not touched in this task — the component is written and tested standalone, so this task's tests are the whole gate.

**Files:**
- Create: `src/components/deck-picker.tsx`
- Test: `src/components/deck-picker.test.tsx`

**Interfaces:**
- Consumes: `Deck` type from `@/lib/api/decks` (re-exported from `~server/db/schema`; fields `id: string`, `userId: string`, `name: string`, `description: string | null`, `createdAt: Date`). The `Select` family from `@/components/ui/select`.
- Produces: `DeckPicker({ decks, value, onValueChange })` where `decks: Deck[] | undefined`, `value: string`, `onValueChange: (deckId: string) => void`. Task 2 renders it; Task 3 extends its props.

- [ ] **Step 1: Write the failing test**

Create `src/components/deck-picker.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeckPicker } from "@/components/deck-picker";
import type { Deck } from "@/lib/api/decks";

// vitest.config.ts sets neither `globals: true` nor a setup file, so
// @testing-library/react never registers its automatic afterEach cleanup.
afterEach(cleanup);

function makeDeck(id: string, name: string): Deck {
  return {
    id,
    userId: "user-1",
    name,
    description: null,
    createdAt: new Date(0),
  };
}

const GERMAN = makeDeck("deck-1", "German");
const PHARMA = makeDeck("deck-2", "Pharmacology");

function renderPicker(props: Partial<Parameters<typeof DeckPicker>[0]> = {}) {
  const onValueChange = vi.fn();
  render(
    <DeckPicker
      decks={[GERMAN, PHARMA]}
      value=""
      onValueChange={onValueChange}
      {...props}
    />,
  );
  return { onValueChange };
}

async function openPicker() {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox"));
  });
}

// Base UI's Select ignores a bare click on an option in jsdom — it commits a
// selection off the pointer sequence. Firing all three is what actually
// selects, so a "did not call" assertion elsewhere means something.
async function chooseOption(name: string) {
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
    fireEvent.click(option, { button: 0, detail: 1 });
  });
}

describe("DeckPicker", () => {
  it("shows the placeholder when nothing is selected", () => {
    renderPicker();

    expect(screen.getByRole("combobox").textContent).toContain(
      "Choose a deck…",
    );
  });

  it("shows the selected deck's name, not its id", () => {
    renderPicker({ value: GERMAN.id });

    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).toContain("German");
    expect(trigger.textContent).not.toContain(GERMAN.id);
  });

  it("shows the placeholder while the deck list is still loading", () => {
    renderPicker({ decks: undefined });

    expect(screen.getByRole("combobox").textContent).toContain(
      "Choose a deck…",
    );
  });

  it("reports the chosen deck's id", async () => {
    const { onValueChange } = renderPicker();

    await openPicker();
    await chooseOption("Pharmacology");

    expect(onValueChange).toHaveBeenCalledWith(PHARMA.id);
  });

  it("labels the control", () => {
    renderPicker();

    expect(screen.getByText("Deck")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno task test src/components/deck-picker.test.tsx
```

Expected: FAIL — `Failed to resolve import "@/components/deck-picker"`.

- [ ] **Step 3: Write the implementation**

Create `src/components/deck-picker.tsx`. This is the markup currently inline in `src/routes/_authed.add.tsx:129-156`, moved verbatim:

```tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { Deck } from "@/lib/api/decks";

/**
 * The deck control on the "Add a card" screen. Presentational on purpose —
 * the route owns `useDecks`, so this renders from props alone and can be
 * tested without a query client.
 */
export function DeckPicker({
  decks,
  value,
  onValueChange,
}: {
  decks: Deck[] | undefined;
  value: string;
  onValueChange: (deckId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="deck">Deck</Label>
      {/* Base UI represents "nothing selected yet" as null, which is what
          renders the placeholder — the caller passes "" for that case.
          `items` maps the deck id onto its name for the trigger label; without
          it the trigger renders the raw id. */}
      <Select
        items={decks?.map((deck) => ({ value: deck.id, label: deck.name }))}
        value={value || null}
        onValueChange={(next) => onValueChange(next ?? "")}
      >
        <SelectTrigger id="deck" className="w-full">
          <SelectValue placeholder="Choose a deck…" />
        </SelectTrigger>
        <SelectContent>
          {decks?.map((deck) => (
            <SelectItem key={deck.id} value={deck.id}>
              {deck.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
deno task test src/components/deck-picker.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/deck-picker.tsx src/components/deck-picker.test.tsx
git commit -m "refactor(add): extract the deck Select into a DeckPicker component"
```

---

### Task 2: Render `DeckPicker` from the add-card route

Swap the inline `Select` for the extracted component. Nothing a user can see changes; this is the checkpoint that proves the extraction is faithful before any new behaviour lands on top of it.

**Files:**
- Modify: `src/routes/_authed.add.tsx` (imports at 25-31, deck markup at 129-156)

**Interfaces:**
- Consumes: `DeckPicker({ decks, value, onValueChange })` from Task 1.
- Produces: nothing new. `deckId`, `picked`, and `search.deckId` keep their current meanings.

- [ ] **Step 1: Replace the inline deck markup**

In `src/routes/_authed.add.tsx`, replace this block (currently the first child of the idle state's `<div className="space-y-4">`):

```tsx
          <div className="space-y-2">
            <Label htmlFor="deck">Deck</Label>
            {/* Base UI represents "nothing selected yet" as null, which is what
                renders the placeholder — `deckId` resolves to "" whenever
                there's no picked value yet or the candidate isn't a deck in
                the loaded list, so the disabled checks below are unchanged.
                `items` maps the deck id onto its name for the trigger label. */}
            <Select
              items={decks?.map((deck) => ({
                value: deck.id,
                label: deck.name,
              }))}
              value={deckId || null}
              onValueChange={(value) => setPicked(value ?? "")}
            >
              <SelectTrigger id="deck" className="w-full">
                <SelectValue placeholder="Choose a deck…" />
              </SelectTrigger>
              <SelectContent>
                {decks?.map((deck) => (
                  <SelectItem key={deck.id} value={deck.id}>
                    {deck.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
```

with:

```tsx
          <DeckPicker decks={decks} value={deckId} onValueChange={setPicked} />
```

- [ ] **Step 2: Fix the imports**

Delete the whole `Select` import block (the last import in the file):

```tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```

Add, next to the other component imports:

```tsx
import { DeckPicker } from "@/components/deck-picker";
```

Keep the `Label` import — it is still used by the "Word or concept" field.

- [ ] **Step 3: Typecheck and test**

```bash
deno task build && deno task test
```

Expected: both PASS. `deno task build` is what catches a leftover unused import or a prop-type mismatch (`setPicked` is `Dispatch<SetStateAction<string | null>>`, which accepts the `(deckId: string) => void` position).

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authed.add.tsx
git commit -m "refactor(add): render the deck control through DeckPicker"
```

---

### Task 3: Add "+ New deck…" and the inline creator

Give `DeckPicker` its second mode and wire the route's `useCreateDeck` into it.

**Files:**
- Modify: `src/components/deck-picker.tsx`
- Modify: `src/components/deck-picker.test.tsx`
- Modify: `src/routes/_authed.add.tsx`

**Interfaces:**
- Consumes: `useCreateDeck()` from `@/lib/api/decks` — a React Query mutation whose `mutateAsync({ name })` resolves with the created `Deck` and exposes `isPending`, `isError`, `error`.
- Produces: `DeckPicker({ decks, value, onValueChange, onCreate, creating?, error? })` where `onCreate: (name: string) => Promise<Deck>`, `creating?: boolean` (default `false`), `error?: string | null` (default `null`).

**Note on naming:** the spec's illustrative snippet used `creating` for both the internal mode flag and the pending prop. This plan names the internal state `creatorOpen` and reserves `creating` for the prop.

- [ ] **Step 1: Write the failing tests**

In `src/components/deck-picker.test.tsx`, add `onCreate` to the render helper so every existing test keeps compiling. Replace the `renderPicker` function with:

```tsx
function renderPicker(props: Partial<Parameters<typeof DeckPicker>[0]> = {}) {
  const onValueChange = vi.fn();
  const onCreate = vi.fn(async (name: string) => makeDeck("deck-new", name));
  render(
    <DeckPicker
      decks={[GERMAN, PHARMA]}
      value=""
      onValueChange={onValueChange}
      onCreate={onCreate}
      {...props}
    />,
  );
  return { onValueChange, onCreate };
}
```

Then append these cases inside the existing `describe("DeckPicker", ...)` block:

```tsx
  it("offers a create entry alongside the decks", async () => {
    renderPicker();

    await openPicker();

    expect(await screen.findByRole("option", { name: "German" })).toBeTruthy();
    expect(
      await screen.findByRole("option", { name: "+ New deck…" }),
    ).toBeTruthy();
  });

  it("opens the creator without reporting the sentinel as a deck", async () => {
    const { onValueChange } = renderPicker();

    await openPicker();
    await chooseOption("+ New deck…");

    expect(screen.getByLabelText("Deck")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    // The sentinel must never escape the component: `deckId` upstream trusts
    // any non-empty value to be a real, owned deck.
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("starts in the creator when the user has no decks, with no way back", () => {
    renderPicker({ decks: [] });

    expect(screen.getByLabelText("Deck")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("stays on the picker while the deck list is still loading", () => {
    renderPicker({ decks: undefined });

    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.queryByPlaceholderText("New deck name")).toBeNull();
  });

  it("creates the trimmed name, selects it, and returns to the picker", async () => {
    const { onCreate, onValueChange } = renderPicker();

    await openPicker();
    await chooseOption("+ New deck…");
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("New deck name"), {
        target: { value: "  Mycology  " },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(onCreate).toHaveBeenCalledWith("Mycology");
    expect(onValueChange).toHaveBeenCalledWith("deck-new");
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("submits on Enter from the name field", async () => {
    const { onCreate } = renderPicker({ decks: [] });

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("New deck name"), {
        target: { value: "Mycology" },
      });
    });
    await act(async () => {
      fireEvent.submit(screen.getByPlaceholderText("New deck name").closest("form")!);
    });

    expect(onCreate).toHaveBeenCalledWith("Mycology");
  });

  it("cannot submit a blank or whitespace-only name", async () => {
    renderPicker({ decks: [] });

    const create = screen.getByRole("button", {
      name: "Create",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("New deck name"), {
        target: { value: "   " },
      });
    });

    expect(create.disabled).toBe(true);
  });

  it("blocks a second submit while one is in flight", () => {
    renderPicker({ decks: [], creating: true });

    const create = screen.getByRole("button", {
      name: "Creating…",
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });

  it("keeps the typed name and the creator open when creating fails", () => {
    renderPicker({ decks: [], error: "Failed to create deck" });

    expect(screen.getByText("Failed to create deck")).toBeTruthy();
    expect(screen.getByPlaceholderText("New deck name")).toBeTruthy();
  });

  it("cancels back to the picker without creating anything", async () => {
    const { onCreate, onValueChange } = renderPicker({ value: GERMAN.id });

    await openPicker();
    await chooseOption("+ New deck…");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(onCreate).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
    // The selection the user arrived with is untouched.
    expect(screen.getByRole("combobox").textContent).toContain("German");
  });
```

Two things worth knowing while reading these:

- `screen.getByLabelText("Deck")` resolves to the name `<input>` in creator mode and would resolve to the `Select` trigger otherwise, which is why each mode assertion pairs it with a `queryBy…` for the other mode.
- The "creates … and returns to the picker" test starts from a non-empty `decks` list on purpose. `decks` is a prop the parent owns, so a test that started from `decks={[]}` would still have `decks.length === 0` after `onCreate` resolves and would sit in the creator forever. In the real app `useCreateDeck` awaits its `invalidateQueries` before `mutateAsync` resolves, so the list has already refetched by then.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
deno task test src/components/deck-picker.test.tsx
```

Expected: FAIL. The new cases fail on the missing "+ New deck…" option and missing name field; TypeScript also flags `onCreate` as an unknown prop.

- [ ] **Step 3: Write the implementation**

Replace the whole of `src/components/deck-picker.tsx` with:

```tsx
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Deck } from "@/lib/api/decks";

/**
 * The value behind the "+ New deck…" row. Deck ids are server-generated
 * uuidv7s, so this cannot collide with one — and `handleSelect` intercepts it
 * before it can reach `onValueChange` regardless. That matters: callers treat
 * any non-empty deck id as a real, owned deck.
 */
const NEW_DECK = "__new__";

/**
 * The deck control on the "Add a card" screen: pick an existing deck, or
 * create one without leaving the page. Presentational on purpose — the route
 * owns `useDecks`/`useCreateDeck`, so this renders from props alone and can be
 * tested without a query client.
 */
export function DeckPicker({
  decks,
  value,
  onValueChange,
  onCreate,
  creating = false,
  error = null,
}: {
  decks: Deck[] | undefined;
  value: string;
  onValueChange: (deckId: string) => void;
  onCreate: (name: string) => Promise<Deck>;
  creating?: boolean;
  error?: string | null;
}) {
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [name, setName] = useState("");

  // With no decks there is nothing to pick, so the creator *is* the starting
  // state. Deriving that instead of storing it means the first successful
  // create flips back to the Select on its own, once the refreshed list
  // arrives from the parent.
  //
  // `decks === undefined` (list still in flight) is deliberately not this
  // case: `undefined?.length === 0` is false, so a loading list shows the
  // ordinary placeholder rather than flashing the creator open.
  const noDecks = decks?.length === 0;
  const showCreator = creatorOpen || noDecks;

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !creating;

  async function handleCreate() {
    if (!canSubmit) return;
    let deck: Deck;
    try {
      deck = await onCreate(trimmed);
    } catch {
      // The failure is already rendered from the `error` prop below, and the
      // typed name is deliberately left in place — clearing it would discard
      // what the user wrote. Swallow here so this doesn't surface as an
      // unhandled rejection.
      return;
    }
    onValueChange(deck.id);
    setCreatorOpen(false);
    setName("");
  }

  function handleSelect(next: string | null) {
    if (next === NEW_DECK) {
      setCreatorOpen(true);
      return;
    }
    onValueChange(next ?? "");
  }

  if (showCreator) {
    return (
      // A real form, so Enter submits from the field rather than forcing a
      // trip to the button — the same reason `_authed.decks.index.tsx` uses
      // one. The idle "Add a card" screen is a plain div, so this nests
      // inside no other form.
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <Label htmlFor="new-deck-name">Deck</Label>
        <div className="flex gap-2">
          <Input
            id="new-deck-name"
            className="flex-1"
            placeholder="New deck name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={!canSubmit}>
            {creating ? "Creating…" : "Create"}
          </Button>
          {/* No Cancel with zero decks: there is nothing to fall back to, and
              offering one would put the user back at the dead end this
              control exists to remove. */}
          {!noDecks && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreatorOpen(false)}
            >
              Cancel
            </Button>
          )}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </form>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="deck">Deck</Label>
      {/* Base UI represents "nothing selected yet" as null, which is what
          renders the placeholder — the caller passes "" for that case.
          `items` maps the deck id onto its name for the trigger label; without
          it the trigger renders the raw id. The sentinel is left out of
          `items` because it never survives as a value. */}
      <Select
        items={decks?.map((deck) => ({ value: deck.id, label: deck.name }))}
        value={value || null}
        onValueChange={handleSelect}
      >
        <SelectTrigger id="deck" className="w-full">
          <SelectValue placeholder="Choose a deck…" />
        </SelectTrigger>
        <SelectContent>
          {decks?.map((deck) => (
            <SelectItem key={deck.id} value={deck.id}>
              {deck.name}
            </SelectItem>
          ))}
          <SelectItem value={NEW_DECK}>+ New deck…</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno task test src/components/deck-picker.test.tsx
```

Expected: PASS, 15 tests.

- [ ] **Step 5: Wire the route to `useCreateDeck`**

In `src/routes/_authed.add.tsx`, change the decks import to pull in the create hook:

```tsx
import { useCreateDeck, useDecks } from "@/lib/api/decks";
```

Add the mutation next to the other hooks in `AddPage`, below `const { data: decks } = useDecks();`:

```tsx
  const createDeck = useCreateDeck();
```

Then replace the `DeckPicker` element from Task 2 with:

```tsx
          <DeckPicker
            decks={decks}
            value={deckId}
            onValueChange={setPicked}
            onCreate={(name) => createDeck.mutateAsync({ name })}
            creating={createDeck.isPending}
            error={
              createDeck.isError
                ? createDeck.error instanceof Error
                  ? createDeck.error.message
                  : "Failed to create deck"
                : null
            }
          />
```

- [ ] **Step 6: Verify the whole suite and the typecheck**

```bash
deno task build && deno task check:api && deno task test
```

Expected: all three PASS. This is exactly what CI runs.

- [ ] **Step 7: Manual check**

```bash
deno task dev
```

Open `/add` and confirm:
1. With decks: "+ New deck…" sits at the bottom of the dropdown; choosing it swaps in the name field; Cancel returns to the dropdown with the previous selection intact.
2. Creating a deck selects it immediately — the trigger shows the new name, and "Generate cards" enables once a word is typed.
3. With no decks (a fresh account, or delete them all): `/add` shows the name field directly, with no Cancel.

Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
git add src/components/deck-picker.tsx src/components/deck-picker.test.tsx src/routes/_authed.add.tsx
git commit -m "feat(add): create a deck from the card picker

Closes #15"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Extract `DeckPicker`, route keeps data wiring | 1, 2 |
| `deckId` derivation unchanged | 2 (route edit touches only the markup) |
| Mode derivation (`creatorOpen \|\| noDecks`), loading is not the zero case | 3 |
| Sentinel item + interception | 3 |
| Creator form, Enter submits, Cancel hidden at zero decks | 3 |
| Select the new deck on success, no flicker | 3 |
| Errors keep the name and the creator open; submit disabled while pending/blank | 3 |
| Component tests per the spec's list | 1, 3 |
| Out of scope: descriptions, deck management, reusing on `/decks` | not implemented, by design |

Every spec edge case has a test except "last deck deleted in another tab" and "sentinel picked twice" — both are consequences of the derivations rather than separate code paths (the first is `decks` going to `[]`, covered by the zero-decks tests; the second is unreachable because the `Select` is unmounted in creator mode).

**Placeholder scan:** no TBDs; every code step carries its actual content.

**Type consistency:** `DeckPicker`'s prop names are identical across Tasks 1, 2, and 3 (`decks`, `value`, `onValueChange`, plus `onCreate`, `creating`, `error` from Task 3). `onCreate` returns `Promise<Deck>` in both the component and the test double, and `createDeck.mutateAsync({ name })` resolves with the inserted deck (`server/router/decks.ts` returns it). `NEW_DECK` is used under one name throughout.
