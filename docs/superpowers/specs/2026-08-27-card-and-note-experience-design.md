# Card and Saved Note Experience

## Status and Parent Document

Approved design for the first implementation slice of the mobile UI/UX
redesign. It is governed by:

- `docs/superpowers/specs/2026-08-27-mobile-learning-experience-north-star-design.md`

This specification defines card and saved-note behavior. The north star remains
authoritative for program-wide product and quality principles.

This specification also supersedes one decision in
`docs/superpowers/specs/2026-08-09-image-cued-language-cards-design.md`: a
successfully loaded image no longer hides the inline cloze hint, and there is
no separate "Text hint" action. The image remains the primary visual cue while
the stored hint remains visible as a precise semantic cue.

## Goal

Replace the saved-note screen's disabled-form presentation with a calm,
readable learning-material view, and add complete, safe editing of cards on a
saved note.

After this slice, a learner can:

- Read rendered questions, clozes, hints, and answers instead of technical
  fields.
- Correct, create, delete, and reset cards without losing progress on other
  cards.
- Cancel an entire edit session.
- Keep all local work after validation or network failure.
- Avoid silently overwriting a newer edit made on another device.
- Leave a note with no cards and return to it later.

The slice also establishes shared card-presentation semantics for the later
Capture and Review slices. It does not redesign those screens yet.

## Current Problems

The current `NoteScreen` uses `CardEditor` for reading as well as editing.
Saved cards therefore look like disabled forms: they expose raw `aspect`,
"Front" and "Back" fields, `{{c1::...}}` markup, and a disabled switch. A
saved note has no normal entry point into editing.

The existing `notes.save` mutation consumes a draft and creates a new note.
Reusing it for editing would mint replacement card IDs and lose existing FSRS
schedules and review history. The server has no note-update or note-delete
mutation.

`notes.get` currently sorts cards by review due date. That ordering belongs in
the review queue, but it makes the content and editor order unstable.

## Scope

### In scope

- A new read mode for a saved note.
- A separate edit mode backed by a local draft and one atomic save.
- Shared presentation for basic and cloze cards.
- A cloze editor that never exposes storage markup.
- An open, editable card aspect.
- Creating basic and cloze cards.
- Updating the content and image-cue policy of existing cards.
- Permanently deleting a card and its review history.
- Explicitly resetting one card's progress.
- Keeping an empty note after its final card is deleted.
- Permanently deleting a complete note after confirmation.
- Optimistic concurrency through a note revision.
- Correctly invalidating and regenerating pronunciation after text changes.
- Stable card ordering on the note screen.
- Automated, server, component, accessibility, and visual verification for the
  slice.

### Out of scope

- Redesigning Add or the generation workflow.
- Redesigning the actual Review session or FSRS grading UI.
- Redesigning Today, onboarding, decks, authentication, or settings.
- Editing the original source text.
- Editing or removing the generated note image.
- Drag-and-drop card reordering.
- Automatically invoking AI after a manual content or aspect edit.
- Automatically merging conflicting edits from two devices.
- Dark mode.

## Card Conceptual Model

### Card type and aspect are separate concepts

The technical card type determines how an answer is stored and revealed:

- `basic`: separate question and answer.
- `cloze`: one answer hidden within the front text.

The aspect describes what the card teaches. It remains open text rather than an
enum. Examples include "past tense", "gender", "redox reaction", "definition",
or any value suitable for a particular language or subject.

AI assigns an aspect during generation. The learner may later correct it in a
"Learning focus" field. Manually editing card content does not invoke AI or
rewrite the aspect. A new card starts with the neutral aspect "Question and
answer" or "Fill in the blank", which the learner may immediately replace with
any text.

Presentation may only make an aspect mechanically readable, for example by
turning separators in `past_tense` into spaces. It must not map aspects through
a closed vocabulary or reinterpret their meaning.

### Cloze semantics

The storage format remains exactly one deletion in `front`:

```text
Ich wohne im {{c1::Haus::dom}}.
```

Its parts have distinct roles:

- `Haus` is the hidden answer.
- `dom` is the hint stored inside the cloze deletion.
- `Ich wohne im ...` is the question context.
- `back`, such as `Mieszkam w domu.`, is a translation of the complete
  sentence or an additional explanation.

Before reveal, presentation shows:

```text
Ich wohne im [dom].
```

After reveal, it shows:

```text
Ich wohne im Haus.
Mieszkam w domu.
```

