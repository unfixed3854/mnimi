# Mobile UI Polish

## Goal

Polish the complete Expo mobile app so that hierarchy, touch affordances,
spacing, and action priority feel intentional and consistent. The work keeps the
existing warm visual character and all product behavior, while permitting new
visual treatments only when they make an interaction clearer or easier to use.

The two most visible problems are representative of broader system issues:

- The Decks tab repeats its title, lets the creation form dominate the page, and
  renders deck destinations like passive text with a small effective touch
  target.
- The Review screen gives supporting and grading actions nearly identical visual
  weight and leaves no optical space between the final grade and the Android
  system navigation area.

## Scope

The polish applies to the complete mobile UI in `apps/mobile`:

- Primary tabs: Today, Decks, Add, and Settings.
- Detail flows: deck, note, and review.
- Authentication screens.
- Development tools.
- Shared screen, typography, button, input, card, list, loading, error, empty,
  selection, and navigation patterns used by those screens.

This is a focused refinement of the current NativeWind and repository-owned
Reusables implementation. It is not a framework migration, visual rebrand, or
workflow redesign.

## Design principles

### Every change must explain itself

New colors, surfaces, layouts, or control treatments are justified by a specific
usability need: identifying a destination, distinguishing action priority,
exposing selection, enlarging a touch target, grouping related choices, or
creating safe visual separation. Novelty alone is not a reason to change the
interface.

### Content establishes the hierarchy

Each screen has one page title, one visually dominant task or content region,
and a clear distinction between primary, supporting, selection, and destructive
actions. Repeated filled buttons do not stand in for hierarchy.

### Warm and restrained remains the visual character

The existing warm background, white surfaces, dark foreground, muted text, green
primary, and red destructive colors remain the foundation. The design may add
semantic tonal variants derived from those colors, but it does not add an
unrelated accent palette, decorative gradient, or ornamental font.

### Mobile ergonomics are part of the design

Interactive controls and rows have at least a 48 px touch target, clear pressed
feedback, and accessible labels or roles. Long content remains keyboard-safe and
scrollable. Every screen ends with deliberate space above the tab bar or Android
system navigation area.

## Shared shell and page structure

### Single app-owned page header

Hide Expo Router's visible header on the four tab routes and use one shared
app-owned `PageHeader` inside screen content. This removes repeated titles and
makes tab screens consistent with detail and review routes, whose stack headers
are already hidden.

`PageHeader` supports:

- A required title.
- An optional supporting subtitle.
- An optional leading back action on detail routes.
- An optional trailing action or status.

The Add screen's `DraftIndicator` moves from the navigator header into the
trailing page-header slot. The Today, Decks, Add, and Settings screens each show
exactly one visible page title. Detail routes use the same title rhythm and a
consistent leading back affordance. Back actions use stable destinations rather
than history-only navigation: deck detail returns to Decks, note detail returns
to its deck, and Review returns to the reviewed deck. This keeps deep links from
creating dead ends.

### Screen rhythm and safe ending space

Extend `Screen` rather than adding screen-specific spacer views. Its scroll
content keeps the existing growth, keyboard behavior, safe-area edges, and tap
persistence, and gains consistent top rhythm plus at least 32 px of content
padding after the final element. The safe-area inset and optical content padding
are complementary: the inset prevents obstruction, while the content padding
prevents the last control from appearing attached to the system or tab bar.

Screens may opt into centered or task-specific composition, but they inherit the
same horizontal gutter and bottom spacing.

### Typography roles

Use the existing typeface with a small set of explicit roles:

- Page title.
- Page subtitle or metadata.
- Section title.
- Body copy.
- Supporting text.
- Control label.

Page titles are the only repeated large heading. Section titles step down
clearly, while metadata and status text use muted color rather than competing
weight. Existing one-off sizes should move to these roles where practical.

## Shared interaction components

### Buttons and action priority

Extend the existing Reusables `Button` variants and the app-level async button
wrapper instead of introducing a second button implementation. The available
roles are:

- Primary: solid green, reserved for the screen's main constructive action.
- Secondary: softly tinted or outlined for supporting actions.
- Neutral selection: communicates selectable and selected states without looking
  disabled.
- Destructive: red treatment for actions that remove or discard data.
- Quiet destructive: lower-emphasis destructive treatment for actions that must
  be available but should not compete with the primary task.
