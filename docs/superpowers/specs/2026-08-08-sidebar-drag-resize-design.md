# Sidebar drag-to-resize design

Make the sidebar's edge rail actually resize the sidebar by dragging, matching
the resize-cursor affordance it already shows.

## Problem

`SidebarRail` (`src/components/ui/sidebar.tsx`) has `cursor-w-resize` /
`cursor-e-resize` classes and a visible hairline that read as a drag handle,
but the only handler wired up is `onClick={toggleSidebar}` — a binary
collapse/expand toggle. There is no pointer-drag logic, no width state beyond
the fixed `SIDEBAR_WIDTH = "16rem"` constant, and no persistence of a custom
width. This is upstream shadcn/ui behavior (the rail has never supported
resize there either) — GitHub issue #16 tracks fixing it for this app.

## Approach

Extend the existing `SidebarContext`/`SidebarProvider` state (which already
tracks `open`/`setOpen` with a cookie) with a parallel `width`/`setWidth`, and
give `SidebarRail` pointer handlers that distinguish a click (toggle, today's
behavior) from a drag (resize). All changes are confined to
`src/components/ui/sidebar.tsx`; `app-sidebar.tsx` needs no changes.

## 1. State (`SidebarProvider` / `SidebarContext`)

New constants, alongside the existing `SIDEBAR_*` ones:

```ts
const SIDEBAR_WIDTH_MIN_PX = 192 // 12rem
const SIDEBAR_WIDTH_MAX_PX = 384 // 24rem
const SIDEBAR_WIDTH_DEFAULT_PX = 256 // 16rem, matches SIDEBAR_WIDTH
const SIDEBAR_WIDTH_COOKIE_NAME = "sidebar_width"
const SIDEBAR_DRAG_THRESHOLD_PX = 4
```

`SidebarContextProps` gains:

```ts
width: number // px, current committed width
setWidth: (width: number) => void
wrapperRef: React.RefObject<HTMLDivElement | null>
```

- `setWidth` clamps to `[SIDEBAR_WIDTH_MIN_PX, SIDEBAR_WIDTH_MAX_PX]`, updates
  state, and writes `SIDEBAR_WIDTH_COOKIE_NAME` — mirroring `setOpen`'s cookie
  write (`document.cookie = "${name}=${value}; path=/; max-age=${...}"`). The
  cookie value is the clamped width as a plain integer pixel count (e.g.
  `"256"`, not `"16rem"`) — it's read with a bare `parseInt`.
- Initial `width` is lazily read from `document.cookie` in the `useState`
  initializer (guarded so it's a no-op when `document` is unavailable during
  SSR). A missing cookie, or a parsed value that is `NaN` or outside
  `[SIDEBAR_WIDTH_MIN_PX, SIDEBAR_WIDTH_MAX_PX]`, falls back to
  `SIDEBAR_WIDTH_DEFAULT_PX`. This is a deliberate deviation from the
  open-state cookie, which is written but never read back anywhere in the app
  (confirmed: no server or client code parses `sidebar_state`, `defaultOpen`
  is always `true`). Mirroring
  that write-only pattern for width would make the "persistence" invisible to
  the user — every reload would silently discard a resize. Fixing the
  open-state read-back is out of scope for this change.
- `wrapperRef` is a new `useRef<HTMLDivElement>(null)` attached to the
  existing `sidebar-wrapper` div, exposed through context so `SidebarRail` can
  write `--sidebar-width` to it directly during a drag, without going through
  React state on every pointer move.
- The wrapper's inline `--sidebar-width` becomes `` `${width}px` `` instead of
  the fixed `SIDEBAR_WIDTH` string. `--sidebar-width-icon`
  (`SIDEBAR_WIDTH_ICON`) and the mobile sheet's `SIDEBAR_WIDTH_MOBILE` are
  unchanged.

## 2. Interaction (`SidebarRail`)

Pointer lifecycle, using `window`-level listeners (not
`element.setPointerCapture`, which jsdom doesn't implement and which buys
nothing extra here since the rail's own bounding box doesn't matter once a
drag starts):

