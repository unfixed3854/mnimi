# React Native Tab Bar Icons and Layout Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Expo Router's Android missing-icon fallback with native tab icons and restore consistent vertical spacing between direct screen-level controls.

**Architecture:** Keep Expo Router's existing Tabs navigator and route structure. Add explicit `Ionicons` callbacks to the four existing tab definitions, passing through the navigator's focused state, tint color, and size. Add one baseline vertical gap to the shared `Screen` scroll content container so all screen-level siblings receive consistent spacing without duplicating margins in feature screens.

**Tech Stack:** Deno workspace tasks, Expo SDK 57, React Native 0.86, Expo Router, `@expo/vector-icons`, Jest Expo, React Native Testing Library, TypeScript.

## Global Constraints

- Use `deno` for all package management and script execution; do not use `npm`, `npx`, `yarn`, or `pnpm`.
- Do not change route names, tab titles, accessibility labels, API behavior, or server code.
- Use `@expo/vector-icons` `Ionicons`; do not use Unicode glyphs or custom SVG rendering for the tab icons.
- Production code changes require a focused failing test first, followed by the smallest implementation that makes it pass.
- Run generated-type-dependent checks sequentially, and run `git diff --check` before claiming completion.

---

### Task 1: Add the native icon dependency and regression tests

**Files:**
- Modify: `apps/mobile/package.json` through `deno add`
- Modify: `deno.lock` through the same Deno dependency update
- Modify: `apps/mobile/__tests__/navigation-shell.test.tsx`
- Modify: `apps/mobile/__tests__/screen-scroll.test.tsx`

**Interfaces:**
- The tab test mock records each `Tabs.Screen` options object in `mockTabOptions`.
- The production tab layout will provide `options.tabBarIcon({ focused, color, size })` for each of the four screens.
- The shared screen test will observe `contentContainerStyle.gap` on the existing `screen-scroll-content` node.

- [ ] **Step 1: Add the Expo-compatible icon dependency**

Run:

```bash
deno add npm:@expo/vector-icons@^15.0.3
deno install
```

Expected: `apps/mobile/package.json` declares `@expo/vector-icons` and the root `deno.lock` records its resolved dependency without changing application source files.

- [ ] **Step 2: Make the tab test capture options and add the failing icon assertion**

In `apps/mobile/__tests__/navigation-shell.test.tsx`, add a module-level `mockTabOptions` array, clear it in `beforeEach`, and replace the `Tabs.Screen` mock with:

```tsx
Tabs.Screen = ({ options }: { options: { title: string; tabBarIcon?: unknown } }) => {
  mockTabOptions.push(options);
  return <Text>{options.title}</Text>;
};
```

Add this test to the existing `native navigation shell` suite:

```tsx
it("provides a native icon callback for every primary tab", async () => {
  setSessionForTest({
    user: {
      id: "user-1",
      email: "ada@example.com",
      name: "Ada",
      nativeLanguage: "en",
      uiLanguage: "en",
      ttsAutoplay: true,
    },
  });

  await render(<RootLayout />);

  expect(mockTabOptions).toHaveLength(4);
  for (const options of mockTabOptions) {
    expect(options.tabBarIcon).toEqual(expect.any(Function));
  }
});
```

The test should observe the current behavior: all four `tabBarIcon` properties are `undefined`.

- [ ] **Step 3: Add the failing shared-spacing assertion**

Extend the existing `Screen` test assertion in `apps/mobile/__tests__/screen-scroll.test.tsx`:

```tsx
expect(scroll.props.contentContainerStyle).toEqual(
  expect.objectContaining({ flexGrow: 1, gap: 16 }),
);
```

The test should fail because the current content style has `flexGrow: 1` but no `gap`.

- [ ] **Step 4: Run the focused tests and verify the failures are meaningful**