When a hint exists, it is always visible before reveal, including on an
image-cued card. There is no separate "Show text hint" action. A normal cloze
may omit the hint, but an image cue continues to require a non-empty hint under
the existing server rules.

## Saved Note Read Mode

### Header and source

`PageHeader` has the stable title "Note", a stable return to the owning deck,
and a quiet "Edit" action. The original `sourceText` is no longer used as the
page title. It appears as content in a "Source" section so that long material
cannot overwhelm navigation and heading hierarchy.

The source remains read-only. Changing it could invalidate classification,
image, and generation assumptions, so it requires a separate future design.

### Note image

When an image exists or is still generating, it is a large and meaningful
element below the source. Existing distinctions between generating, absent,
failed, and retryable image states remain intact.

The saved-note screen does not repeat the same large image inside every card.
A card with `imageCue: true` has a quiet, explicit indication that the note
image forms part of its prompt. The later Review slice will make the image the
dominant cue inside the actual recall experience.

### Card list

The "Cards" section shows a card count and rendered surfaces instead of
disabled forms. Each surface contains:

- The open aspect as quiet metadata.
- The learner-facing card type without technical jargon.
- The rendered question or cloze sentence.
- Any cloze hint, always visible.
- The revealed answer and `back`, because note inspection is not a memory
  test.
- A compact pronunciation control when the card is eligible.

Card order on a saved note is stable and independent of `due`. Existing cards
are ordered by creation order and new cards append to the end. The Review queue
continues to sort by scheduling data.

### Empty note

Deleting the final card does not delete its note. Source, image, and metadata
remain. The card section shows "This note has no cards yet" and a primary "Add
card" action that enters edit mode directly on a new card.

A secondary menu contains a separate "Delete note" action. Confirmation
describes the loss of all cards, review history, and media. After success,
replacement navigation returns to the owning deck.

## Edit Mode

### Session and navigation

"Edit" hydrates a local draft from the current server snapshot and changes the
screen heading to "Edit note". The header provides "Cancel", while a sticky
"Save changes" action stays reachable above the keyboard and safe-area inset.

The draft owns stable local keys for both existing and new cards. Background
image or audio polling must not rehydrate the draft or overwrite local work.

"Cancel" restores the complete snapshot, including content, additions,
pending deletions, and progress resets. Leaving through a gesture, the Android
system Back button, or a link while the editor is dirty requires confirmation.
Leaving a clean editor is immediate.

### Basic card

The `basic` editor contains:

- The open aspect.
- A required "Question" field.
- A required "Answer" field.

A basic card cannot set `imageCue`, because that persisted contract means the
image is the preferred prompt for a valid cloze with a text hint. A note image
may still appear as supporting material in a later Review design, but it does
not replace a basic card's question.

The server continues to derive `cardType` from content. The client is not the
authoritative source of the technical type.

### Cloze card

The cloze editor never exposes `{{c1::...}}`. It maintains a structured local
model:

- The complete sentence without markup.
- The range of the hidden answer.
- An optional hint.
- An optional full translation or explanation in `back`.
- Image-cue policy.

The learner enters an ordinary sentence, selects a non-empty range, and chooses
"Hide selection". The preview immediately shows the resulting blank. The
learner can choose another range or clear the current selection.

An existing valid deletion hydrates into plain text and a range. A text edit
preserves the range when the change is unambiguously outside it. A change that
intersects or invalidates the hidden range marks the range invalid, preserves
all entered text, and asks the learner to select the answer again. Saving is
blocked by a card-local error until the range is valid.

Before transport, a pure function serializes the model back to one
`{{c1::answer::hint}}` deletion. Client and server use the same
well-formed-cloze rules, while the server remains the final validation
boundary.

### Image cue

The image is the stronger visual cue but does not replace the text cue stored in
the cloze. The intended hierarchy for a future image-cued review is:

1. Large image.
2. Cloze sentence.
3. Visible, quieter hint inside the blank.
4. `back` only after reveal.

This slice encodes that meaning in the note view and shared presentation
contract but does not migrate `ReviewScreen` yet.

The image-cue control is available only for a combination allowed by the
existing domain, image, and cloze rules. Enabling it requires a non-empty hint.
An invalid combination produces a local explanation instead of allowing a
save that the server will later reject.

### Add, delete, and reset

"Add card" offers "Question and answer" and "Fill in the blank". A new card is
appended, expanded, and focused on its first field. It must satisfy the same
save rules as a generated card.

"Delete card" requires confirmation that saving will permanently remove the
card and its review history. Until "Save changes", deletion remains local and
can be undone by canceling the edit session. Deleting a new unsaved card merely
removes it from the draft, and confirmation copy must not claim that review
history exists.

