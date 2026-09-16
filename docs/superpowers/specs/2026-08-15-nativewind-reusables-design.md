# NativeWind and React Native Reusables Migration

## Goal

Migrate the complete Android mobile client from hand-written `StyleSheet`
styling to NativeWind utility classes and React Native Reusables primitives,
allowing a modest visual refinement while preserving the app's behavior,
accessibility contract, navigation, API flows, and native media functionality.

## Scope

The migration covers every mobile route and shared UI component in
`apps/mobile`:

- Authentication: login and signup.
- Primary tabs: Today, Decks, Add, and Settings.
- Detail flows: deck, note, review, and development tools.
- Shared controls: screen layout, buttons, text fields, dialogs,
  loading/error/empty states, deck selection, card editing, generated
  cards/images, draft status, card faces, and pronunciation controls.

The implementation is a single full rewrite of the styling layer rather than a
long-lived incremental styling migration. The existing component boundaries and
behavioral APIs remain where they protect behavior and test coverage; their
styling internals move to NativeWind and Reusables.

## Design decisions

### Stable NativeWind setup

Use the stable NativeWind 4.x integration documented for Expo rather than the
NativeWind 5 preview. Configure the mobile app with:

- NativeWind and its Expo-compatible peer dependencies.
- Tailwind CSS 3.x with the NativeWind preset.
- A mobile `global.css` containing the Tailwind directives.
- `metro.config.js` wrapped with `withNativeWind` and pointed at `global.css`.
- Babel's NativeWind JSX import source and Babel transform.
- A committed `nativewind-env.d.ts` declaration reference.
- Tailwind content paths covering `app`, `src`, and `src/components/ui`.

All dependency installation and command execution uses Deno. No npm, npx, yarn,
or pnpm command is added to the project workflow.

### Token and visual system

Move the current theme values into Tailwind theme tokens with semantic names:

- Background, surface, foreground, muted foreground, border, primary, primary
  foreground, destructive, destructive foreground, and focus colors.
- The existing spacing scale and medium/large radii.
- App-specific typography sizes and weights used by screen headings, captions,
  controls, and content cards.

The warm monochrome palette remains the foundation. The refactor may improve
visual hierarchy through consistent typography, stronger surface/card treatment,
predictable control heights, focus/pressed states, disabled contrast, and
spacing normalization. It does not add a new dark-mode product requirement or
change the app's supported platform behavior.

### Reusable component layer

Add the React Native Reusables source components required by the app under
`apps/mobile/src/components/ui/`:

- `text` for semantic text and inherited text styles.
- `button` for variants and button text context.
- `input` for native text input styling.
- `card` for bordered surface content.
- `alert-dialog` for destructive confirmations.

Use Reusables as source components owned by the repository, not as an opaque
runtime UI dependency. Adapt their class names and variants to the app's
semantic tokens and Android-first visual language.

Keep native primitives for controls where Reusables does not add value or where
the platform behavior is already correct: `Switch`, `Image`,
`ActivityIndicator`, `ScrollView`, `KeyboardAvoidingView`, Expo Router
links/tabs, audio, and media loading.

### Application component contracts

Preserve the existing app-level component contracts while replacing their
styling implementations:

- `PrimaryButton` remains responsible for async press serialization, pending
  indicators, disabled/busy accessibility state, destructive styling, and label
  derivation. It composes the Reusables button.
- `TextField` remains responsible for its label, controlled input props,
  placeholder color, error border, and accessible error message. It composes
  Reusables input/text primitives.
- `ConfirmDialog` remains responsible for controlled visibility, cancellation,
  pending confirmation, destructive confirmation, and Android back handling. It
  composes Reusables alert-dialog primitives and the root portal.
- `Screen` retains safe-area edges, keyboard behavior, scroll persistence,
  content growth, test IDs, and baseline vertical spacing while moving layout
  styles to NativeWind.

No API, authentication, query, draft, FSRS, audio, image, navigation, or route
behavior changes are part of this migration.

### Screen migration

Replace screen-level `StyleSheet.create` rules and theme-driven style objects
with explicit NativeWind `className` values. Apply color classes to text
elements rather than relying on React Native's non-cascading view color
behavior. Preserve explicit flex direction and `flex-1` semantics where required
by native layout.

Use the Reusables primitives consistently for interactive and surface patterns:

- Primary, destructive, secondary/outline, ghost, and link button variants as
  appropriate to the current action hierarchy.
- Inputs, labels, error text, and focus states for authentication, deck
  creation, note editing, and generated-card editing.
