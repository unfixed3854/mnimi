# Sidebar Drag-to-Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `SidebarRail` actually resize the sidebar by dragging, so its `cursor-w-resize`/`cursor-e-resize` affordance matches real behavior (GitHub issue #16).

**Architecture:** Extend `SidebarProvider`'s existing `open`/`setOpen`-plus-cookie pattern with a parallel `width`/`setWidth`. `SidebarRail` gets pointer handlers that distinguish a click (today's `toggleSidebar()`) from a drag (imperative CSS-var write during the drag, committed to state + cookie on release). All changes live in one vendored file, `src/components/ui/sidebar.tsx`, plus a new test file.

**Tech Stack:** React 19, TypeScript (strict, `noUnusedLocals`/`noUnusedParameters`), Vitest + `@testing-library/react` + jsdom, Tailwind v4 (CSS custom properties consumed via `w-(--sidebar-width)` arbitrary values).

Full design: `docs/superpowers/specs/2026-08-08-sidebar-drag-resize-design.md`.

## Global Constraints

- All production code changes are confined to `src/components/ui/sidebar.tsx` — no new files, no new dependencies (the codebase deliberately hand-rolls this vendored primitive rather than pulling in a resizable-panel library).
- Width bounds: `192` (12rem) to `384` (24rem) px inclusive; default `256` (16rem) px.
- Drag-vs-click threshold: `4` px of pointer movement.
- New cookie: `sidebar_width`, same `path=/; max-age=` pattern as the existing `sidebar_state` cookie (`SIDEBAR_COOKIE_MAX_AGE`, 7 days). Unlike `sidebar_state` (write-only today), `sidebar_width` **is** read back on mount — that's the one deliberate deviation from the existing pattern, and it's documented inline in the code, not just the spec.
- A cookie value that's missing, non-numeric, or outside the bounds falls back to the default (`256`), not to the nearest bound.
- `SidebarRail` stays `tabIndex={-1}` (no keyboard resizing — out of scope, see spec).
- This file is vendored from shadcn/ui; local deviations get a short comment explaining why (see the existing Ctrl/Cmd+B example at the top of `SidebarProvider`) so a future re-vendor doesn't silently strip them. `sidebar-shortcut.test.tsx` documents this convention — new tests follow the same "tripwire" framing.
- Verify with `deno task test` (vitest) and `deno task build` (tsr generate + `tsc` + vite build — the project's typecheck), matching CI (`.github/workflows/*.yml`, job "Typecheck, test, build").

---

### Task 1: Resizable width state on `SidebarProvider`

**Files:**
- Modify: `src/components/ui/sidebar.tsx` (constants block ~line 28-33, `SidebarContextProps` ~line 35-43, `SidebarProvider` body ~line 56-159)
- Create: `src/components/sidebar-resize.test.tsx`

**Interfaces:**
- Produces: `useSidebar()` now returns `width: number` (px) and `setWidth: (width: number) => void`, plus a new `wrapperRef: React.RefObject<HTMLDivElement | null>` pointing at the `sidebar-wrapper` div. `setWidth` clamps to `[192, 384]` and persists to the `sidebar_width` cookie. These are consumed by Task 2's `SidebarRail`.
- Produces (module-scope helpers, not exported): `clampSidebarWidth(width: number): number` and `readSidebarWidthCookie(): number`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/sidebar-resize.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

// ui/sidebar.tsx is vendored; drag-to-resize is a local addition with no
// upstream shadcn/ui equivalent. These tests are the tripwire a re-vendor
// would silently fail (see sidebar-shortcut.test.tsx for the same pattern
// applied to the Ctrl/Cmd+B gate).

afterEach(cleanup);

beforeEach(() => {
  document.cookie = "sidebar_width=; path=/; max-age=0";
});

function WidthProbe() {
  const { width, setWidth } = useSidebar();
  return (
    <div>
      <span data-testid="width">{width}</span>
      <button data-testid="set-300" onClick={() => setWidth(300)}>
        set 300
      </button>
      <button data-testid="set-below-min" onClick={() => setWidth(50)}>
        set 50
      </button>
      <button data-testid="set-above-max" onClick={() => setWidth(999)}>
        set 999
      </button>
    </div>
  );
}

describe("sidebar width state", () => {
  it("defaults to 256px when no width cookie is set", () => {
    const { getByTestId } = render(
      <SidebarProvider>
        <WidthProbe />
      </SidebarProvider>,
    );
    expect(getByTestId("width").textContent).toBe("256");
  });

  it("reads the width back from the cookie on mount", () => {
    document.cookie = "sidebar_width=300; path=/";
    const { getByTestId } = render(
      <SidebarProvider>
        <WidthProbe />
      </SidebarProvider>,
    );
    expect(getByTestId("width").textContent).toBe("300");
  });

  it("falls back to the default when the cookie value is out of bounds", () => {
    document.cookie = "sidebar_width=999; path=/";
    const { getByTestId } = render(
      <SidebarProvider>
        <WidthProbe />
      </SidebarProvider>,
    );
    expect(getByTestId("width").textContent).toBe("256");
  });

  it("clamps setWidth to the bounds and writes the cookie", () => {
    const { getByTestId } = render(
      <SidebarProvider>
        <WidthProbe />
      </SidebarProvider>,
    );

    fireEvent.click(getByTestId("set-below-min"));
    expect(getByTestId("width").textContent).toBe("192");
    expect(document.cookie).toContain("sidebar_width=192");

    fireEvent.click(getByTestId("set-above-max"));
    expect(getByTestId("width").textContent).toBe("384");
    expect(document.cookie).toContain("sidebar_width=384");
  });

  it("applies the current width to the wrapper's --sidebar-width custom property", () => {
    const { container, getByTestId } = render(
      <SidebarProvider>
        <WidthProbe />
      </SidebarProvider>,
    );

    const wrapper = container.querySelector(
      '[data-slot="sidebar-wrapper"]',
    ) as HTMLElement;
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("256px");

    fireEvent.click(getByTestId("set-300"));
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("300px");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test src/components/sidebar-resize.test.tsx`
Expected: FAIL — `useSidebar()` has no `width`/`setWidth` (runtime error calling `setWidth`, and the default-width assertions fail since the wrapper still renders the fixed `16rem` string, not `256px`).

- [ ] **Step 3: Implement the state**

In `src/components/ui/sidebar.tsx`, replace the constants block (current lines 28-33):

```ts
const SIDEBAR_COOKIE_NAME = "sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH_MOBILE = "18rem"
const SIDEBAR_WIDTH_ICON = "3rem"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"
const SIDEBAR_WIDTH_MIN_PX = 192 // 12rem
const SIDEBAR_WIDTH_MAX_PX = 384 // 24rem
const SIDEBAR_WIDTH_DEFAULT_PX = 256 // 16rem
const SIDEBAR_WIDTH_COOKIE_NAME = "sidebar_width"
const SIDEBAR_DRAG_THRESHOLD_PX = 4

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_WIDTH_MAX_PX, Math.max(SIDEBAR_WIDTH_MIN_PX, width))
}

// Unlike SIDEBAR_COOKIE_NAME (open/closed), this cookie is read back: an
// unread cookie would make persisting a resize pointless, since every reload
// would silently discard it.
function readSidebarWidthCookie(): number {
  if (typeof document === "undefined") {
    return SIDEBAR_WIDTH_DEFAULT_PX
  }

  const match = document.cookie.match(
    new RegExp(`(?:^|; )${SIDEBAR_WIDTH_COOKIE_NAME}=(\\d+)`)
  )
  if (!match) {
    return SIDEBAR_WIDTH_DEFAULT_PX
  }

  const parsed = Number.parseInt(match[1], 10)
  if (
    Number.isNaN(parsed) ||
    parsed < SIDEBAR_WIDTH_MIN_PX ||
    parsed > SIDEBAR_WIDTH_MAX_PX
  ) {
    return SIDEBAR_WIDTH_DEFAULT_PX
  }

  return parsed
}
```

(This removes the old `const SIDEBAR_WIDTH = "16rem"` — it's superseded by `SIDEBAR_WIDTH_DEFAULT_PX`, and `noUnusedLocals` would otherwise flag it once nothing references the string form.)

Update `SidebarContextProps` (current lines 35-43) to add three fields:

```ts
type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
  width: number
  setWidth: (width: number) => void
  wrapperRef: React.RefObject<HTMLDivElement | null>
}
```

In `SidebarProvider` (current lines 56-159), add the ref and width state after the existing `openMobile` state, and thread them into the context value and the wrapper `div`:

```tsx
function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)
  const wrapperRef = React.useRef<HTMLDivElement>(null)

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
    },
    [setOpenProp, open]
  )

  const [width, _setWidth] = React.useState(readSidebarWidthCookie)
  const setWidth = React.useCallback((value: number) => {
    const clamped = clampSidebarWidth(value)
    _setWidth(clamped)
    document.cookie = `${SIDEBAR_WIDTH_COOKIE_NAME}=${clamped}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
  }, [])

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  // Adds a keyboard shortcut to toggle the sidebar.
  //
  // LOCAL CHANGE: gated on !isMobile. Below md this app navigates with the
  // bottom tab bar and the sidebar's mobile Sheet is never meant to open —
  // it has no visible trigger there. Upstream, the shortcut would still call
  // setOpenMobile, putting a second navigation (with a second "Primary"
  // landmark) on screen alongside the tab bar. Skipping the handler entirely
  // also leaves Ctrl/Cmd+B free for its native meaning below md.
  React.useEffect(() => {
    if (isMobile) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isMobile, toggleSidebar])

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed"

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      width,
      setWidth,
      wrapperRef,
    }),
    [
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      width,
      setWidth,
    ]
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        ref={wrapperRef}
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": `${width}px`,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test src/components/sidebar-resize.test.tsx`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Typecheck**

Run: `deno task build`
Expected: succeeds — confirms `SidebarContextProps`, the `wrapperRef` type, and every existing `useSidebar()` call site still type-check (no call site destructures unknown fields, so none should need changes).

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/sidebar.tsx src/components/sidebar-resize.test.tsx
git commit -m "feat(sidebar): add resizable width state to SidebarProvider"
```

---

### Task 2: Drag-to-resize on `SidebarRail`

**Files:**
- Modify: `src/components/ui/sidebar.tsx` (`SidebarRail`, current lines 289-312)
- Modify: `src/components/sidebar-resize.test.tsx` (append)

**Interfaces:**
- Consumes: `useSidebar()`'s `state`, `width`, `setWidth`, `toggleSidebar`, `wrapperRef` from Task 1. Module-scope `clampSidebarWidth` and `SIDEBAR_DRAG_THRESHOLD_PX` from Task 1.
- Produces: `SidebarRail` now resizes on drag and still toggles on a plain click. Task 3 adds `onDoubleClick` on top of this without touching the pointer handlers.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/sidebar-resize.test.tsx` (add these imports to the existing import lines: `Sidebar`, `SidebarRail` from `@/components/ui/sidebar`; `React` isn't needed):

```tsx
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "@/components/ui/sidebar";
```

```tsx
const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;

function setViewport(width: number) {
  window.innerWidth = width;
  window.matchMedia = ((query: string) => ({
    matches: width < 768,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function SidebarProbe() {
  const { state, width } = useSidebar();
  return (
    <>
      <span data-testid="state">{state}</span>
      <span data-testid="width">{width}</span>
    </>
  );
}

function renderRail(providerProps: { defaultOpen?: boolean } = {}) {
  setViewport(1100);
  const utils = render(
    <SidebarProvider {...providerProps}>
      <Sidebar>
        <SidebarRail />
      </Sidebar>
      <SidebarProbe />
    </SidebarProvider>,
  );
  const rail = utils.container.querySelector(
    '[data-sidebar="rail"]',
  ) as HTMLElement;
  return { ...utils, rail };
}

describe("sidebar rail: click vs. drag", () => {
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    window.innerWidth = originalInnerWidth;
  });

  it("toggles on a click with no meaningful pointer movement", () => {
    const { rail, getByTestId } = renderRail();

    fireEvent.pointerDown(rail, { clientX: 100 });
    fireEvent.pointerUp(window, { clientX: 100 });

    expect(getByTestId("state").textContent).toBe("collapsed");
    expect(getByTestId("width").textContent).toBe("256");
  });

  it("resizes on drag and clamps at the max bound", () => {
    const { rail, getByTestId } = renderRail();

    fireEvent.pointerDown(rail, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 260 }); // +160px, past the threshold
    fireEvent.pointerMove(window, { clientX: 600 }); // well past the max
    fireEvent.pointerUp(window, { clientX: 600 });

    expect(getByTestId("width").textContent).toBe("384");
    expect(getByTestId("state").textContent).toBe("expanded"); // a drag never toggles
    expect(document.cookie).toContain("sidebar_width=384");
  });

  it("resizes on drag and clamps at the min bound", () => {
    const { rail, getByTestId } = renderRail();

    fireEvent.pointerDown(rail, { clientX: 300 });
    fireEvent.pointerMove(window, { clientX: -200 });
    fireEvent.pointerUp(window, { clientX: -200 });

    expect(getByTestId("width").textContent).toBe("192");
  });

  it("ignores drag while collapsed but still toggles on click", () => {
    const { rail, getByTestId } = renderRail({ defaultOpen: false });
    expect(getByTestId("state").textContent).toBe("collapsed");

    fireEvent.pointerDown(rail, { clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 400 });
    fireEvent.pointerUp(window, { clientX: 400 });

    expect(getByTestId("width").textContent).toBe("256");
    expect(getByTestId("state").textContent).toBe("expanded");
  });

  it("commits the drag width on pointercancel", () => {
    const { rail, getByTestId } = renderRail();

    fireEvent.pointerDown(rail, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 }); // +50px
    fireEvent.pointerCancel(window);

    expect(getByTestId("width").textContent).toBe("306");
  });

  it("flips the drag direction for a right-side sidebar", () => {
    setViewport(1100);
    const { getByTestId, container } = render(
      <SidebarProvider>
        <Sidebar side="right">
          <SidebarRail />
        </Sidebar>
        <SidebarProbe />
      </SidebarProvider>,
    );
    const rail = container.querySelector(
      '[data-sidebar="rail"]',
    ) as HTMLElement;

    fireEvent.pointerDown(rail, { clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 250 }); // dragging left...
    fireEvent.pointerUp(window, { clientX: 250 });

    // ...grows a right-side sidebar, since its rail is on the left edge.
    expect(getByTestId("width").textContent).toBe("306");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test src/components/sidebar-resize.test.tsx`
Expected: FAIL — dragging currently does nothing (no pointer handlers beyond `onClick`), so the resize assertions fail; the click-toggle test may already pass coincidentally since `onClick` still fires today, but leave it — it will keep passing after the rewrite too.

- [ ] **Step 3: Implement the pointer handlers**

Replace `SidebarRail` (current lines 289-312) in `src/components/ui/sidebar.tsx`:

```tsx
type SidebarDragState = {
  startX: number
  startWidth: number
  side: "left" | "right"
  dragging: boolean
  canResize: boolean
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { state, toggleSidebar, width, setWidth, wrapperRef } = useSidebar()
  const dragStateRef = React.useRef<SidebarDragState | null>(null)

  const handlePointerMove = React.useCallback(
    (event: PointerEvent) => {
      const drag = dragStateRef.current
      if (!drag || !drag.canResize) return

      const rawDelta = event.clientX - drag.startX
      const delta = drag.side === "right" ? -rawDelta : rawDelta

      if (!drag.dragging && Math.abs(delta) <= SIDEBAR_DRAG_THRESHOLD_PX) {
        return
      }

      drag.dragging = true
      const next = clampSidebarWidth(drag.startWidth + delta)
      wrapperRef.current?.style.setProperty("--sidebar-width", `${next}px`)
    },
    [wrapperRef]
  )

  const endDrag = React.useCallback(() => {
    const drag = dragStateRef.current
    window.removeEventListener("pointermove", handlePointerMove)
    window.removeEventListener("pointerup", endDrag)
    window.removeEventListener("pointercancel", endDrag)
    dragStateRef.current = null

    if (!drag) return

    if (drag.dragging) {
      const cssValue = wrapperRef.current?.style.getPropertyValue(
        "--sidebar-width"
      )
      const committed = cssValue ? Number.parseInt(cssValue, 10) : NaN
      setWidth(Number.isNaN(committed) ? drag.startWidth : committed)
      return
    }

    // A pointerdown/pointerup pair with no meaningful movement is a click.
    // There's no separate onClick handler for the browser's native "click"
    // (which still fires after this) to reach, so toggling only ever
    // happens here, exactly once per click.
    toggleSidebar()
  }, [handlePointerMove, setWidth, toggleSidebar, wrapperRef])

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const side =
      (event.currentTarget
        .closest("[data-side]")
        ?.getAttribute("data-side") as "left" | "right" | null) ?? "left"

    dragStateRef.current = {
      startX: event.clientX,
      startWidth: width,
      side,
      dragging: false,
      canResize: state === "expanded",
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", endDrag)
    window.addEventListener("pointercancel", endDrag)
  }

  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onPointerDown={handlePointerDown}
      title="Toggle Sidebar"
      className={cn(
        "absolute inset-y-0 z-20 hidden w-4 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2",
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
        className
      )}
      {...props}
    />
  )
}
```

Note what's deliberately *not* here: no `onClick` prop. Keeping `onClick={toggleSidebar}` alongside the pointerup-driven toggle would double-fire — the browser synthesizes a native `click` after `pointerdown`+`pointerup` on the same element, so a plain click would toggle once from `endDrag` and once more from `onClick`, canceling itself out. Toggling lives only in `endDrag` now.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test src/components/sidebar-resize.test.tsx`
Expected: PASS (all tests, both Task 1's and Task 2's)

- [ ] **Step 5: Typecheck**

Run: `deno task build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/sidebar.tsx src/components/sidebar-resize.test.tsx
git commit -m "feat(sidebar): drag SidebarRail to resize the sidebar"
```

---

### Task 3: Double-click to reset width

**Files:**
- Modify: `src/components/ui/sidebar.tsx` (`SidebarRail`, added in Task 2)
- Modify: `src/components/sidebar-resize.test.tsx` (append)

**Interfaces:**
- Consumes: `state`, `setWidth` from `useSidebar()` (Task 1); `SIDEBAR_WIDTH_DEFAULT_PX` (Task 1).
- Produces: nothing further consumed by other tasks — this is the last task.

- [ ] **Step 1: Write the failing tests**

Append to the `"sidebar rail: click vs. drag"` describe block in `src/components/sidebar-resize.test.tsx` (or a new adjacent `describe` — either is fine, they use the same `renderRail` helper):

```tsx
describe("sidebar rail: double-click reset", () => {
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    window.innerWidth = originalInnerWidth;
  });

  it("resets to the default width on double-click while expanded", () => {
    const { rail, getByTestId } = renderRail();

    fireEvent.pointerDown(rail, { clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 100 });
    fireEvent.pointerUp(window, { clientX: 100 });
    expect(getByTestId("width").textContent).toBe("356");

    fireEvent.doubleClick(rail);
    expect(getByTestId("width").textContent).toBe("256");
  });

  it("does not reset width from a double-click while collapsed", () => {
    const { rail, getByTestId } = renderRail();

    fireEvent.pointerDown(rail, { clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 100 });
    fireEvent.pointerUp(window, { clientX: 100 });
    expect(getByTestId("width").textContent).toBe("356");

    // collapse via a plain click
    fireEvent.pointerDown(rail, { clientX: 0 });
    fireEvent.pointerUp(window, { clientX: 0 });
    expect(getByTestId("state").textContent).toBe("collapsed");

    fireEvent.doubleClick(rail);
    expect(getByTestId("width").textContent).toBe("356");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno task test src/components/sidebar-resize.test.tsx`
Expected: FAIL — double-click currently does nothing.

- [ ] **Step 3: Implement double-click reset**

In `SidebarRail`, add a handler and wire it up:

```tsx
  const handleDoubleClick = () => {
    if (state !== "expanded") return
    setWidth(SIDEBAR_WIDTH_DEFAULT_PX)
  }
```

Add it above `return (` (after `handlePointerDown`), and add the prop to the `<button>`:

```tsx
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      title="Toggle Sidebar"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno task test src/components/sidebar-resize.test.tsx`
Expected: PASS (every test in the file).

- [ ] **Step 5: Full verification pass**

Run: `deno task test` (whole suite, not just this file — confirms nothing else regressed, e.g. `sidebar-shortcut.test.tsx`)
Expected: PASS

Run: `deno task build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/sidebar.tsx src/components/sidebar-resize.test.tsx
git commit -m "feat(sidebar): reset width to default on rail double-click"
```

---

## Manual smoke test (after Task 3)

Automated tests cover the logic; do this once by hand since it's a pointer-drag interaction in a real browser (`deno task dev`, then open the app):

1. Hover the sidebar's right edge — cursor should show a resize affordance.
2. Drag it wider and narrower — sidebar should track the pointer smoothly, stopping at the 12rem/24rem bounds.
3. Release — width should stick.
4. Reload the page — the custom width should still be there.
5. Click the edge without dragging — sidebar should still collapse/expand as before.
6. Double-click the edge while expanded — width should snap back to the default (16rem).
7. Collapse the sidebar, then try dragging the edge — nothing should resize; a click should still expand it.
