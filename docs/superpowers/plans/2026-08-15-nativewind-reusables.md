# NativeWind and React Native Reusables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile app's hand-written static styling with stable
NativeWind 4.2.6 and repository-owned React Native Reusables primitives while
preserving all current Android workflows, accessibility behavior, navigation,
and async state semantics.

**Architecture:** Configure NativeWind at the `apps/mobile` Metro/Babel
boundary, define the existing semantic design tokens in Tailwind, and keep a
small runtime color bridge only for native props that cannot consume
`className`. Add Reusables source primitives under `src/components/ui`, retain
app-level wrappers for behavior, and convert every route/feature/shared
component in one styling rewrite.

**Tech Stack:** Deno workspace, Expo SDK 57, React Native 0.86, NativeWind
4.2.6, Tailwind CSS 3.4.17, React Native Reusables source components,
`class-variance-authority`, `clsx`, `tailwind-merge`, `@rn-primitives/*`, Jest
Expo, React Native Testing Library.

## Global Constraints

- Use Deno for every package-management and script command; package references
  use `npm:` inside Deno commands and no direct npm, npx, yarn, or pnpm command
  is allowed.
- Use stable NativeWind 4.2.6 with Tailwind CSS 3.4.17; do not adopt NativeWind
  5 preview or Tailwind CSS 4.
- Preserve current route names, accessibility labels/roles,
  authentication/session behavior, API contracts, query invalidation, draft
  lifecycle, FSRS behavior, audio/media ownership, and development-only gating.
- Use Tailwind semantic tokens for static layout, color, spacing, borders, and
  typography; retain object styles only for navigator APIs, native props
  requiring a color/value, or genuinely calculated runtime dimensions.
- Reusables components are checked-in source under
  `apps/mobile/src/components/ui`; do not introduce an opaque UI runtime
  package.
- Run generated-type-dependent checks sequentially and run `git diff --check`
  before claiming completion.

---

### Task 1: Configure NativeWind, Tailwind tokens, and the native root

**Files:**

- Modify: `apps/mobile/package.json`, `deno.lock`
- Modify: `apps/mobile/babel.config.js`, `apps/mobile/tsconfig.json`,
  `apps/mobile/jest.config.js`, `apps/mobile/app/_layout.tsx`
- Create: `apps/mobile/metro.config.js`, `apps/mobile/tailwind.config.js`,
  `apps/mobile/global.css`, `apps/mobile/nativewind-env.d.ts`
- Create: `apps/mobile/__mocks__/styleMock.js`,
  `apps/mobile/__tests__/nativewind-root.test.tsx`

**Interfaces:**

- `tailwind.config.js` exports the NativeWind preset and semantic tokens
  `background`, `surface`, `foreground`, `muted-foreground`, `border`,
  `primary`, `primary-foreground`, `destructive`, `destructive-foreground`, and
  `focus`.
- `AppProviders` renders one `PortalHost` with `testID="nativewind-portal-host"`
  inside the existing `SafeAreaProvider` and `QueryClientProvider` hierarchy.
- Jest resolves `*.css` imports to `__mocks__/styleMock.js` and resolves the
  `@/*` alias to `apps/mobile/src/*`.

- [ ] **Step 1: Add the failing root integration test**

Create `apps/mobile/__tests__/nativewind-root.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { AppProviders } from "../app/_layout";

describe("NativeWind root integration", () => {
  it("mounts styled descendants and the Reusables portal host", () => {
    render(
      <AppProviders>
        <Text className="text-foreground" testID="nativewind-descendant">
          Ready
        </Text>
      </AppProviders>,
    );

    expect(screen.getByTestId("nativewind-descendant")).toBeTruthy();
    expect(screen.getByTestId("nativewind-portal-host")).toBeTruthy();
  });
});
```

