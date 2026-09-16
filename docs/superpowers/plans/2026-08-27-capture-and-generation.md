# Capture and Generation Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single technical Add draft with a durable Creation inbox that routes requests by deck context, schedules at most two text generations per learner, reveals only complete persisted cards, supports focused review/edit/AI adjustment/Undo, and delivers optional background notifications.

**Architecture:** Keep the server namespace and `drafts` table name for one compatibility window, but turn each row into a revisioned multi-creation aggregate backed by lease-based text work, independently leased image attempts, idempotent save receipts, and user-scoped notification installations. The mobile app uses a user-scoped persisted composer/outbox, summary and detail queries/subscriptions, a content-first creation detail route, and a separate single-card editor; server rows remain authoritative across navigation and process restarts.

**Tech Stack:** Bun 1.3.13, TypeScript 6, Expo SDK 57, React Native 0.86, Expo Router, React Query/oRPC, NativeWind, React Native Reusables, AsyncStorage, Expo Notifications, Expo Device, Drizzle ORM/libSQL, Zod, TanStack AI/OpenRouter, Vitest, Jest, React Native Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-27-capture-and-generation-design.md`

## Global Constraints

- Read `AGENTS.md`, `docs/superpowers/specs/2026-08-27-mobile-learning-experience-north-star-design.md`, `docs/superpowers/specs/2026-08-27-card-and-note-experience-design.md`, and the capture specification before editing.
- Use `bun` for package management and every public script or CLI invocation. Do not use Deno, npm, npx, Yarn, or pnpm.
- Run the complete repository suite with `bun run test`; never substitute raw `bun test` for the full suite.
- Keep source, UI copy, tests, specifications, plans, commits, and QA records in English.
- Follow strict TDD: write one behavior test, run it and confirm the expected failure, implement the minimum behavior, rerun it green, then refactor.
- Use conventional commits and stage only the paths reviewed for the current task.
- Keep the saved-note editor simplification out of scope. Reuse `CardPresentation` and pure cloze/card-draft functions, but do not move `NoteEditView` or its multi-card form into creation.
- Keep the internal Expo Router tab path `/add`, but expose only **Create** in learner-facing navigation and copy.
- Accept a trimmed natural-language request of 1–2,000 characters. Never clear invalid composer input.
- Do not render a routine deck picker, card-count option, image option, domain, language, provider, model, retry counter, elapsed timer, confidence percentage, job id, raw stage, or raw cloze syntax.
- Generate one to six cards. Show a card only after that whole card validates and has been persisted for the active attempt.
- Use the chosen deck name and optional description, interpreted learning goal, original request, and learner native language as generation context.
- AI may match an owned deck, offer two or three owned choices, or propose a new deck. It may never authorize ownership or silently create a deck.
- Count routing, generation, retry, adjustment, and change-deck regeneration against one durable per-user text-work limit of two. Image generation uses a separate bounded pool and never retains a text slot.
- Treat attempt id, revision, and lease owner as write fences. Canceled, expired, or superseded attempts cannot publish cards or media.
- Keep completed cards, current reviewed cards, one AI-adjustment Undo snapshot, routing decisions, safe errors, and retry context durable.
- Preserve the current reviewed set while AI adjustment or change-deck regeneration is queued/running. Replace it only after complete set validation.
- Clear the one Undo snapshot on the next manual or AI card-set mutation; ordinary image changes do not clear it.
- Save exactly one reviewed creation idempotently, remove only that item from inbox caches, and leave every other creation untouched.
- Make notifications optional and just-in-time. The inbox and badge remain authoritative if permission or delivery fails.
- Keep touch targets at least 48 px, inbox rows at least 56 px, actions reachable with the keyboard open, state readable without color or motion, and reduced-motion ordering stable.
- Native notification acceptance requires a rebuilt Android app; Expo Go or JavaScript hot reload is not sufficient evidence.

## File Structure

### Shared and server model boundaries

- `apps/server/ai/schemas.ts`: one-to-six complete-card validation.
- `apps/server/ai/complete-cards.ts`: pure projection of only structurally completed, individually valid cards.
- `apps/server/ai/creation-routing.ts`: validated matched/ambiguous/new-deck routing prompts and ownership-safe projection.
- `apps/server/ai/creation-generation.ts`: deck-context generation and complete-card progress.
- `apps/server/ai/creation-adjustment.ts`: set-level adjustment against current reviewed cards.
- `apps/server/ai/model-calls.ts`: production route/generate/adjust provider adapter without provider terminology crossing the boundary.
- `apps/server/db/schema.ts`: multi-creation aggregate, independent image attempts, save receipts, and notification installations.
- `apps/server/creations/contracts.ts`: durable creation types, public summary/detail projection, learner-safe error categories, and shared card normalization.
- `apps/server/creations/events.ts`: process-local summary/detail subscription delivery only.
- `apps/server/creations/scheduler.ts`: atomic per-user claims, lease recovery/heartbeat, accepted-order advancement, and scheduler kicks.
- `apps/server/creations/worker.ts`: route/generate/adjust/regenerate execution fenced by attempt and lease.
- `apps/server/creations/image-scheduler.ts`: separately bounded, durable image attempts and ownership transfer.
- `apps/server/router/drafts.ts`: new inbox/detail/mutation/watch procedures plus legacy adapters.
- `apps/server/router/creation-save.ts`: idempotent creation-to-note transaction and pending-image transfer.
- `apps/server/notifications/expo-push.ts`: injected Expo Push transport.
- `apps/server/notifications/dispatcher.ts`: short-window grouping of actionable transitions.
- `apps/server/router/notifications.ts`: ownership-scoped installation registration/unregistration.

### Mobile persistence, data, and screens

- `apps/mobile/src/lib/creation-outbox.ts`: request normalization and a single serialized per-user composer/outbox document.
- `apps/mobile/src/lib/creation-card-draft.ts`: hydrate/validate/serialize one creation card with no raw markup in UI state.
- `apps/mobile/src/api/creations.ts`: typed list/detail/watch and revision-safe mutations with exact cache ownership.
- `apps/mobile/src/api/notifications.ts`: register/unregister installation procedures.
- `apps/mobile/src/hooks/use-creation-outbox.ts`: durable submit/retry/ack orchestration.
- `apps/mobile/src/hooks/use-creation-detail.ts`: one detail query/subscription isolated from local editing.
- `apps/mobile/src/notifications/registration.ts`: just-in-time permission, Expo token registration, foreground suppression, and deep links.
- `apps/mobile/src/features/create/create-screen.tsx`: composer plus grouped Creation inbox.
- `apps/mobile/src/features/create/request-composer.tsx`: growing 2,000-character natural-language field and one Create action.
- `apps/mobile/src/features/create/creation-inbox.tsx`: ordered non-empty groups and accessible summary rows.
- `apps/mobile/src/features/create/deck-decision-dialog.tsx`: candidate choice and editable new-deck confirmation.
- `apps/mobile/src/features/create/creation-detail-screen.tsx`: detail orchestration only.
- `apps/mobile/src/features/create/creation-progress.tsx`: honest real-stage, complete-card, image, and reduced-motion presentation.
- `apps/mobile/src/features/create/creation-preview.tsx`: content-first ready/partial preview and set-level actions.
- `apps/mobile/src/features/create/creation-card-editor-screen.tsx`: one basic or cloze card, local recovery, More options, and Done.
- `apps/mobile/src/features/create/adjust-creation-dialog.tsx`: compact natural-language adjustment input.
- `apps/mobile/app/creations/[creationId].tsx` and `apps/mobile/app/creations/[creationId]/card/[cardKey].tsx`: focused routes outside the tab navigator.

---

### Task 1: Define complete-card, routing, and creation-card pure contracts

**Files:**
- Modify: `apps/server/ai/schemas.ts`
- Create: `apps/server/ai/complete-cards.ts`
- Create: `apps/server/ai/complete-cards.test.ts`
- Create: `apps/server/ai/creation-routing.ts`
- Create: `apps/server/ai/creation-routing.test.ts`
- Modify: `apps/server/ai/generate-note.ts`
- Modify: `apps/server/ai/generate-note.test.ts`
- Modify: `apps/server/ai/model-calls.ts`
- Modify: `apps/mobile/src/lib/card-draft.ts`
- Create: `apps/mobile/src/lib/creation-card-draft.ts`
- Create: `apps/mobile/__tests__/creation-card-draft.test.ts`

**Interfaces:**
- Consumes: Existing `GeneratedCard`, `generatedCardSchema`, `Classification`, `parseEditableCloze`, `serializeEditableCloze`, `CardDraft`, and `CardPresentationModel` semantics.
- Produces: `CreationCard`, `DeckRoutingOutcome`, `routeCreation`, `projectCompleteCards`, deck-aware `GenerationInput`, `hydrateCreationCardDraft`, `serializeCreationCardDraft`, and `createBlankCreationCardDraft`.

Use these exact server contracts:

```ts
export type DeckRoutingCandidate = {
  deckId: string;
  learningGoal: string;
};