"Reset progress" exists only for a saved card and has its own confirmation.
Reset may accompany a content update to the same card. A card pending deletion
cannot also be reset.

## API Contract and Concurrency

### Note revision

The `notes` table gains an integer `revision` starting at `0`. Only saved
changes to card content or card membership increment it. Background image and
audio state transitions do not change the revision because they are not user
edits.

`notes.get` returns `revision`, cards in stable content order, `cardType`,
and public audio state. It does not expose filesystem paths.

### Atomic update

A new `notes.update` mutation accepts:

- `noteId`.
- `expectedRevision`.
- Explicit `create` operations with stable client keys.
- Explicit `update` operations with existing card IDs.
- `deleteCardIds`.
- `resetCardIds`.

Explicit operation sets are safer than interpreting every omitted card as a
deletion. The server rejects duplicate IDs, invalid intersections between
operation sets, and references to cards outside the note or current user.

Inside one write lock and database transaction, the server:

1. Verifies note ownership and `expectedRevision`.
2. Validates the complete resulting card set and image-cue relationships.
3. Updates existing cards without changing their IDs or FSRS fields.
4. Creates new cards with new IDs and `due` set to the save time.
5. Resets explicitly selected cards.
6. Deletes explicitly selected cards.
7. Increments the note revision.
8. Returns the current snapshot and a mapping from client keys to new IDs.

The transaction may leave a note with zero cards. Any validation, ownership,
or persistence error rolls back the complete operation.

### Version conflict

A mismatched revision returns a conflict rather than applying last-write-wins.
The mobile editor preserves its local draft and explains that the note changed
elsewhere. The learner can:

- Stay in the editor without losing entered content.
- Explicitly discard local work and load the latest server snapshot.

This slice does not attempt automatic card merging and does not permit retrying
with a newer revision without first reloading. Either behavior could silently
restore a card changed or removed elsewhere.

The separate `notes.delete` mutation also accepts `noteId` and
`expectedRevision`. It refuses to delete a note that changed after the
confirmation screen was prepared, preventing a deletion from silently erasing
newer work from another device.

## Scheduling and Review History

### Existing-card edit

Changing aspect, front, back, or image-cue policy preserves:

- Card ID.
- Current `due`.
- FSRS stability, difficulty, and state.
- Review and lapse counters.
- Existing review logs.

This is the default for corrections. The learner chooses the separate reset
action when a semantic change makes earlier progress misleading.

### New card

A new card uses the same initial FSRS values as a card created by
`notes.save`, is due at the save time, and has no review logs.

### Reset

Reset deletes the card's review logs and restores every FSRS field to the new
card state, with `due` set to the save time. It does not change content,
aspect, ID, or note ownership.

### Delete

Permanent card deletion removes the row and its review logs through existing
foreign keys. Deleting a whole note cascades through all its cards and logs.

## Audio and Media

`ttsTextForCard` depends on note domain, language, and the revealed front.
After a front edit, the server compares old and new TTS text:

- If the text is unchanged, existing audio remains valid.
- If it changed and the card remains eligible, stored audio state is cleared,
  generation becomes pending, and a new job starts after commit.
- If the card is no longer eligible, audio is cleared without starting a job.

Old audio paths for changed or deleted cards are collected before the
transaction but physically removed only after a successful commit. Cleanup is
idempotent and best effort: a filesystem failure is logged but does not restore
a deleted database row.

Deleting a note similarly collects its image and every card audio path, applies
the database cascade, and then removes files. An audio or image job completing
after its owner was deleted must detect the missing row and remove its late
output, following the existing job pattern.

## Errors and Recovery

- A fetch failure retains a stable header, a route back to the deck, and retry.
- Client validation errors belong to a specific field or card and block
  transport without clearing data.
- Server validation errors preserve the draft and map paths to the correct card
  through a card ID or client key.
- A network failure preserves the complete session and permits the exact same
  mutation to be retried.
- A revision conflict preserves the draft and does not overwrite the server.
- Audio-generation failure does not roll back correctly saved content; the card
  exposes the existing pronunciation retry state.
- Media-cleanup failure does not resurrect deleted data and is recorded in
  server logs.
- Failed note deletion leaves the learner on the current note with content and
  retry available.

## Component Boundaries

### Presentation

A shared card-presentation component accepts an explicit card model and mode:

- Saved-note inspection.
- Edit preview.
- Later Review prompt and reveal.

