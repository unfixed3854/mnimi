# React Native Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tauri/Vite client with a feature-complete Android Expo application in `apps/mobile`, retaining the Deno/oRPC server and shared domain logic.

**Architecture:** Expo Router owns native navigation. Native adapters preserve oRPC, Better Auth bearer sessions, React Query caching, durable draft streams, media, and FSRS behaviour; `apps/server` remains a separately running LAN-reachable API.

**Tech Stack:** Deno workspace/tasks, Expo development build, Expo Router, React Native, React Query, oRPC, Better Auth, Expo SecureStore/Audio/FileSystem, NetInfo, Jest Expo, React Native Testing Library.

## Global Constraints

- Rename `apps/app` to `apps/mobile`; Android only; use an Expo development build rather than Expo Go.
- Preserve authentication, deck CRUD, note/card editing, generated drafts, review grading, images, pronunciation, settings, and server-backed mnimi developer tools.
- Read `EXPO_PUBLIC_API_URL`; allow LAN HTTP only in development, require HTTPS in production.
- Keep `apps/server`, its oRPC contract/database, and `libs/shared` as the backend/domain source of truth.
- Exclude browser-only TanStack devtools. Expose mnimi developer actions only in development.
- Use `deno` for all dependency and script commands; never invoke npm, npx, yarn, or pnpm.
- Set root `nodeModulesDir` to `"auto"`, because Expo Metro needs local `node_modules`.

## File Structure

```text
apps/mobile/
  app/                         # Expo Router auth, tabs, detail, review, devtools routes
  src/api/                     # oRPC hooks and authenticated media
  src/auth/                    # SecureStore token and session external store
  src/components/              # native reusable controls
  src/features/                # native screen bodies
  src/lib/                     # FSRS, draft reducer, stream watcher
  __tests__/                   # Jest Expo/RNTL tests
apps/server/main.ts            # host binding
apps/server/app.ts, auth.ts    # browser CORS plus native bearer compatibility
```

---

### Task 1: Replace the web/desktop shell with an Expo Android client

**Files:**
- Move: `apps/app/` → `apps/mobile/`
- Create: `apps/mobile/app/_layout.tsx`, `apps/mobile/app/index.tsx`, `apps/mobile/app.json`, `apps/mobile/babel.config.js`, `apps/mobile/jest.config.js`, `apps/mobile/tsconfig.json`
- Create: `apps/mobile/__tests__/app-shell.test.tsx`
- Modify: `deno.json`, `package.json`, `deno.lock`
- Delete: `apps/mobile/vite.config.ts`, `apps/mobile/vitest.config.ts`, `apps/mobile/index.html`, `apps/mobile/src/main.tsx`, `apps/mobile/src/index.css`, `apps/mobile/src-tauri/`

**Interfaces:**
- Produce `AppProviders({ children }: { children: React.ReactNode })`.
- Produce root Deno tasks `mobile:start`, `mobile:android`, `mobile:test`, `mobile:typecheck`, `mobile:doctor`, and `build:android`.

- [ ] **Step 1: Write the failing shell test**

```tsx
it("renders descendants inside the native providers", () => {
  render(<AppProviders><Text>mnimi mobile</Text></AppProviders>);
  expect(screen.getByText("mnimi mobile")).toBeTruthy();
});
```

- [ ] **Step 2: Run the test**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/app-shell.test.tsx`

Expected: FAIL because Expo configuration and `AppProviders` do not exist.

- [ ] **Step 3: Build the minimal project**

Use `deno add` for the current stable Expo SDK, React Native peers, `expo-router`, `expo-dev-client`, `expo-secure-store`, `expo-audio`, `expo-file-system`, `@react-native-community/netinfo`, `jest-expo`, and `@testing-library/react-native`; run `deno install`. Configure the root workspace as `./apps/mobile` with `nodeModulesDir: "auto"`. Set Expo Router's entry point and Android development-build metadata. All Expo invocations are Deno tasks using `deno run -A npm:expo ...`.

Implement a safe-area `AppProviders`, root Expo `Stack`, and an initial redirect to login.

- [ ] **Step 4: Verify and commit**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/app-shell.test.tsx && deno task mobile:typecheck && deno task mobile:doctor`