export type DeckRoutingOutcome =
  | { kind: "matched"; deckId: string; learningGoal: string }
  | { kind: "ambiguous"; candidates: DeckRoutingCandidate[] }
  | {
      kind: "newDeck";
      proposedName: string;
      proposedDescription: string;
      learningGoal: string;
    };

export type CreationCard = GeneratedCard & { key: string };

export type GenerationInput = {
  text: string;
  nativeLanguage: string;
  deck: { id: string; name: string; description: string | null };
  learningGoal: string;
};
```

- [ ] **Step 1: Write failing complete-card projection tests**

  Create `complete-cards.test.ts` with literal fixtures proving that the last parsed array element stays hidden until `includeLast` is true, a closed preceding card is emitted when a second begins, invalid cloze/basic cards are excluded, and no learner projection contains partial brace text:

  ```ts
  expect(projectCompleteCards({ cards: [
    { aspect: "meaning", front: "The answer is {{c1::", back: null },
  ] }, false)).toEqual([]);

  expect(projectCompleteCards({ cards: [
    {
      aspect: "meaning",
      front: "Das ist eine {{c1::Banane::banana}}.",
      back: "This is a banana.",
      imageCue: true,
    },
    { aspect: "gender" },
  ] }, false)).toEqual([
    {
      aspect: "meaning",
      front: "Das ist eine {{c1::Banane::banana}}.",
      back: "This is a banana.",
      imageCue: true,
    },
  ]);
  ```

- [ ] **Step 2: Run the complete-card test and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run ai/complete-cards.test.ts
  ```

  Expected: FAIL because `projectCompleteCards` does not exist.

- [ ] **Step 3: Implement individual validation and the one-to-six set bound**

  Change `generatedNoteSchema.cards` to `.min(1).max(6)`. Implement `projectCompleteCards(parsed, includeLast)` by taking `cards.slice(0, includeLast ? cards.length : -1)`, running every candidate through `generatedCardSchema.safeParse`, and returning only the contiguous valid prefix. A candidate after the first invalid candidate must not be emitted because array order is part of the card-set contract.

- [ ] **Step 4: Write failing routing tests before the routing implementation**

  Cover all three outcomes with owned decks `latin` and `philosophy`; reject an invented id, duplicate ambiguous ids, one or four ambiguous candidates, blank goals, and foreign ids. Pin the same quotation to distinct goals:

  ```ts
  expect(await routeCreation(input, async () => ({
    kind: "ambiguous",
    candidates: [
      { deckId: latin.id, learningGoal: "Practice producing the Latin expression." },
      { deckId: philosophy.id, learningGoal: "Learn the quotation, author, and idea." },
    ],
  }))).toEqual({
    kind: "ambiguous",
    candidates: [
      { deckId: latin.id, learningGoal: "Practice producing the Latin expression." },
      { deckId: philosophy.id, learningGoal: "Learn the quotation, author, and idea." },
    ],
  });
  ```

  Also assert that the provider prompt contains both deck descriptions, the full request, and native language, instructs the router to distinguish learner intent from quoted/foreign-language source material, and prefers ambiguity over an unsafe guess. The returned object contains no reasoning trace or confidence field.

- [ ] **Step 5: Run routing tests and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run ai/creation-routing.test.ts
  ```

  Expected: FAIL because the routing boundary does not exist.

- [ ] **Step 6: Implement the structured routing boundary and provider call**

  Define a Zod discriminated union with exactly 2–3 ambiguous candidates. `routeCreation` builds the owned-id set before the call, validates the model object, rejects unknown/duplicate ids, and uses `parseWithRetry` for one schema-correction attempt. Add `route(prompts)` to the production creation AI adapter in `model-calls.ts`; keep provider names inside that adapter and server logs.

- [ ] **Step 7: Write failing deck-context generation tests**

  Update `generate-note.test.ts` so the same source in Latin and Philosophy produces different literal user prompts. Assert that `deck.name`, `deck.description`, `learningGoal`, `nativeLanguage`, and the one-to-six rule are present, while no client-selected count appears.

- [ ] **Step 8: Implement deck-aware generation and complete-card events**

  Expand `GenerationInput`, tell the model to choose the smallest useful set within one to six cards, replace `projectCards` events with `projectCompleteCards(parsed, false)`, emit only a changed complete prefix, and emit the final validated set with `includeLast=true`. Keep the image prompt independent and keep classification server-only.

- [ ] **Step 9: Write failing mobile single-card draft tests**

  Test hydration of basic and cloze cards into structured local state, blank-card defaults, field-specific validation, round-trip serialization, invalid cloze recovery without markup, image-cue/hint constraints, and stable keys. Export the minimum pure helpers from `card-draft.ts`; do not change `NoteEditView` or `CardEditForm` behavior.

- [ ] **Step 10: Implement the pure creation-card adapter**

  `hydrateCreationCardDraft(card)` maps one persisted `CreationCard` to a `CardDraft`; `serializeCreationCardDraft(card)` returns `{ key, aspect, front, back, imageCue }` only for a valid draft; `createBlankCreationCardDraft(kind, key)` delegates to `createCardDraft`. Learner-safe invalid preview text must be `Fix the card fields to preview it.` and must never return storage markup.

- [ ] **Step 11: Run focused checks and review the boundary**

  ```bash
  bun run --cwd apps/server vitest run ai/complete-cards.test.ts ai/creation-routing.test.ts ai/generate-note.test.ts ai/model-calls.test.ts
  bun run --cwd apps/mobile jest --runInBand __tests__/creation-card-draft.test.ts __tests__/native-cloze.test.ts __tests__/card-draft.test.ts
  bun run server:check
  bun run mobile:check
  git diff --check
  ```

  Review that raw partial card text cannot reach any exported event, all routing ids are checked against the supplied catalog, the final card count is 1–6, and no saved-note UI composition changed.

- [ ] **Step 12: Commit the pure AI and card contracts**

  ```bash
  git add apps/server/ai/schemas.ts apps/server/ai/complete-cards.ts apps/server/ai/complete-cards.test.ts apps/server/ai/creation-routing.ts apps/server/ai/creation-routing.test.ts apps/server/ai/generate-note.ts apps/server/ai/generate-note.test.ts apps/server/ai/model-calls.ts apps/server/ai/model-calls.test.ts apps/mobile/src/lib/card-draft.ts apps/mobile/src/lib/creation-card-draft.ts apps/mobile/__tests__/creation-card-draft.test.ts
  git commit -m "feat: add creation routing and complete card contracts"
  ```

### Task 2: Migrate single drafts into durable multi-creation storage

**Files:**
- Modify: `apps/server/db/schema.ts`
- Modify: `apps/server/db/schema.test.ts`
- Modify: `apps/server/db/migrations.test.ts`
- Create: generated `apps/server/drizzle/0007_*.sql`
- Create: generated `apps/server/drizzle/meta/0007_snapshot.json`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Create: `apps/server/creations/contracts.ts`
- Create: `apps/server/creations/contracts.test.ts`

**Interfaces:**
- Consumes: Existing `drafts`, `decks`, `notes`, `user`, `DraftCard`, image ids, classifications, and UUIDv7 defaults.
- Produces: revisioned `Draft`/`Creation`, `CreationImageAttempt`, `CreationSaveReceipt`, `PushInstallation`, deterministic public `CreationSummary`/`CreationDetail`, and legacy card normalization.

Use these durable unions:

```ts
export type CreationStatus =
  | "queued"
  | "routing"
  | "needs_choice"
  | "generating"
  | "ready"
  | "failed"
  | "adjusting"
  | "regenerating"
  | "removed";

export type CreationOperation =
  | "route_generate"
  | "generate"
  | "retry"
  | "adjust"
  | "regenerate";

export type CreationErrorStage = "submission" | "routing" | "cards" | "image" | null;
export type CreationImageStatus = "none" | "queued" | "generating" | "ready" | "failed";
```

The `drafts` table must contain: `clientRequestId`, nullable `deckId`, `learningGoal`, `routing`, `classification`, `status`, `operation`, `activeAttemptId`, `attemptCards`, `cards`, `undoCards`, `revision`, `targetDeckId`, `targetLearningGoal`, `adjustmentInstruction`, `queuedAt`, `leaseOwner`, `leaseExpiresAt`, `imageAttemptId`, `imagePrompt`, `imageStatus`, `draftImageId`, `errorCategory`, `errorStage`, learner-safe `error`, `removedAt`, `undoUntil`, `createdAt`, and `updatedAt`. Add `(userId, clientRequestId)` uniqueness plus `(userId, status, queuedAt, id)` and lease indexes; remove `userId` uniqueness. Change `deckId` to nullable with `ON DELETE SET NULL`.

- [ ] **Step 1: Write failing schema and migration-preservation tests**

  In `schema.test.ts`, assert multiple draft rows for one user and a duplicate `(userId, clientRequestId)` rejection. In `migrations.test.ts`, apply through `0006`, insert a ready draft and an in-flight draft, apply the new migration, then assert:

  ```ts
  expect(ready.source_text).toBe("die Banane");
  expect(ready.status).toBe("ready");
  expect(ready.deck_id).toBe("d1");
  expect(JSON.parse(String(ready.cards))).toEqual(existingCards);
  expect(inFlight.status).toBe("queued");
  expect(inFlight.operation).toBe("generate");
  expect(inFlight.lease_owner).toBeNull();
  expect(inFlight.client_request_id).toBe("legacy:draft-2");
  ```

  Assert that two migrated rows for the same owner coexist and retain image prompt/status/id, classification, error, and created time.

- [ ] **Step 2: Run the migration tests and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run db/schema.test.ts db/migrations.test.ts
  ```

  Expected: FAIL because the current schema enforces one draft per user and has no creation fields.