It does not fetch data, persist server state, or own routing. It owns consistent
basic, cloze, hint, back, and image-cue semantics. This slice does not migrate
`ReviewScreen`, but the public interface must not assume the answer is always
revealed.

### Local edit model

A pure draft-model module owns:

- Hydrating a server snapshot.
- Stable local keys.
- Parsing cloze into plain text and a selection range.
- Adjusting or invalidating the range after text edits.
- Serializing cloze.
- Validating basic, cloze, and image-cue rules.
- Computing dirty state.
- Building explicit API operations.

The module does not render UI or issue requests, so the most consequential
transformations have fast unit tests.

### Screen

`NoteScreen` orchestrates fetch, read mode, the edit session, confirmations,
mutations, revision conflicts, and navigation. Large presentation and editing
sections are extracted into focused components instead of making the screen a
single monolithic file.

## Accessibility and Mobile Ergonomics

- Read mode does not expose rendered cards as disabled forms.
- Aspect, prompt, hint, and answer have an unambiguous reading order.
- An image cue has alternative text equivalent to the visible hint, never the
  hidden answer.
- Card type, image cue, reset, and delete do not rely on color alone.
- Cloze range selection has instructions, current state, and errors available
  to assistive technology.
- Every action has at least a 48 px practical touch target.
- Sticky save remains reachable with the keyboard open and respects safe area.
- Enlarged text may expand cards and buttons without clipping.
- Confirmation dialogs move focus, describe consequences, and return focus to
  a logical control after cancellation.
- Pending state blocks duplicate actions without appearing permanently
  disabled.

## Testing

### Pure functions

- Round trips for basic cards and every valid cloze form.
- Parsing before text, answer, hint, after text, and back.
- Existing hint visibility with image cue enabled.
- Text edits before, after, and inside the hidden range.
- Rejection of empty, multiple, or malformed clozes.
- Open aspects from language and non-language domains.
- Stable local keys and correct create/update/delete/reset diffs.
- Dirty-state calculation and complete snapshot restoration after cancel.

### Mobile components and screen

- Read mode renders no `TextInput` or disabled switches.
- Source is not the page heading.
- Basic and cloze cards show the correct prompt, hint, answer, and back.
- Image cue never hides an existing hint.
- Audio remains attached to the correct card after an adjacent addition or
  deletion.
- Add card creates both types and moves focus.
- Cloze editing selects an answer without revealing markup.
- Validation, deletion, reset, cancel, and unsaved-exit confirmation.
- Empty note and direct entry into a new card.
- Revision conflict and network retry preserve the draft.
- Delete note navigates only after success.
- Roles, labels, selected/busy state, and accessibility order.

### Server and database

- Migration adds `revision: 0` without altering existing notes, cards, or FSRS.
- `notes.get` returns revision, card type, and stable order without file paths.
- One mixed mutation creates, updates, resets, and deletes in one commit.
- Edit preserves ID, history, and FSRS without a reset flag.
- Reset removes logs and restores the complete new-card state.
- A new card is due immediately.
- The last card can be removed without deleting the note.
- One invalid card rolls back every other operation.
- Foreign IDs and invalid operation intersections are rejected.
- Revision mismatch performs no mutation.
- Front changes correctly preserve or regenerate audio.
- Card and note deletion clean data, logs, and media.
- Late jobs do not leave ownerless media.

### Visual verification

Android-emulator QA covers:

- Short and very long source text.
- Note without an image, with an image, with image generation pending, and with
  an image error.
- One and many cards of both types.
- Cloze with a hint, without a hint, and with image cue.
- Empty note.
- New, edited, deleted, and reset cards.
- Field validation, network failure, and revision conflict.
- Open keyboard, enlarged text, and long translations.
- Android system Back from a dirty editor.

After focused tests, the implementation must pass:

```bash
bun run check
bun run test
git diff --check
```

## Acceptance Criteria

The slice is complete when:

- Saved cards never look like disabled inputs on the note screen.
- Raw cloze markup is absent from read mode and normal editing.
- An existing cloze hint remains visible when an image is present.
- A learner can atomically create, correct, reset, and permanently delete
  cards.
- Ordinary edits preserve progress while reset requires explicit intent.
- Deleting the final card leaves a useful empty note.
- Whole-note deletion is separate, confirmed, and cleans media.
- A revision conflict or network error does not discard local work.
- Audio matches current card content.
- Automated and visual verification from this specification has recorded
  evidence.
- Later slices can reuse card-presentation semantics without copying cloze
  interpretation.