```bash
git add deno.json package.json deno.lock apps/mobile
git commit -m "feat: scaffold Expo mobile client"
```

### Task 2: Create native API, session, and React Query foundations

**Files:**
- Create: `apps/mobile/src/config/api-url.ts`, `src/auth/token-store.ts`, `src/auth/session-store.ts`, `src/api/orpc.ts`, `src/api/session-rejection.ts`
- Create: `apps/mobile/src/hooks/use-query-lifecycle.ts`, `src/hooks/use-query-connectivity.ts`
- Create: `apps/mobile/__tests__/api-url.test.ts`, `token-store.test.ts`, `session-store.test.ts`
- Modify: `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Produce `getApiUrl(): string`; `getToken/setToken/clearToken` returning promises; `getSession/subscribeAuth/initializeSession/clearRejectedSession`; and typed `client`/ `orpc`.
- Screens import only these modules for API/session access; no screen uses `fetch`, Better Auth, or SecureStore directly.

- [ ] **Step 1: Write the failing tests**

```ts
expect(getApiUrl({ apiUrl: "http://192.168.1.20:8787", development: true }))
  .toBe("http://192.168.1.20:8787");
expect(() => getApiUrl({ apiUrl: "http://api.example.com", development: false }))
  .toThrow("EXPO_PUBLIC_API_URL must use HTTPS outside development");

await setToken("token");
expect(await getToken()).toBe("token");
await clearToken();
expect(await getToken()).toBeNull();
```

- [ ] **Step 2: Run tests**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/api-url.test.ts apps/mobile/__tests__/token-store.test.ts apps/mobile/__tests__/session-store.test.ts`

Expected: FAIL because native configuration/storage are absent.

- [ ] **Step 3: Implement adapters**

Accept one trailing slash, reject an unset URL, allow `http:` only for private/LAN hosts in `__DEV__`, and require `https:` otherwise. Store `mnimi.bearer` in SecureStore. Recreate Better Auth's bearer header and `set-auth-token` capture, retaining a synchronous external store for route guards. A 401 clears token/session and QueryClient cache once.

Wire one QueryClient into `AppProviders`; map React Native `AppState` to `focusManager` and NetInfo connectivity to `onlineManager`.

- [ ] **Step 4: Verify and commit**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/api-url.test.ts apps/mobile/__tests__/token-store.test.ts apps/mobile/__tests__/session-store.test.ts && deno task mobile:typecheck`

```bash
git add apps/mobile/app/_layout.tsx apps/mobile/src/{config,auth,api,hooks} apps/mobile/__tests__
git commit -m "feat: add native client foundations"
```

### Task 3: Make API access work from a LAN Android build

**Files:**
- Modify: `apps/server/main.ts`, `apps/server/app.ts`, `apps/server/auth.ts`, `.env.example`, `apps/mobile/app.json`
- Modify: `apps/server/app.test.ts`, `apps/server/auth.test.ts`
- Create: `apps/mobile/__tests__/lan-config.test.ts`

**Interfaces:**
- Produce `serverOptions(env): { hostname: string; port: number }`, defaulting to `0.0.0.0`.
- Browser origins remain explicitly allowlisted. Native bearer requests with no `Origin` header must not fail an origin check.

- [ ] **Step 1: Write failing server tests**

```ts
expect(serverOptions({ PORT: "8787", HOST: "192.168.1.20" }))
  .toEqual({ hostname: "192.168.1.20", port: 8787 });