- [ ] **Step 3: Define the tables and generate the Drizzle migration**

  Update `schema.ts`, then run:

  ```bash
  bun run db:generate
  ```

  Inspect generated SQL. Adjust only the generated migration SQL needed to preserve existing draft rows: map `generating` to queued `generate`, retain ready/failed states, set `client_request_id` to `legacy:` plus id, retain existing JSON verbatim, and set `queued_at`/`updated_at` from `created_at`. Do not hand-edit snapshot JSON.

  Add:

  - `creation_image_attempts`: attempt id, user id, nullable creation/note owner, prompt, status, lease, generation-owned `draftImageId`, timestamps.
  - `creation_save_receipts`: `(userId, creationId)` and `(userId, saveRequestId)` unique, note id, deck id, created time.
  - `push_installations`: id, user id, unique Expo token, platform, timestamps, with user index.

- [ ] **Step 4: Write failing projection and legacy-normalization tests**

  Prove deterministic summary ordering/group mapping, action count, legacy cards without keys receiving stable `legacy-0`/`legacy-1` keys, detail cards never containing nullable/partial fields, and errors exposing only safe categories/copy.

- [ ] **Step 5: Implement `creations/contracts.ts`**

  Export `normalizeStoredCards(creationId, cards)`, `toCreationSummary(row, deckName, thumbnailId)`, `toCreationDetail(row, deck)`, `actionableCreationCount(summaries)`, and `legacyStatus(row)`. The summary state mapping is exactly:

  ```ts
  needs_choice -> "Needs your choice"
  ready -> "Ready to review"
  routing | generating | adjusting | regenerating -> "Creating"
  queued -> "Queued"
  failed -> "Needs attention"
  ```

  `removed` never projects into the inbox. `legacyStatus` maps queued/routing/generating/adjusting/regenerating to `generating`, but legacy list selection excludes `needs_choice` and `removed`.

- [ ] **Step 6: Run focused tests and review migration safety**

  ```bash
  bun run --cwd apps/server vitest run db/schema.test.ts db/migrations.test.ts creations/contracts.test.ts
  bun run server:check
  git diff --check
  ```

  Review the actual migration from a `0006` scratch database, both uniqueness indexes, every foreign-key deletion action, and preservation of pre-migration cards/image/error metadata.

- [ ] **Step 7: Commit the durable schema**

  ```bash
  git add apps/server/db/schema.ts apps/server/db/schema.test.ts apps/server/db/migrations.test.ts apps/server/drizzle apps/server/creations/contracts.ts apps/server/creations/contracts.test.ts
  git commit -m "feat(server): store a durable creation inbox"
  ```

### Task 3: Implement atomic two-slot scheduling and complete-card persistence

**Files:**
- Create: `apps/server/creations/events.ts`
- Create: `apps/server/creations/events.test.ts`
- Create: `apps/server/creations/scheduler.ts`
- Create: `apps/server/creations/scheduler.test.ts`
- Create: `apps/server/creations/worker.ts`
- Create: `apps/server/creations/worker.test.ts`
- Create: `apps/server/ai/creation-generation.ts`
- Create: `apps/server/ai/creation-generation.test.ts`
- Modify: `apps/server/router/base.ts`
- Modify: `apps/server/main.ts`

**Interfaces:**
- Consumes: `routeCreation`, deck-aware generation, creation rows, write lock, database transactions, and complete `CreationCard` prefixes.
- Produces: `claimCreationWork`, `renewCreationLease`, `recoverStaleCreationWork`, `kickCreationScheduler`, `startCreationScheduler`, `runCreationAttempt`, `subscribeCreation`, and `subscribeCreationInbox`.

Use:

```ts
export const MAX_ACTIVE_TEXT_WORK_PER_USER = 2;
export const CREATION_LEASE_MS = 90_000;
export const CREATION_HEARTBEAT_MS = 30_000;

export type ClaimedCreationWork = {
  creationId: string;
  userId: string;
  attemptId: string;
  leaseOwner: string;
  operation: CreationOperation;
};
```

- [ ] **Step 1: Write failing scheduler race tests**

  Seed three queued creations for Ada and three for Bob. Run concurrent claim calls and assert exactly two claims per user, the third remains queued, accepted order is `queuedAt` then id, ambiguity/failure/cancellation frees a slot, and Bob's claims do not reduce Ada's limit. Add a stale lease test where only an expired active row requeues and a current lease is untouched.

- [ ] **Step 2: Run scheduler tests and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run creations/scheduler.test.ts
  ```

  Expected: FAIL because no durable scheduler exists.

- [ ] **Step 3: Implement atomic claims and lease recovery**

  Within `withWriteLock` plus one DB transaction, count unexpired active leases for the user, select the oldest queued rows up to `2 - active`, and update each only when its `status`, `activeAttemptId`, and null lease still match. Use a process UUID as `leaseOwner`; never infer activity from the event registry. `renewCreationLease` updates only matching `(id, attemptId, leaseOwner)`. Recovery clears expired leases and returns work to queued with the same operation and a new attempt id only when the previous attempt must be fenced.

- [ ] **Step 4: Write failing worker persistence tests**

  Cover:

  - matched routing persists deck and goal before generation;
  - ambiguous routing persists 2–3 choices, enters `needs_choice`, and releases the slot;
  - new-deck routing persists editable proposal and releases the slot;
  - each complete prefix is written to `attemptCards` before a detail event publishes;
  - a model-validation retry atomically assigns a fresh attempt id and clears only `attemptCards`, so cards from the rejected attempt cannot mix with its replacement;
  - reconnect reads the same completed cards from the row;
  - a final valid set atomically becomes `cards` and `ready`;
  - provider failure copies at least one safe `attemptCard` into reviewable `cards` and marks `failed`;
  - retry retains existing `cards` until replacement succeeds;
  - stale/canceled attempt writes affect zero rows;
  - lease heartbeat stops after terminal state.

- [ ] **Step 5: Run worker tests and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run creations/worker.test.ts ai/creation-generation.test.ts
  ```

  Expected: FAIL because the creation worker does not exist.

- [ ] **Step 6: Implement deck-aware work execution**

  `route_generate` first reads the user's complete deck catalog and native language, runs `routeCreation`, then either releases the slot at `needs_choice` or transitions the same claim into card generation. `generate`, `retry`, and matched initial routing call `creation-generation.ts`. Allocate stable server UUIDv7 keys for newly completed card indices and retain existing keys for an unchanged prefix. Persist with a guard equivalent to:

  ```ts
  where(and(
    eq(drafts.id, creationId),
    eq(drafts.activeAttemptId, attemptId),
    eq(drafts.leaseOwner, leaseOwner),
  ))
  ```

  On the generator's internal validation-retry event, guard on the old attempt id, assign a fresh UUIDv7 attempt id under the same lease, clear only `attemptCards`, and continue with the new fence; existing reviewed `cards` stay visible. Publish only after the guarded update returns one row. Terminal paths clear lease fields, publish detail and owner-summary snapshots, and call `kickCreationScheduler(userId)`.

- [ ] **Step 7: Implement event delivery as a non-authoritative layer**

  `subscribeCreation` and `subscribeCreationInbox` yield an immediate database snapshot, then channel events. Coalesce full snapshots by creation/user. A disconnected subscriber never cancels work. Every detail event carries `creationId`, `attemptId`, and `revision`; mobile can ignore stale events.

- [ ] **Step 8: Start recovery and scheduling before serving**

  In `main.ts`, await stale/boot recovery, then start the scheduler before `Bun.serve`. Replace the old orphan-to-failed boot policy: queued/active text work is requeued and resumed; already ready rows stay ready. Make interval handles non-blocking for tests through injected clocks/timers.

- [ ] **Step 9: Run focused tests and review concurrency fences**

  ```bash
  bun run --cwd apps/server vitest run creations/events.test.ts creations/scheduler.test.ts creations/worker.test.ts ai/creation-generation.test.ts
  bun run server:check
  git diff --check
  ```

  Review simultaneous claim behavior, release on every terminal branch, boot recovery, accepted order, attempt/lease guards on every write, and proof that events never precede persistence.

- [ ] **Step 10: Commit the text scheduler**

  ```bash
  git add apps/server/creations apps/server/ai/creation-generation.ts apps/server/ai/creation-generation.test.ts apps/server/router/base.ts apps/server/main.ts
  git commit -m "feat(server): schedule durable creation work"
  ```

### Task 4: Add independent image scheduling and generation-owned media transfer

