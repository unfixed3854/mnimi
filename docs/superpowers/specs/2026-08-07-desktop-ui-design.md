# Desktop UI

Give the desktop build a layout that fits a desktop window — a sidebar instead
of a bottom tab bar, and a measure per screen chosen for its content — without
changing a single thing Android sees. Closes issue #6.

## Problem

mnimi is laid out phone-first and has no responsive breakpoints at all. Not
"few" — none. `src/**` contains zero `sm:`, `md:` or `lg:` classes. The desktop
build therefore renders the phone layout at whatever size the Tauri window
happens to be, and three things go wrong.

**Navigation is a bottom tab bar.** `_authed.tsx` pins four tabs to
`inset-x-0 bottom-0` with a blurred backdrop and a safe-area inset. That is the
right control on a phone, where the thumb is at the bottom of the device and the
bar is a few hundred pixels wide. On a desktop window it is a strip of chrome
across the full width of the screen, capped at `max-w-xl` and centred so the
four tabs do not drift to opposite corners — a cap that exists precisely because
the component is in the wrong place, and which leaves the rest of the bar as
empty tinted background.

**Every screen is capped at `max-w-xl`.** `Page` applies
`mx-auto w-full max-w-xl` and its own comment says why: without a cap, text runs
the full width of a desktop monitor. The cap is correct, but 36rem is a phone's
measure. A deck list, a notes list and the card-review editor all get the same
576px column no matter how large the window is, so a maximised window is a
narrow strip of content inside a wide field of background.

**Vertical centring is computed against furniture that will not exist.** Both
the Today screen and the Review screen's empty state centre themselves with
`min-h-[calc(100dvh-7rem)]`, subtracting the reserve `main`'s `pb-28` holds for
the fixed tab bar. Remove the tab bar on desktop and that subtraction becomes a
7rem upward offset applied to a hero that is supposed to be centred.

**And the window opens too small to show any of it well.** `tauri.conf.json`
asks for 800×600. Once a 16rem sidebar is subtracted that leaves 544px of
content — narrower than the phone measure it replaced.

## Approach

**Responsive adaptation, one codebase, one breakpoint.** The same components
render both layouts; a `md:` prefix decides which. No desktop-only routes, no
duplicated screens, no platform detection. Android is untouched because every
change is gated above a breakpoint a phone never reaches.

Explicitly rejected, and recorded so it is not re-argued:

- **Two-pane master–detail** on Decks (list beside the selected deck) and on Add
  (form beside its generated cards). It is the more desktop-native answer and it
  is a genuinely better use of a wide window. It also means the deck-detail
  route stops being a route, which changes navigation, back-button behaviour and
  the shape of `_authed.decks.$deckId.tsx`. That is a restructure, not a
  responsive pass, and it should be its own issue if it is wanted.
- **Desktop interaction work** — keyboard grading (space to reveal, 1–4 to
  rate), a ⌘K deck jump, hover affordances. Valuable on a keyboard-first
  platform and entirely orthogonal to layout. Deferred whole.
- **Tauri shell work** — window position persistence, a native menu bar, title
  bar treatment. Deferred, with one deliberate exception below.

The one exception is the window's **initial size**, which is included because
the layout otherwise lands in a window too small to show it. That is a
four-line change to `tauri.conf.json` and nothing else in `src-tauri/` moves.

### The breakpoint is `md` (768px), and it is not a free choice

The sidebar is vendored from shadcn's `base-nova` registry. Its desktop
container is hardcoded `hidden ... md:block`, and the `use-mobile` hook it
depends on hardcodes a `(max-width: 767px)` media query. Choosing any other
breakpoint means editing two vendored files that the next `shadcn add` would
overwrite. So the whole change uses `md` and only `md` — one tier to reason
about, one width to check.

That the component's 768px and Tailwind's `md` are the *same* 768px is what
makes the navigation swap safe; see below.

## Design

### Navigation: one array, two renderings

`NAV_ITEMS` moves out of `_authed.tsx` into `src/components/nav-items.ts`, which
exports three things:

```ts
export const PRIMARY_NAV = [Today, Decks, Add];
export const ACCOUNT_NAV = { to: "/settings", label: "Account", icon: User };
export const NAV_ITEMS = [...PRIMARY_NAV, ACCOUNT_NAV];
```

`PRIMARY_NAV` and `ACCOUNT_NAV` are separate exports rather than
`NAV_ITEMS.slice(0, 3)` and `NAV_ITEMS[3]`, because the sidebar splits the two
groups and index arithmetic is exactly what breaks the day a fifth item is
added.

The bottom tab bar keeps its current markup and iterates `NAV_ITEMS`, gaining
`md:hidden`. A new `src/components/app-sidebar.tsx` iterates `PRIMARY_NAV` into
`SidebarMenu` and renders `ACCOUNT_NAV` in `SidebarFooter`.

**The sidebar's own mobile Sheet path is deliberately left unused.** Below
768px the vendored `Sidebar` sees `isMobile === true` and renders a closed
`<Sheet>` — invisible, with no trigger anywhere to open it — while the tab bar
is what is actually on screen. Above 768px it renders the desktop container and
the tab bar is `md:hidden`. Because both switch on the same 768px, this needs no
JavaScript branching and the two navigations can never both be visible or both
be absent.

**Active state comes from one helper, used by both.** A
`useIsNavActive(to, exact)` built on TanStack Router's `useMatchRoute` replaces
the tab bar's current reliance on `Link`'s `activeProps`, and feeds
`SidebarMenuButton`'s `isActive` prop. Both navigations then compute "you are
here" the same way, and `aria-current="page"` is applied from the same boolean —
so the visual highlight and the screen-reader announcement cannot disagree.
The exactness rule the tab bar already encodes (`exact: to === "/"`, so the home
tab does not stay lit on every child route) moves into the helper's call sites
unchanged.

The account button in the footer is labelled with the signed-in address —
`session?.user.email ?? "Account"` — and carries `tooltip="Account"` so the
collapsed icon rail still identifies it. The vendored `SidebarMenuButton`
already applies `truncate` to its last span, so a long address cannot widen the
16rem column.

### Measures: a `width` prop on `Page`

`page.tsx` already declares itself "the one container every screen sits in" and
names guarding the measure as its reason to exist. The width logic therefore
belongs there rather than as `md:max-w-*` sprinkled across seven call sites,
where it would drift the same way the three different paddings that motivated
`Page` in the first place drifted.

`Page` gains one prop:

| `width` | < 768px | ≥ 768px | screens |
|---|---|---|---|
| `prose` *(default)* | `max-w-xl` | `max-w-2xl` (42rem) | Today, Settings, Review |
| `wide` | `max-w-xl` | `max-w-3xl` (48rem) | Decks, Deck detail, Add |

Defaulting to `prose` means every existing call site keeps working unchanged and
only the screens that want more say so.

Nothing is full-bleed at any size. A 2560px monitor gets the same 48rem column a
1440px one gets. The goal is a window that looks composed, not one that consumes
every available pixel — an unbounded measure is the failure this cap exists to
prevent, and removing it on desktop would reintroduce it.

### Full-height screens

`FULL_HEIGHT` is currently a module-level string duplicated in
`_authed.index.tsx` and `_authed.review.$deckId.tsx`. It moves into `page.tsx`
as a single exported constant and becomes:

```
flex min-h-[calc(100dvh-7rem)] md:min-h-dvh flex-col justify-center
```

The `7rem` subtraction is the tab-bar reserve, which does not exist at `md` and
above. Left in place it would push both heroes 7rem above centre in every
desktop window. Extracting it is what stops one of the two copies being fixed
and the other not.

### Per-screen changes

| Screen | Width | Other |
|---|---|---|
| Today (`_authed.index.tsx`) | `prose` | Shared `FULL_HEIGHT` |
| Decks (`_authed.decks.index.tsx`) | `wide` | None — rows stay one per line |
| Deck detail (`_authed.decks.$deckId.tsx`) | `wide` | Notes `space-y-1` → `grid gap-1 md:grid-cols-2`; "Review N due" → `w-full md:w-auto` |
| Add (`_authed.add.tsx`) | `wide` | Generate / Save / Cancel → `w-full md:w-auto` |
| Review (`_authed.review.$deckId.tsx`) | `prose` | Shared `FULL_HEIGHT` |
| Settings (`_authed.settings.tsx`) | `prose` | None |
| Login (`login.tsx`) | — | Untouched: outside `_authed`, no sidebar, already centred |