const response = await app.request("/api/auth/get-session", {
  headers: { authorization: "Bearer valid-token" },
});
expect(response.status).not.toBe(403);
```

- [ ] **Step 2: Run tests**

Run: `deno test -A apps/server/app.test.ts apps/server/auth.test.ts`

Expected: FAIL until host resolution/native handling is explicit.

- [ ] **Step 3: Implement the boundary**

Pass `serverOptions(Deno.env.toObject())` into `Deno.serve`. Preserve Hono browser CORS (including the `set-auth-token` exposed header) and Better Auth trusted origins for supplied browser origins, but permit originless bearer transport. Configure cleartext only in the Android development build. Document:

```dotenv
EXPO_PUBLIC_API_URL=http://192.168.1.20:8787
HOST=0.0.0.0
```

- [ ] **Step 4: Verify and commit**

Run: `deno test -A apps/server/app.test.ts apps/server/auth.test.ts && deno task mobile:test --runInBand apps/mobile/__tests__/lan-config.test.ts && deno task check:api`

```bash
git add apps/server .env.example apps/mobile/app.json apps/mobile/__tests__/lan-config.test.ts
git commit -m "feat: support LAN Android development"
```

### Task 4: Add native navigation and shared native controls

**Files:**
- Create: `apps/mobile/app/(auth)/_layout.tsx`, `login.tsx`, `signup.tsx`
- Create: `apps/mobile/app/(tabs)/_layout.tsx`, `index.tsx`, `decks.tsx`, `add.tsx`, `settings.tsx`
- Create: `apps/mobile/src/components/{Screen,LoadingState,ErrorState,EmptyState,PrimaryButton,TextField,ConfirmDialog}.tsx`
- Create: `apps/mobile/src/theme/index.ts`, `apps/mobile/__tests__/navigation-shell.test.tsx`

**Interfaces:**
- Tabs: Today, Decks, Add, Settings. Root stack later owns deck/note/review/devtools.
- `ConfirmDialog` accepts `visible, title, message, confirmLabel, destructive, pending, onCancel, onConfirm`.

- [ ] **Step 1: Write failing navigation test**

```tsx
setSessionForTest(null);
render(<RootLayout />);
expect(await screen.findByText("Sign in")).toBeTruthy();
```

- [ ] **Step 2: Run test**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/navigation-shell.test.tsx`

Expected: FAIL because protected route groups do not exist.

- [ ] **Step 3: Implement**

Use Expo Router Stack/Tabs/Redirect, safe areas, accessibility roles/labels, native loading/error/empty states, and mutation-safe buttons. Signed-out navigation must never render a protected screen; session expiry replaces the tab stack with login. Do not port the desktop sidebar, DOM CSS, or TanStack Router route tree.

- [ ] **Step 4: Verify and commit**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/navigation-shell.test.tsx && deno task mobile:typecheck`

```bash
git add apps/mobile/app apps/mobile/src/components apps/mobile/src/theme apps/mobile/__tests__/navigation-shell.test.tsx
git commit -m "feat: add native navigation shell"
```

### Task 5: Port authentication, Today, settings, decks, and note editing

**Files:**
- Create: `src/features/auth/AuthForm.tsx`, `src/features/today/TodayScreen.tsx`, `src/features/settings/SettingsScreen.tsx`
- Create: `src/api/decks.ts`, `src/api/notes.ts`, `src/features/decks/{DeckListScreen,DeckDetailScreen}.tsx`, `src/features/notes/NoteScreen.tsx`
- Create: `src/components/{CardEditor,DeckPicker}.tsx`
- Create routes: `app/decks/[deckId].tsx`, `app/notes/[noteId].tsx`
- Create tests: `auth-form.test.tsx`, `settings-screen.test.tsx`, `deck-list-screen.test.tsx`, `deck-detail-screen.test.tsx`, `note-screen.test.tsx`

**Interfaces:**
- Preserve `signIn/signUp/signOut/updateNativeLanguage/updateTtsAutoplay/useSession`.
- Preserve `useDecks/useDeck/useCreateDeck/useRemoveDeck/useNotes/useNote/useSaveNote`.
- `CardEditor({ cards, editable, onChange })` and `DeckPicker({ decks, value, onChange, onCreate })`.

- [ ] **Step 1: Write failing feature tests**

```tsx
await user.press(screen.getByRole("button", { name: "Remove deck" }));
expect(removeDeckMock).not.toHaveBeenCalled();
await user.press(screen.getByRole("button", { name: "Remove" }));
expect(removeDeckMock).toHaveBeenCalledWith({ deckId: "deck-1" });
```

- [ ] **Step 2: Run tests**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/auth-form.test.tsx apps/mobile/__tests__/settings-screen.test.tsx apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx apps/mobile/__tests__/note-screen.test.tsx`