**Files:**
- Create: `apps/server/creations/image-scheduler.ts`
- Create: `apps/server/creations/image-scheduler.test.ts`
- Modify: `apps/server/images.ts`
- Modify: `apps/server/images.test.ts`
- Modify: `apps/server/write-image.test.ts`
- Modify: `apps/server/creations/worker.ts`
- Modify: `apps/server/creations/worker.test.ts`
- Modify: `apps/server/main.ts`

**Interfaces:**
- Consumes: `creation_image_attempts`, generation-owned draft image files, current attempt/owner guards, and `generateImageBytes`.
- Produces: `enqueueCreationImage`, `cancelCreationImage`, `transferCreationImageToNote`, `retryCreationImage`, `startImageScheduler`, and a global independent image limit of two.

- [ ] **Step 1: Write failing independent-image tests**

  Prove two image attempts claim globally while text slots already advance, a slow image does not retain a creation text lease, image-ready/failed states do not change card readiness, retry supersedes the previous image attempt, a stale image result cannot overwrite a newer id, and ownerless late bytes are deleted.

  Add transfer cases:

  ```ts
  expect(await transferCreationImageToNote(tx, {
    creationId,
    imageAttemptId,
    noteId,
  })).toEqual({ kind: "pending" });
  ```

  Then complete the image and assert it writes/attaches to the note rather than a deleted creation. For an already-ready image, assert the file is claimed synchronously and the note path is returned.

- [ ] **Step 2: Run image tests and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run creations/image-scheduler.test.ts images.test.ts write-image.test.ts
  ```

  Expected: FAIL because image work is process-owned and embedded in the old draft job.

- [ ] **Step 3: Implement durable image attempts**

  Claim at most two queued image rows globally under the write lock. Before writing bytes, re-read `(attemptId, leaseOwner, creationId/noteId)`. Write to a generation-owned draft id or directly to the transferred note. Settle the owning creation only if `drafts.imageAttemptId` still matches; otherwise remove the generated file. A failed image updates only image state and publishes a quiet retryable detail snapshot.

- [ ] **Step 4: Connect card generation to image enqueueing**

  When a validated image prompt first settles, create an image-attempt row and persist `imageAttemptId/imagePrompt/imageStatus=queued`. Do not await it in the text worker. On validation retry or change-deck supersession, cancel the old pending attempt and delete only media owned by that exact attempt.

- [ ] **Step 5: Update boot recovery and sweeping**

  Requeue expired image leases independently. Extend the draft-image sweep's referenced set to include both creation rows and image-attempt rows. Do not delete transferred note media or a generation-owned file still referenced by a live attempt.

- [ ] **Step 6: Run focused tests and review media races**

  ```bash
  bun run --cwd apps/server vitest run creations/image-scheduler.test.ts creations/worker.test.ts images.test.ts write-image.test.ts
  bun run server:check
  git diff --check
  ```

  Review pending/ready transfer, retry during generation, supersession, cancellation, save while pending, boot recovery, and late owner deletion.

- [ ] **Step 7: Commit independent image work**

  ```bash
  git add apps/server/creations/image-scheduler.ts apps/server/creations/image-scheduler.test.ts apps/server/creations/worker.ts apps/server/creations/worker.test.ts apps/server/images.ts apps/server/images.test.ts apps/server/write-image.test.ts apps/server/main.ts
  git commit -m "feat(server): schedule creation images independently"
  ```

### Task 5: Expose inbox, detail, decisions, recovery, and legacy adapters

**Files:**
- Rewrite: `apps/server/router/drafts.ts`
- Rewrite: `apps/server/router/drafts.test.ts`
- Modify: `apps/server/router/decks.ts`
- Modify: `apps/server/router/decks.test.ts`
- Modify: `apps/server/router/index.ts`
- Modify: `apps/server/router/concurrency.test.ts`

**Interfaces:**
- Consumes: Creation projections, events, text/image scheduler kicks, revision guards, routing outcomes, and ownership helpers.
- Produces: `drafts.list`, `drafts.get`, `drafts.submit`, `drafts.watchInbox`, `drafts.watch`, `drafts.resolveDeck`, `drafts.confirmNewDeck`, `drafts.update`, `drafts.retry`, `drafts.retryImage`, `drafts.cancel`, `drafts.restore`, `drafts.discard`, plus compatible `drafts.current` and legacy `drafts.start`.

Use these principal inputs:

```ts
submit({ clientRequestId: string, text: string /* trimmed 1..2000 */ })
resolveDeck({ creationId: uuid, expectedRevision: int, deckId: uuid })
confirmNewDeck({ creationId: uuid, expectedRevision: int, name: string, description: string | null })
update({ creationId: uuid, expectedRevision: int, cards: CreationCard[] })
retry({ creationId: uuid, stage: "routing" | "cards" })
cancel({ creationId: uuid, expectedRevision: int })
restore({ creationId: uuid })
discard({ creationId: uuid, expectedRevision: int })
```

- [ ] **Step 1: Write failing submit/list/watch tests**

  Cover empty/2,001-character rejection without insertion, trimming, simultaneous duplicate `clientRequestId` returning the same creation, three rapid distinct submissions, deterministic group/order projection, strict ownership, list summaries without cards/internal metadata, detail with complete cards, and subscriptions isolated by user and creation/attempt.

- [ ] **Step 2: Write failing deck-decision tests**

  Prove candidate selection atomically writes deck/goal, increments revision, clears routing, requeues, and kicks scheduling. A deleted/stale candidate reroutes instead of returning raw not-found. New-deck confirmation validates name/description, creates the owned deck and assigns/requeues in one transaction; a forced insert failure rolls everything back. No-deck routing must remain in new-deck proposal, never an empty-deck dead end.

- [ ] **Step 3: Write failing recovery/removal tests**

  Prove routing/card/image retries target only their stage, manual update requires ready/failed state and exact revision, conflict preserves stored cards, queued cancellation becomes `removed` with `undoUntil`, restore within the window requeues at its original accepted position, expired removed rows are purged without affecting active work, running cancellation fences the attempt before deletion, ready discard removes only one row, and late results cannot resurrect it.

- [ ] **Step 4: Run router tests and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run router/drafts.test.ts router/decks.test.ts router/concurrency.test.ts
  ```

  Expected: FAIL because the current router has only one draft and no new procedures.

- [ ] **Step 5: Implement the new procedures with ownership and revisions**

  Every read filters `userId`. Every write uses the current user, id, expected revision, and applicable attempt/status guard in the same transaction. `submit` resolves idempotency through the unique `(userId, clientRequestId)` constraint and returns the existing row on a race. A scheduler maintenance pass deletes `removed` rows only after `undoUntil`. Only learner-safe `error` values cross the router.

- [ ] **Step 6: Preserve one compatibility window**

  `start({ deckId, text })` validates the owned deck, retains the legacy 200-character input, rejects when a legacy-compatible current item exists, inserts a pre-routed `generate` creation, and returns `{ draftId }`. `current` selects the oldest compatible creation and maps new internal statuses into `generating|ready|failed`; it excludes unresolved choice/removed rows. Legacy watch/update/retry-image/discard inputs keep `draftId` aliases and target exactly that creation. New-only states are never coerced into legacy output.

- [ ] **Step 7: Make deck deletion preserve creation requests**

  Replace cascading draft loss with attempt fencing plus rerouting: selected/target deck references become null, current reviewed cards remain, affected unsaved creations enter queued `route_generate` or retain failed reviewed content with a specific retry. Candidate outcomes referencing the deleted deck are invalidated. Existing notes still follow their established deck-delete cascade.

- [ ] **Step 8: Run focused tests and review API/cache-safe shapes**

  ```bash
  bun run --cwd apps/server vitest run router/drafts.test.ts router/decks.test.ts router/concurrency.test.ts creations/scheduler.test.ts creations/worker.test.ts
  bun run server:check
  git diff --check
  ```

  Review idempotency races, foreign ids, stale revisions, candidate deletion, one-item removal, legacy visibility, and absence of internal/provider fields in public projections.

- [ ] **Step 9: Commit the creation API**

  ```bash
  git add apps/server/router/drafts.ts apps/server/router/drafts.test.ts apps/server/router/decks.ts apps/server/router/decks.test.ts apps/server/router/index.ts apps/server/router/concurrency.test.ts
  git commit -m "feat(server): expose creation inbox workflows"
  ```

### Task 6: Add manual drafts, AI adjustment, exact Undo, and change-deck regeneration

**Files:**
- Create: `apps/server/ai/creation-adjustment.ts`
- Create: `apps/server/ai/creation-adjustment.test.ts`
- Modify: `apps/server/ai/model-calls.ts`
- Modify: `apps/server/ai/model-calls.test.ts`
- Modify: `apps/server/creations/worker.ts`
- Modify: `apps/server/creations/worker.test.ts`
- Modify: `apps/server/router/drafts.ts`
- Modify: `apps/server/router/drafts.test.ts`

**Interfaces:**
- Consumes: Current reviewed cards, original request, selected deck context, creation scheduler, revision, and complete-set schema.
- Produces: `drafts.adjust`, `drafts.cancelAdjustment`, `drafts.undoAdjustment`, and `drafts.changeDeck`; worker operations `adjust` and `regenerate`.