Three of those deserve their reasoning stated, because the obvious move is the
wrong one:

**Review stays narrow and structurally identical.** Its measure goes 36rem →
42rem with the `prose` default and nothing else about it moves: the card, the
reveal button and the 4-up rating grid are unchanged. A review screen is a
single object the
eye should take in at a glance; widening the card only lengthens the saccade for
every card in the session, and spreading four rating buttons across 48rem makes
the user aim rather than react.

**Add's card editors stay one per row.** A `CardEditor` is already a stacked
front/back pair, so a two-column grid halves the width of every field in
exchange for vertical compactness that a scrolling review list does not need.

**Full-width buttons become auto-width only where the button is an action, not
a bar.** "Review N due", "Generate cards", "Save N cards" and "Cancel" are
actions and get `md:w-auto`. "Show answer" keeps `w-full`, because it sits
directly under the card and reads as that card's bottom edge rather than as a
stray control.

### `main` and the tab-bar reserve

`_authed.tsx`'s `<main className="pb-28">` becomes the sidebar's
`<SidebarInset className="pb-28 md:pb-0">` — `SidebarInset` renders a `<main>`
itself, so the landmark is preserved and not nested. The 7rem reserve is
dropped at `md` for the same reason `FULL_HEIGHT` drops it.

### Window size

`src-tauri/tauri.conf.json`:

```
"width": 1100, "height": 760, "minWidth": 380, "minHeight": 520
```

`minWidth: 380` is chosen deliberately below the breakpoint so the window can
still be dragged narrow enough to exercise the phone layout — which is how the
desktop build is used to check Android's layout without a device.

## Files

**New**

- `src/components/ui/sidebar.tsx`, `ui/sheet.tsx`, `ui/tooltip.tsx`,
  `src/hooks/use-mobile.ts` — vendored verbatim by
  `deno run -A npm:shadcn@latest add sidebar`. Not hand-edited except for the
  import noted under Risks.
- `src/components/app-sidebar.tsx` — header wordmark and `SidebarTrigger`,
  `SidebarMenu` over `PRIMARY_NAV`, `SidebarRail`, `SidebarFooter` with
  `ACCOUNT_NAV`.
- `src/components/nav-items.ts` — the three exports above.
- `src/lib/use-is-nav-active.ts` — the shared active-route helper. It goes in
  `src/lib/`, not `src/hooks/`, because that is where this repo already keeps
  hooks (`useSession` lives in `src/lib/auth.ts`). `src/hooks/` will exist after
  the install, but only because `components.json` points the CLI's `hooks` alias
  there for `use-mobile`; it is not a convention this repo chose.

**Changed**

- `src/routes/_authed.tsx` — `SidebarProvider` + `AppSidebar` + `SidebarInset`;
  tab bar gains `md:hidden`; `NAV_ITEMS` import replaces the local const.
- `src/components/page.tsx` — `width` prop, exported `FULL_HEIGHT`.
- Six route files — `width` prop and the `md:` classes tabulated above.
- `src-tauri/tauri.conf.json` — window dimensions.

## Data flow and error handling

Neither changes. There is no I/O in this work: no route changes, no query
changes, no new API surface, nothing that can fail at runtime. The only new
client state is the sidebar's own open/collapsed boolean, owned by
`SidebarProvider` and persisted by it to `document.cookie`.

`_authed`'s `beforeLoad` guard is not touched — every edit is inside
`component`, none inside `options` — so the redirect behaviour and the
assertions covering it in `-routes.test.ts` are unaffected by construction.

## Testing

This is a layout change, so the honest position is that **the substantive
verification is visual, not unit.** Assertions about which Tailwind classes a
div carries restate the implementation instead of checking it, and they would
pass just as happily if the layout were broken.

So:

