# SRS Devtools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a development-only TanStack Devtools panel that resets SRS state for all of the signed-in user's cards, one selected deck, or one selected card.

**Architecture:** A development-gated authenticated oRPC router owns summary and reset operations. A focused React panel calls those procedures with React Query, while a small root-level adapter is the only code coupled to the alpha TanStack Devtools shell. Resetting is transactional, user-scoped, and preserves all non-SRS card data and suspension.

**Tech Stack:** Deno tasks/package management, TypeScript, React 19, TanStack Query, TanStack Devtools, oRPC, Drizzle SQLite, Vitest, Testing Library, ts-fsrs.

## Global Constraints

- Use `deno` for all package management and script execution; never use npm, npx, yarn, or pnpm.
- Expose all-card, selected-deck, and selected-card reset scopes.
- Reset only FSRS scheduling state and matching review logs; preserve content, membership, media, generation metadata, and suspension.
- Require authentication and scope every read/write to the signed-in user.
- Gate the browser shell and server operations independently to development mode.
- Keep the alpha TanStack Devtools dependency behind one `MnimiDevtools` component.
- Follow strict red-green-refactor: every production behavior starts with a test observed failing for the expected reason.

## File map

- Create `server/router/debug.ts`: development guard, debug summary, scope validation, and transactional SRS reset.
- Create `server/router/debug.test.ts`: real-SQLite behavior, authorization, isolation, preservation, and rollback coverage.
- Modify `server/router/base.ts`: add the `devtoolsEnabled` request-context capability.
- Modify `server/router/index.ts`: register the debug router.
- Modify `server/app.ts`: accept and pass the server development flag into oRPC context.
- Modify `server/main.ts`: enable server devtools only with an explicit `--devtools` argument.
- Modify `server/app.test.ts`: prove the HTTP application defaults to disabled and honors explicit enablement.
- Modify `server/router/testing.ts`: enable debug procedures in test contexts and add a transactional delete fault injector.
- Modify `deno.json`: pass `--devtools` only from `dev:api`.
- Create `src/lib/api/debug.ts`: React Query hooks and cache invalidation for summary/reset.
- Create `src/components/srs-devtools-panel.tsx`: scope selection, confirmation, mutation states, and feedback.
- Create `src/components/srs-devtools-panel.test.tsx`: panel behavior tests.
- Create `src/components/mnimi-devtools.tsx`: isolated TanStack Devtools adapter and SRS plugin registration.
- Create `src/components/mnimi-devtools.test.tsx`: development guard and plugin registration boundary tests.
- Modify `src/main.tsx`: mount `MnimiDevtools` beside the router provider.
- Modify `vite.config.ts`: register TanStack's Vite plugin first.
- Modify `package.json` and `deno.lock`: add TanStack Devtools development dependencies through Deno.

---

### Task 1: Development-gated server reset API

**Files:**
- Create: `server/router/debug.ts`
- Create: `server/router/debug.test.ts`
- Modify: `server/router/base.ts`
- Modify: `server/router/index.ts`
- Modify: `server/router/testing.ts`

**Interfaces:**
- Consumes: `cards`, `notes`, `decks`, and `reviewLogs` Drizzle tables; `authed`; `withWriteLock`.
- Produces: `debugRouter.summary`, `debugRouter.resetSrs`; `AppContext.devtoolsEnabled?: boolean`; summary shape `{ totalCards, decks, cards }`; reset input union `{ scope: "all" } | { scope: "deck"; deckId: string } | { scope: "card"; cardId: string }`; reset result `{ resetCount: number }`.

- [ ] **Step 1: Write failing server tests for the development gate and summary isolation**

Create `server/router/debug.test.ts` with a real temporary database. Reuse the existing router-level `seed` pattern to create two decks and several cards for Ada plus one for Bob. Add tests which call `debugRouter.summary` and prove:

```ts
const summary = await call(debugRouter.summary, {}, { context: ada.context });
expect(summary.totalCards).toBe(3);
expect(summary.decks.map(({ name, cardCount }) => [name, cardCount])).toEqual([
  ["German", 2],
  ["Physics", 1],
]);
expect(summary.cards).toEqual(expect.arrayContaining([
  expect.objectContaining({ deckId: german.id, aspect: "aspect-0" }),
]));
expect(summary.cards.every((card) => card.userId === undefined)).toBe(true);
```

Call both procedures with `{ ...ada.context, devtoolsEnabled: false }` and expect `{ code: "FORBIDDEN" }`. Include Bob's data in the fixture and assert it never appears in Ada's summary.

- [ ] **Step 2: Run the summary tests and verify RED**

Run: `deno task test -- server/router/debug.test.ts`