- Cards for deck/note links, generated card previews, editable card sections,
  and review surfaces.
- Alert dialogs for destructive confirmation.
- Native switch and modal behavior for settings language and autoplay controls
  unless a Reusables component provides an equivalent without weakening platform
  behavior.

Retain dynamic object styles only where an API requires them, such as Expo
Router navigation options, navigator-provided icon color/size, or genuinely
calculated media dimensions. These are configuration or runtime values rather
than the app's static styling system.

### Root integration

Import the global CSS from the top-level Expo Router layout so Metro loads it
with the application root. Add `PortalHost` within the root provider hierarchy
so alert dialogs render on native platforms. Keep the existing
`SafeAreaProvider`, `QueryClientProvider`, auth initialization, session
rejection handling, lifecycle, and connectivity hooks unchanged.

## Error handling and behavior preservation

Styling and primitive replacement must not alter:

- Auth input retention after failed sign-in/sign-up.
- Button pending serialization, busy accessibility state, and error recovery.
- Session expiration cleanup and route protection.
- Draft generation, retry, autosave, discard, and navigation cleanup.
- Deck deletion confirmation and post-delete navigation.
- Note/card editing, image generation, pronunciation playback, and review
  grading.
- Development-only tool gating.

NativeWind or Reusables setup failures must be caught by typecheck, Jest, and
Android build verification. A component that cannot preserve the existing
platform behavior will retain a native primitive or app-level wrapper rather
than forcing a library abstraction.

## Testing and verification

Existing mobile tests remain the primary behavioral contract. Update test
imports and test-specific style observations only where the styling
implementation changes the rendered primitive; do not weaken accessibility or
interaction assertions.

Add focused coverage for:

- Reusables button variants and the `PrimaryButton` pending/destructive/disabled
  behavior.
- Text field labels, controlled input props, and accessible errors.
- Alert dialog visibility, cancellation, confirmation, and pending state.
- NativeWind class application on representative shared primitives and screen
  containers.
- Root portal/provider rendering.

Run these checks sequentially where generated Expo or TypeScript artifacts are
involved:

```text
deno task mobile:typecheck
deno task mobile:test --runInBand
deno task check:api
deno task build:android
git diff --check
```

The implementation is complete only when the commands pass, the Android build
includes the configured NativeWind/Reusables setup, and the mobile source has no
remaining `StyleSheet.create` blocks or screen-level theme imports used for
static styling.

## Files and boundaries

Expected configuration changes:

- `apps/mobile/package.json`
- `deno.lock`
- `apps/mobile/babel.config.js`
- `apps/mobile/metro.config.js`
- `apps/mobile/tailwind.config.js`
- `apps/mobile/global.css`
- `apps/mobile/nativewind-env.d.ts`
- `apps/mobile/tsconfig.json`
- `apps/mobile/jest.config.js`
- `apps/mobile/app/_layout.tsx`

Expected reusable-component changes:

- Create/update `apps/mobile/src/components/ui/` primitives.
- Rewrite shared components in `apps/mobile/src/components/` to compose those
  primitives and use NativeWind classes.
- Remove `apps/mobile/src/theme/index.ts` after all static style consumers have
  moved to Tailwind tokens.

Expected screen changes:

- Rewrite route files under `apps/mobile/app/` and feature files under
  `apps/mobile/src/features/` to use NativeWind classes.
- Preserve tab icon callbacks and navigation option object styles.

Expected test changes:

- Update existing mobile component tests for the new primitive tree without
  changing user-facing assertions.
- Add focused UI primitive/provider regression tests under
  `apps/mobile/__tests__/`.

No server, shared-domain, database, API, or generated runtime data files are in
scope.

## Non-goals

- iOS support or a new web client.
- NativeWind 5 preview adoption.
- A new dark-mode product experience.
- Replacing Expo Router or native platform controls wholesale.
- Changing API contracts, data models, auth semantics, or learning workflows.
- Adding unrelated UI features or redesigning information architecture.

## Acceptance criteria

- Every mobile screen and shared component uses NativeWind classes for static
  layout, color, spacing, borders, and typography.
- Required React Native Reusables primitives live in the repository and are used
  by the app-level controls and surfaces they replace.
- The existing warm visual language remains recognizable, with approved
  refinements to hierarchy, states, and consistency.
- Existing route names, labels, accessibility semantics, async behavior, and
  feature tests remain valid.
- No mobile `StyleSheet.create` blocks or obsolete theme-style consumers remain.
- The root Deno workflow, mobile typecheck, mobile tests, API check, Android
  build, and diff whitespace check pass.
