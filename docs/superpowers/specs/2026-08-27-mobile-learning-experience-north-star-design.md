# Mobile Learning Experience North Star

## Status

Approved program direction for the Mnimi mobile UI/UX redesign. This document
governs the independently specified implementation slices listed below. Each
slice still requires its own approved design specification and implementation
plan before an agent changes application code.

## Purpose

Mnimi already has a coherent warm visual foundation, shared mobile primitives,
and the core workflows needed to create and review learning material. The next
stage is a product-level refinement: make the app feel like a calm study coach
instead of a polished database manager.

The redesign must make it easy for a learner to understand where they are,
choose the next useful action, recover from interruptions, and stay focused on
the material. It should improve the entire learning loop without adding reward
mechanics or replacing the current technical stack.

## Relationship to Earlier UI Work

The following documents remain useful historical records:

- `docs/superpowers/specs/2026-08-17-mobile-ui-polish-design.md`
- `docs/superpowers/plans/2026-08-17-mobile-ui-polish.md`

They describe the shared header, list-row, button hierarchy, safe-area, and
screen-rhythm foundations already present in the app. They intentionally kept
the existing workflows unchanged, while this program is authorized to redesign
those workflows.

This north star and its slice specifications take precedence where the older
documents conflict with them. The old implementation plan must not be executed:
its Deno commands are obsolete. Current work must follow `AGENTS.md`, use Bun,
and run the full suite with `bun run test`.

## Product Personality

Mnimi is a **calm study coach**.

It is focused, reassuring, and quietly progress-aware. It does not use XP,
levels, streak pressure, artificial urgency, competitive rankings, or excessive
celebration. Progress feedback exists to orient the learner and close a task,
not to make the learner feel punished for missing a day.

The interface should feel:

- Calm without appearing empty or unfinished.
- Warm without becoming decorative or playful.
- Helpful without constantly explaining itself.
- Focused without hiding necessary control.
- Polished without relying on novelty.

## Experience Contract

Every screen and workflow must answer three questions:

1. Where am I?
2. What is the most useful thing I can do next?
3. What happened after my last action?

### Content before machinery

Learning content is the primary visual material. Configuration, internal model
stages, raw card syntax, provider metadata, aspect identifiers, and diagnostic
details use progressive disclosure or remain development-only. Learners see
human descriptions of generated cards and scheduling actions.

### One clear primary action

Each state has one visually dominant constructive action. Supporting,
navigation, selection, and destructive actions use distinct lower-emphasis
treatments. Destructive actions never compete with the learning task.

### Honest and resilient state

The interface distinguishes loading, empty, partial, pending, saved, offline,
recoverable failure, and expired-session states. It tells the learner whether
the app is waiting, retrying, saving, or safe to leave.

User work is preserved whenever technically possible. A failed request or
interrupted workflow must not silently discard source text, generated cards,
form input, revealed review state, or retry context.

### Restrained feedback

Use pressed states, brief transitions, and optional haptics to confirm actions
and changes of state. Motion must clarify hierarchy or causality; it must not
delay the learner or decorate routine navigation. Every animated behavior needs
a reduced-motion path.

### Learner-facing language

Copy is direct, specific, and supportive. Avoid internal terms, guilt-inducing
language, vague success messages, and generic errors. Empty states explain why
the state exists and offer the most relevant next action.

## Visual Direction

Preserve the established warm-neutral background, white surfaces, dark text,
muted supporting text, green constructive accent, and restrained red
destructive treatment. Improve hierarchy through composition, spacing,
typography, surface grouping, and action priority before adding new colors.

Light mode is the only theme delivered by this program and must be fully
polished. New and modified components must use semantic theme tokens rather
than assuming fixed light colors internally. Dark mode is a later project and
must not require these components to be restructured.

Avoid ornamental gradients, decorative illustration without instructional
purpose, oversized headings that crowd content, and repeated full-width filled
buttons. Prefer a stable screen rhythm, strong content surfaces, quiet
supporting controls, and clear spatial grouping.

## Accessibility and Mobile Ergonomics

Accessibility is a requirement of every slice rather than a final cleanup
phase.

- Interactive targets are at least 48 px in both practical dimensions.
- Destination rows remain at least 56 px high and make the complete row
  interactive.
- Labels, roles, hints, busy states, selected states, and expanded states are
  exposed to assistive technology where applicable.
- State and meaning never depend on color alone.
- Text layouts tolerate enlarged system text without clipping essential
  content or hiding actions.
- Focus order follows the visual and task order.
- Keyboard-open layouts keep the active input and completion action reachable.
- Scrollable screens include deliberate safe-area and optical ending space.
- Motion honors the operating system's reduced-motion preference.
- Audio controls remain operable and understandable without hearing the audio.

## Technical Direction

The redesign extends the existing Expo Router, React Query/oRPC, NativeWind,
and repository-owned React Native UI primitives. It must not introduce a second
component system or initiate an unrelated architecture rewrite.

Shared components own reusable presentation and interaction contracts. Feature
screens own workflow orchestration. A shared abstraction should be introduced
only when at least one approved slice needs it and its interface is clear.

Server-owned facts remain authoritative. Due counts, scheduling outcomes,
completion summaries, persisted drafts, and other shared product state should
come from server APIs rather than being reconstructed differently by multiple
clients. When better UX needs backend work, the responsible slice includes the
complete vertical change: shared contract, validation, server behavior, mobile
consumption, compatibility handling, and tests.