- **`onPointerDown`** — bail out if `state !== "expanded"` (collapsed rail
  keeps today's click-only behavior, matching its "expand" cursor). Otherwise
  record `startX` and `startWidth = width`, and attach `pointermove`,
  `pointerup`, and `pointercancel` listeners on `window`.
- **`onPointerMove`** — compute `delta = event.clientX - startX`, sign
  flipped when the rail's side is `"right"`. `SidebarRail` isn't passed a
  `side` prop and `side` isn't in `SidebarContext` (it's local to `Sidebar`),
  so this reads `data-side` off the DOM at drag start:
  `event.currentTarget.closest("[data-side]")?.getAttribute("data-side")`.
  `SidebarRail` is always rendered as a child of `Sidebar`, whose outer
  `group` div already carries `data-side={side}` (`sidebar.tsx` line 223), so
  this needs no new prop threading or context field. Until
  `Math.abs(delta) > SIDEBAR_DRAG_THRESHOLD_PX`,
  do nothing (still could be a click). Once past the threshold, mark "is
  dragging" and on every subsequent move write
  `wrapperRef.current.style.setProperty("--sidebar-width", `${clamp(startWidth + delta)}px`)`
  directly — no `setState`, no re-render.
- **`onPointerUp` / `onPointercancel`** — remove the `window` listeners.
  - If drag was never engaged (pure click): call `toggleSidebar()` — today's
    behavior, unchanged.
  - If dragging: call `setWidth()` with the last computed clamped value,
    committing it to React state and the cookie.
- **`onDoubleClick`** — only while expanded: `setWidth(SIDEBAR_WIDTH_DEFAULT_PX)`.

## Data flow

```
pointerdown (expanded only)
  -> pointermove x N
       |Δ| <= threshold: no-op (still could be a click)
       |Δ| >  threshold: dragging; imperative CSS var write, no re-render
  -> pointerup / pointercancel
       was dragging?  -> setWidth(final) -> React state + cookie write
       was a click?   -> toggleSidebar()      (unchanged existing path)
```

## Edge cases

- **Pointer leaves the window mid-drag**: `pointercancel` is handled
  identically to `pointerup`, committing the last width rather than leaving
  the drag "stuck" with dangling listeners.
- **Resize immediately followed by reload**: the cookie write in `setWidth`
  is synchronous on `pointerup`, so a reload right after picks up the new
  width.
- **Collapsing after a custom resize**: collapsing switches to
  `--sidebar-width-icon`, which this change doesn't touch, so a custom
  expanded width and the icon rail are independent — collapsing and
  re-expanding restores the last custom width.
- **`side="right"`**: not used anywhere in this app today (only
  `AppSidebar`'s single, default-`side` instance exists), but the primitive
  supports it, and the DOM-read delta sign flip (see above) keeps the drag
  direction correct if it is ever used, without needing side threaded through
  props or context.

## Out of scope

- Keyboard resizing (arrow keys on a focused rail) — the rail stays
  `tabIndex={-1}`, matching its current non-focusable state. A future a11y
  pass can add this.
- Reading back the existing `sidebar_state` (open/closed) cookie — it stays
  write-only, as today.
- Any change to `variant="floating"` / `variant="inset"` sizing math beyond
  what naturally follows from `--sidebar-width` changing (both already derive
  their padding from that variable).

## Testing

Extend the pattern in `src/components/sidebar-shortcut.test.tsx`
(`@testing-library/react` + jsdom, `vitest`) with a new
`sidebar-resize.test.tsx`: render `SidebarProvider` with a `Probe` that reads
`width` from `useSidebar()`, dispatch synthetic `pointerdown` /
`pointermove` / `pointerup` (and `pointercancel`) on the rail, and cover:

- A click with no meaningful pointer movement still calls `toggleSidebar()`
  (collapses/expands), and does not change `width`.
- Dragging past the threshold updates `width` on release, clamped at
  `SIDEBAR_WIDTH_MIN_PX` / `SIDEBAR_WIDTH_MAX_PX` for drags past either bound.
- Setting the `sidebar_width` cookie before mounting a fresh `SidebarProvider`
  restores that width (read-back on init).
- While `state === "collapsed"`, pointer drag events on the rail are a no-op
  for `width` (click-to-toggle still works).
- `onDoubleClick` while expanded resets `width` to
  `SIDEBAR_WIDTH_DEFAULT_PX`.
