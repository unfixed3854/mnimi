# Mobile UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every mobile screen read and behave like one coherent Android
app, with single page titles, list-first deck navigation, explicit action
hierarchy, reliable touch targets, and safe bottom spacing.

**Architecture:** Extend the existing NativeWind/Reusables layer with semantic
button variants and three focused composition primitives: `PageHeader`,
`SectionHeader`, and `ListRow`. Keep feature state and data flow inside the
current screens, then migrate screens in independently testable slices before
switching the tab navigator to app-owned headers.

**Tech Stack:** Deno workspace, Expo SDK 57, React Native 0.86, Expo Router,
NativeWind 4.2.6, Tailwind CSS 3.4.17, repository-owned React Native Reusables,
Ionicons, Jest Expo, React Native Testing Library.

## Global Constraints

- Use `deno` for all package management and script execution. Do not use npm,
  npx, yarn, or pnpm.
- Add no dependency; the existing Expo Router, Ionicons, NativeWind, Reusables,
  CVA, and test dependencies cover the implementation.
- Preserve API contracts, query keys, mutations, route destinations, session
  handling, draft persistence, FSRS behavior, image/audio behavior, and
  development-only gating.
- Keep the existing warm palette. Add only semantic tonal colors derived from
  the current green, red, and warm-neutral tokens.
- Use one visible app-owned page title per screen. Detail back links must have
  stable destinations rather than depending only on navigation history.
- Every pressable target must be at least 48 px high; destination rows must be
  at least 56 px high.
- Every scroll screen must keep safe-area handling and at least 32 px of
  end-of-content padding.
- Selected, disabled, busy, destructive, and pressed states must remain
  distinguishable without relying only on color.
- Follow test-driven development for each task and commit each completed task
  separately.

---

### Task 1: Establish action hierarchy and shared screen rhythm

**Files:**

- Modify: `apps/mobile/tailwind.config.js`
- Modify: `apps/mobile/src/lib/utils.ts`
- Modify: `apps/mobile/src/components/ui/button.tsx`
- Modify: `apps/mobile/src/components/PrimaryButton.tsx`
- Modify: `apps/mobile/src/components/Screen.tsx`
- Modify: `apps/mobile/__tests__/ui-primitives.test.tsx`
- Modify: `apps/mobile/__tests__/shared-components.test.tsx`
- Modify: `apps/mobile/__tests__/screen-scroll.test.tsx`

**Interfaces:**

- `Button` adds variants `tonal`, `selection`, `selected`, and
  `destructiveQuiet` while retaining every existing variant and size.
- `PrimaryButton` adds optional `variant?: ButtonProps["variant"]`,
  `selected?: boolean`, and `className?: string`; the existing `destructive`
  boolean remains supported until all current callers are migrated.
- `Screen` keeps its current props and behavior. Its scroll content class gains
  `pb-xl` for 32 px of optical bottom space.

- [ ] **Step 1: Write failing tests for the new variants and bottom padding**

Add these cases to the existing test files:

```tsx
// ui-primitives.test.tsx
it.each(
  [
    ["tonal", "bg-primary-soft"],
    ["selection", "bg-surface"],
    ["selected", "bg-primary-soft"],
    ["destructiveQuiet", "bg-destructive-soft"],
  ] as const,
)("renders the %s action treatment", async (variant, className) => {
  await render(
    <Button variant={variant}>
      <ButtonText>{variant}</ButtonText>
    </Button>,
  );

  expect(screen.getByRole("button", { name: variant }).props.className)
    .toContain(className);
});

// shared-components.test.tsx
it("exposes selected state without treating the control as disabled", async () => {
  await render(
    <PrimaryButton selected variant="selected" onPress={jest.fn()}>
      German
    </PrimaryButton>,
  );

  expect(
    screen.getByRole("button", { name: "German" }).props.accessibilityState,
  )
    .toEqual(expect.objectContaining({ selected: true, disabled: false }));
});

it("passes layout classes to the underlying press target", async () => {
  await render(
    <PrimaryButton className="flex-1" onPress={jest.fn()}>
      Good
    </PrimaryButton>,
  );

  expect(screen.getByRole("button", { name: "Good" }).props.className)
    .toContain("flex-1");
});

// screen-scroll.test.tsx
expect(scroll.props.contentContainerClassName).toEqual(
  expect.stringContaining("pb-xl"),
);
```

- [ ] **Step 2: Run the focused tests and confirm the expected failures**

Run:

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/ui-primitives.test.tsx apps/mobile/__tests__/shared-components.test.tsx apps/mobile/__tests__/screen-scroll.test.tsx
```

Expected: FAIL because the new variants and `PrimaryButton` props do not exist,
and `Screen` does not include `pb-xl`.

- [ ] **Step 3: Add the semantic tonal tokens**

Extend `tailwind.config.js` colors with these exact values:

```js
"surface-muted": "#F2EFE8",
"primary-soft": "#E4ECE8",
"primary-soft-strong": "#D2E0DA",
"destructive-soft": "#F6E4E1",
```

Add the matching `text-*` names to the `text-color` class group in
`src/lib/utils.ts`, preserving every existing token:

```ts
"text-surface-muted",
"text-primary-soft",
"text-primary-soft-strong",
"text-destructive-soft",
```

- [ ] **Step 4: Implement the button variants**

Extend both CVA maps in `ui/button.tsx` with these classes:

```ts
// buttonVariants.variant
outline: "border border-border bg-surface text-foreground",
tonal: "border border-primary/15 bg-primary-soft text-primary",
selection: "border border-border bg-surface text-foreground",
selected: "border border-primary bg-primary-soft text-primary",
destructiveQuiet:
  "border border-destructive/30 bg-destructive-soft text-destructive",