Expected: FAIL because `./debug.ts` and `debugRouter` do not exist.

- [ ] **Step 3: Implement the development guard and summary**

Add `devtoolsEnabled?: boolean` to `AppContext`. In `debug.ts`, build on `authed` with middleware that throws `new ORPCError("FORBIDDEN", { message: "Devtools are disabled" })` unless `context.devtoolsEnabled === true`.

Implement `summary` as two owned queries: decks ordered by creation time and cards joined through notes, ordered deterministically. Return only:

```ts
type DebugSummary = {
  totalCards: number;
  decks: Array<{ id: string; name: string; cardCount: number }>;
  cards: Array<{
    id: string;
    deckId: string;
    aspect: string;
    front: string;
  }>;
};
```

Count cards per deck from the owned card result, so empty decks remain available with `cardCount: 0`. Export `{ summary, resetSrs }` only after reset is implemented; temporarily export `{ summary }` to make this red-green cycle pass. Set `devtoolsEnabled: true` in `createTestServer().signIn()` contexts.

- [ ] **Step 4: Run the summary tests and verify GREEN**

Run: `deno task test -- server/router/debug.test.ts`

Expected: summary and disabled-summary tests PASS; the reset-disabled test may remain skipped until Step 7 rather than importing a nonexistent member.

- [ ] **Step 5: Write failing reset tests for all three scopes**

Grade/seed cards into visibly non-new state and insert review logs. Add independent tests for `{ scope: "all" }`, `{ scope: "deck", deckId }`, and `{ scope: "card", cardId }`. Use literal expected fields:

```ts
expect(resetResult).toEqual({ resetCount: 1 });
expect(resetCard).toMatchObject({
  stability: 0,
  difficulty: 0,
  elapsedDays: 0,
  scheduledDays: 0,
  learningSteps: 0,
  reps: 0,
  lapses: 0,
  state: 0,
  lastReview: null,
});
expect(resetCard.due.getTime()).toBeGreaterThanOrEqual(beforeReset);
expect(resetCard.due.getTime()).toBeLessThanOrEqual(afterReset);
```

Assert all cards affected by one request share the exact due timestamp, only matching review logs disappear, and unrelated cards/logs retain their pre-reset values.

- [ ] **Step 6: Run the reset tests and verify RED**

Run: `deno task test -- server/router/debug.test.ts`

Expected: FAIL because `debugRouter.resetSrs` is missing.

- [ ] **Step 7: Implement transactional reset**

Validate with a Zod discriminated union using UUIDv7 identifiers. Within one `withWriteLock(() => context.db.transaction(...))`, build the owned target predicate for the scope, count the target rows, delete owned `reviewLogs` whose `cardId` belongs to the target subquery, and update target cards with one captured `now` and the literal new-card scheduling fields. Return `{ resetCount }`; return zero without writing for an empty target. Export both procedures and register `debug: debugRouter` in `server/router/index.ts`.

- [ ] **Step 8: Run reset tests and verify GREEN**

Run: `deno task test -- server/router/debug.test.ts`

Expected: all scope tests PASS.

- [ ] **Step 9: Write failing safety tests**

Add tests that prove:

- another user's deck/card identifier resets zero rows and reveals no data;
- an unknown valid UUIDv7 resets zero rows;
- a suspended card remains suspended;
- front/back, note/deck association, audio fields, and image cue remain unchanged;
- the disabled context rejects `resetSrs` with `FORBIDDEN`;
- if deletion of `reviewLogs` throws after the card update, the transaction restores the card state.

Add a `failingDeleteFrom` proxy to `server/router/testing.ts`, mirroring `failingInsertInto` and wrapping transaction callbacks, so failure reaches the real delete inside the transaction. Order implementation writes as card update followed by log deletion to prove rollback of an already completed update.

- [ ] **Step 10: Run safety tests and verify RED**

Run: `deno task test -- server/router/debug.test.ts`

Expected: at least the rollback test FAILS until `failingDeleteFrom` and transaction ordering are correct.

- [ ] **Step 11: Complete minimal safety implementation and refactor shared target construction**

Keep scope construction in one private helper used by count, update, and log deletion. Ensure each branch includes `cards.userId = context.userId`; the deck branch additionally selects owned note ids. Do not add edit, unsuspend, seed, or arbitrary SQL capabilities.

- [ ] **Step 12: Run server tests and commit**

Run: `deno task test -- server/router/debug.test.ts server/router/base.test.ts`

Expected: PASS with no warnings.

Commit:

```bash
git add server/router/debug.ts server/router/debug.test.ts server/router/base.ts server/router/index.ts server/router/testing.ts
git commit -m "feat: add development SRS reset API"
```