```ts
adjust({ creationId, expectedRevision, instruction: z.string().trim().min(1).max(500) })
cancelAdjustment({ creationId, expectedRevision })
undoAdjustment({ creationId, expectedRevision })
changeDeck({ creationId, expectedRevision, deckId })
```

- [ ] **Step 1: Write failing manual-update and Undo tests**

  Prove one manual update validates the complete 1–6 card set, stores stable keys/order, increments revision, and clears an older `undoCards`. Invalid cards or an expected-revision mismatch mutate nothing. For adjustment success, assert exact restoration of aspects, fronts, backs, cloze hints, image cues, additions/removals, keys, and order.

- [ ] **Step 2: Write failing adjustment prompt/worker tests**

  Assert the adjustment prompt includes original request, selected deck name/description, learning goal, current cards, and learner instruction. It must say cards only and preserve image intent. While queued/running, public detail retains current cards. Success atomically writes `undoCards=current cards`, swaps the fully validated replacement, increments revision, and becomes ready. Failure/cancel retains cards and the pre-existing Undo boundary.

- [ ] **Step 3: Write failing change-deck tests**

  A different owned deck queues `regenerate`, keeps current deck/cards visible, uses the target deck context, and swaps deck/goal/classification/cards only after full validation. Failure or cancel retains the prior deck/cards. A deleted target returns to deck resolution rather than applying stale context. Regeneration may enqueue a replacement image, but adjustment may not.

- [ ] **Step 4: Run focused tests and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run ai/creation-adjustment.test.ts creations/worker.test.ts router/drafts.test.ts
  ```

  Expected: FAIL because adjustment, Undo, and regeneration do not exist.

- [ ] **Step 5: Implement revision-safe manual and AI mutations**

  Manual edits and Undo are direct locked transactions. Adjustment/regeneration create a new attempt id, operation, accepted queue time, and target context, then scheduler-kick. On AI success use one guarded transaction for the entire replacement. Saving is disallowed while adjustment/regeneration is queued or active; cancel first restores immediate save availability.

- [ ] **Step 6: Run focused tests and review mutation boundaries**

  ```bash
  bun run --cwd apps/server vitest run ai/creation-adjustment.test.ts ai/model-calls.test.ts creations/worker.test.ts router/drafts.test.ts
  bun run server:check
  git diff --check
  ```

  Review exact Undo restoration, when Undo clears, current-set visibility, save blocking, target deck deletion, and image non-mutation during ordinary adjustment.

- [ ] **Step 7: Commit adjustment and regeneration**

  ```bash
  git add apps/server/ai/creation-adjustment.ts apps/server/ai/creation-adjustment.test.ts apps/server/ai/model-calls.ts apps/server/ai/model-calls.test.ts apps/server/creations/worker.ts apps/server/creations/worker.test.ts apps/server/router/drafts.ts apps/server/router/drafts.test.ts
  git commit -m "feat(server): support creation adjustment and undo"
  ```

### Task 7: Save exactly one creation idempotently

**Files:**
- Create: `apps/server/router/creation-save.ts`
- Create: `apps/server/router/creation-save.test.ts`
- Modify: `apps/server/router/notes.ts`
- Modify: `apps/server/router/notes.test.ts`
- Modify: `apps/server/router/index.ts`
- Modify: `apps/server/tts/jobs.ts`
- Modify: `apps/server/tts/jobs.test.ts`

**Interfaces:**
- Consumes: Current `notes.save` validation/FSRS/audio behavior, creation revision, save receipts, and image transfer.
- Produces: `drafts.save({ creationId, expectedRevision, saveRequestId }) -> { noteId, deckId, sourceText }` plus unchanged legacy `notes.save({ draftId, cards })` adapter.

- [ ] **Step 1: Write failing idempotent-save tests**

  Seed two ready creations. Save one and assert one note, its 1–6 initial cards, a save receipt, only that creation removed, and the second creation unchanged. Repeat concurrently and after the creation row is gone with the same `saveRequestId`; both return the same note. Reject another user's id, stale revision, empty/invalid cards, unresolved deck, and queued/active adjustment without side effects.

- [ ] **Step 2: Write failing image/audio ownership tests**

  Cover ready image claim, pending image transfer, failed/no image, pending image completion after the creation is deleted, and stale attempt cleanup. Assert initial TTS jobs are generation-owned and late audio cannot attach after note/card deletion.

- [ ] **Step 3: Run save tests and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run router/creation-save.test.ts router/notes.test.ts tts/jobs.test.ts
  ```

  Expected: FAIL because multi-creation receipts and pending image transfer are absent.

- [ ] **Step 4: Extract and implement the shared transactional save core**

  Move the existing card validation, note/card insertion, FSRS initialization, image claim/transfer decision, and post-commit TTS enqueueing into `creation-save.ts`. Inside the write lock and transaction:

  1. Return an existing receipt for the same owner/creation.
  2. Verify creation owner, exact revision, ready/failed-reviewable state, selected deck, and no active replacement.
  3. Validate the complete set and image-cue context.
  4. Insert the note/cards and save receipt.
  5. Transfer or claim the exact image attempt.
  6. Delete only the requested creation.

  A failure rolls back all database writes. Media cleanup remains generation-aware and best effort after commit.

- [ ] **Step 5: Keep the legacy save adapter**

  `notes.save` keeps its old input and routes through the same core after legacy update semantics, so supported old clients continue to save their selected draft. It must not assume the entire draft namespace is empty afterward.

- [ ] **Step 6: Run focused tests and review transaction/idempotency**

  ```bash
  bun run --cwd apps/server vitest run router/creation-save.test.ts router/notes.test.ts tts/jobs.test.ts creations/image-scheduler.test.ts
  bun run server:check
  git diff --check
  ```

  Review simultaneous repeats, receipt lookup after consumption, rollback injection, only-one-row deletion, pending image transfer, and post-commit TTS/media work.

- [ ] **Step 7: Commit idempotent save**

  ```bash
  git add apps/server/router/creation-save.ts apps/server/router/creation-save.test.ts apps/server/router/notes.ts apps/server/router/notes.test.ts apps/server/router/index.ts apps/server/tts/jobs.ts apps/server/tts/jobs.test.ts
  git commit -m "feat(server): save creations idempotently"
  ```

### Task 8: Deliver optional grouped background notifications

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `bun.lock`
- Modify: `apps/mobile/app.json`
- Modify: `apps/mobile/scripts/app-icon-config.test.ts`
- Create: `apps/server/notifications/expo-push.ts`
- Create: `apps/server/notifications/expo-push.test.ts`
- Create: `apps/server/notifications/dispatcher.ts`
- Create: `apps/server/notifications/dispatcher.test.ts`
- Create: `apps/server/router/notifications.ts`
- Create: `apps/server/router/notifications.test.ts`
- Modify: `apps/server/router/index.ts`
- Modify: `apps/server/router/base.ts`
- Modify: `apps/server/creations/worker.ts`
- Create: `apps/mobile/src/api/notifications.ts`
- Create: `apps/mobile/src/notifications/registration.ts`
- Create: `apps/mobile/__tests__/notification-registration.test.ts`
- Modify: `apps/mobile/src/auth/auth.ts`
- Modify: `apps/mobile/__tests__/auth-signout.test.ts`
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/__tests__/navigation-shell.test.tsx`

**Interfaces:**
- Consumes: Actionable creation transitions, authenticated user id, Expo Push tokens, `EXPO_PUBLIC_EAS_PROJECT_ID`, current foreground route, and sign-out lifecycle.
- Produces: installation register/unregister, two-second grouped delivery, just-in-time permission education, foreground suppression, single/group deep links, and sign-out disassociation.

- [ ] **Step 1: Install compatible native dependencies with Bun**

  ```bash
  bun run --cwd apps/mobile expo install expo-notifications expo-device @react-native-async-storage/async-storage
  ```

  Inspect `package.json` and `bun.lock`; do not accept unrelated upgrades.

- [ ] **Step 2: Write failing server notification tests**

  Test token ownership/upsert, exact-token unregister, foreign-token protection, malformed token rejection, two ready transitions within the grouping window producing one `2 creations are ready to review` message, choice-only copy, mixed action count, single detail data `{ creationId }`, grouped `{ route: "/add" }`, invalid Expo tickets removing only invalid tokens, and no provider details in RPC responses.

- [ ] **Step 3: Run server notification tests and confirm RED**

  ```bash
  bun run --cwd apps/server vitest run notifications/expo-push.test.ts notifications/dispatcher.test.ts router/notifications.test.ts
  ```

  Expected: FAIL because notification storage and delivery do not exist.

- [ ] **Step 4: Implement transport, grouping, and installation procedures**

  Post JSON batches to `https://exp.host/--/api/v2/push/send` through an injected `fetch`. The dispatcher debounces by user for two seconds, then queries current actionable summaries and sends one message per installation. Call it only on transitions into `needs_choice` or `ready`. Delivery is best effort: log transport detail server-side and never change creation state.