Expected: FAIL because the native feature modules are absent.

- [ ] **Step 3: Implement parity**

Use controlled native inputs, picker/action-sheet language selection, an autoplay Switch, and serialized preference writes. Preserve failed auth form input, clear secure session/cache on sign-out, uncapped Today due count, deck creation/list/detail/removal confirmation, and all note/card fields including cloze, hints, image cues, save invalidation, and image/audio polling.

- [ ] **Step 4: Verify and commit**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/auth-form.test.tsx apps/mobile/__tests__/settings-screen.test.tsx apps/mobile/__tests__/deck-list-screen.test.tsx apps/mobile/__tests__/deck-detail-screen.test.tsx apps/mobile/__tests__/note-screen.test.tsx && deno task mobile:typecheck`

```bash
git add apps/mobile
git commit -m "feat: port native account decks and notes"
```

### Task 6: Port review, authenticated media, and audio

**Files:**
- Create: `app/review/[deckId].tsx`, `src/api/review.ts`, `src/api/media.ts`, `src/features/review/ReviewScreen.tsx`
- Create: `src/components/{CardFace,GeneratedImage,ImageCueReviewCard,PronunciationControl}.tsx`, `src/hooks/use-card-audio.ts`
- Create: `__tests__/review-screen.test.tsx`, `__tests__/use-card-audio.test.ts`

**Interfaces:**
- Preserve `useDueCards/useDueCount/useGradeCard` and existing `gradeCard(card, rating)` FSRS calculation.
- `useCardAudio(cardId)` returns `play, stop, status, error` and releases playback/download resources on unmount.

- [ ] **Step 1: Write failing tests**

```tsx
render(<ReviewScreen deckId="deck-1" />);
expect(screen.queryByRole("button", { name: "Good" })).toBeNull();
fireEvent.press(screen.getByRole("button", { name: "Show answer" }));
expect(screen.getByRole("button", { name: "Good" })).toBeTruthy();
```

- [ ] **Step 2: Run tests**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/review-screen.test.tsx apps/mobile/__tests__/use-card-audio.test.ts`

Expected: FAIL because native review/media modules are absent.

- [ ] **Step 3: Implement parity**

Fetch image/audio bytes with bearer auth; store temporary native files and delete them when the owner changes/unmounts. Preserve image-cue reveal integrity, audio autoplay preference, error/retry display, first-due-card queue semantics, and the invariant that failed grading leaves the same card visible.

- [ ] **Step 4: Verify and commit**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/review-screen.test.tsx apps/mobile/__tests__/use-card-audio.test.ts && deno task mobile:typecheck`

```bash
git add apps/mobile
git commit -m "feat: port native review media and audio"
```

### Task 7: Port generated draft flows and development tools

**Files:**
- Create: `src/api/{drafts,debug}.ts`, `src/lib/{draft-state,watch-draft}.ts`, `src/hooks/use-draft-session.ts`
- Create: `src/features/add/AddScreen.tsx`, `src/features/devtools/DevtoolsScreen.tsx`
- Create: `src/components/{DraftStatus,StreamingCards,DraftIndicator}.tsx`
- Create: `app/devtools.tsx`, tests `draft-state.test.ts`, `watch-draft.test.ts`, `add-screen.test.tsx`, `devtools-screen.test.tsx`

**Interfaces:**
- Keep existing `DraftState`, `draftReducer`, `isSavable`, and `runDraftWatch` semantics, including three reconnect attempts.
- `useDraftSession` owns draft watch abort, autosave timer cleanup, save/discard/retry operations, and query invalidations.

- [ ] **Step 1: Write failing tests**

```ts
const state = draftReducer(initialDraftState, { type: "loaded", draft: failedDraft });
expect(state.status).toBe("failed");
expect(isSavable(state)).toBe(true);