---

### Task 2: Explicit server startup gate

**Files:**
- Modify: `server/app.ts`
- Modify: `server/app.test.ts`
- Modify: `server/main.ts`
- Modify: `deno.json`

**Interfaces:**
- Consumes: `AppContext.devtoolsEnabled` and the registered debug router from Task 1.
- Produces: `createApp({ db, auth, corsOrigin?, devtoolsEnabled? })`; `deno task dev:api` passes `--devtools`; `deno task start` does not.

- [ ] **Step 1: Write failing HTTP-level gate tests**

In `server/app.test.ts`, add authenticated RPC calls against two app instances. The default `createApp({ db, auth })` request to `/rpc/debug/summary` must return an oRPC forbidden response; `createApp({ db, auth, devtoolsEnabled: true })` must return the user's empty summary. Assert status/payload behavior through the real Hono `app.request`, following existing authentication helpers in that file.

- [ ] **Step 2: Run tests and verify RED**

Run: `deno task test -- server/app.test.ts`

Expected: the explicitly enabled app remains forbidden because `createApp` does not pass the flag into request context.

- [ ] **Step 3: Pass the explicit flag through application construction**

Extend `createApp` options with `devtoolsEnabled = false` and include it in the oRPC context. In `server/main.ts`, use:

```ts
const devtoolsEnabled = Deno.args.includes("--devtools");
const app = createApp({ db, auth, devtoolsEnabled });
```

Change only `dev:api` to append `--devtools` after `server/main.ts`; leave `start` unchanged.

- [ ] **Step 4: Run gate and full server-router tests**

Run: `deno task test -- server/app.test.ts server/router/debug.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app.ts server/app.test.ts server/main.ts deno.json
git commit -m "feat: enable reset API only in dev server"
```

---

### Task 3: SRS panel behavior and query integration

**Files:**
- Create: `src/lib/api/debug.ts`
- Create: `src/components/srs-devtools-panel.tsx`
- Create: `src/components/srs-devtools-panel.test.tsx`

**Interfaces:**
- Consumes: `orpc.debug.summary`, `orpc.debug.resetSrs`, TanStack Query's shared `QueryClient`.
- Produces: `useDebugSummary()`, `useResetSrs()`, and `SrsDevtoolsPanel`.

- [ ] **Step 1: Write failing render/selection tests**

Mock only the oRPC boundary with complete summary data. Render the real panel inside a real `QueryClientProvider`. Prove that all/deck/card choices are present; deck scope reveals one deck selector; card scope reveals deck then card selector; and switching the selected deck filters visible card options. Name assertions by accessible roles and labels, not implementation test ids.

- [ ] **Step 2: Run component tests and verify RED**

Run: `deno task test -- src/components/srs-devtools-panel.test.tsx`

Expected: FAIL because the panel module does not exist.

- [ ] **Step 3: Implement summary hook and minimal selection UI**

Implement `useDebugSummary` with `orpc.debug.summary.queryOptions({ input: {} })`. In the panel, keep `scope`, `deckId`, and `cardId` state; derive card choices and affected count from summary data; clear card selection when its deck changes. Use semantic labels/selects/buttons and compact styles that work inside the devtools panel without depending on application-page layout.

- [ ] **Step 4: Run selection tests and verify GREEN**

Run: `deno task test -- src/components/srs-devtools-panel.test.tsx`

Expected: PASS.

- [ ] **Step 5: Write failing confirmation and mutation-state tests**

Stub `window.confirm` and assert observable behavior: incomplete/empty targets disable the reset button; confirmation text includes the exact count and scope label; cancellation makes no RPC request; confirmation sends the exact discriminated-union payload; pending state prevents repeated action; success displays `Reset N cards`; failure displays the returned error message.

- [ ] **Step 6: Run action tests and verify RED**

Run: `deno task test -- src/components/srs-devtools-panel.test.tsx`

Expected: FAIL because mutation behavior is missing.

- [ ] **Step 7: Implement reset hook and action feedback**

Implement `useResetSrs` with `orpc.debug.resetSrs.mutationOptions`. On success invalidate `orpc.debug.key()`, `orpc.cards.key()`, and `orpc.decks.key()`. The panel must calculate confirmation copy before calling `window.confirm`, disable while pending, and render concise success/error status in an `aria-live` region.

- [ ] **Step 8: Run panel tests and refactor**

Run: `deno task test -- src/components/srs-devtools-panel.test.tsx`

Expected: PASS. Extract only small pure derivations if duplication is present; keep the panel and its single-purpose hooks focused.

- [ ] **Step 9: Commit**