- [ ] **Step 5: Write failing mobile notification tests**

  Mock Expo Notifications/Device and assert:

  - no permission request at boot or first creation;
  - leaving the first active detail sets one education opportunity;
  - accepting education triggers the OS prompt, Expo token with configured project id, and register mutation;
  - denial is persisted and not repeated during routine creation;
  - foreground notification for the currently visible creation is suppressed;
  - single notification pushes `/creations/[creationId]` and grouped notification pushes `/add`;
  - sign-out unregisters before local session cleanup and still clears the local account if unregister transport fails.

- [ ] **Step 6: Run mobile notification tests and confirm RED**

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/notification-registration.test.ts __tests__/auth-signout.test.ts __tests__/navigation-shell.test.tsx
  ```

  Expected: FAIL because the mobile notification boundary does not exist.

- [ ] **Step 7: Configure and implement native notification registration**

  Add the `expo-notifications` config plugin and Android notification icon/color without changing the adaptive icon. Read the Expo project id from `process.env.EXPO_PUBLIC_EAS_PROJECT_ID`; a missing id returns a learner-safe unavailable result and logs only in development. Store permission education/denial per authenticated user in AsyncStorage. Register response listeners in `AppProviders`; clean them on unmount.

- [ ] **Step 8: Disassociate on sign-out**

  Extend the existing signed-out cleanup registered in `AppProviders` to unregister the current installation and clear user-scoped composer/outbox/edit recovery before query cache clear. Authentication failure cannot leave another account's local rows visible.

- [ ] **Step 9: Run focused checks and review native boundaries**

  ```bash
  bun run --cwd apps/server vitest run notifications/expo-push.test.ts notifications/dispatcher.test.ts router/notifications.test.ts creations/worker.test.ts
  bun run --cwd apps/mobile jest --runInBand __tests__/notification-registration.test.ts __tests__/auth-signout.test.ts __tests__/navigation-shell.test.tsx
  bun run server:check
  bun run mobile:check
  bun run --cwd apps/mobile expo config --type public
  git diff --check
  ```

  Review opt-in timing, denial persistence, token ownership, sign-out ordering, grouping, foreground suppression, deep links, native plugin resolution, and the explicit environment dependency.

- [ ] **Step 10: Commit notifications**

  ```bash
  git add apps/mobile/package.json bun.lock apps/mobile/app.json apps/mobile/scripts/app-icon-config.test.ts apps/server/notifications apps/server/router/notifications.ts apps/server/router/notifications.test.ts apps/server/router/index.ts apps/server/router/base.ts apps/server/creations/worker.ts apps/mobile/src/api/notifications.ts apps/mobile/src/notifications/registration.ts apps/mobile/__tests__/notification-registration.test.ts apps/mobile/src/auth/auth.ts apps/mobile/__tests__/auth-signout.test.ts apps/mobile/app/_layout.tsx apps/mobile/__tests__/navigation-shell.test.tsx
  git commit -m "feat: add creation completion notifications"
  ```

### Task 9: Build the durable mobile outbox and Creation inbox

**Files:**
- Create: `apps/mobile/src/lib/creation-outbox.ts`
- Create: `apps/mobile/__tests__/creation-outbox.test.ts`
- Create: `apps/mobile/src/api/creations.ts`
- Create: `apps/mobile/__tests__/creation-api.test.tsx`
- Create: `apps/mobile/src/hooks/use-creation-outbox.ts`
- Create: `apps/mobile/__tests__/use-creation-outbox.test.tsx`
- Create: `apps/mobile/src/features/create/request-composer.tsx`
- Create: `apps/mobile/src/features/create/creation-inbox.tsx`
- Create: `apps/mobile/src/features/create/create-screen.tsx`
- Rewrite: `apps/mobile/src/features/add/add-screen.tsx`
- Rewrite: `apps/mobile/__tests__/add-screen.test.tsx`
- Modify: `apps/mobile/app/(tabs)/_layout.tsx`
- Modify: `apps/mobile/__tests__/navigation-shell.test.tsx`
- Modify: `apps/mobile/src/components/draft-indicator.tsx`
- Modify: `apps/mobile/__tests__/draft-indicator-tab.test.tsx`

**Interfaces:**
- Consumes: AsyncStorage, current session user id, creation list/watch/submit APIs, React Query, `ListRow`, `TextField`, `PrimaryButton`, and tab navigation.
- Produces: persisted `CreationOutboxDocument`, `useCreationOutbox`, `RequestComposer`, grouped `CreationInbox`, and learner-facing Create tab/badge.

Use one per-user serialized document so composer-to-outbox is one storage write:

```ts
export type CreationOutboxItem = {
  clientRequestId: string;
  sourceText: string;
  createdAt: number;
  state: "pending" | "sending" | "failed";
  error: string | null;
};

export type CreationOutboxDocument = {
  composer: string;
  items: CreationOutboxItem[];
};
```

- [ ] **Step 1: Write failing pure outbox tests**

  Pin validation against the trimmed value, empty/2,001-character rejection, exact pre-ack source preservation (including multiline input), normalized server submission, character-count visibility threshold at 1,800, stable opaque idempotency keys, three distinct rapid enqueue operations, acknowledge-one without touching others, failure retaining original text, and user-scoped storage keys.

- [ ] **Step 2: Run pure tests and confirm RED**

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/creation-outbox.test.ts
  ```

  Expected: FAIL because the outbox does not exist.

- [ ] **Step 3: Implement the pure document transitions and storage adapter**

  Export `normalizeCreationRequest`, `enqueueRequest`, `markSending`, `markFailed`, `acknowledgeRequest`, `creationOutboxKey(userId)`, `loadCreationOutbox`, and `saveCreationOutbox`. A failed submission never copies text back over `document.composer`.

- [ ] **Step 4: Write failing hook/API cache tests**

  Prove enqueue persists before `submit`, composer clears in the same document write, optimistic summaries appear immediately, uncertain retries reuse the same `clientRequestId`, server acknowledgment replaces the optimistic row without a gap, reconnect resumes pending/failed rows for the same account, session expiry preserves that account's document until the same account signs in again, a different account sees only its own key, and save/discard removes only one id from list/detail caches.

- [ ] **Step 5: Implement typed creation API and outbox orchestration**

  `creations.ts` owns `creationListKey`, `creationDetailKey(id)`, list/detail hooks, subscriptions, and typed mutations. Summary handlers key by creation id/client request id and ignore events with stale attempt/revision. `useCreationOutbox` loads after session initialization, merges outbox rows with server rows, retries on explicit action and connectivity recovery, and never keeps one rich subscription per inbox row.

- [ ] **Step 6: Write failing composer/inbox component tests**

  Assert:

  - heading and prompt are `Create` / `What do you want to learn?`;
  - no deck/count/image/domain/language controls render;
  - invalid input remains in the field with a nearby alert;
  - the count is hidden below 1,800 and visible near 2,000;
  - three submissions create three rows and leave focus suitable for another request;
  - non-empty groups order choice, ready, creating, queued, failed;
  - rows are complete touch targets with excerpt, deck when known, human state, optional thumbnail, no technical metadata;
  - empty copy says Mnimi will choose a suitable deck and prepare cards in the background;
  - badge count includes choice/ready/failed only.

- [ ] **Step 7: Implement the Create screen and tab**

  Keep `add-screen.tsx` as a thin export of `CreateScreen` to avoid route churn. Compose only the request composer and inbox. Change tab title/accessibility label to Create and update the indicator to the actionable count. Use a stable static example; do not rotate it while typing.

- [ ] **Step 8: Run focused checks and review recovery/cache ownership**

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/creation-outbox.test.ts __tests__/creation-api.test.tsx __tests__/use-creation-outbox.test.tsx __tests__/add-screen.test.tsx __tests__/draft-indicator-tab.test.tsx __tests__/navigation-shell.test.tsx
  bun run mobile:check
  git diff --check
  ```

  Review persist-before-clear, account isolation, uncertain response retry, no optimistic/server gap, group priority, action badge, technical-copy absence, and exact cache removal.

- [ ] **Step 9: Commit the Creation inbox**

  ```bash
  git add apps/mobile/src/lib/creation-outbox.ts apps/mobile/__tests__/creation-outbox.test.ts apps/mobile/src/api/creations.ts apps/mobile/__tests__/creation-api.test.tsx apps/mobile/src/hooks/use-creation-outbox.ts apps/mobile/__tests__/use-creation-outbox.test.tsx apps/mobile/src/features/create/request-composer.tsx apps/mobile/src/features/create/creation-inbox.tsx apps/mobile/src/features/create/create-screen.tsx apps/mobile/src/features/add/add-screen.tsx apps/mobile/__tests__/add-screen.test.tsx apps/mobile/app/'(tabs)'/_layout.tsx apps/mobile/__tests__/navigation-shell.test.tsx apps/mobile/src/components/draft-indicator.tsx apps/mobile/__tests__/draft-indicator-tab.test.tsx
  git commit -m "feat(mobile): build the Creation inbox"
  ```

### Task 10: Build deck decisions and honest generation detail

**Files:**
- Create: `apps/mobile/src/hooks/use-creation-detail.ts`
- Create: `apps/mobile/__tests__/use-creation-detail.test.tsx`
- Create: `apps/mobile/src/features/create/deck-decision-dialog.tsx`
- Create: `apps/mobile/__tests__/deck-decision-dialog.test.tsx`
- Create: `apps/mobile/src/features/create/creation-progress.tsx`
- Create: `apps/mobile/__tests__/creation-progress.test.tsx`
- Create: `apps/mobile/src/features/create/creation-detail-screen.tsx`
- Create: `apps/mobile/__tests__/creation-detail-screen.test.tsx`
- Modify: `apps/mobile/src/components/generated-image.tsx`
- Modify: `apps/mobile/__tests__/generated-image.test.tsx`
- Create: `apps/mobile/app/creations/[creationId].tsx`
- Modify: `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Consumes: One creation detail query/watch, owned deck list, routing outcome, `GeneratedImage`, `CardPresentation`, notification education hook, and reduced-motion preference.
- Produces: isolated `useCreationDetail(creationId)`, `DeckDecisionDialog`, honest `CreationProgress`, and deep-linkable detail route.