Run:

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/nativewind-root.test.tsx
```

Expected: FAIL because the NativeWind declaration/configuration and root portal
host do not exist.

- [ ] **Step 2: Add the compatible dependencies through Deno**

From `apps/mobile`, add the Expo SDK 57-compatible native packages and Reusables
support packages:

```bash
cd apps/mobile
deno add --package-json npm:nativewind@4.2.6 npm:react-native-reanimated@4.5.1 npm:react-native-worklets@0.10.1 npm:class-variance-authority@0.7.1 npm:clsx@2.1.1 npm:tailwind-merge@3.6.0 npm:tailwindcss-animate@1.0.7 npm:@rn-primitives/alert-dialog@1.5.2 npm:@rn-primitives/portal@1.5.3 npm:@rn-primitives/slot@1.5.2
deno add --package-json --dev npm:tailwindcss@3.4.17
deno install
```

Confirm `apps/mobile/package.json` owns the new mobile dependencies and
`deno.lock` records them. Do not add them to server-only dependency sections or
alter unrelated existing resolutions.

- [ ] **Step 3: Create the NativeWind configuration**

Create `apps/mobile/tailwind.config.js` with these exact semantic extensions:

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#FAF8F3",
        surface: "#FFFFFF",
        foreground: "#1D1C1A",
        "muted-foreground": "#68645E",
        border: "#DDD8CF",
        primary: "#315C4D",
        "primary-foreground": "#FFFFFF",
        destructive: "#B53B32",
        "destructive-foreground": "#FFFFFF",
        focus: "#1B6C9C",
      },
      spacing: {
        xs: "4px",
        sm: "8px",
        md: "16px",
        lg: "24px",
        xl: "32px",
      },
      borderRadius: {
        md: "12px",
        lg: "18px",
      },
      fontSize: {
        eyebrow: ["16px", { lineHeight: "24px" }],
        body: ["16px", { lineHeight: "24px" }],
        caption: ["15px", { lineHeight: "22px" }],
        title: ["32px", { lineHeight: "38px" }],
        hero: ["72px", { lineHeight: "80px" }],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
```

Create `apps/mobile/global.css` with the Tailwind directives:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Create `apps/mobile/metro.config.js` using `withNativeWind` and `inlineRem: 16`,
and update `apps/mobile/babel.config.js` to use:

```js
presets: [
  ["babel-preset-expo", { jsxImportSource: "nativewind" }],
  "nativewind/babel",
],
```

Create `apps/mobile/nativewind-env.d.ts` containing exactly:

```ts
/// <reference types="nativewind/types" />
```

Add `nativewind-env.d.ts` to the mobile TypeScript `include` list, add
`baseUrl: "."` and `paths: { "@/*": ["./src/*"] }`, and map `^@/(.*)$` to
`<rootDir>/src/$1` in Jest.

Create `__mocks__/styleMock.js` exporting an empty object and map `\\.css$` to
it so the root layout's CSS import remains testable without a CSS parser.

- [ ] **Step 4: Integrate CSS and the portal host without changing providers**

In `apps/mobile/app/_layout.tsx`:

```tsx
import "../global.css";
import { PortalHost } from "@rn-primitives/portal";
```

Render `<PortalHost testID="nativewind-portal-host" />` inside
`SafeAreaProvider`, leaving the existing QueryClient, session initialization,
rejection handling, lifecycle, and connectivity hooks unchanged.