- Link/ghost: navigation or tertiary actions that do not need a filled surface.

All variants retain the existing async press serialization, pending indicator,
disabled/busy accessibility state, minimum 48 px height, and pressed feedback. A
selected control must remain readable and interactive according to its purpose;
selected state must not be represented solely by disabling a normal primary
button.

### List rows

Add a shared `ListRow` for deck and note destinations and native-feeling
settings entries. A row provides:

- A minimum height of 56 px, expanding naturally for multiline content.
- A full-width press target.
- Optional leading icon.
- Primary label and optional supporting metadata.
- Optional trailing value, switch, or chevron.
- Border/separator and surface treatment appropriate to its group.
- Pressed feedback and explicit accessibility role/label.

Rows may sit in one grouped surface with separators or as individually spaced
surfaces when the content benefits from separation. Both treatments use the same
internal geometry and interaction behavior.

### Supporting structure

Add a small `SectionHeader` primitive for consistent section titles and optional
metadata/actions. Continue using existing `Card`, `TextField`, dialog, loading,
error, and empty-state components, refining their variants only where the
approved hierarchy requires it.

## Screen designs

### Decks

Deck selection is the primary task. The screen contains:

1. A single `PageHeader` titled "Decks" with a secondary "New deck" action.
2. An inline creation panel, hidden by default and expanded from that action.
3. The deck list region.

The expanded creation panel contains the named input plus Create and Cancel
actions. Create remains disabled for a blank trimmed name and serialized while
pending. A failed request leaves the panel open, preserves the typed name, and
shows the error beside the form. Cancel closes the panel and clears its local
name and error state.

Each deck is a full-width `ListRow` with a deck/layers icon, bold deck name, and
trailing chevron. The complete row navigates to the deck. Rows have at least a
56 px touch target and pressed feedback, so a single deck such as "German"
cannot be mistaken for passive body text.

Loading, error, and empty states occupy the stable list region. The header's
"New deck" action remains available in the empty state.

### Review

The Review screen is organized around one learning decision:

1. A compact `PageHeader` titled "Review" with a back action to the deck and
   remaining count/card aspect as supporting metadata.
2. The study card as the dominant surface.
3. Supporting reveal, hint, image, and pronunciation controls.
4. The grading decision after reveal.

The current card, reveal state, image behavior, cloze behavior, audio behavior,
and self-consuming server queue remain unchanged. "Play pronunciation" uses a
secondary treatment because it supports the task without completing it.

After reveal, the prompt "How well did you remember?" introduces a two-column,
two-row grading group in this stable order:

- Again, Hard.
- Good, Easy.

Every grade has the same minimum height and width within the grid. Again uses a
restrained destructive treatment, Hard uses neutral styling, and Good/Easy use
tonal green treatments. The treatments communicate meaning without making one
grade appear required. Pending grading disables the group consistently.

The group inherits `Screen`'s bottom content padding, leaving visible space
above Android system navigation. A failed grade keeps the current revealed card
and grade controls visible and places the existing recovery message near the
decision group.

### Today

Use one `PageHeader` titled "Today". The due count or caught-up message remains
the focal content. When cards are due, choosing a deck becomes the clear primary
button. When nothing is due, browsing decks is a quieter secondary link because
there is no urgent action.

### Add

Arrange the existing workflow into visible stages without changing its state
machine:

1. Source text and generation action.
2. Deck selection.
3. Generation and image status.
4. Generated card review/editing.
5. Save action.

The page header reads "Add note" while collecting source text and "Review cards"
once a draft is ready for review. These are mutually exclusive states, so the
Add tab still renders one page title at a time.

Use `SectionHeader` and spacing rather than wrapping every stage in another
card. Deck selection communicates its current value with a true selected
treatment. "New deck" remains available as an action but does not look like
another selectable deck.

Save is the primary constructive action. Discard is visually separated below it
and uses quiet destructive styling. Draft retry and image utility actions use
secondary styling. Draft autosave, retry, discard, persistence, navigation, and
generation behavior remain unchanged.

### Deck detail

Use `PageHeader` with a back action, the deck name, and note/due metadata.
Review is the primary action when cards are due; the no-due state remains
visibly unavailable without masquerading as an active primary action.

Render notes with the shared `ListRow`, making the full row pressable. Move
"Remove deck" into a separated destructive section near the bottom of the
screen. Keep the existing confirmation, error retention, mutation, and
post-removal replacement navigation.