// buttonTextVariants.variant
tonal: "text-primary",
selection: "text-foreground",
selected: "text-primary",
destructiveQuiet: "text-destructive",
```

Keep the base `min-h` sizes and `active:opacity-80` feedback unchanged.

- [ ] **Step 5: Extend `PrimaryButton` without weakening async behavior**

Import `ButtonProps` and change the prop contract and render mapping to:

```tsx
type PrimaryButtonProps = PropsWithChildren<{
  onPress: () => void | Promise<void>;
  disabled?: boolean;
  pending?: boolean;
  destructive?: boolean;
  variant?: ButtonProps["variant"];
  selected?: boolean;
  className?: string;
  accessibilityLabel?: string;
}>;

const resolvedVariant = destructive ? "destructive" : variant ?? "default";

<Button
  accessibilityLabel={label}
  accessibilityState={{
    disabled: unavailable,
    busy: pending || submitting,
    selected,
  }}
  className={className}
  disabled={unavailable}
  onPress={() => void handlePress()}
  variant={resolvedVariant}
>
```

Do not change `handlePress`: it must continue blocking duplicate async mutations
until the first promise settles.

- [ ] **Step 6: Add shared bottom content padding**

Change only the `ScrollView` content container baseline in `Screen.tsx`:

```tsx
<ScrollView
  contentContainerClassName="grow gap-md pb-xl"
  keyboardShouldPersistTaps="handled"
  testID="screen-scroll-content"
>
  {children}
</ScrollView>;
```

Keep all four safe-area edges, keyboard avoidance, `keyboardShouldPersistTaps`,
and the existing test ID.

- [ ] **Step 7: Run the focused tests and typecheck**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/ui-primitives.test.tsx apps/mobile/__tests__/shared-components.test.tsx apps/mobile/__tests__/screen-scroll.test.tsx
deno task mobile:typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 8: Commit the shared action foundation**

```bash
git add apps/mobile/tailwind.config.js apps/mobile/src/lib/utils.ts apps/mobile/src/components/ui/button.tsx apps/mobile/src/components/PrimaryButton.tsx apps/mobile/src/components/Screen.tsx apps/mobile/__tests__/ui-primitives.test.tsx apps/mobile/__tests__/shared-components.test.tsx apps/mobile/__tests__/screen-scroll.test.tsx
git commit -m "feat(mobile): establish UI action hierarchy"
```

### Task 2: Add page, section, and list composition primitives

**Files:**

- Create: `apps/mobile/src/components/PageHeader.tsx`
- Create: `apps/mobile/src/components/SectionHeader.tsx`
- Create: `apps/mobile/src/components/ListRow.tsx`
- Create: `apps/mobile/__tests__/layout-primitives.test.tsx`

**Interfaces:**

- `PageHeaderProps` is
  `{ title: string; subtitle?: string; back?: { href: Href; label: string };
  trailing?: ReactNode; className?: string }`.
- `SectionHeaderProps` is
  `{ title: string; detail?: string; trailing?: ReactNode; className?: string }`.
- `ListRowProps` is
  `{ title: string; description?: string; href?: Href; onPress?: () => void;
  leadingIcon?: ComponentProps<typeof Ionicons>["name"];
  trailing?: ReactNode; showChevron?: boolean; accessibilityLabel?: string;
  className?: string }`.
- `ListRow` renders a link when `href` exists, a button when `onPress` exists,
  and a noninteractive `View` otherwise. Callers must not provide both `href`
  and `onPress`.

- [ ] **Step 1: Write the failing primitive tests**

Create `layout-primitives.test.tsx`:

```tsx
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

jest.mock("expo-router", () => ({
  Link: ({ children, href, asChild }: {
    children: React.ReactElement<{ href?: unknown }>;
    href: unknown;
    asChild?: boolean;
  }) =>
    asChild ? React.cloneElement(children, { href }) : <Text>{children}</Text>,
}));

import { ListRow } from "../src/components/ListRow";
import { PageHeader } from "../src/components/PageHeader";
import { SectionHeader } from "../src/components/SectionHeader";