- [ ] **Step 5: Run the root test and typecheck**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/nativewind-root.test.tsx
deno task mobile:typecheck
```

Expected: the root test and typecheck pass with `className` accepted on React
Native elements and the portal host mounted.

- [ ] **Step 6: Commit the infrastructure**

```bash
git add apps/mobile deno.lock
git commit -m "feat: configure NativeWind mobile styling"
```

### Task 2: Add repository-owned Reusables primitives and runtime token bridge

**Files:**

- Create: `apps/mobile/src/lib/utils.ts`
- Create: `apps/mobile/src/theme/native-colors.ts`
- Create: `apps/mobile/src/components/ui/text.tsx`
- Create: `apps/mobile/src/components/ui/button.tsx`
- Create: `apps/mobile/src/components/ui/input.tsx`
- Create: `apps/mobile/src/components/ui/card.tsx`
- Create: `apps/mobile/src/components/ui/alert-dialog.tsx`
- Create: `apps/mobile/__tests__/ui-primitives.test.tsx`

**Interfaces:**

- `cn(...inputs: ClassValue[]): string` merges conditional class names with
  `clsx` and `tailwind-merge`.
- `Text` is a forwarded React Native text primitive with `className` support and
  `text-foreground`/`text-body` defaults.
- `Button` accepts `variant` (`default`, `destructive`, `secondary`, `outline`,
  `ghost`, `link`), `size` (`default`, `sm`, `lg`, `icon`), `className`, and
  standard `Pressable` props.
- `ButtonText` and `buttonVariants`/`buttonTextVariants` expose the same
  variants for app wrappers and Expo Router links.
- `Input` forwards a `TextInput` ref and accepts `className` while preserving
  all native input props.
- `Card`, `CardHeader`, `CardContent`, `CardFooter`, `CardTitle`, and
  `CardDescription` provide class-based surface composition.
- `AlertDialog` exports the checked-in alert-dialog compound components consumed
  by `ConfirmDialog`.
- `nativeColors` contains only runtime values required by native props such as
  `ActivityIndicator`, `placeholderTextColor`, and Expo Router navigation
  options; it is not used for static layout styling.

- [ ] **Step 1: Add the failing primitive contract tests**

Create `ui-primitives.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react-native";
import { Button, ButtonText } from "../src/components/ui/button";
import { Card, CardContent } from "../src/components/ui/card";
import { Input } from "../src/components/ui/input";
import { Text } from "../src/components/ui/text";