- [ ] **Step 1: Write failing detail subscription tests**

  Prove snapshot hydration after restart, one detail subscription only while focused, no work cancellation on unmount, stale attempt/revision events ignored, complete cards retained across reconnect, and local focused-edit state not overwritten by a refetch.

- [ ] **Step 2: Write failing deck-decision UI tests**

  Candidate options must render deck name plus learning angle under `Where should this go?`; selecting calls revision-safe resolution. New-deck proposal name/description are editable, validation remains local and server-backed, Cancel leaves the choice unresolved, and alternate existing-deck/discard actions remain available. No confidence/reasoning/provider copy may render.

- [ ] **Step 3: Write failing progress presentation tests**

  Assert real states map to `Understanding your request`, `Choosing the best fit`, `Creating a picture`, and `Writing cards` only when true; no percentage/countdown/elapsed time/three-card skeleton/partial fields render; each persisted complete card enters once; image is the largest content region when ready; no-image collapses; failed image keeps cards and exposes `Try picture again`; cloze hint remains visible; live-region announcements occur on stage/card completion only; reduced motion removes transform/stagger but preserves order.

- [ ] **Step 4: Run focused tests and confirm RED**

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/use-creation-detail.test.tsx __tests__/deck-decision-dialog.test.tsx __tests__/creation-progress.test.tsx __tests__/creation-detail-screen.test.tsx
  ```

  Expected: FAIL because detail components/routes do not exist.

- [ ] **Step 5: Implement detail orchestration and decision surfaces**

  `CreationDetailScreen` owns fetch/retry/dialog/mutation errors and delegates visuals. It uses request excerpt as stable content heading, shows deck when resolved, and displays `You can leave — we'll keep creating.` after initial transition. An in-context deck dialog may auto-open only while this detail is focused; it never mounts over the inbox composer or another route.

- [ ] **Step 6: Implement honest content animation**

  Use React Native Reanimated already in the project. Key entrances by `(attemptId, card.key)` and image id. Extend `GeneratedImage` with an optional `className` so creation can render a wide, visually primary image while the saved-note default remains unchanged; pin both variants in `generated-image.test.tsx`. Under reduced motion, use opacity only with no translation/scale/stagger. Do not replay arrivals already present in the initial persisted snapshot.

- [ ] **Step 7: Register the deep detail route and leave education**

  Add the creation route to the protected root stack. On the first attempt to leave an active creation, show the non-blocking in-context notification education once; whether accepted or declined, preserve the intended navigation action and stop only the detail subscription.

- [ ] **Step 8: Run focused checks and review truthful states**

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/use-creation-detail.test.tsx __tests__/deck-decision-dialog.test.tsx __tests__/creation-progress.test.tsx __tests__/creation-detail-screen.test.tsx __tests__/card-presentation.test.tsx __tests__/generated-image.test.tsx
  bun run mobile:check
  git diff --check
  ```

  Review snapshot vs arrival animation, focus-only dialog, stale events, leaving behavior, accessibility announcements, reduced motion, image priority, and raw-cloze/provider absence.

- [ ] **Step 9: Commit detail generation UX**

  ```bash
  git add apps/mobile/src/hooks/use-creation-detail.ts apps/mobile/__tests__/use-creation-detail.test.tsx apps/mobile/src/features/create/deck-decision-dialog.tsx apps/mobile/__tests__/deck-decision-dialog.test.tsx apps/mobile/src/features/create/creation-progress.tsx apps/mobile/__tests__/creation-progress.test.tsx apps/mobile/src/features/create/creation-detail-screen.tsx apps/mobile/__tests__/creation-detail-screen.test.tsx apps/mobile/src/components/generated-image.tsx apps/mobile/__tests__/generated-image.test.tsx apps/mobile/app/creations/'[creationId]'.tsx apps/mobile/app/_layout.tsx
  git commit -m "feat(mobile): show creation decisions and progress"
  ```

### Task 11: Build content-first preview and focused single-card editing

**Files:**
- Create: `apps/mobile/src/features/create/creation-preview.tsx`
- Create: `apps/mobile/__tests__/creation-preview.test.tsx`
- Create: `apps/mobile/src/features/create/creation-card-editor-screen.tsx`
- Create: `apps/mobile/__tests__/creation-card-editor-screen.test.tsx`
- Create: `apps/mobile/src/hooks/use-creation-card-edit.ts`
- Create: `apps/mobile/__tests__/use-creation-card-edit.test.tsx`
- Create: `apps/mobile/app/creations/[creationId]/card/[cardKey].tsx`
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/src/features/create/creation-detail-screen.tsx`

**Interfaces:**
- Consumes: `CardPresentation`, pure creation-card drafts, AsyncStorage recovery, revision-safe update, `AddCardDialog`, image context, and safe-area `Screen.footer`.
- Produces: presentation-only ready/partial preview and one-card-at-a-time basic/cloze editor with More options.

- [ ] **Step 1: Write failing content-first preview tests**

  Assert order: large image, quiet deck/request context, presentation cards, dominant `Save to [deck]`. There are no always-on TextInputs/switches. Basic/cloze question, visible hint, answer/back, open aspect, and image-cue indication render through `CardPresentation`. Pending/failed/absent images keep stable content hierarchy and save remains available for a useful partial set.

- [ ] **Step 2: Write failing focused editor tests**

  Assert only the selected card is mounted. Basic defaults show `Prompt` and `Answer`; cloze defaults show sentence/hidden answer/hint/full meaning. `Learning focus` and valid image cue appear only after `More options`; no model/storage fields exist. Removing is a quiet menu action. `Add card` after the list opens the same route with a blank basic/cloze draft. Invalid exit preserves fields and identifies the exact error without raw markup.

- [ ] **Step 3: Write failing local recovery/autosave tests**

  Prove every field edit persists under `(userId, creationId, cardKey)` before navigation; each locally valid change debounces an automatic revision-safe server save; Done flushes the pending save and returns; network failure retains the local draft and retry; success clears only that card recovery document and updates revision; server conflict retains local fields and offers deliberate refresh; detail refetch cannot replace the local editor.

- [ ] **Step 4: Run focused tests and confirm RED**

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/creation-preview.test.tsx __tests__/creation-card-editor-screen.test.tsx __tests__/use-creation-card-edit.test.tsx
  ```

  Expected: FAIL because preview/editor boundaries do not exist.

- [ ] **Step 5: Implement preview and the separate editor route**

  Preview cards link to `/creations/[creationId]/card/[cardKey]`. `Add card` creates a local stable key, persists it, then opens the same editor. Compose new focused fields directly from low-level primitives and pure cloze helpers; do not import `NoteEditView` or render multiple `CardEditForm` instances. Keep Done in the sticky footer above the keyboard.

- [ ] **Step 6: Implement revision-safe local recovery**

  `useCreationCardEdit` snapshots one card into AsyncStorage, validates locally, and replaces/adds/removes it through one complete-card `drafts.update`. A 600 ms debounce automatically writes each valid state with the latest acknowledged revision; serialized writes prevent revision races. Done flushes the pending mutation before returning. On conflict or network failure it keeps the local document and pauses automatic writes until explicit retry or refresh. On successful server snapshot it advances the local revision; it clears the recovery document only after Done or confirmed removal.

- [ ] **Step 7: Run focused checks and review focused scope**

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/creation-preview.test.tsx __tests__/creation-card-editor-screen.test.tsx __tests__/use-creation-card-edit.test.tsx __tests__/card-presentation.test.tsx __tests__/card-edit-form.test.tsx
  bun run mobile:check
  git diff --check
  ```

  Review single-card mounting, local recovery order, exact conflict behavior, add/remove semantics, More options hierarchy, image hint visibility, keyboard/safe-area reachability, and no saved-note editor redesign.

- [ ] **Step 8: Commit preview and focused editing**

  ```bash
  git add apps/mobile/src/features/create/creation-preview.tsx apps/mobile/__tests__/creation-preview.test.tsx apps/mobile/src/features/create/creation-card-editor-screen.tsx apps/mobile/__tests__/creation-card-editor-screen.test.tsx apps/mobile/src/hooks/use-creation-card-edit.ts apps/mobile/__tests__/use-creation-card-edit.test.tsx apps/mobile/app/creations/'[creationId]'/card/'[cardKey]'.tsx apps/mobile/app/_layout.tsx apps/mobile/src/features/create/creation-detail-screen.tsx
  git commit -m "feat(mobile): add focused creation review and editing"
  ```