Run:

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/navigation-shell.test.tsx apps/mobile/__tests__/screen-scroll.test.tsx
```

Expected: the existing tests pass, the new icon test fails because each tab lacks `tabBarIcon`, and the spacing test fails because `gap` is absent. Do not edit production code until both failures are confirmed.

- [ ] **Step 5: Commit the dependency and red tests**

```bash
git add apps/mobile/package.json deno.lock apps/mobile/__tests__/navigation-shell.test.tsx apps/mobile/__tests__/screen-scroll.test.tsx
git commit -m "test: cover native tab icons and screen spacing"
```

### Task 2: Implement explicit tab icons and shared spacing

**Files:**
- Modify: `apps/mobile/app/(tabs)/_layout.tsx`
- Modify: `apps/mobile/src/components/Screen.tsx`

**Interfaces:**
- `Tabs.Screen` retains the existing `name`, `title`, `tabBarAccessibilityLabel`, and Add-tab `headerRight` options.
- Each `tabBarIcon` callback accepts `{ focused, color, size }` and returns an `Ionicons` element.
- `Screen` continues to expose `screenSafeAreaEdges`, `testID`, keyboard avoidance, and scroll behavior unchanged.

- [ ] **Step 1: Add the minimal explicit Ionicons callbacks**

Import `Ionicons` from `@expo/vector-icons` in `apps/mobile/app/(tabs)/_layout.tsx`. Add these callbacks to the matching `Tabs.Screen` options:

```tsx
tabBarIcon: ({ focused, color, size }) => (
  <Ionicons name={focused ? "calendar" : "calendar-outline"} color={color} size={size} />
)
```

Use the same shape with these names:

```tsx
// decks:  focused "layers",          unfocused "layers-outline"
// add:    focused "add-circle",      unfocused "add-circle-outline"
// settings: focused "settings",      unfocused "settings-outline"
```

Preserve all current tab screen options and order.

- [ ] **Step 2: Add the shared baseline gap**

Update `styles.content` in `apps/mobile/src/components/Screen.tsx` from:

```tsx
content: { flexGrow: 1 },
```

to:

```tsx
content: { flexGrow: 1, gap: theme.spacing.md },
```

Do not move or remove the existing screen padding, keyboard behavior, scroll persistence, or safe-area edges.

- [ ] **Step 3: Run the focused tests and verify they pass**

Run:

```bash
deno task mobile:test --runInBand apps/mobile/__tests__/navigation-shell.test.tsx apps/mobile/__tests__/screen-scroll.test.tsx
```

Expected: all tests pass, including four non-undefined tab icon callbacks and the `gap: 16` screen-content assertion.

- [ ] **Step 4: Commit the implementation**

```bash
git add apps/mobile/app/'(tabs)'/_layout.tsx apps/mobile/src/components/Screen.tsx
git commit -m "fix: restore native tab icons and screen spacing"
```

### Task 3: Run complete sequential verification

**Files:**
- Inspect only: all files changed by Tasks 1–2 and generated Android build output.

- [ ] **Step 1: Run the mobile typecheck**

Run:

```bash
deno task mobile:typecheck
```

Expected: TypeScript exits successfully with no new errors.

- [ ] **Step 2: Run the complete mobile test suite**

Run:

```bash
deno task mobile:test --runInBand
```

Expected: every mobile Jest suite passes.

- [ ] **Step 3: Run the API check**

Run:

```bash
deno task check:api
```

Expected: the unchanged server code typechecks successfully.

- [ ] **Step 4: Build the Android release artifact**

Run:

```bash
deno task build:android
```

Expected: the existing Android build task completes successfully with the new vector-icon dependency bundled.

- [ ] **Step 5: Check the final diff**

Run:

```bash
git diff --check HEAD~2..HEAD && git status --short
```

Expected: no whitespace errors; only the intentional dependency, test, tab-layout, shared-screen, and documentation commits are present. Report any pre-existing unrelated worktree change separately.

## Plan self-review

- The approved design's four icon mappings are covered in Task 2 and its callback presence is covered in Task 1.
- The approved shared `Screen` gap is covered by a failing test in Task 1 and the minimal implementation in Task 2.
- No server, route, API, accessibility-label, or behavior changes are included.
- Every production change follows a test-first step, and all commands use Deno.
- There are no placeholder steps or undefined file/function names.
