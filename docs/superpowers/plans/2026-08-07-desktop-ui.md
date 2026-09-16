# Desktop UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give mnimi's desktop build a sidebar and per-screen measures at a single `md` breakpoint, leaving the phone layout byte-for-byte identical.

**Architecture:** One codebase, one breakpoint. A shadcn `sidebar` block is vendored and rendered above 768px; the existing bottom tab bar gains `md:hidden`. Both navigations read one `NAV_ITEMS` array and one active-route predicate. `Page` gains a `width` prop so the measure lives in the single container component that already exists to guard it.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind v4, shadcn/ui (`base-nova` style, Base UI under it), `@tanstack/react-router`, Vitest + jsdom + `@testing-library/react`, Tauri v2.

**Spec:** `docs/superpowers/specs/2026-08-07-desktop-ui-design.md`

## Global Constraints

- **Deno only.** Per `AGENTS.md`: use `deno` for all package management and script execution. Never `npm`, `npx`, `yarn` or `pnpm`.
- **One breakpoint: `md` (768px).** No `sm:`, `lg:` or `xl:` classes anywhere in this work. The vendored sidebar hardcodes `md:block` and its `use-mobile` hook hardcodes 767px; any other tier would desynchronise the two navigations. **Sanctioned exception:** the deck-detail notes list grid uses `lg:grid-cols-2` instead of `md:grid-cols-2` — at `md` the two columns are only ~230px wide at a 768px viewport once the sidebar and page padding are subtracted, too narrow to hold a note title and its domain badge. This is a single, scoped, explicitly-approved exception (see the spec's Risks section), not licence for further `sm:`/`lg:`/`xl:` classes elsewhere.
- **Android is untouched.** Every change is either gated behind `md:` or is invisible below it. If a diff changes what renders under 768px, it is wrong.
- **No restyling.** Palette, type scale, `.app-grain`, and all motion are unchanged. This work changes where things sit, not what they look like.
- **`tsconfig.json` runs `strict`, `noUnusedLocals` and `noUnusedParameters`.** Vendored files must satisfy all three; `deno task build` is the gate.
- **Commands:** `deno task test` (Vitest, one shot), `deno task build` (`tsr generate && tsc && vite build`), `deno task dev` (Vite :1420 + API :8787).

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/components/ui/sidebar.tsx` | Vendored. The sidebar primitive set. |
| `src/components/ui/sheet.tsx` | Vendored. Dependency of `sidebar`; its mobile path is unused here. |
| `src/components/ui/tooltip.tsx` | Vendored. Dependency of `sidebar`; used by the collapsed icon rail. |
| `src/hooks/use-mobile.ts` | Vendored. Dependency of `sidebar`. |
| `src/components/nav-items.ts` | The single source of navigation entries, split into `PRIMARY_NAV` and `ACCOUNT_NAV`. |
| `src/lib/nav-active.ts` | `isNavActive(pathname, to)` (pure) and `useNavActive()` (hook wrapping it). |
| `src/lib/nav-active.test.ts` | Tests for the pure matcher. |
| `src/components/app-sidebar.tsx` | mnimi's sidebar: header, primary menu, account footer, rail. |
| `src/components/page.test.tsx` | Tests for `Page`'s `width` prop and `FULL_HEIGHT`. |

**Modified**

| File | Change |
|---|---|
| `src/components/page.tsx` | `width` prop; exported `FULL_HEIGHT`. |
| `src/routes/_authed.tsx` | `SidebarProvider`/`AppSidebar`/`SidebarInset`; tab bar extracted to `BottomNav` and gated `md:hidden`; `NAV_ITEMS` imported. |
| `src/routes/_authed.index.tsx` | Consume exported `FULL_HEIGHT`. |
| `src/routes/_authed.review.$deckId.tsx` | Consume exported `FULL_HEIGHT`. |
| `src/routes/_authed.decks.index.tsx` | `width="wide"`. |
| `src/routes/_authed.decks.$deckId.tsx` | `width="wide"`; notes grid; button widths. |
| `src/routes/_authed.add.tsx` | `width="wide"`; button widths. |
| `src-tauri/tauri.conf.json` | Window dimensions and minimums. |

`src/routes/_authed.settings.tsx` and `src/routes/login.tsx` are **not** modified — settings takes the `prose` default and login sits outside `_authed`.

## Deviations from the spec

Two, both deliberate. Recorded here so a reviewer comparing plan to spec does not read them as drift.

1. **`useIsNavActive(to, exact)` becomes `useNavActive()` returning a predicate.** Both navigations call it inside `.map()`, and React's rules of hooks forbid calling a hook in a loop. The hook is called once per component and hands back a plain function.
2. **`useMatchRoute` is replaced by `useRouterState` + a pure string comparison.** `matchRoute({ to })` is heavily generic and a union-typed `to` fights its inference. Reading `location.pathname` and comparing is fully typed, and — the actual reason — it splits cleanly into a pure `isNavActive(pathname, to)` that is worth a real test. The spec's "one unit test" therefore becomes two, both over genuine logic rather than markup.

---

### Task 1: Vendor the shadcn sidebar block

**Files:**
- Create: `src/components/ui/sidebar.tsx`, `src/components/ui/sheet.tsx`, `src/components/ui/tooltip.tsx`, `src/hooks/use-mobile.ts` (all written by the CLI)

**Interfaces:**
- Consumes: nothing.
- Produces: from `@/components/ui/sidebar` — `SidebarProvider`, `Sidebar`, `SidebarContent`, `SidebarFooter`, `SidebarGroup`, `SidebarGroupContent`, `SidebarHeader`, `SidebarInset`, `SidebarMenu`, `SidebarMenuButton`, `SidebarMenuItem`, `SidebarRail`, `SidebarTrigger`, `useSidebar`.
  - `SidebarMenuButton` accepts `{ isActive?: boolean; tooltip?: string; render?: React.ReactElement }` — `render` is Base UI's composition prop, the same one `Button` already takes throughout this codebase.
  - `SidebarInset` renders a `<main>` element.
  - `Sidebar` accepts `collapsible?: "offcanvas" | "icon" | "none"`.

- [ ] **Step 1: Preview what the CLI will write**

The repo forbids npm, and the shadcn CLI may try to invoke a package manager for dependencies. Every dependency this block needs (`@base-ui/react`, `class-variance-authority`, `lucide-react`, `tailwind-merge`) is already in `package.json`, so a dry run should report no installs. Check before writing anything:

```bash
deno run -A npm:shadcn@latest add sidebar --dry-run
```

Expected: a list of files to be created under `src/components/ui/` plus `src/hooks/use-mobile.ts`, and no new dependency to install. If it names a dependency that is not already in `package.json`, stop and report it rather than letting the CLI run a package manager.

- [ ] **Step 2: Vendor the files**

```bash
deno run -A npm:shadcn@latest add sidebar --yes
```

- [ ] **Step 3: Confirm the CLI did not touch dependency manifests**

```bash
git status --short
```

Expected: only new untracked files under `src/components/ui/` and `src/hooks/`. If `package.json`, `deno.lock` or `node_modules` were modified, revert those specific paths — the block needs no new dependency:

```bash
git checkout -- package.json deno.lock
```

- [ ] **Step 4: Check the registry-internal import was rewritten**

The registry source imports `IconPlaceholder` from `@/app/(create)/components/icon-placeholder`, a path that does not exist in this project. The CLI is expected to rewrite it to lucide's `PanelLeftIcon` because `components.json` sets `"iconLibrary": "lucide"`.

```bash
grep -n "IconPlaceholder\|PanelLeft" src/components/ui/sidebar.tsx
```

Expected: `PanelLeftIcon` imported from `lucide-react`, and no occurrence of `IconPlaceholder`.

If `IconPlaceholder` is still present, patch that one import by hand — add `import { PanelLeftIcon } from "lucide-react"` to the imports, delete the `IconPlaceholder` import line, and replace its single JSX usage inside `SidebarTrigger`:

```tsx
      <PanelLeftIcon className="cn-rtl-flip" />
      <span className="sr-only">Toggle Sidebar</span>
```

- [ ] **Step 5: Verify the vendored files typecheck**

`tsconfig.json` enables `strict`, `noUnusedLocals` and `noUnusedParameters`, so vendored code is not automatically safe.

```bash
deno task build
```

Expected: PASS, no TypeScript errors. If `noUnusedLocals` flags an unused import in a vendored file, delete only that import — do not restructure vendored code.

- [ ] **Step 6: Verify the existing suite still passes**

```bash
deno task test
```

Expected: PASS. Nothing imports the new files yet, so this is a regression check only.

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/sidebar.tsx src/components/ui/sheet.tsx src/components/ui/tooltip.tsx src/hooks/use-mobile.ts
git commit -m "feat(ui): vendor the shadcn sidebar block

Adds sidebar, sheet, tooltip and use-mobile from the base-nova registry.
Nothing imports them yet. No new dependencies: every package the block
needs was already present."
```

---

### Task 2: `Page` width prop and shared `FULL_HEIGHT`

**Files:**
- Modify: `src/components/page.tsx`
- Modify: `src/routes/_authed.index.tsx`
- Modify: `src/routes/_authed.review.$deckId.tsx`
- Test: `src/components/page.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: from `@/components/page` —
  - `Page` gains an optional prop `width?: "prose" | "wide"`, defaulting to `"prose"`. `prose` resolves to `max-w-xl md:max-w-2xl`; `wide` resolves to `max-w-xl md:max-w-3xl`.
  - `export const FULL_HEIGHT: string` — the full-height centring class string.

- [ ] **Step 1: Write the failing test**

Create `src/components/page.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FULL_HEIGHT, Page } from "@/components/page";

