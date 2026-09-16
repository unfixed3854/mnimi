# React Native Tab Bar Icons and Layout Spacing Design

## Goal

Restore readable native icons in the Android bottom tab bar and restore consistent vertical spacing between direct screen-level controls after the React Native migration.

## Context and root cause

The Expo Router tabs currently define titles but no `tabBarIcon` callbacks. Expo Router therefore renders its built-in `MissingIcon` fallback for every tab. That fallback uses a Unicode glyph which Android renders as a missing-glyph rectangle with an x-like mark.

The shared `Screen` component currently gives its `ScrollView` content only `flexGrow: 1`. Screens that render a `TextField`, `PrimaryButton`, error text, or another control as direct siblings therefore have no shared vertical layout gap; spacing exists only in some nested feature containers.

## Design

### Native tab icons

Use Expo's supported `@expo/vector-icons` package and the `Ionicons` set. Each tab gets an explicit focused and unfocused icon while retaining the existing tab titles, colors, labels, and route names:

| Route | Focused | Unfocused |
| --- | --- | --- |
| Today | `calendar` | `calendar-outline` |
| Decks | `layers` | `layers-outline` |
| Add | `add-circle` | `add-circle-outline` |
| Settings | `settings` | `settings-outline` |

The callbacks pass React Navigation's supplied `color` and `size` values to `Ionicons`, so active/inactive tinting remains owned by the existing `Tabs` configuration. No custom SVG renderer or Unicode substitute is introduced.

### Shared screen spacing

Add `gap: theme.spacing.md` to the shared `Screen` scroll content container. This gives every screen a predictable baseline between direct children, including inputs followed by buttons, while preserving the existing nested `gap`, margin, and action-group rules. The change remains in the shared layout primitive rather than duplicating one-off margins across feature screens.

## Files and boundaries

- Modify `apps/mobile/package.json` and `deno.lock` to add the Expo-compatible vector icon dependency through Deno.
- Modify `apps/mobile/app/(tabs)/_layout.tsx` to define the four tab icon callbacks.
- Modify `apps/mobile/src/components/Screen.tsx` to add the shared content gap.
- Extend `apps/mobile/__tests__/navigation-shell.test.tsx` to assert each tab supplies an icon callback.
- Extend `apps/mobile/__tests__/screen-scroll.test.tsx` to assert the shared content gap.

No route behavior, API behavior, screen-specific copy, or server code changes are included.

## Verification

Use Deno tasks only. Write focused failing tests for the missing callbacks and missing gap, confirm each fails for the intended reason, then implement the smallest changes and run them green. Finish with the mobile typecheck, complete mobile Jest suite, API check, production Android build, and `git diff --check`. Generated-type-dependent checks remain sequential.

## Acceptance criteria

- The Android bottom bar shows four actual native vector icons rather than Expo Router's missing-icon glyph.
- Focused and unfocused icon tint follows the existing primary and muted colors.
- Direct screen-level inputs, buttons, and status elements have a consistent baseline vertical gap.
- Existing navigation, accessibility labels, pending-button behavior, and screen-specific layouts continue to pass their tests.