### Note detail

Use the shared back/header treatment. Separate note media, generated cards,
pronunciation controls, and editing actions with section hierarchy and spacing.
Image generation and pronunciation are secondary utilities. Save remains the
primary action while editing. Existing hydration, polling protection, image
retry, audio, and save behavior remain unchanged.

### Settings

Title the page "Settings" and treat account information as content rather than a
competing page title. Present native language as a `ListRow` with its current
value and chevron. Present pronunciation autoplay as a settings row with
supporting text and the native switch. Keep development tools as a secondary
navigation action and separate Sign out at the bottom as destructive.

The language modal remains native and accessible, but its choices use explicit
selection styling rather than disabled primary buttons. Language and autoplay
optimistic local state, serialization, and errors remain unchanged.

### Authentication

Keep the focused authentication forms. Apply the shared page-title rhythm, field
spacing, error placement, button hierarchy, and bottom padding. Sign-in,
sign-up, input retention, validation, pending state, and cross-navigation
behavior do not change.

### Development tools

Preserve all development-only behavior and server gating. Replace repeated
stacks of solid primary buttons used as selectors with explicit selection
controls or list rows. Keep seed actions constructive, reset actions clearly
destructive, and current scope/count status visually attached to the affected
control group.

## Behavior and data boundaries

This work changes presentation and local disclosure state only. It does not
change:

- API contracts, query keys, cache invalidation, or mutation payloads.
- Authentication or protected-route behavior.
- Draft generation, autosave, retry, cleanup, or persistence.
- Note/card editing semantics.
- Review ordering, reveal identity, grading, or FSRS behavior.
- Image or pronunciation loading and playback.
- Deck removal semantics or navigation destinations.

The only new screen state is whether the Decks creation panel is expanded.
Visual components receive labels, metadata, variant, selection, and navigation
props; they do not fetch data or own feature mutations.

## Accessibility and interaction states

- Interactive rows expose the correct link or button role and an accessible name
  independent of decorative icons.
- Every pressable target is at least 48 px high; destination rows are at least
  56 px high.
- Pressed, focused where supported, selected, disabled, busy, error, loading,
  and empty states remain distinguishable without relying only on color.
- Icons use one consistent Ionicons stroke/fill family already present in the
  app and are hidden from accessibility when the row label supplies the name.
- Text continues to expand naturally; list rows and grading controls must remain
  usable with larger system font sizes.
- Modal controls retain Android back handling and modal accessibility.

## Testing

Preserve existing behavior-oriented tests and add focused coverage for the new
presentation contracts:

- Tab navigation hides native headers and each tab renders one visible page
  title.
- The Add draft indicator remains accessible in its app-owned header.
- `Screen` retains keyboard-safe scrolling and includes shared bottom content
  padding.
- `ListRow` makes its complete minimum-height surface interactive and exposes
  the correct accessibility role and label.
- Deck creation expands on request, cancels cleanly, preserves input/error after
  failure, and still creates/navigates as before.
- Deck and note rows navigate when pressed anywhere in the row.
- Button variants preserve pending serialization and accessibility state.
- Selected controls are visually and semantically distinct from disabled
  controls.
- Review grades render in a two-column group, submit the same FSRS values, stay
  hidden before reveal, and preserve the current card after failure.
- Settings rows and language choices retain current mutation behavior.

Use Deno for all package management and script execution. Verification for the
implementation is:

```text
deno fmt --check <changed files>
deno task mobile:test --runInBand
deno task mobile:typecheck
deno task check:api
deno task build:android
git diff --check
```

No new dependency is expected. If implementation reveals a dependency need, that
is a scope change and requires explicit review before adding it.

## Acceptance criteria

- No tab screen shows a duplicated page title.
- Deck creation is secondary and collapsed by default.
- Every deck and note destination reads as an interactive full-width list row
  with a reliable touch target.
- Review pronunciation is visually secondary, grades form one clear 2x2 decision
  group, and the final row has visible bottom breathing room.
- Primary, secondary, selection, and destructive actions are visually distinct
  across all mobile screens.
- Every mobile screen uses consistent page, section, and end-of-content spacing.
- Existing functional and accessibility behavior remains intact.
- The Deno-only verification suite passes, including the Android build.