// vitest.config.ts sets neither `globals: true` nor a setup file, so
// @testing-library/react never gets the chance to register its automatic
// afterEach cleanup. Without this line each render leaks its container into
// the next test's document and getByTestId finds two matching nodes.
afterEach(cleanup);

function classesOf(ui: React.ReactElement): string {
  return render(ui).getByTestId("page").className;
}

describe("Page width", () => {
  it("defaults to the prose measure", () => {
    const cls = classesOf(<Page data-testid="page" />);
    expect(cls).toContain("max-w-xl");
    expect(cls).toContain("md:max-w-2xl");
  });

  it("widens at md when width is wide, and only at md", () => {
    const cls = classesOf(<Page data-testid="page" width="wide" />);
    // The phone measure is identical either way — that is the whole point.
    expect(cls).toContain("max-w-xl");
    expect(cls).toContain("md:max-w-3xl");
    expect(cls).not.toContain("md:max-w-2xl");
  });

  it("keeps a caller's own classes alongside the measure", () => {
    const cls = classesOf(<Page data-testid="page" className="flex flex-col" />);
    expect(cls).toContain("flex");
    expect(cls).toContain("max-w-xl");
  });

  it("lets a caller override the measure instead of emitting both", () => {
    // tailwind-merge has to win here, or a caller who wants a different
    // measure silently gets two competing max-w classes.
    const cls = classesOf(<Page data-testid="page" className="max-w-none" />);
    expect(cls).toContain("max-w-none");
    expect(cls).not.toContain("max-w-xl");
  });
});