- **One new unit test**, `src/components/page.test.tsx`, covering the only
  actual logic introduced: that `width="wide"` and the `prose` default resolve
  to the intended max-widths, and that a caller-supplied `className` still
  merges rather than being overridden.
- **`deno task test`** stays green, `-routes.test.ts` included and unmodified.
- **`deno task build`** (`tsr generate && tsc && vite build`) for type safety
  across the vendored files and the new prop.
- **Manual check at both widths** via `deno task dev`: at 767px the bottom tab
  bar is present and the sidebar is absent; at ~1100px the reverse. Today and
  Review's empty state are optically centred at both. The sidebar collapses on
  ⌘B and its icon rail shows tooltips.

No device E2E tests are added; the repo has none and this change does not
justify introducing the harness.

## Risks

**The vendored sidebar imports a registry-internal shim.** The registry source
imports `IconPlaceholder` from `@/app/(create)/components/icon-placeholder`,
which does not exist in this project. The CLI is expected to rewrite it to
lucide's `PanelLeftIcon` given `iconLibrary: "lucide"` in `components.json`. If
it does not, the vendored file will not compile and that one import is patched
by hand. Contained either way, but it is the difference between a clean install
and a manual edit, so it is checked immediately after the CLI runs.

**Cookie persistence in the Tauri webview.** `SidebarProvider` writes
`document.cookie` to remember the collapsed state. If the custom-protocol origin
rejects it, the sidebar simply always opens expanded — degraded, not broken, and
not worth pre-empting.

**`shadcn add` may reformat or add dependencies.** `@base-ui/react`,
`class-variance-authority`, `lucide-react` and `tailwind-merge` are all already
present, so no new package is expected; the diff is reviewed before committing
rather than assumed.

**The notes list grid needed a second breakpoint, by explicit decision.**
The "one breakpoint" rule (see "The breakpoint is `md`... and it is not a
free choice", above) held until the deck-detail notes list. Its two-column
grid was originally specified at `md:grid-cols-2`, but at `md` — a 768px
viewport, with the 16rem sidebar and the `wide` measure's own padding
subtracted — each column is only around 230px, too narrow for a domain badge
sitting beside a real note title without wrapping badly. The fix knowingly
amends the plan's global constraint: the grid uses `lg:grid-cols-2` (1024px)
instead, which is wide enough (~360px per column) to hold a long note plus
its badge. This is a sanctioned, single-purpose exception, not drift — it is
scoped to this one `<ul>` and does not license `sm:`/`lg:`/`xl:` classes
anywhere else in this work. It was accompanied by a `min-w-0` fix on the
title span, since even at `lg`'s wider columns the longest realistic note
text still needs more room than flex's default `min-width: auto` allows to
shrink into.

**The 768–831px window is narrower than the phone layout it replaces.**
Content column width above `md` is `min(W - 256, 768) - 48` (window width,
minus the 16rem/256px sidebar, capped at the `wide` measure's 768px content
box, minus the `Page` component's horizontal padding). That expression only
reaches the sub-`md` value of 528px once `W` hits 832px. So a window dragged
from 767px to 768px — crossing into what this design calls "desktop" — loses
up to 64px of content width before it starts gaining any back: the layout
gets measurably worse for a 64px band before it gets better. This is not a
bug to fix; it is an inherent consequence of pairing a fixed 16rem sidebar
with a 768px breakpoint, and it is recorded here so it is not rediscovered
and treated as a regression. It is reachable in practice — `tauri.conf.json`
sets `minWidth: 380`, well below 832px — so a window dragged slowly across
that range will visibly pass through it.

## Out of scope

Recorded here so they are not re-argued, per the convention in
`docs/OUT-OF-SCOPE.md`:

- Two-pane master–detail layouts on Decks or Add.
- Keyboard shortcuts for review grading and any command palette.
- Tauri window position persistence, native menus, custom title bar.
- Any `lg:` or `xl:` tier, with the single sanctioned exception of
  `lg:grid-cols-2` on the deck-detail notes list (see "The notes list grid
  needed a second breakpoint", above). One breakpoint otherwise, deliberately.
- Restyling. Palette, type scale, grain overlay and motion are unchanged; this
  changes where things sit, not what they look like.