describe("UI primitives", () => {
  it("renders a destructive button with accessible text", () => {
    render(
      <Button variant="destructive">
        <ButtonText>Remove</ButtonText>
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("renders text, input, and card composition", () => {
    render(
      <Card>
        <CardContent>
          <Text>Deck</Text>
          <Input accessibilityLabel="Deck name" />
        </CardContent>
      </Card>,
    );
    expect(screen.getByText("Deck")).toBeTruthy();
    expect(screen.getByLabelText("Deck name")).toBeTruthy();
  });
});
```

Run:

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/ui-primitives.test.tsx
```

Expected: FAIL because the checked-in UI primitives do not yet exist.

- [ ] **Step 2: Implement the shared utility and text primitive**

Implement `cn` as:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Implement `Text` with `React.forwardRef`, defaulting to
`className="text-body text-foreground"`, merging caller classes after defaults,
and preserving `accessibilityRole`, `numberOfLines`, and all native `TextProps`.

- [ ] **Step 3: Implement button, input, and card primitives**

Use `cva` for the button variants. The default and destructive variants must map
to `bg-primary text-primary-foreground` and
`bg-destructive text-destructive-foreground`; outline, secondary, ghost, and
link must remain readable against the warm background. Apply `opacity-55` for
disabled state and `opacity-80` for pressed state. `ButtonText` must inherit the
button text variant through the Reusables text context while allowing an
explicit caller class to override it.

Forward refs from `Input`, preserve `editable`, `secureTextEntry`, keyboard,
placeholder, and accessibility props, and use
`border border-border bg-surface text-foreground` with `min-h-[48px]`,
`rounded-md`, and `px-md` defaults. Add a `focus:border-focus` class without
changing existing error handling.

Implement card primitives with `bg-surface`, `border`, `border-border`,
`rounded-md`, `p-md`, and `gap-sm` defaults, exposing header/content/footer
slots for screen-specific composition.

- [ ] **Step 4: Add the alert-dialog source and runtime colors**

Compose the `@rn-primitives/alert-dialog` primitives with NativeWind classes and
the portal host configured in Task 1. Keep the modal backdrop opaque enough for
Android, use `max-w-[480px]`, `w-full`, `rounded-lg`, `bg-surface`, and `p-lg`,
and preserve the destructive action variant.

Create `native-colors.ts`:

```ts
export const nativeColors = {
  background: "#FAF8F3",
  foreground: "#1D1C1A",
  mutedForeground: "#68645E",
  primary: "#315C4D",
  primaryForeground: "#FFFFFF",
  destructive: "#B53B32",
} as const;
```

- [ ] **Step 5: Run primitive tests and commit**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/ui-primitives.test.tsx
deno task mobile:typecheck
git add apps/mobile
git commit -m "feat: add native reusable UI primitives"
```

### Task 3: Rewrite shared application components

**Files:**

- Modify: `apps/mobile/src/components/Screen.tsx`
- Modify: `apps/mobile/src/components/PrimaryButton.tsx`
- Modify: `apps/mobile/src/components/TextField.tsx`
- Modify: `apps/mobile/src/components/ConfirmDialog.tsx`
- Modify: `apps/mobile/src/components/CardEditor.tsx`
- Modify: `apps/mobile/src/components/CardFace.tsx`
- Modify: `apps/mobile/src/components/DeckPicker.tsx`
- Modify: `apps/mobile/src/components/DraftIndicator.tsx`
- Modify: `apps/mobile/src/components/DraftStatus.tsx`
- Modify: `apps/mobile/src/components/EmptyState.tsx`
- Modify: `apps/mobile/src/components/ErrorState.tsx`
- Modify: `apps/mobile/src/components/GeneratedImage.tsx`
- Modify: `apps/mobile/src/components/ImageCueReviewCard.tsx`
- Modify: `apps/mobile/src/components/LoadingState.tsx`
- Modify: `apps/mobile/src/components/PronunciationControl.tsx`
- Modify: `apps/mobile/src/components/StreamingCards.tsx`
- Create: `apps/mobile/__tests__/shared-components.test.tsx`

**Interfaces:**

- `Screen` adds optional `className?: string` while retaining `style`, `testID`,
  safe-area edges, keyboard behavior, and `screen-scroll-content`.
- `PrimaryButton`, `TextField`, `ConfirmDialog`, `CardEditor`, `DeckPicker`, and
  status/media components retain their current props and user-facing labels.
- No component imports `theme` for static styling after this task; native
  runtime colors come from `native-colors.ts`.

- [ ] **Step 1: Add failing shared-component assertions**

Create `shared-components.test.tsx` with these contract checks before rewriting
the components:

```tsx
import { fireEvent, render, screen } from "@testing-library/react-native";
import { PrimaryButton } from "../src/components/PrimaryButton";
import { TextField } from "../src/components/TextField";

it("keeps PrimaryButton busy and destructive semantics", async () => {
  const onPress = jest.fn(() => new Promise<void>(() => undefined));
  render(<PrimaryButton destructive onPress={onPress}>Remove</PrimaryButton>);
  fireEvent.press(screen.getByRole("button", { name: "Remove" }));
  expect(
    screen.getByRole("button", { name: "Remove" }).props.accessibilityState,
  ).toEqual(
    expect.objectContaining({ busy: true, disabled: true }),
  );
});

it("keeps TextField label and accessible error", () => {
  render(<TextField label="Front" error="Required" />);
  expect(screen.getByLabelText("Front")).toBeTruthy();
  expect(screen.getByRole("alert")).toHaveTextContent("Required");
});
```

Run the focused test. Expected: the new module assertions fail before the
component migration because the test imports the new UI composition contract.

- [ ] **Step 2: Rewrite Screen and the primary control wrappers**

Update `Screen` to use `className={cn("flex-1 bg-background px-md", className)}`
on `SafeAreaView`, `className="flex-1"` on `KeyboardAvoidingView`, and
`contentContainerClassName="grow gap-md"` on `ScrollView`. Keep
`keyboardShouldPersistTaps="handled"` and all test IDs.

Update `PrimaryButton` to compose `Button` and `ButtonText`. Keep
`unavailable = disabled || pending || submitting`, the `try/finally` submission
guard, the current accessibility label derivation, and
`accessibilityState={{ disabled: unavailable, busy: pending || submitting }}`.
Render `ActivityIndicator color={nativeColors.primaryForeground}` before the
text while pending.

Update `TextField` to compose a `View className="gap-xs"`, Reusables `Text`, and
`Input`; keep `accessibilityLabel`, disabled accessibility state, native input
props, placeholder color from `nativeColors.mutedForeground`, and error alert
text.

- [ ] **Step 3: Rewrite dialog, cards, and status/media components**

Replace the controlled `Modal` in `ConfirmDialog` with the checked-in
alert-dialog composition. Map `visible` to `open`, call `onCancel` only when a
non-pending dialog closes, disable cancel while pending, and invoke `onConfirm`
from the action. Keep the existing `title`, `message`, `confirmLabel`,
destructive, pending, and Android back behavior.

Convert all remaining shared components to NativeWind classes using this
mapping:

| Existing style responsibility      | NativeWind/Reusables mapping                          |
| ---------------------------------- | ----------------------------------------------------- |
| Surface card                       | `bg-surface border border-border rounded-md p-md`     |
| Large surface card                 | `bg-surface border border-border rounded-lg p-xl`     |
| Main text                          | `text-foreground`                                     |
| Muted/caption text                 | `text-muted-foreground`                               |
| Error text                         | `text-destructive`                                    |
| Primary action                     | `bg-primary text-primary-foreground`                  |
| Content stack                      | `gap-sm`, `gap-md`, or `gap-lg`                       |
| Centered empty/error/loading state | `items-center gap-sm p-xl`                            |
| Image                              | `self-center h-48 w-48 rounded-md mb-lg`              |
| Draft indicator dot                | `h-2 w-2 rounded-full bg-primary` or `bg-destructive` |

Keep `GeneratedImage` file ownership/deletion and status transitions unchanged,
using `nativeColors.primary` only for the spinner. Keep `CardFace` cloze parsing
and nested text semantics unchanged. Keep pronunciation generation/autoplay
identity guards unchanged.

- [ ] **Step 4: Run shared tests and commit**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/shared-components.test.tsx apps/mobile/__tests__/screen-scroll.test.tsx apps/mobile/__tests__/pronunciation-control.test.tsx apps/mobile/__tests__/use-card-audio.test.ts
deno task mobile:typecheck
git add apps/mobile
git commit -m "refactor: migrate shared mobile components to NativeWind"
```

### Task 4: Rewrite authentication, Today, decks, and navigation screens

**Files:**

- Modify: `apps/mobile/app/(auth)/login.tsx`,
  `apps/mobile/app/(auth)/signup.tsx`
- Modify: `apps/mobile/app/(tabs)/_layout.tsx`
- Modify: `apps/mobile/src/features/auth/AuthForm.tsx`
- Modify: `apps/mobile/src/features/today/TodayScreen.tsx`
- Modify: `apps/mobile/src/features/decks/DeckListScreen.tsx`
- Modify: `apps/mobile/src/features/decks/DeckDetailScreen.tsx`
- Modify: `apps/mobile/__tests__/auth-form.test.tsx`,
  `apps/mobile/__tests__/deck-list-screen.test.tsx`,
  `apps/mobile/__tests__/deck-detail-screen.test.tsx`,
  `apps/mobile/__tests__/navigation-shell.test.tsx`

**Interfaces:**

- Auth, Today, DeckList, and DeckDetail exports keep their current props and
  route behavior.
- Tab titles, accessibility labels, tab icon callbacks, `headerRight`,
  active/inactive tint, and route names remain unchanged.
- Link components use `buttonVariants({ variant: "link" })` and
  `buttonTextVariants({ variant: "link" })` only for presentation; navigation
  destinations do not change.

- [ ] **Step 1: Add failing class/variant regression assertions**

Extend the navigation and deck tests before editing production screens:

```tsx
expect(screen.getByRole("link", { name: "Create an account" }).props.className)
  .toContain("text-primary");
expect(screen.getByRole("button", { name: "Remove deck" }).props.className)
  .toContain("bg-destructive");
```

Run the focused auth/deck/navigation test set and confirm the new class
assertions fail while existing behavior assertions remain green.

- [ ] **Step 2: Convert auth and Today layouts**

Use `Screen`, Reusables `Text`, `TextField`, `Button`, and `ButtonText` with
explicit classes. Preserve auth form validation, error copy, pending state,
input retention, header roles, and links. Convert Today to
`className="justify-center"`, `text-eyebrow`, `text-title`, `text-hero`,
`text-body`, and `text-primary`/`text-muted-foreground` classes without changing
due-count logic.

- [ ] **Step 3: Convert deck list/detail layouts**

Use the existing primary/destructive/disabled button variants, surface card/link
classes, and stack gaps. Preserve create/remove mutation guards, error states,
deck/note destinations, due-count copy, confirmation flow, and the awaited
post-delete navigation behavior.

- [ ] **Step 4: Remove static theme styling from tab navigation**

Replace the tab layout's `theme` import with `nativeColors` for the Expo Router
option values that require JavaScript colors. Leave the existing Ionicons
callbacks and tab options intact.

- [ ] **Step 5: Run focused tests and commit**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/auth-form.test.tsx apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx apps/mobile/__tests__/navigation-shell.test.tsx
deno task mobile:typecheck
git add apps/mobile
git commit -m "refactor: migrate auth and deck screens to NativeWind"
```

### Task 5: Rewrite add, note, review, settings, and development-tool screens

**Files:**

- Modify: `apps/mobile/src/features/add/AddScreen.tsx`
- Modify: `apps/mobile/src/features/notes/NoteScreen.tsx`
- Modify: `apps/mobile/src/features/review/ReviewScreen.tsx`
- Modify: `apps/mobile/src/features/settings/SettingsScreen.tsx`
- Modify: `apps/mobile/src/features/devtools/DevtoolsScreen.tsx`
- Modify: `apps/mobile/app/(tabs)/add.tsx`,
  `apps/mobile/app/(tabs)/settings.tsx`, `apps/mobile/app/notes/[noteId].tsx`,
  `apps/mobile/app/review/[deckId].tsx`, `apps/mobile/app/decks/[deckId].tsx`,
  `apps/mobile/app/devtools.tsx`
- Modify: `apps/mobile/__tests__/add-screen.test.tsx`,
  `apps/mobile/__tests__/note-screen.test.tsx`,
  `apps/mobile/__tests__/review-screen.test.tsx`,
  `apps/mobile/__tests__/settings-screen.test.tsx`,
  `apps/mobile/__tests__/devtools-screen.test.tsx`,
  `apps/mobile/__tests__/draft-autosave.test.tsx`,
  `apps/mobile/__tests__/draft-indicator-tab.test.tsx`

**Interfaces:**

- All feature exports preserve current props, query/mutation calls,
  loading/error branches, draft reducer/watch integration, and navigation calls.
- Review identity remains keyed by `card.id`; image/audio state remains scoped
  to its stable owner; settings writes remain serialized.
- Development tools remain gated by `__DEV__` and the server's devtools
  authorization.

- [ ] **Step 1: Add failing representative class assertions**

Add assertions to the existing feature tests before conversion:

```tsx
expect(screen.getByRole("button", { name: "Generate cards" }).props.className)
  .toContain("bg-primary");
expect(screen.getByRole("button", { name: "Sign out" }).props.className)
  .toContain("bg-destructive");
expect(screen.getByText("Cards").props.className).toContain("text-foreground");
```

Run the affected feature test files and confirm only the new class assertions
fail.

- [ ] **Step 2: Convert Add and generated-draft screens**

Use class-based stacks, labels, cards, draft status, streaming cards, deck
selection, retry controls, and action groups. Preserve draft
loading/none/generating/failed/saved branches, autosave and discard cleanup,
image retry behavior, and the rule that saving is allowed while an image is
still generating.

- [ ] **Step 3: Convert Note and Review screens**

Use cards for editable note cards and review surfaces, preserve cloze rendering,
image-cue reveal, first due-card queue semantics, audio controls, failed-grade
retention, and all authenticated media lifecycle behavior. Keep route back links
and review button labels unchanged.

- [ ] **Step 4: Convert Settings and Development Tools**

Use text/button/card classes for account content, language picker content,
autoplay row, sign-out action, SRS scope controls, seed action, and status/error
messages. Keep native `Switch` and the existing language `Modal` behavior.
Preserve `__DEV__` navigation gating and all reset/seed mutation guards.

- [ ] **Step 5: Run all feature tests and commit**

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/add-screen.test.tsx apps/mobile/__tests__/note-screen.test.tsx apps/mobile/__tests__/review-screen.test.tsx apps/mobile/__tests__/settings-screen.test.tsx apps/mobile/__tests__/devtools-screen.test.tsx apps/mobile/__tests__/draft-autosave.test.tsx apps/mobile/__tests__/draft-indicator-tab.test.tsx
deno task mobile:typecheck
git add apps/mobile
git commit -m "refactor: migrate mobile feature screens to NativeWind"
```

### Task 6: Remove the old styling layer, update regression coverage, and verify the app

**Files:**

- Delete: `apps/mobile/src/theme/index.ts`
- Modify: `apps/mobile/__tests__/screen-scroll.test.tsx`,
  `apps/mobile/__tests__/legacy-web-files.test.ts`,
  `apps/mobile/__tests__/repository-test-task.test.ts`
- Inspect and remove: all remaining `StyleSheet` imports/blocks and static
  `theme` style consumers under `apps/mobile/app` and `apps/mobile/src`

**Interfaces:**

- `Screen` tests observe `contentContainerClassName` containing `grow` and
  `gap-md`, while keyboard persistence remains `handled`.
- The repository absence test covers the obsolete theme file in addition to
  existing web/Tauri artifacts.
- No API/server/shared files change during cleanup.

- [ ] **Step 1: Update the screen and repository regression tests**

Change the screen assertion to:

```tsx
expect(scroll.props.contentContainerClassName).toEqual(
  expect.stringContaining("grow"),
);
expect(scroll.props.contentContainerClassName).toEqual(
  expect.stringContaining("gap-md"),
);
```

Extend `legacy-web-files.test.ts` to assert that `src/theme/index.ts` is absent
after migration. Keep its existing checks for Vite, Tauri, React DOM, and other
obsolete web artifacts.

- [ ] **Step 2: Remove old static styling artifacts**

Run:

```bash
rg -n 'StyleSheet|styles\\.|theme' apps/mobile/app apps/mobile/src
```

Remove every remaining `StyleSheet.create` block and replace any static
style-only theme import with NativeWind classes. Keep `native-colors.ts` only
for native props that cannot consume classes. Delete `src/theme/index.ts` once
the search shows no consumer.

- [ ] **Step 3: Run the complete sequential verification**

```bash
deno task mobile:typecheck
deno task mobile:test --runInBand
deno task check:api
deno task build:android
git diff --check
```

Expected: all commands exit successfully. The Android build must complete with
NativeWind Metro processing and the Reusables alert-dialog portal bundled.

- [ ] **Step 4: Inspect the final scope and commit**

```bash
git status -sb
git diff --stat HEAD~5..HEAD
git diff -- apps/server libs/shared
```

Confirm that the diff contains only mobile styling/configuration, checked-in UI
primitives, mobile tests, and the implementation plan/spec commits. Then commit
cleanup if it is not already included in the preceding task commit:

```bash
git add apps/mobile deno.lock
git commit -m "refactor: remove legacy mobile styling layer"
```

## Plan self-review

- The approved architecture is covered by Tasks 1–2: stable NativeWind
  configuration, semantic Tailwind tokens, checked-in Reusables primitives,
  portal integration, and runtime native colors.
- Every shared component and every feature screen named in the approved scope is
  assigned to Tasks 3–5.
- Behavior preservation is explicit in each feature task and is verified by the
  existing focused tests plus the complete mobile suite.
- The old theme and all `StyleSheet.create` blocks are removed and checked by
  Task 6.
- All package and script commands use Deno; no direct npm, npx, yarn, or pnpm
  invocation appears in the plan.
- No step contains TBD/TODO language or depends on an undefined function or
  file.