No slice may depend on unimplemented work from a later slice. Each slice must
leave the repository working and independently shippable.

## State and Error Handling

Every slice specification must enumerate the meaningful states of its workflows
and define their transitions. At minimum, consider:

- Initial loading.
- Empty data.
- Partial or streaming data.
- Ready interaction.
- Pending mutation.
- Successful completion.
- Recoverable server or network failure.
- Offline or interrupted operation.
- Session expiration.
- Navigation away and subsequent restoration where the workflow is durable.

Errors appear near the action or content they affect and include a specific
recovery path. A retry should continue from preserved context instead of
restarting the entire workflow. Background query updates must not leak local
interaction state from one entity to the next.

## Implementation Slices

The program is delivered sequentially through six vertical slices.

### 1. Card and note experience

Establish polished card presentation, learner-facing aspect names, rendered
cloze content, clear read and edit modes, and reliable saved-note editing. This
slice supplies stable card presentation interfaces for later capture and review
work.

Planned artifacts:

- `docs/superpowers/specs/2026-08-27-card-and-note-experience-design.md`
- `docs/superpowers/plans/2026-08-27-card-and-note-experience.md`

### 2. Capture and generation

Redesign source capture, contextual deck selection, generation progress, draft
recovery, generated-card preview and editing, save, and discard behavior. It
builds on the card presentation contracts from slice 1.

Planned artifacts:

- `docs/superpowers/specs/2026-08-27-capture-and-generation-design.md`
- `docs/superpowers/plans/2026-08-27-capture-and-generation.md`

### 3. Review session

Add meaningful progress, focused reveal interaction, restrained audio controls,
understandable grading, failure recovery, gentle feedback, and a useful
completion recap. It reuses the card presentation language from slice 1.

Planned artifacts:

- `docs/superpowers/specs/2026-08-27-review-session-experience-design.md`
- `docs/superpowers/plans/2026-08-27-review-session-experience.md`

### 4. Onboarding and Today

Guide a first-time learner through creating useful learning material, then turn
Today into a calm daily hub. This slice routes into the completed capture and
review experiences instead of inventing parallel versions of them.

Planned artifacts:

- `docs/superpowers/specs/2026-08-27-onboarding-and-today-design.md`
- `docs/superpowers/plans/2026-08-27-onboarding-and-today.md`

### 5. Deck library

Improve scanning and navigation with meaningful metadata, contextual creation,
stronger empty states, clearer deck details, and safely de-emphasized
destructive actions.

Planned artifacts:

- `docs/superpowers/specs/2026-08-27-deck-library-experience-design.md`
- `docs/superpowers/plans/2026-08-27-deck-library-experience.md`

### 6. Account and global polish

Refine authentication and settings, complete accessibility and theme-readiness
audits, reconcile remaining inconsistencies, and perform final cross-flow
visual QA. This slice closes program-wide gaps; it does not postpone basic
accessibility or quality work from earlier slices.

Planned artifacts:

- `docs/superpowers/specs/2026-08-27-account-and-global-polish-design.md`
- `docs/superpowers/plans/2026-08-27-account-and-global-polish.md`

## Documentation and Execution Contract

Each slice follows its own design specification, user review, and implementation
plan cycle. The future handoff index will define the completed execution order
and link every artifact.

An implementation agent must read, in order:

1. Repository `AGENTS.md` instructions.
2. This north-star document.
3. The assigned slice specification.
4. The assigned slice implementation plan.

The agent executes the approved decisions instead of reopening product design.
It may choose small implementation details that do not change user-visible
behavior or documented interfaces. It must stop and request direction when the
codebase contradicts the plan, a requirement cannot be satisfied safely, or a
new decision would materially change the approved experience.

Plans must identify exact files, interfaces, test cases, commands, and
conventional commit boundaries. Necessary server and shared-package work lives
in the slice whose experience requires it.

## Verification Contract

Every implementation plan requires test-driven tasks and explicit verification.
At minimum, the implementing agent must:

1. Run focused tests throughout development.
2. Run `bun run check`.
3. Run the full suite with `bun run test`.
4. Run `git diff --check`.
5. Exercise materially changed states in an Android emulator.
6. Check relevant accessibility behavior, enlarged text, keyboard layouts,
   touch targets, and reduced-motion behavior.
7. Rebuild the development app when native configuration or native dependencies
   change.
8. Report verification evidence and label unexercised states explicitly.

Visual QA covers the states that apply to the slice, including loading, empty,
populated, pending, recoverable error, keyboard-open, and long-content states.
Automated tests alone are not sufficient evidence for a user-visible redesign.

Each task ends in a conventional commit. Each slice ends with a clean,
independently reviewable repository state. The final slice repeats core-flow QA
across the complete mobile experience.

## Program Completion Criteria

The documentation program is ready for implementation handoff when:

- All six slice specifications have been approved and committed.
- Each approved specification has a complete Superpowers implementation plan.
- A handoff index links the north star, specifications, and plans in dependency
  order.
- Plans use the current Bun commands and contain no obsolete Deno instructions.
- Slice boundaries contain no circular or forward dependencies.
- Every user-visible requirement maps to an implementation task and a
  verification step.

The product redesign is complete only after all six implementation plans have
been executed and their cross-flow verification has passed.