describe("FULL_HEIGHT", () => {
  it("drops the tab-bar reserve at md, where there is no tab bar", () => {
    // main reserves 7rem for the fixed tab bar below md. Above it the bar is
    // hidden, so subtracting the reserve would push a centred hero 7rem high.
    expect(FULL_HEIGHT).toContain("min-h-[calc(100dvh-7rem)]");
    expect(FULL_HEIGHT).toContain("md:min-h-dvh");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno task test src/components/page.test.tsx
```

Expected: FAIL. `FULL_HEIGHT` is not exported from `@/components/page`, so the import errors before any assertion runs.

- [ ] **Step 3: Implement the width prop and the shared constant**

In `src/components/page.tsx`, add above the `Page` function:

```tsx
/**
 * Two measures, both identical below md. Desktop is where they diverge: a
 * review card wants to stay a single glanceable object, a deck list does not.
 * Keeping this here rather than as md:max-w-* at every call site is the same
 * reason Page exists at all — three screens had already drifted to three
 * different paddings before it did.
 */
const PAGE_WIDTHS = {
  prose: "max-w-xl md:max-w-2xl",
  wide: "max-w-xl md:max-w-3xl",
} as const;

/**
 * Vertical centring for the screens that are a single centred statement.
 * `main` reserves 7rem for the fixed tab bar, so a screen centring itself in
 * the viewport has to subtract that to land optically centred — but only
 * below md, because above it the tab bar is hidden and the reserve is gone.
 */
export const FULL_HEIGHT =
  "flex min-h-[calc(100dvh-7rem)] md:min-h-dvh flex-col justify-center";
```

Then replace the `Page` function body:

```tsx
export function Page({
  className,
  width = "prose",
  ...props
}: React.ComponentProps<"div"> & { width?: keyof typeof PAGE_WIDTHS }) {
  return (
    <div
      data-slot="page"
      className={cn(
        "mx-auto w-full px-6 pt-10 pb-8",
        PAGE_WIDTHS[width],
        className,
      )}
      {...props}
    />
  );
}
```

Note `max-w-xl` moves out of the first string and into `PAGE_WIDTHS` — leaving it in both would emit two `max-w` classes and defeat the override test.

- [ ] **Step 4: Run the test to verify it passes**

```bash
deno task test src/components/page.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Point both full-height screens at the shared constant**

In `src/routes/_authed.index.tsx`, delete the local constant and its comment:

```tsx
// `main` reserves 7rem for the fixed tab bar. Subtracting it here is what
// lets this screen centre itself in the space that's actually visible,
// instead of centring in a box that then overflows into a stray scrollbar.
const FULL_HEIGHT = "flex min-h-[calc(100dvh-7rem)] flex-col justify-center";
```

and import it instead — change the existing `@/components/page` import to:

```tsx
import {
  FULL_HEIGHT,
  Page,
  PageDescription,
  PageTitle,
} from "@/components/page";
```

The four `<Page className={FULL_HEIGHT}>` usages in that file are unchanged.

In `src/routes/_authed.review.$deckId.tsx`, change the import to:

```tsx
import { BackLink, FULL_HEIGHT, Page, PageTitle } from "@/components/page";
```

and replace the one inlined copy of the string:

```tsx
      <Page className={FULL_HEIGHT}>
```

(it currently reads `<Page className="flex min-h-[calc(100dvh-7rem)] flex-col justify-center">`, in the "Nothing due. Well done." branch).

- [ ] **Step 6: Verify the whole suite and the types**

```bash
deno task test && deno task build
```

Expected: both PASS. `deno task build` catches a missed import or a now-unused local that `noUnusedLocals` rejects.

- [ ] **Step 7: Commit**

```bash
git add src/components/page.tsx src/components/page.test.tsx src/routes/_authed.index.tsx src/routes/_authed.review.\$deckId.tsx
git commit -m "feat(ui): give Page a width prop and share FULL_HEIGHT

Page gains width=prose|wide, identical below md and diverging above it, so
the measure stays in the one container that exists to guard it rather than
spreading to every call site.

FULL_HEIGHT was duplicated in two routes and subtracted a tab-bar reserve
that will not exist on desktop. It moves into page.tsx with md:min-h-dvh so
the fix cannot land in one copy and miss the other."
```

---

### Task 3: Navigation items and the active-route matcher

**Files:**
- Create: `src/components/nav-items.ts`
- Create: `src/lib/nav-active.ts`
- Test: `src/lib/nav-active.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces:
  - from `@/components/nav-items` — `PRIMARY_NAV`, `ACCOUNT_NAV`, `NAV_ITEMS`, and `type NavTo = "/" | "/decks" | "/add" | "/settings"`. Each entry is `{ to, label, icon }` where `icon` is a lucide component.
  - from `@/lib/nav-active` — `isNavActive(pathname: string, to: NavTo): boolean` (pure) and `useNavActive(): (to: NavTo) => boolean` (hook).

- [ ] **Step 1: Write the failing test**

Create `src/lib/nav-active.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isNavActive } from "@/lib/nav-active";

describe("isNavActive", () => {
  it("matches home only exactly", () => {
    expect(isNavActive("/", "/")).toBe(true);
    // Home must not light up on every child route — the tab bar already
    // encoded this as activeOptions={{ exact: to === "/" }}.
    expect(isNavActive("/decks", "/")).toBe(false);
    expect(isNavActive("/decks/abc", "/")).toBe(false);
  });

  it("matches a section exactly", () => {
    expect(isNavActive("/decks", "/decks")).toBe(true);
    expect(isNavActive("/add", "/add")).toBe(true);
    expect(isNavActive("/settings", "/settings")).toBe(true);
  });

  it("keeps a section lit on its children", () => {
    // Opening a deck should not drop the Decks highlight.
    expect(isNavActive("/decks/019283-uuid", "/decks")).toBe(true);
  });

  it("does not match a sibling that merely shares a prefix", () => {
    // The segment boundary is what makes this safe; a bare startsWith
    // would light Decks on a hypothetical /decksettings route.
    expect(isNavActive("/decksettings", "/decks")).toBe(false);
  });

  it("lights nothing during a review session", () => {
    // /review/$deckId is reachable but is not a nav destination. No tab or
    // sidebar entry should claim it.
    expect(isNavActive("/review/abc", "/decks")).toBe(false);
    expect(isNavActive("/review/abc", "/")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno task test src/lib/nav-active.test.ts
```

Expected: FAIL — cannot resolve `@/lib/nav-active`.

- [ ] **Step 3: Write the navigation items module**

Create `src/components/nav-items.ts`:

```ts
import { CalendarCheck, Layers, Plus, User } from "lucide-react";

/**
 * The navigation destinations, split by where they render rather than kept
 * as one array indexed into. The sidebar puts the account entry in its
 * footer and the rest in its menu; the tab bar shows all four in a row.
 * Separate exports rather than NAV_ITEMS.slice(0, 3) because index
 * arithmetic is exactly what breaks the day a fifth entry is added.
 */
export const PRIMARY_NAV = [
  { to: "/", label: "Today", icon: CalendarCheck },
  { to: "/decks", label: "Decks", icon: Layers },
  { to: "/add", label: "Add", icon: Plus },
] as const;

export const ACCOUNT_NAV = {
  to: "/settings",
  label: "Account",
  icon: User,
} as const;

/** Every destination, in tab-bar order. */
export const NAV_ITEMS = [...PRIMARY_NAV, ACCOUNT_NAV];

export type NavTo = (typeof NAV_ITEMS)[number]["to"];
```

- [ ] **Step 4: Write the matcher**

Create `src/lib/nav-active.ts`:

```ts
import { useRouterState } from "@tanstack/react-router";
import type { NavTo } from "@/components/nav-items";

/**
 * One "you are here" rule, shared by the sidebar and the tab bar so the
 * highlight and the aria-current announcement cannot disagree.
 *
 * Home matches exactly; every other destination also matches its children,
 * so opening a deck keeps Decks lit. The trailing slash in the prefix test
 * is what stops /decks claiming a route that merely starts with the same
 * letters.
 */
export function isNavActive(pathname: string, to: NavTo): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * Returns a predicate rather than taking `to` directly: both callers use it
 * inside .map(), and a hook cannot be called in a loop. Subscribing to
 * pathname alone keeps this from re-rendering on unrelated router state.
 */
export function useNavActive(): (to: NavTo) => boolean {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (to) => isNavActive(pathname, to);
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
deno task test src/lib/nav-active.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Verify types**

```bash
deno task build
```

Expected: PASS. This confirms `NavTo` resolves to the literal union `"/" | "/decks" | "/add" | "/settings"` rather than widening to `string` — if it had widened, the `<Link to={...}>` usages in the next task would fail to typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/components/nav-items.ts src/lib/nav-active.ts src/lib/nav-active.test.ts
git commit -m "feat(nav): extract nav items and a shared active-route matcher

Both navigations will read one array and one predicate, so the visual
highlight and aria-current cannot drift apart. isNavActive is pure and
tested; the hook is a thin subscription over location.pathname."
```

---

### Task 4: The sidebar, and the layout that switches between the two navigations

**Files:**
- Create: `src/components/app-sidebar.tsx`
- Modify: `src/routes/_authed.tsx`

**Interfaces:**
- Consumes: `SidebarProvider`, `Sidebar`, `SidebarContent`, `SidebarFooter`, `SidebarGroup`, `SidebarGroupContent`, `SidebarHeader`, `SidebarInset`, `SidebarMenu`, `SidebarMenuButton`, `SidebarMenuItem`, `SidebarRail`, `SidebarTrigger` (Task 1); `PRIMARY_NAV`, `ACCOUNT_NAV`, `NAV_ITEMS` (Task 3); `useNavActive` (Task 3); `useSession` from `@/lib/auth` (existing — returns a session object or `null`, with `session.user.email`).
- Produces: `AppSidebar` from `@/components/app-sidebar`, taking no props.

- [ ] **Step 1: Write the sidebar**

Create `src/components/app-sidebar.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { ACCOUNT_NAV, PRIMARY_NAV } from "@/components/nav-items";
import { useNavActive } from "@/lib/nav-active";
import { useSession } from "@/lib/auth";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";

/**
 * The desktop navigation. Below md the vendored Sidebar renders a closed
 * Sheet — invisible, with no trigger anywhere to open it — and the bottom
 * tab bar in _authed.tsx is what is on screen instead. Both switch on the
 * same 768px, so the two can never both appear or both be missing.
 */
export function AppSidebar() {
  const isActive = useNavActive();
  const session = useSession();
  const accountActive = isActive(ACCOUNT_NAV.to);
  const AccountIcon = ACCOUNT_NAV.icon;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex-row items-center justify-between gap-2 px-3 py-3">
        {/* The wordmark has nothing to truncate to on a 3rem icon rail, so
            it leaves rather than being clipped. */}
        <span className="font-heading text-base font-semibold tracking-[-0.015em] group-data-[collapsible=icon]:hidden">
          mnimi
        </span>
        <SidebarTrigger />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {PRIMARY_NAV.map(({ to, label, icon: Icon }) => {
                const active = isActive(to);
                return (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={label}
                      render={
                        <Link
                          to={to}
                          aria-current={active ? "page" : undefined}
                        />
                      }
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={accountActive}
              // The tooltip stays "Account" rather than the address: on the
              // icon rail the user needs to know where the link goes.
              tooltip={ACCOUNT_NAV.label}
              render={
                <Link
                  to={ACCOUNT_NAV.to}
                  aria-current={accountActive ? "page" : undefined}
                />
              }
            >
              <AccountIcon />
              <span>{session?.user.email ?? ACCOUNT_NAV.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
```

`SidebarMenuButton` already applies `truncate` to its last child span, so a long address cannot widen the 16rem column.

- [ ] **Step 2: Rewire the authed layout**

Replace the whole of `src/routes/_authed.tsx` with:

```tsx
import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { NAV_ITEMS } from "@/components/nav-items";
import { useNavActive } from "@/lib/nav-active";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context, location }) => {
    // The session is resolved before the first render and this subtree
    // covers every application route, so a signed-out visitor never reaches
    // one — whatever URL they typed. router.invalidate() re-runs this on
    // SIGNED_OUT, which is what evicts a user whose token dies mid-session.
    if (!context.auth.getSession()) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* SidebarInset renders the <main> landmark itself, so this is the
          same single main the layout had before, not a nested one. The
          28-unit reserve is for the fixed tab bar, which is md:hidden — so
          the reserve goes with it. */}
      <SidebarInset className="pb-28 md:pb-0">
        <Outlet />
      </SidebarInset>
      <BottomNav />
    </SidebarProvider>
  );
}

/**
 * The phone navigation, unchanged in behaviour and hidden at md where the
 * sidebar takes over. Active state now comes from the shared predicate
 * rather than Link's activeProps, so both navigations answer "you are here"
 * identically.
 */
function BottomNav() {
  const isActive = useNavActive();

  return (
    // Named, because a screen reader listing landmarks otherwise announces
    // an unlabelled "navigation". The tab row is capped and centred to match
    // Page's measure — left to stretch, the four tabs drift to the far
    // corners of a wide window.
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-nav border-t border-border bg-background/85 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-16px_var(--shadow-color)] backdrop-blur-md md:hidden"
    >
      <ul className="mx-auto flex max-w-xl gap-1 p-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
          const active = isActive(to);
          return (
            <li key={to} className="flex-1">
              <Button
                // aria-current is what conveys to a screen reader the same
                // "you are here" that the accent fill conveys visually —
                // colour alone is not an announcement.
                render={
                  <Link to={to} aria-current={active ? "page" : undefined} />
                }
                variant="ghost"
                size="lg"
                className={cn(
                  "h-14 w-full flex-col gap-1 rounded-xl text-xs font-medium text-muted-foreground",
                  active &&
                    "bg-accent text-accent-foreground [&_svg]:text-primary",
                )}
              >
                <Icon />
                {label}
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 3: Verify the guard tests still pass**

`-routes.test.ts` asserts `_authed`'s `beforeLoad` redirect behaviour. Every edit above is inside `component`, so it must be untouched:

```bash
deno task test src/routes/-routes.test.ts
```

Expected: PASS, including "redirects to /login with the visited path when signed out" and the route-directory invariant.

- [ ] **Step 4: Verify the whole suite and the types**

```bash
deno task test && deno task build
```

Expected: both PASS.

- [ ] **Step 5: Check both layouts in a browser**

```bash
deno task dev
```

Open `http://localhost:1420`, sign in, and confirm:

- At a window width of **~1100px**: the sidebar is visible on the left, the bottom tab bar is absent, the active entry is highlighted, and the footer shows the signed-in address.
- At a window width of **767px or less**: the bottom tab bar is visible, the sidebar is absent, and no sheet or overlay appears.
- Navigating to a deck (`/decks/<id>`) keeps **Decks** lit in both navigations.
- ⌘B (or Ctrl+B) collapses the sidebar to an icon rail, and hovering an icon shows its tooltip.

- [ ] **Step 6: Commit**

```bash
git add src/components/app-sidebar.tsx src/routes/_authed.tsx
git commit -m "feat(nav): sidebar at md and up, tab bar below it

The vendored Sidebar and the existing tab bar both switch on 768px, so no
platform detection is needed and the two can never both render. Account
moves to the sidebar footer, labelled with the signed-in address.

The beforeLoad guard is untouched; every edit is inside component."
```

---

### Task 5: Per-screen measures and desktop button widths

**Files:**
- Modify: `src/routes/_authed.decks.index.tsx`
- Modify: `src/routes/_authed.decks.$deckId.tsx`
- Modify: `src/routes/_authed.add.tsx`

**Interfaces:**
- Consumes: `Page`'s `width` prop (Task 2).
- Produces: nothing new.

`_authed.settings.tsx`, `_authed.index.tsx`, `_authed.review.$deckId.tsx` and `login.tsx` are deliberately **not** touched — the first three take the `prose` default and login sits outside the sidebar.

- [ ] **Step 1: Widen the decks list**

In `src/routes/_authed.decks.index.tsx`, change the single opening tag:

```tsx
    <Page width="wide">
```

- [ ] **Step 2: Widen the deck detail screen and grid its notes**

In `src/routes/_authed.decks.$deckId.tsx`, there are **two** `<Page>` opening tags — the deleted-deck branch and the main body. Change both to:

```tsx
      <Page width="wide">
```

Change the notes list from a stack to a grid that splits only on desktop:

```tsx
          <ul className="grid gap-1 md:grid-cols-2">
```

(it currently reads `<ul className="space-y-1">`; the loading skeleton block above it keeps `space-y-1` — three stacked skeletons read fine and gridding them would imply a column count the real list may not fill.)

Give both review buttons an auto width on desktop — a primary action stretched across 48rem reads as a banner, not a button:

```tsx
          className="w-full md:w-auto"
```

Both occurrences: the enabled `Review {dueCount} due` button and the disabled `Nothing due right now` button.

- [ ] **Step 3: Widen the add screen and its buttons**

In `src/routes/_authed.add.tsx` there are **two** `<Page>` opening tags. The idle branch becomes:

```tsx
      <Page width="wide">
```

and the review branch, which already carries a className, becomes:

```tsx
    <Page width="wide" className="space-y-4">
```

Then change all three action buttons from `className="w-full"` to:

```tsx
          className="w-full md:w-auto"
```

They are: `Generate cards` in the idle branch, the `Save {n} cards` button, and the `Cancel` button.

The `CardEditor` list is unchanged — a front/back pair is already two stacked fields, so a second column would halve every field's width for nothing.

- [ ] **Step 4: Verify the suite and the types**

```bash
deno task test && deno task build
```

Expected: both PASS.

- [ ] **Step 5: Confirm the phone layout did not move**

```bash
git diff HEAD -- src/routes/
```

Expected: every changed class either adds an `md:`-prefixed utility or changes a `<Page>` prop whose sub-768px value is identical (`prose` and `wide` are both `max-w-xl` below md). If any hunk changes an unprefixed utility, it is a regression on Android and must be reverted.

- [ ] **Step 6: Check the three screens in a browser**

With `deno task dev` running, at ~1100px:

- `/decks` — the list occupies a 48rem column, rows still one per line.
- `/decks/<id>` — notes render in two columns; the review button is button-sized, not full-width.
- `/add` — the form occupies 48rem; "Generate cards" is button-sized. Generate a note and confirm the card editors remain one per row.

Then narrow the window below 768px and confirm all three are identical to how they looked before this task.

- [ ] **Step 7: Commit**

```bash
git add src/routes/_authed.decks.index.tsx src/routes/_authed.decks.\$deckId.tsx src/routes/_authed.add.tsx
git commit -m "feat(ui): per-screen measures and button widths at md

Decks, deck detail and add take the wide measure; notes split into two
columns; primary actions stop spanning the full column. Review and settings
keep the prose measure deliberately — a review card is a single glanceable
object and widening it only lengthens the saccade per card.

Every changed utility is md:-prefixed, so the phone layout is unchanged."
```

---

### Task 6: Window size

**Files:**
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Set the window dimensions**

In `src-tauri/tauri.conf.json`, replace the single window entry:

```json
      {
        "title": "mnimi",
        "width": 1100,
        "height": 760,
        "minWidth": 380,
        "minHeight": 520
      }
```

`minWidth` is deliberately below the 768px breakpoint: the window must still be draggable narrow enough to exercise the phone layout, which is how the desktop build is used to check Android's layout without a device.

- [ ] **Step 2: Verify the config parses**

```bash
deno eval 'const c = JSON.parse(Deno.readTextFileSync("src-tauri/tauri.conf.json")); console.log(JSON.stringify(c.app.windows[0]))'
```

Expected: `{"title":"mnimi","width":1100,"height":760,"minWidth":380,"minHeight":520}` — which proves both that the file still parses and that the values landed where Tauri reads them.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(desktop): open at 1100x760 with a 380px minimum width

800x600 left 544px of content once the sidebar was subtracted — narrower
than the phone measure it replaced. The minimum stays below the 768px
breakpoint so the window can still be dragged down to the phone layout."
```

---

### Task 7: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the whole suite**

```bash
deno task test
```

Expected: PASS, including the 5 new `page.test.tsx` cases, the 5 new `nav-active.test.ts` cases, and every pre-existing test unchanged.

- [ ] **Step 2: Run the full build**

```bash
deno task build
```

Expected: PASS — `tsr generate`, then `tsc` with `strict`/`noUnusedLocals`/`noUnusedParameters`, then `vite build`.

- [ ] **Step 3: Confirm no stray breakpoints were introduced**

```bash
grep -rn "sm:\|lg:\|xl:" src --include=*.tsx --include=*.ts | grep -v "src/components/ui/" | grep -v "max-w-xl\|max-w-2xl\|max-w-3xl"
```

Expected: exactly one line — the `lg:grid-cols-2` on the deck-detail notes list, which is the sanctioned exception recorded in the Global Constraints and in the spec. Anything else is a stray breakpoint. Vendored `ui/` files are excluded because their breakpoints are upstream's, and the `max-w-*xl` names are substring false positives, not breakpoints.

- [ ] **Step 4: Walk every screen at both widths**

With `deno task dev` running, visit `/`, `/decks`, `/decks/<id>`, `/add`, `/review/<id>` and `/settings` at ~1100px and again at 767px. At each:

- Exactly one navigation is visible.
- The Today hero and the Review empty state are optically centred, not sitting high.
- No horizontal scrollbar appears at either width.
- `/login` (signed out) is unchanged at both widths.

- [ ] **Step 5: Report honestly**

State which checks passed with their output. If anything failed, say so with the failure text rather than describing the work as complete.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: breakpoint choice → Global Constraints; navigation array and two renderings → Tasks 3–4; active-state helper → Task 3; sidebar footer with email → Task 4; `Page` width prop → Task 2; `FULL_HEIGHT` → Task 2; per-screen table → Tasks 2 and 5; `main`/tab-bar reserve → Task 4; window size → Task 6; testing → Tasks 2, 3, 7; the `IconPlaceholder` risk → Task 1 Step 4; the cookie-persistence risk → accepted, no task (degrades to "always expanded", nothing to implement); the `shadcn add` dependency risk → Task 1 Steps 1 and 3.

**Placeholders.** None. Every code step carries the literal code; every verification step carries the command and its expected result.

**Type consistency.** `NavTo` is defined in Task 3 and consumed in Tasks 3–4. `useNavActive()` returns `(to: NavTo) => boolean` in both its definition and both call sites. `PAGE_WIDTHS` keys (`prose`, `wide`) match the `width` prop values used in Tasks 2 and 5. `FULL_HEIGHT` is exported in Task 2 and imported in the same task's Step 5. `ACCOUNT_NAV.icon` is destructured as `AccountIcon` before use in JSX, since a lowercase identifier would be parsed as an HTML tag.