```bash
git add src/lib/api/debug.ts src/components/srs-devtools-panel.tsx src/components/srs-devtools-panel.test.tsx
git commit -m "feat: add SRS reset devtools panel"
```

---

### Task 4: TanStack Devtools shell and production removal

**Files:**
- Create: `src/components/mnimi-devtools.tsx`
- Create: `src/components/mnimi-devtools.test.tsx`
- Modify: `src/main.tsx`
- Modify: `vite.config.ts`
- Modify: `package.json`
- Modify: `deno.lock`

**Interfaces:**
- Consumes: `SrsDevtoolsPanel`; `@tanstack/react-devtools`; `@tanstack/devtools-vite`.
- Produces: `MnimiDevtools`, containing the sole `<TanStackDevtools>` integration with plugin `{ id: "mnimi-srs", name: "SRS", render: <SrsDevtoolsPanel /> }`.

- [ ] **Step 1: Install alpha devtools packages through Deno**

Run:

```bash
deno add --dev npm:@tanstack/react-devtools npm:@tanstack/devtools-vite
```

Inspect the installed type declarations with `deno info`/`rg` before using the API; adapt only import names or plugin field names if the installed alpha differs from the documented interface.

- [ ] **Step 2: Write failing adapter test**

Mock `@tanstack/react-devtools` at the package boundary with a component that renders the supplied plugin elements. Render `MnimiDevtools` and assert the real SRS panel heading/control appears through a plugin named `SRS`. Add a production-mode test around an exported pure `devtoolsEnabled(isDev: boolean)` guard if Vitest cannot safely replace `import.meta.env.DEV`; verify false returns no mounted shell and true mounts it.

- [ ] **Step 3: Run adapter test and verify RED**

Run: `deno task test -- src/components/mnimi-devtools.test.tsx`

Expected: FAIL because `MnimiDevtools` does not exist.

- [ ] **Step 4: Implement the isolated adapter and mount it**

Create `MnimiDevtools` with the explicit `import.meta.env.DEV` guard and one custom SRS plugin. Mount it in `src/main.tsx` inside `QueryClientProvider`, beside `RouterProvider`, so its hooks share the application query client. Do not add a route or sidebar item.

- [ ] **Step 5: Register the Vite plugin first**

Import `devtools` from `@tanstack/devtools-vite` and place `devtools()` before `tanstackRouter(...)` in `vite.config.ts`, preserving the router-before-React ordering among the existing plugins and the default `removeDevtoolsOnBuild` behavior.

- [ ] **Step 6: Run adapter and panel tests**

Run: `deno task test -- src/components/mnimi-devtools.test.tsx src/components/srs-devtools-panel.test.tsx`

Expected: PASS.

- [ ] **Step 7: Verify production removal behavior**

Run: `deno task build`

Expected: route generation, TypeScript, and Vite production build all succeed. Inspect built JavaScript with:

```bash
if rg -n "mnimi-srs|Reset SRS state|TanStackDevtools" dist; then
  echo "devtools leaked into production bundle" >&2
  exit 1
fi
```

Expected: exit 0 with no matches.

- [ ] **Step 8: Commit**

```bash
git add package.json deno.lock vite.config.ts src/main.tsx src/components/mnimi-devtools.tsx src/components/mnimi-devtools.test.tsx
git commit -m "feat: mount SRS plugin in TanStack Devtools"
```

---

### Task 5: Full verification and documentation alignment

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: completed client/server behavior.
- Produces: concise development documentation describing how to open and use the SRS panel.

- [ ] **Step 1: Document the development tool**

Under Running or Tests, document that `deno task dev` enables the floating TanStack Devtools trigger, the SRS plugin resets all/deck/card scheduling and history, suspension is preserved, and `deno task start` plus production builds disable it.

- [ ] **Step 2: Run formatting/static checks available in the project**

Run:

```bash
deno fmt --check
deno task check:api
deno task build
```

Expected: all exit 0. If `deno fmt --check` reports only files touched by this work, run `deno fmt` on those explicit files and repeat the check; do not reformat unrelated user files.

- [ ] **Step 3: Run the complete test suite**

Run: `deno task test`

Expected: all tests PASS with no unhandled errors or warnings.

- [ ] **Step 4: Recheck production output and working tree**

Run the production artifact command from Task 4 again, then `git diff --check` and `git status --short`. Expected: no devtools strings in `dist`, no whitespace errors, and only the intended README change remains uncommitted.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: describe development SRS reset tools"
```

- [ ] **Step 6: Record final evidence**

Report the exact passing test count, successful `deno task check:api`, successful production build, production-bundle absence check, and final commit hashes. Do not claim completion from stale or partial command output.