describe("layout primitives", () => {
  it("renders one page heading with subtitle and stable back link", async () => {
    await render(
      <PageHeader
        title="German"
        subtitle="4 notes · 3 due"
        back={{ href: "/decks", label: "Back to decks" }}
      />,
    );

    expect(screen.getByRole("header", { name: "German" })).toBeTruthy();
    expect(screen.getByText("4 notes · 3 due")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to decks" })).toBeTruthy();
  });

  it("makes a destination row a full-height link", async () => {
    await render(
      <ListRow
        title="German"
        href="/decks/german"
        leadingIcon="layers-outline"
      />,
    );

    const row = screen.getByRole("link", { name: "German" });
    expect(row.props.className).toContain("min-h-[56px]");
    expect(row.props.className).toContain("active:bg-surface-muted");
  });

  it("runs a row action and renders its trailing value", async () => {
    const onPress = jest.fn();
    await render(
      <ListRow
        title="Native language"
        trailing={<Text>English</Text>}
        onPress={onPress}
      />,
    );

    fireEvent.press(screen.getByRole("button", { name: "Native language" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByText("English")).toBeTruthy();
  });

  it("renders a section title below page-title prominence", async () => {
    await render(<SectionHeader title="Your decks" detail="2 decks" />);
    expect(screen.getByText("Your decks").props.className).toContain(
      "text-[20px]",
    );
    expect(screen.getByText("2 decks")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test and verify missing-module failures**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/layout-primitives.test.tsx
```

Expected: FAIL because the three components do not exist.

- [ ] **Step 3: Implement `PageHeader`**

Build `PageHeader` from `View`, `Pressable`, `Link`, `Ionicons`, shared `Text`,
`nativeColors`, and `cn`. Use this structure and classes:

```tsx
<View className={cn("gap-sm pt-lg", className)}>
  <View className="flex-row items-start gap-sm">
    {back
      ? (
        <Link href={back.href} asChild>
          <Pressable
            accessibilityLabel={back.label}
            accessibilityRole="link"
            className="h-12 w-12 items-center justify-center rounded-md active:bg-surface-muted"
          >
            <Ionicons
              accessibilityElementsHidden
              color={nativeColors.foreground}
              importantForAccessibility="no-hide-descendants"
              name="chevron-back"
              size={24}
            />
          </Pressable>
        </Link>
      )
      : null}
    <View className="min-w-0 flex-1 gap-xs">
      <Text
        accessibilityRole="header"
        className="text-title font-bold tracking-[-0.5px]"
      >
        {title}
      </Text>
      {subtitle
        ? <Text className="text-body text-muted-foreground">{subtitle}</Text>
        : null}
    </View>
    {trailing
      ? <View className="min-h-12 justify-center">{trailing}</View>
      : null}
  </View>
</View>;
```

Do not make the whole header interactive.

- [ ] **Step 4: Implement `SectionHeader`**

Use one horizontal row with `title` in `text-[20px] font-semibold`, `detail` in
`text-caption text-muted-foreground`, and optional `trailing` content aligned to
the end. The root class is `flex-row items-end justify-between gap-md` merged
with `className`.

- [ ] **Step 5: Implement `ListRow`**

Create one internal row body with these baseline classes:

```tsx
const rowClassName = cn(
  "min-h-[56px] flex-row items-center gap-md px-md py-sm",
  href || onPress ? "active:bg-surface-muted" : undefined,
  className,
);
```

Render the leading Ionicon at 22 px in `nativeColors.primary`; render title as
`text-body font-semibold`, description as `text-caption
text-muted-foreground`,
and a `chevron-forward` at 20 px when `showChevron ?? Boolean(href || onPress)`
is true. Decorative icons must set `accessibilityElementsHidden` and
`importantForAccessibility` so the row label is the only spoken name.

Wrap the row body in `<Link href={href} asChild>` plus a `Pressable` with role
`link` for destinations. Use a role `button` `Pressable` for `onPress`. Use a
plain `View` when neither is supplied. Throw in development when both are
supplied:

```ts
if (__DEV__ && href && onPress) {
  throw new Error("ListRow accepts either href or onPress, not both.");
}
```

- [ ] **Step 6: Run the primitive tests and typecheck**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/layout-primitives.test.tsx
deno task mobile:typecheck
```

Expected: all new tests and typecheck pass.

- [ ] **Step 7: Commit the layout primitives**

```bash
git add apps/mobile/src/components/PageHeader.tsx apps/mobile/src/components/SectionHeader.tsx apps/mobile/src/components/ListRow.tsx apps/mobile/__tests__/layout-primitives.test.tsx
git commit -m "feat(mobile): add polished layout primitives"
```

### Task 3: Make Decks list-first and polish deck detail

**Files:**

- Modify: `apps/mobile/src/features/decks/DeckListScreen.tsx`
- Modify: `apps/mobile/src/features/decks/DeckDetailScreen.tsx`
- Modify: `apps/mobile/__tests__/deck-list-screen.test.tsx`
- Modify: `apps/mobile/__tests__/deck-detail-screen.test.tsx`

**Interfaces:**

- `DeckListScreen` adds local `creating: boolean`, initially `false`.
- Deck creation still calls `useCreateDeck().mutateAsync({ name: trimmed })`.
- Deck rows link to `/decks/[deckId]` with the same `deckId` param.
- Deck detail back navigation links to `/decks`; note rows link to
  `/notes/[noteId]`; review and removal mutations keep their current imperative
  navigation.

- [ ] **Step 1: Expand Decks tests around disclosure and row affordance**

Replace the fixed empty deck mock with mutable `mockDecks`, reset it before each
test, and add these cases. In both deck test files, replace the existing
`Link: Text` stub with the as-child-aware `Link` factory from Task 2 so
`PageHeader` and `ListRow` retain their rendered Pressable roles; keep the
existing `router.push` and `router.replace` spies in the deck-detail factory.

```tsx
it("keeps deck creation secondary until requested", async () => {
  const view = await render(<DeckListScreen />);
  expect(view.queryByLabelText("New deck name")).toBeNull();

  await fireEvent.press(view.getByRole("button", { name: "New deck" }));
  expect(view.getByLabelText("New deck name")).toBeTruthy();
});

it("clears and closes deck creation when cancelled", async () => {
  const view = await render(<DeckListScreen />);
  await fireEvent.press(view.getByRole("button", { name: "New deck" }));
  await fireEvent.changeText(view.getByLabelText("New deck name"), "Polish");
  await fireEvent.press(view.getByRole("button", { name: "Cancel" }));

  expect(view.queryByLabelText("New deck name")).toBeNull();
  await fireEvent.press(view.getByRole("button", { name: "New deck" }));
  expect(view.getByLabelText("New deck name").props.value).toBe("");
});

it("renders each deck as a full destination row", async () => {
  mockDecks = [{ id: "deck-1", name: "German" }];
  const view = await render(<DeckListScreen />);

  expect(view.getByRole("link", { name: "German" }).props.className)
    .toContain("min-h-[56px]");
  expect(view.getByTestId("deck-list")).toBeTruthy();
});
```

Update the existing failed-creation test to press `New deck`, then press the
renamed `Create deck` action. Keep its assertions for the error and retained
input.

Add a deck-detail fixture with one note and assert:

```tsx
expect(view.getByRole("link", { name: "Back to decks" })).toBeTruthy();
expect(view.getByRole("link", { name: "Hallo" })).toBeTruthy();
expect(view.getByRole("button", { name: "Remove deck" }).props.className)
  .toContain("bg-destructive-soft");
```

- [ ] **Step 2: Run the deck tests and verify they fail**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx
```

Expected: FAIL because creation is always visible, deck/note links are text
nodes, and the detail screen has no shared back/header treatment.

- [ ] **Step 3: Implement the list-first Decks screen**

Add `creating` state. Replace the hand-written title with:

```tsx
<PageHeader
  title="Decks"
  trailing={!creating
    ? (
      <PrimaryButton variant="outline" onPress={() => setCreating(true)}>
        New deck
      </PrimaryButton>
    )
    : undefined}
/>;
```

When `creating` is true, render a `Card` containing `TextField`, an error beside
the form, and a horizontal action row:

```tsx
<View className="flex-row gap-sm">
  <PrimaryButton
    className="flex-1"
    variant="outline"
    onPress={() => {
      setCreating(false);
      setName("");
      setCreateError(null);
    }}
  >
    Cancel
  </PrimaryButton>
  <PrimaryButton
    className="flex-1"
    disabled={!name.trim() || createDeck.isPending}
    pending={createDeck.isPending}
    onPress={create}
  >
    Create deck
  </PrimaryButton>
</View>;
```

After successful creation, clear `name`, clear `createError`, and set `creating`
to false. Do not close or clear the form on failure.

Add `<SectionHeader title="Your decks" detail={`${decks?.length ?? 0}`} />`
above the stable list region. Render loaded decks inside a rounded bordered
surface with `testID="deck-list"`, separators between rows, and:

```tsx
<ListRow
  href={{ pathname: "/decks/[deckId]", params: { deckId: deck.id } }}
  leadingIcon="layers-outline"
  title={deck.name}
/>;
```

- [ ] **Step 4: Apply the same hierarchy to deck detail**

Replace the back text/title/metadata trio with:

```tsx
<PageHeader
  back={{ href: "/decks", label: "Back to decks" }}
  title={deck.name}
  subtitle={`${notes?.length ?? "—"} notes${due ? ` · ${due} due` : ""}`}
/>;
```

Keep Review as the primary button. Replace the no-due filled disabled button
with a `Card className="bg-surface-muted"` containing the muted text “Nothing
due right now”. Render notes in one grouped list with `ListRow`, using
`description` only when note metadata already available in the current result.
Move Remove deck after the notes section inside `View className="mt-xl"` and
render it as:

```tsx
<PrimaryButton
  variant="destructiveQuiet"
  onPress={() => setConfirming(true)}
>
  Remove deck
</PrimaryButton>;
```

Do not alter `removeDeck`, the confirmation dialog, or navigation ordering.

- [ ] **Step 5: Run deck tests and typecheck**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx
deno task mobile:typecheck
```

Expected: deck tests and typecheck pass, including failure retention and
post-delete navigation ordering.

- [ ] **Step 6: Commit the Decks polish**

```bash
git add apps/mobile/src/features/decks/DeckListScreen.tsx apps/mobile/src/features/decks/DeckDetailScreen.tsx apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx
git commit -m "feat(mobile): make deck navigation list-first"
```

### Task 4: Turn Review into one clear grading decision

**Files:**

- Modify: `apps/mobile/src/features/review/ReviewScreen.tsx`
- Modify: `apps/mobile/src/components/ImageCueReviewCard.tsx`
- Modify: `apps/mobile/src/components/PronunciationControl.tsx`
- Modify: `apps/mobile/__tests__/review-screen.test.tsx`
- Modify: `apps/mobile/__tests__/pronunciation-control.test.tsx`

**Interfaces:**

- Review back navigation links to
  `{ pathname: "/decks/[deckId]", params: { deckId } }`.
- Grade buttons continue calling `submit(rating.value)` with unchanged `ts-fsrs`
  `Grade` values and stable `RATINGS` order.
- `PronunciationControl` keeps its public props and audio behavior; only its
  action variant and internal spacing change.

- [ ] **Step 1: Add failing hierarchy and grade-grid tests**

Extend `review-screen.test.tsx`:

Add the Task 2 as-child-aware `expo-router.Link` mock first because Review now
renders a stable back link.

```tsx
it("groups the revealed grades into two equal decision rows", async () => {
  const view = await render(<ReviewScreen deckId="deck-1" />);
  await fireEvent.press(view.getByRole("button", { name: "Show answer" }));

  expect(view.getByText("How well did you remember?")).toBeTruthy();
  expect(view.getByTestId("review-grade-row-again-hard").props.className)
    .toContain("flex-row");
  expect(view.getByTestId("review-grade-row-good-easy").props.className)
    .toContain("flex-row");
  for (const label of ["Again", "Hard", "Good", "Easy"]) {
    expect(view.getByRole("button", { name: label }).props.className)
      .toContain("flex-1");
  }
});

it("keeps every grade wired to its existing FSRS value", async () => {
  const view = await render(<ReviewScreen deckId="deck-1" />);
  await fireEvent.press(view.getByRole("button", { name: "Show answer" }));
  await fireEvent.press(view.getByRole("button", { name: "Easy" }));
  expect(mockMutateAsync).toHaveBeenCalledWith({
    card: firstCard,
    rating: Rating.Easy,
  });
});

it("provides a stable back destination to the reviewed deck", async () => {
  const view = await render(<ReviewScreen deckId="deck-1" />);
  expect(view.getByRole("link", { name: "Back to deck" })).toBeTruthy();
});
```

Import `Rating` in the test. Update the pronunciation test with:

```tsx
expect(view.getByRole("button", { name: "Play pronunciation" }).props.className)
  .toContain("bg-surface");
```

- [ ] **Step 2: Run the focused tests and verify they fail**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/review-screen.test.tsx apps/mobile/__tests__/pronunciation-control.test.tsx
```

Expected: FAIL because Review has no shared header/prompt/grid and pronunciation
still uses a primary action.

- [ ] **Step 3: Replace Review's title block with `PageHeader`**

Use:

```tsx
<PageHeader
  back={{
    href: { pathname: "/decks/[deckId]", params: { deckId } },
    label: "Back to deck",
  }}
  title="Review"
  subtitle={`${cards?.length ?? 0} left · ${card.aspect}`}
/>;
```

Loading and error states also render `PageHeader` with title “Review” and the
same `deckId`-based back destination. They omit card-count/aspect subtitle data
that has not loaded.

- [ ] **Step 4: Build the 2x2 grading group without changing submissions**

After `PronunciationControl`, render the prompt and two explicit rows:

```tsx
<View className="gap-sm">
  <SectionHeader title="How well did you remember?" />
  <View className="flex-row gap-sm" testID="review-grade-row-again-hard">
    {RATINGS.slice(0, 2).map((rating) => (
      <PrimaryButton
        key={rating.value}
        className="flex-1"
        variant={rating.value === Rating.Again
          ? "destructiveQuiet"
          : "selection"}
        disabled={grade.isPending}
        onPress={() => submit(rating.value)}
      >
        {rating.label}
      </PrimaryButton>
    ))}
  </View>
  <View className="flex-row gap-sm" testID="review-grade-row-good-easy">
    {RATINGS.slice(2).map((rating) => (
      <PrimaryButton
        key={rating.value}
        className="flex-1"
        variant={rating.value === Rating.Good ? "tonal" : "outline"}
        disabled={grade.isPending}
        onPress={() => submit(rating.value)}
      >
        {rating.label}
      </PrimaryButton>
    ))}
  </View>
</View>;
```

Keep the existing reveal identity and reset it only after a successful grade.
Move `gradeError` directly above the grading group after reveal so failure
context stays attached to the choice being retried.

- [ ] **Step 5: Demote supporting review actions**

In `PronunciationControl`, render
`<PrimaryButton disabled={waiting} variant="outline" onPress={play}>{label}</PrimaryButton>`
and add `className="gap-xs"` to its root `View`. In `ImageCueReviewCard`, use
`variant="outline"` for Text hint and keep Show answer primary. Do not change
autoplay, generation, retry, image, or cloze behavior.

- [ ] **Step 6: Run Review/audio tests and typecheck**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/review-screen.test.tsx apps/mobile/__tests__/pronunciation-control.test.tsx apps/mobile/__tests__/use-card-audio.test.ts
deno task mobile:typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 7: Commit the Review hierarchy**

```bash
git add apps/mobile/src/features/review/ReviewScreen.tsx apps/mobile/src/components/ImageCueReviewCard.tsx apps/mobile/src/components/PronunciationControl.tsx apps/mobile/__tests__/review-screen.test.tsx apps/mobile/__tests__/pronunciation-control.test.tsx
git commit -m "feat(mobile): clarify review grading hierarchy"
```

### Task 5: Organize Add into visible stages and real selection states

**Files:**

- Modify: `apps/mobile/src/components/DeckPicker.tsx`
- Modify: `apps/mobile/src/features/add/AddScreen.tsx`
- Modify: `apps/mobile/src/components/CardEditor.tsx`
- Modify: `apps/mobile/__tests__/add-screen.test.tsx`
- Modify: `apps/mobile/__tests__/shared-components.test.tsx`

**Interfaces:**

- `DeckPicker` accepts `{ decks, value, onChange, onCreate? }`, renders the
  selected deck with `variant="selected"` plus `selected` accessibility state,
  and renders its outline New deck action only when `onCreate` is supplied.
- `AddScreen` continues consuming `useDraftSession()` without changing hook
  state or actions.
- Add shows `PageHeader` title “Add note” in `none` state and “Review cards” in
  generating/ready/failed states.

- [ ] **Step 1: Add failing Add and picker tests**

Update `add-screen.test.tsx` to use one deck and assert:

```tsx
expect(view.getByRole("header", { name: "Add note" })).toBeTruthy();
expect(view.getByRole("button", { name: "German" }).props.accessibilityState)
  .toEqual(expect.objectContaining({ selected: true, disabled: false }));
expect(view.getByRole("button", { name: "Create deck" }).props.className)
  .toContain("bg-primary-soft");
```

Add a second mock draft state (`ready`) and test:

```tsx
expect(view.getByRole("header", { name: "Review cards" })).toBeTruthy();
expect(view.getByRole("button", { name: "Save note" }).props.className)
  .toContain("bg-primary");
expect(view.getByRole("button", { name: "Discard" }).props.className)
  .toContain("bg-destructive-soft");
```

Add a `DeckPicker` case to `shared-components.test.tsx` that presses an
unselected deck, verifies `onChange("deck-2")`, and verifies the selected deck
is not disabled.

- [ ] **Step 2: Run the tests and verify hierarchy failures**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/add-screen.test.tsx apps/mobile/__tests__/shared-components.test.tsx
```

Expected: FAIL because Add still says “Add a card,” uses disabled primary deck
buttons, and renders Discard as a solid destructive peer of Save.

- [ ] **Step 3: Convert `DeckPicker` to selection semantics**

Render the label with `SectionHeader title="Deck"`. For each deck use:

```tsx
<PrimaryButton
  key={deck.id}
  selected={value === deck.id}
  variant={value === deck.id ? "selected" : "selection"}
  onPress={() => onChange(deck.id)}
>
  {deck.name}
</PrimaryButton>;
```

Make `onCreate` optional and render New deck with `variant="outline"` only when
the callback is supplied. Keep the wrapping layout and deck-selection callback.

- [ ] **Step 4: Recompose the empty-draft Add screen**

Replace its title/subtitle with:

```tsx
<PageHeader
  title="Add note"
  subtitle="Write a word or concept, then review the generated cards before saving."
/>;
```

Use `DeckPicker` without `onCreate` for existing choices. Keep the current
new-deck field and Create deck action inline beneath it, with Create deck styled
as `variant="tonal"`; this avoids adding another disclosure state. Use a
`SectionHeader title="Source"` before the Word or concept field. Keep Generate
cards as the only solid primary action. Preserve `newDeck`, local error,
`canStart`, pending flags, and every hook call.

- [ ] **Step 5: Recompose generated-draft stages**

Replace the generated-state title with `<PageHeader title="Review cards" />`.
Group classification/status under `SectionHeader title="Generation"`, card
editing/streaming under `SectionHeader title="Cards"`, and final actions under
`SectionHeader title="Finish"`. Do not add nested cards around these sections.

Keep Save primary. Render Discard in a separate `View className="mt-lg"` with
`variant="destructiveQuiet"`. Render image retry as `variant="outline"`.

In `CardEditor`, change only Remove card to `variant="destructiveQuiet"`; keep
all input labels, switch behavior, and card-array edits unchanged.

- [ ] **Step 6: Run Add/draft tests and typecheck**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/add-screen.test.tsx apps/mobile/__tests__/shared-components.test.tsx apps/mobile/__tests__/draft-state.test.ts apps/mobile/__tests__/draft-autosave.test.tsx apps/mobile/__tests__/draft-indicator-tab.test.tsx
deno task mobile:typecheck
```

Expected: Add, draft, and typecheck suites pass with no state-machine changes.

- [ ] **Step 7: Commit the Add hierarchy**

```bash
git add apps/mobile/src/components/DeckPicker.tsx apps/mobile/src/features/add/AddScreen.tsx apps/mobile/src/components/CardEditor.tsx apps/mobile/__tests__/add-screen.test.tsx apps/mobile/__tests__/shared-components.test.tsx
git commit -m "feat(mobile): organize the add workflow"
```

### Task 6: Switch tabs to app-owned headers and polish Today and Settings

**Files:**

- Modify: `apps/mobile/app/(tabs)/_layout.tsx`
- Modify: `apps/mobile/src/features/today/TodayScreen.tsx`
- Modify: `apps/mobile/src/features/add/AddScreen.tsx`
- Modify: `apps/mobile/src/features/settings/SettingsScreen.tsx`
- Modify: `apps/mobile/__tests__/navigation-shell.test.tsx`
- Modify: `apps/mobile/__tests__/add-screen.test.tsx`
- Modify: `apps/mobile/__tests__/settings-screen.test.tsx`
- Create: `apps/mobile/__tests__/today-screen.test.tsx`

**Interfaces:**

- Tabs retain the same four routes, labels, icons, and active/inactive colors.
- `screenOptions.headerShown` becomes `false`; `headerRight` is removed from
  Add.
- Add renders `DraftIndicator` in `PageHeader.trailing`.
- Settings preference mutations and native modal behavior remain unchanged.

- [ ] **Step 1: Add failing shell, Today, Add-indicator, and Settings tests**

Extend the Tabs test double to capture `screenOptions`, then assert:

```tsx
expect(mockTabScreenOptions).toEqual(
  expect.objectContaining({ headerShown: false }),
);
expect(mockTabOptions.find((options) => options.title === "Add"))
  .not.toHaveProperty("headerRight");
```

Mock `DraftIndicator` in `add-screen.test.tsx` as accessible text and assert it
appears alongside the Add page header.

Create `today-screen.test.tsx` with mutable due count:

Mock `expo-router.Link` as a `Pressable` with `accessibilityRole="link"`, pass
through its `className` and accessibility props, and invoke no router side
effect; these tests inspect hierarchy and destination affordance rather than
navigation dispatch.

```tsx
it("shows one Today heading and a primary deck action when cards are due", async () => {
  mockDueCount = 7;
  const view = await render(<TodayScreen />);
  expect(view.getAllByRole("header", { name: "Today" })).toHaveLength(1);
  expect(view.getByRole("link", { name: "Choose a deck" }).props.className)
    .toContain("bg-primary");
});

it("keeps browsing quiet when nothing is due", async () => {
  mockDueCount = 0;
  const view = await render(<TodayScreen />);
  expect(view.getByRole("link", { name: "Browse decks" }).props.className)
    .toContain("text-primary");
});
```

Extend settings tests:

```tsx
expect(view.getByRole("header", { name: "Settings" })).toBeTruthy();
expect(view.getByRole("button", { name: "Native language: English" }))
  .toBeTruthy();
expect(view.getByRole("switch", { name: "Autoplay pronunciation" }))
  .toBeTruthy();
```

- [ ] **Step 2: Run the focused tests and verify they fail**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/navigation-shell.test.tsx apps/mobile/__tests__/today-screen.test.tsx apps/mobile/__tests__/add-screen.test.tsx apps/mobile/__tests__/settings-screen.test.tsx
```

Expected: FAIL because native tab headers are still visible, DraftIndicator
still belongs to the navigator, Today lacks the app-owned header/primary CTA,
and Settings is titled Account.

- [ ] **Step 3: Hide navigator headers without changing tabs**

In `TabsLayout`, add `headerShown: false` to `screenOptions`, remove
`headerStyle`/`headerTintColor`, and remove Add's `headerRight`. Keep tab
titles, accessibility labels, Ionicon callbacks, and tint colors exactly as they
are.

- [ ] **Step 4: Finish the Add page header handoff**

Import `DraftIndicator` into `AddScreen` and pass
`trailing={<DraftIndicator />}` to both Add-state `PageHeader` instances. For
the loading state, render `PageHeader title="Add note"` plus the loading text so
every Add state has one app-owned title.

- [ ] **Step 5: Recompose Today**

Render `<PageHeader title="Today" />` before a growable centered focal region.
Keep the due count and copy. For `due > 0`, use an Expo Router `Link` styled
with `buttonVariants({ variant: "default" })` and accessible name “Choose a
deck”. For `due === 0`, keep “Browse decks” as the link variant. Both continue
to navigate to `/decks`.

- [ ] **Step 6: Recompose Settings as native-feeling rows**

Use:

```tsx
<PageHeader
  title="Settings"
  subtitle={`Signed in as ${session?.user.email ?? "—"}.`}
/>
<SectionHeader title="Preferences" />
```

Render native language with `ListRow`:

```tsx
<ListRow
  accessibilityLabel={`Native language: ${selectedLanguage}`}
  leadingIcon="language-outline"
  onPress={() => setLanguagePickerOpen(true)}
  title="Native language"
  trailing={<Text className="text-muted-foreground">{selectedLanguage}</Text>}
/>;
```

Render autoplay as a noninteractive `ListRow` with title, description, leading
volume icon, `showChevron={false}`, and the existing `Switch` as `trailing`.
Keep the switch itself interactive and retain its exact accessibility props and
serialization.

In the language modal, use
`variant={language === item.code ? "selected" :
"selection"}` plus
`selected={language === item.code}`; do not disable the selected choice. Use
`variant="outline"` for Cancel. Use an outline/secondary action for Development
tools and keep Sign out in its bottom section as solid destructive.

- [ ] **Step 7: Run shell/Today/Settings tests and typecheck**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/navigation-shell.test.tsx apps/mobile/__tests__/today-screen.test.tsx apps/mobile/__tests__/add-screen.test.tsx apps/mobile/__tests__/settings-screen.test.tsx apps/mobile/__tests__/draft-indicator-tab.test.tsx
deno task mobile:typecheck
```

Expected: all focused tests and typecheck pass; every tab has exactly one
visible app-owned heading.

- [ ] **Step 8: Commit the app-owned tab shell**

```bash
git add 'apps/mobile/app/(tabs)/_layout.tsx' apps/mobile/src/features/today/TodayScreen.tsx apps/mobile/src/features/add/AddScreen.tsx apps/mobile/src/features/settings/SettingsScreen.tsx apps/mobile/__tests__/navigation-shell.test.tsx apps/mobile/__tests__/today-screen.test.tsx apps/mobile/__tests__/add-screen.test.tsx apps/mobile/__tests__/settings-screen.test.tsx
git commit -m "feat(mobile): unify tab page hierarchy"
```

### Task 7: Apply the shared hierarchy to note and authentication screens

**Files:**

- Modify: `apps/mobile/src/features/notes/NoteScreen.tsx`
- Modify: `apps/mobile/app/(auth)/login.tsx`
- Modify: `apps/mobile/app/(auth)/signup.tsx`
- Modify: `apps/mobile/__tests__/note-screen.test.tsx`
- Modify: `apps/mobile/__tests__/navigation-shell.test.tsx`

**Interfaces:**

- Note back navigation keeps the exact deck destination already available from
  `note.deckId`.
- Authentication routes and `AuthForm` behavior remain unchanged.
- Note hydration, polling protection, edit/save, image generation, and audio
  behavior remain unchanged.

- [ ] **Step 1: Add failing note and auth header tests**

Extend `note-screen.test.tsx`:

Replace its existing `Link: Text` stub with the Task 2 as-child-aware factory,
while retaining the current `router.replace` spy used by save tests.

```tsx
expect(view.getByRole("header", { name: "Hallo" })).toBeTruthy();
expect(view.getByRole("link", { name: "Back to deck" })).toBeTruthy();
expect(view.getByRole("button", { name: "Generate one" }).props.className)
  .toContain("bg-surface");
```

Extend `navigation-shell.test.tsx` to render both auth routes and assert one
header per route plus shared content spacing:

```tsx
expect(screen.getAllByRole("header", { name: "Sign in" })).toHaveLength(1);
expect(screen.getAllByRole("header", { name: "Create an account" }))
  .toHaveLength(1);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/navigation-shell.test.tsx
```

Expected: FAIL on the shared back label and secondary image action; auth tests
fail until routes use `PageHeader`.

- [ ] **Step 3: Recompose note detail**

Replace the current back text and title with:

```tsx
<PageHeader
  back={{
    href: { pathname: "/decks/[deckId]", params: { deckId: note.deckId } },
    label: "Back to deck",
  }}
  title={note.sourceText}
/>;
```

Use `SectionHeader title="Picture"` before image state/content and
`SectionHeader title="Cards" detail={`${cards.length}`}` before `CardEditor`.
Use `variant="outline"` for Generate one; pronunciation is already secondary
from Task 4. Keep Save note primary and preserve all current callbacks and error
placement near their source sections.

- [ ] **Step 4: Replace auth title pairs with `PageHeader`**

Login uses:

```tsx
<PageHeader title="Sign in" subtitle="Continue your language practice." />;
```

Signup uses:

```tsx
<PageHeader
  title="Create an account"
  subtitle="Start building your practice habit."
/>;
```

Keep `AuthForm`, route links, protected auth layout, labels, and destinations
unchanged.

- [ ] **Step 5: Run note/auth tests and typecheck**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/auth-form.test.tsx apps/mobile/__tests__/navigation-shell.test.tsx
deno task mobile:typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 6: Commit note and authentication polish**

```bash
git add apps/mobile/src/features/notes/NoteScreen.tsx 'apps/mobile/app/(auth)/login.tsx' 'apps/mobile/app/(auth)/signup.tsx' apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/navigation-shell.test.tsx
git commit -m "feat(mobile): polish detail and auth hierarchy"
```

### Task 8: Polish development tools and close remaining visual inconsistencies

**Files:**

- Modify: `apps/mobile/src/features/devtools/DevtoolsScreen.tsx`
- Modify: `apps/mobile/src/components/EmptyState.tsx`
- Modify: `apps/mobile/src/components/ErrorState.tsx`
- Modify: `apps/mobile/src/components/LoadingState.tsx`
- Modify: `apps/mobile/__tests__/devtools-screen.test.tsx`
- Modify: `apps/mobile/__tests__/shared-components.test.tsx`

**Interfaces:**

- Devtools keeps the same `Scope` values, API payloads, confirmation dialogs,
  status messages, seed behavior, and development-only route.
- Shared state components retain their current props and accessibility roles.

- [ ] **Step 1: Add failing devtools selection and shared-state tests**

Extend `devtools-screen.test.tsx`:

```tsx
expect(view.getByRole("button", { name: "All cards" }).props.accessibilityState)
  .toEqual(expect.objectContaining({ selected: true, disabled: false }));
expect(view.getByRole("button", { name: "Reset SRS" }).props.className)
  .toContain("bg-destructive");
expect(view.getByRole("button", { name: "Seed German" }).props.className)
  .toContain("bg-primary");
```

Add shared component assertions that Empty, Error, and Loading state roots keep
their roles and use `py-xl` without introducing an additional page header.

- [ ] **Step 2: Run the tests and verify selected-state failure**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/devtools-screen.test.tsx apps/mobile/__tests__/shared-components.test.tsx
```

Expected: FAIL because devtool scope still uses disabled primary buttons to show
selection.

- [ ] **Step 3: Recompose development tools**

Replace the title/subtitle with `PageHeader`. Use `SectionHeader` for “Reset
SRS” and “Seed German”. Render scope, deck, and card selectors with:

```tsx
<PrimaryButton
  selected={scope === next}
  variant={scope === next ? "selected" : "selection"}
  disabled={reset.isPending}
  onPress={() => selectScope(next)}
>
  {label}
</PrimaryButton>;
```

Keep the existing inline scope-reset body inside the handler; extracting a local
`selectScope(next: Scope)` is allowed only if it performs exactly
`setScope(next)`, `setDeckId("")`, and `setCardId("")`.

Use the same selected/selection mapping for deck and card choices. Keep Reset
SRS solid destructive because it is the focal action of its destructive section.
Keep Seed German solid primary in its constructive section. Place affected count
and status copy directly inside the relevant section.

- [ ] **Step 4: Normalize shared state spacing**

Keep `EmptyState`, `ErrorState`, and `LoadingState` content and roles. Replace
one-off text sizes with `text-body font-semibold` for state titles and use
`py-xl px-md` on roots. If ErrorState has retry, keep Try again primary because
recovery is the state’s only action.

- [ ] **Step 5: Run focused tests and the complete mobile suite**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/devtools-screen.test.tsx apps/mobile/__tests__/shared-components.test.tsx
deno task mobile:test --runInBand
deno task mobile:typecheck
```

Expected: focused tests, all mobile tests, and typecheck pass.

- [ ] **Step 6: Run a source consistency scan**

```bash
rg -n 'mt-xl text-title|text-\[(17|18|20)px\]|headerRight|disabled=\{[^}]*===' apps/mobile/app apps/mobile/src
```

Expected remaining matches:

- No `headerRight` in the tab layout.
- No screen-level `mt-xl text-title` heading pairs; screen titles use
  `PageHeader`.
- No selected deck/language/devtool choice represented only by `disabled`.
- Arbitrary 17/18/20 px text remains only inside low-level primitives if a
  semantic role cannot express it; migrate every feature-screen match to
  `PageHeader`, `SectionHeader`, `text-body`, or `text-caption`.

- [ ] **Step 7: Commit the consistency pass**

```bash
git add apps/mobile/src/features/devtools/DevtoolsScreen.tsx apps/mobile/src/components/EmptyState.tsx apps/mobile/src/components/ErrorState.tsx apps/mobile/src/components/LoadingState.tsx apps/mobile/__tests__/devtools-screen.test.tsx apps/mobile/__tests__/shared-components.test.tsx
git commit -m "feat(mobile): finish app-wide UI polish"
```

### Task 9: Verify behavior, Android build, and the two reported layouts

**Files:**

- Verify only: all files changed in Tasks 1–8
- Reference: `docs/superpowers/specs/2026-08-17-mobile-ui-polish-design.md`

**Interfaces:** None. This task proves the integrated result.

- [ ] **Step 1: Confirm scope and formatting**

```bash
git status --short
git diff --check f07921f..HEAD
deno fmt --check apps/mobile/app apps/mobile/src apps/mobile/__tests__ apps/mobile/tailwind.config.js
```

Expected: only planned mobile files are changed, diff check is clean, and all
checked files are formatted.

- [ ] **Step 2: Run the complete automated verification sequentially**

```bash
deno task mobile:test --runInBand
deno task mobile:typecheck
deno task check:api
deno task build:android
```

Expected:

- Every Jest suite passes.
- Mobile TypeScript emits no errors.
- Server API checking still passes despite no intended server changes.
- Metro bundles and Gradle ends with `BUILD SUCCESSFUL`.

- [ ] **Step 3: Perform Android visual acceptance on the seeded German flow**

Launch the existing Android development build with the repository's Deno task:

```bash
deno task mobile:android
```

Use the deterministic German seed through Development tools, then verify these
exact states on an Android emulator or device:

1. Decks shows one “Decks” title, one secondary “New deck” action, and German as
   a full-width row with icon, chevron, pressed feedback, and a reliable
   full-row touch target.
2. New deck opens inline; Cancel clears and closes it; a forced failed request
   leaves its text and error visible.
3. Deck detail and note detail show explicit back affordances and list rows.
4. Review before reveal shows no grades; after reveal it shows pronunciation as
   secondary and Again/Hard plus Good/Easy as two equal rows.
5. Scrolling Review to the end leaves visible background between the grade grid
   and Android system navigation.
6. Add shows selected deck state without looking disabled and separates Save
   from Discard.
7. Today, Settings, auth, and devtools each show one page title and no clipped
   final control.

Record any visual mismatch as a failing acceptance item, add the smallest
targeted test, fix it, rerun the affected focused suite plus typecheck, and
commit the correction before proceeding.

- [ ] **Step 4: Confirm the final branch state**

```bash
git status --short
git log --oneline f07921f..HEAD
```

Expected: clean worktree and the planned sequence of focused implementation
commits. Do not merge, push, or open a pull request without a separate user
instruction.