await runDraftWatch("draft-1", failingOpen, dispatch, new AbortController().signal, sleep);
expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "failed" }));
```

- [ ] **Step 2: Run tests**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/draft-state.test.ts apps/mobile/__tests__/watch-draft.test.ts apps/mobile/__tests__/add-screen.test.tsx apps/mobile/__tests__/devtools-screen.test.tsx`

Expected: FAIL because the native draft/devtools feature modules are absent.

- [ ] **Step 3: Implement parity**

Move the reducer/watch unchanged, bind them to oRPC in the hook, and render native deck/source inputs, streaming cards, edit/remove/save/discard controls, durable image status/retry, and cleanup on navigation. Saving while the image job is running remains permitted.

Port SRS reset/summary and German seed to `DevtoolsScreen`, gate its import, route, and Settings link behind `__DEV__`; keep server `--devtools` authorization. Do not add TanStack browser devtools.

- [ ] **Step 4: Verify and commit**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/draft-state.test.ts apps/mobile/__tests__/watch-draft.test.ts apps/mobile/__tests__/add-screen.test.tsx apps/mobile/__tests__/devtools-screen.test.tsx && deno task mobile:typecheck`

```bash
git add apps/mobile
git commit -m "feat: port native drafts and development tools"
```

### Task 8: Remove the old implementation and verify Android end to end

**Files:**
- Delete remaining web-only `apps/mobile/src/routes/`, `src/components/ui/`, legacy web components/hooks/libs/tests, `src-tauri/`, Vite/Vitest configs, `index.html`
- Modify: `deno.json`, `package.json`, `deno.lock`, `.github/workflows/ci.yml`, `README.md`
- Create: `apps/mobile/e2e/android-smoke.md`, `apps/mobile/e2e/android-smoke.sh`, `apps/mobile/__tests__/legacy-web-files.test.ts`

**Interfaces:**
- Root tasks run API checks, native typecheck/tests, and Expo Android build only.
- The source tree has one client implementation: Expo/React Native under `apps/mobile`.

- [ ] **Step 1: Write a failing absence test**

```ts
for (const path of ["src-tauri", "vite.config.ts", "vitest.config.ts", "index.html"]) {
  expect(await exists(join(MOBILE_ROOT, path))).toBe(false);
}
```

- [ ] **Step 2: Run it**

Run: `deno task mobile:test --runInBand apps/mobile/__tests__/legacy-web-files.test.ts`

Expected: FAIL while obsolete client artifacts remain.

- [ ] **Step 3: Delete only superseded code and retarget tooling**

Remove Tauri, Vite, React DOM, TanStack Router/devtools, web Tailwind/Base UI/shadcn, and Vitest/jsdom dependencies only after no Expo source imports them. Retarget CI and docs to Deno tasks. The smoke script validates `EXPO_PUBLIC_API_URL`, starts `HOST=0.0.0.0` API, and documents Android-device confirmation for sign-in, decks, notes, drafts, review, image, audio, settings, developer tools, and production HTTP rejection.

- [ ] **Step 4: Run complete verification**

Run: `deno task check:api && deno task mobile:typecheck && deno task mobile:test --runInBand && deno task build:android && ! rg -n "@tauri-apps|tauri|vite|@tanstack/react-router|react-dom" apps/mobile deno.json package.json`

Expected: PASS. Run the documented smoke checklist on an Android development build on the same Wi-Fi network as the API.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: replace Tauri client with Expo mobile app"
```

## Plan Self-Review

| Requirement | Tasks |
| --- | --- |
| Expo/Android and directory rename | 1, 8 |
| Secure bearer API, lifecycle/connectivity | 2 |
| LAN development and production HTTPS boundary | 2, 3, 8 |
| Feature parity | 4, 5, 6, 7 |
| Native-only development tools | 7 |
| Tauri/Vite removal and Deno-only tooling | 1, 8 |
| Automated plus physical-device verification | 8 |