### Task 12: Integrate Adjust with AI, Undo, regeneration, save, retry, and removal

**Files:**
- Create: `apps/mobile/src/features/create/adjust-creation-dialog.tsx`
- Create: `apps/mobile/__tests__/adjust-creation-dialog.test.tsx`
- Modify: `apps/mobile/src/features/create/creation-preview.tsx`
- Modify: `apps/mobile/src/features/create/creation-detail-screen.tsx`
- Modify: `apps/mobile/src/features/create/creation-inbox.tsx`
- Modify: `apps/mobile/src/api/creations.ts`
- Modify: `apps/mobile/__tests__/creation-api.test.tsx`
- Modify: `apps/mobile/__tests__/creation-preview.test.tsx`
- Modify: `apps/mobile/__tests__/creation-detail-screen.test.tsx`
- Modify: `apps/mobile/__tests__/add-screen.test.tsx`

**Interfaces:**
- Consumes: Server adjust/cancel/undo/change-deck/retry/save/cancel/restore/discard procedures, exact cache helpers, and deck list.
- Produces: compact adjustment workflow, persistent Undo notice, secondary regeneration, idempotent save confirmation/View note, stage-specific recovery, and state-correct removal copy.

- [ ] **Step 1: Write failing Adjust/Undo tests**

  Pin suggested instructions plus a free input limited to 500 characters. Current cards stay visible while queued/running; save is disabled with copy to wait or cancel. Cancel immediately returns to the current version. Success renders `Cards adjusted · Undo`; Undo restores the server snapshot across remount. The next manual or AI mutation removes the notice.

- [ ] **Step 2: Write failing change-deck/retry tests**

  `Change deck and regenerate` is secondary, explains pedagogical impact, and never behaves like moving existing cards. Current deck/cards remain until replacement. Routing/cards/image retries target exact stages and preserve cards. A partial failed set remains previewable/editable/saveable with a warning; raw provider failure remains absent.

- [ ] **Step 3: Write failing save/cache tests**

  Save label is `Save to Latin` (actual selected name), generates a stable `saveRequestId`, retries uncertain transport with that id, removes only the consumed list/detail row, invalidates exact notes/cards/deck queries, returns to Create, and shows concise confirmation with `View note`. Save failure leaves every card/edit/deck visible.

- [ ] **Step 4: Write failing removal tests**

  Queued uses `Remove from queue` plus short Undo/restore; running uses confirmed `Cancel creation`; ready/edited uses confirmed `Discard creation`. Copy names the request excerpt and actual loss. Failure retains the item and retry. No destructive action competes with Create/review/save.

- [ ] **Step 5: Run integration tests and confirm RED**

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/adjust-creation-dialog.test.tsx __tests__/creation-preview.test.tsx __tests__/creation-detail-screen.test.tsx __tests__/creation-api.test.tsx __tests__/add-screen.test.tsx
  ```

  Expected: FAIL because set-level and terminal workflows are not integrated.

- [ ] **Step 6: Implement set-level and terminal workflows**

  Keep dialogs compact and state-specific. All mutations include expected revision where applicable. Apply returned detail snapshots directly, then reconcile list queries; do not synthesize a later revision locally. Save/cancel/discard mutation pending state is item-local. Use one recoverable snackbar/banner for queued Undo and one save confirmation with View note.

- [ ] **Step 7: Run focused checks and conduct cross-layer review**

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/adjust-creation-dialog.test.tsx __tests__/creation-preview.test.tsx __tests__/creation-detail-screen.test.tsx __tests__/creation-api.test.tsx __tests__/add-screen.test.tsx __tests__/creation-card-editor-screen.test.tsx
  bun run mobile:check
  bun run --cwd apps/server vitest run router/drafts.test.ts router/creation-save.test.ts creations/worker.test.ts creations/image-scheduler.test.ts notifications/dispatcher.test.ts
  bun run server:check
  git diff --check
  ```

  Review late-result fences across save/cancel/adjust/regenerate, exact one-row cache changes, pending image save, revision conflict preservation, Undo clearing, session recovery, and all learner-facing copy for provider/job/raw-cloze terms.

- [ ] **Step 8: Commit complete creation actions**

  ```bash
  git add apps/mobile/src/features/create/adjust-creation-dialog.tsx apps/mobile/__tests__/adjust-creation-dialog.test.tsx apps/mobile/src/features/create/creation-preview.tsx apps/mobile/src/features/create/creation-detail-screen.tsx apps/mobile/src/features/create/creation-inbox.tsx apps/mobile/src/api/creations.ts apps/mobile/__tests__/creation-api.test.tsx apps/mobile/__tests__/creation-preview.test.tsx apps/mobile/__tests__/creation-detail-screen.test.tsx apps/mobile/__tests__/add-screen.test.tsx
  git commit -m "feat(mobile): complete creation review actions"
  ```

### Task 13: Record Android acceptance coverage and verify the complete slice

**Files:**
- Rewrite: `apps/mobile/e2e/android-smoke.md`
- Modify: `apps/mobile/e2e/android-smoke.sh`
- Modify: `apps/mobile/__tests__/android-smoke-script.test.ts`
- Modify if evidence is produced: `docs/superpowers/plans/2026-08-27-capture-and-generation.md` checkbox state only

**Interfaces:**
- Consumes: Final mobile/server behavior, native rebuilt Android app, attached emulator/device, notification environment, and repository verification scripts.
- Produces: repeatable acceptance checklist, automated smoke anchors, recorded device evidence when available, and a clean reviewed branch.

- [ ] **Step 1: Write the failing smoke-script expectations**

  Update `android-smoke-script.test.ts` to require anchors for Create tab, composer, Creation inbox, creation detail, focused editor, and notification deep-link launch while retaining authentication/API validation. Run:

  ```bash
  bun run --cwd apps/mobile jest --runInBand __tests__/android-smoke-script.test.ts
  ```

  Expected: FAIL because the smoke script still targets the old Add flow.

- [ ] **Step 2: Update the smoke script and English manual matrix**

  The checklist records target id/build, API endpoint, commit, pass/fail, screenshot path, and notes for:

  - empty inbox and first request;
  - three rapid requests with two Creating and one Queued;
  - ambiguous candidates and editable new-deck proposal;
  - short and near-2,000-character multiline request with keyboard open;
  - first/multiple complete cards and prominent image;
  - absent/slow/failed image;
  - leave tab, background, terminate/reopen, and notification return;
  - notification accept/deny and grouped notification;
  - one/many ready creations;
  - basic/cloze preview, visible hint, and image cue;
  - focused edit, Add/Remove card, Adjust, Undo, and change-deck regeneration;
  - offline submission, routing failure, partial card failure, retry, save failure, and renewed session;
  - enlarged text, TalkBack traversal, reduced motion, Android Back, and gesture navigation.

- [ ] **Step 3: Run all focused mobile/server/shared tests affected by the slice**

  ```bash
  bun run mobile:test
  bun run server:test
  bun run shared:test
  ```

  Expected: PASS.

- [ ] **Step 4: Rebuild and run Android QA when a target and push configuration are available**

  ```bash
  adb devices -l
  bun run mobile:android
  bun run mobile:smoke
  ```

  Use a development build containing `expo-notifications`; record screenshots and pass/fail in `android-smoke.md`. If no target, FCM/Expo project id, or notification credential is available, do not claim device/background notification acceptance; record the exact missing evidence in the final handoff without weakening automated coverage.

- [ ] **Step 5: Run the mandatory fresh repository verification**

  ```bash
  bun run check
  bun run test
  git diff --check
  ```

  Expected baseline expansion: all existing 4 root, 261 mobile, 381 server, and 26 shared tests still pass, plus all tests added by this plan.

- [ ] **Step 6: Perform the final review before committing QA artifacts**

  Inspect:

  ```bash
  git status --short
  git diff --stat HEAD
  git diff HEAD -- apps/server apps/mobile libs/shared docs/superpowers/plans/2026-08-27-capture-and-generation.md
  git log --oneline --decorate -15
  ```

  Review spec coverage, ownership and revision checks, scheduler leases, attempt/media fences, restart recovery, compatibility adapters, exact cache eviction, outbox account isolation, notification sign-out, accessibility, reduced motion, learner copy, and saved-note-editor scope. Fix every Critical/Important finding with a failing regression test and a separate conventional commit before completion.

- [ ] **Step 7: Commit acceptance artifacts**

  ```bash
  git add apps/mobile/e2e/android-smoke.md apps/mobile/e2e/android-smoke.sh apps/mobile/__tests__/android-smoke-script.test.ts
  git commit -m "test(mobile): cover creation acceptance flows"
  ```

- [ ] **Step 8: Re-run the final clean-state gate after the last commit**

  ```bash
  bun run check
  bun run test
  git diff --check
  git status --short --branch
  ```

  Expected: all automated checks pass and the tracked worktree is clean. Report Android/device QA separately from automated evidence. Do not push or merge.
