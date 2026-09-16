# Capture and Generation Experience

## Status and Parent Document

Approved design for the second implementation slice of the mobile UI/UX
redesign. It is governed by:

- `docs/superpowers/specs/2026-08-27-mobile-learning-experience-north-star-design.md`

The north star remains authoritative for program-wide product, accessibility,
and quality principles. This specification takes precedence over earlier Add
screen and single-draft workflow decisions where they conflict.

This slice builds on the learner-facing card presentation and structured cloze
semantics established by:

- `docs/superpowers/specs/2026-08-27-card-and-note-experience-design.md`

It may reuse those presentation and draft-model boundaries, but it does not
redesign the saved-note screen. The saved-note editor needs a later,
deliberate simplification pass; that work must not be smuggled into this slice.

## Goal

Turn Add from a single technical generation screen into a calm, content-first
creation inbox. A learner should be able to describe what they want to learn in
natural language, immediately submit another request, leave while work
continues, and return to polished material that is safe to review, adjust, and
save.

After this slice, a learner can:

- Submit a word, phrase, question, instruction, or short passage without first
  configuring generation.
- Let AI select the most appropriate existing deck and use that deck as
  pedagogical context.
- Resolve an ambiguous deck choice or approve a proposed new deck.
- Queue several creations while at most two generate concurrently.
- Watch an honest but visually engaging generation sequence or leave it
  running in the background.
- Receive a device notification when a creation needs a decision or is ready.
- Review cards as learning content rather than a dense form.
- Edit one card at a time or adjust the complete set with a natural-language AI
  instruction.
- Undo the latest AI adjustment without losing earlier manual work.
- Save a reviewed creation or discard it without affecting other queued work.
- Recover source text, completed cards, and edits after navigation, network
  failure, or an application restart.

## Current Problems

The current Add flow requires a deck before generation even though deck choice
does not influence the model prompt. The generator sees only source text and
the learner's native language. Consequently, a request such as "Myślę więc
jestem po łacińsku" cannot produce a language-production exercise in a Latin
deck and a quotation-and-idea exercise in a Philosophy deck.

The screen permits only one unsaved generation per user. `drafts.userId` is
unique, `drafts.current` returns a single row, and one global draft indicator
stands in for a queue. A learner must wait, review, save, or discard before
capturing another thought.

Generation is presented as machinery: "Generation" and "Cards" sections,
model classification, elapsed time, partially streamed fields, form controls,
and a separate "Finish" section. This makes a long wait feel static and makes
the generated result look like database input rather than material to learn.

Drafts are durable, but only one is queryable. Completed card fields are
streamed to an attached client and persisted as a final set; an application
that leaves and reconnects cannot reconstruct the same progressive reveal.
There is no durable server-owned queue, no multi-item completion surface, and
no completion notification path.

## Experience Principles for This Slice

### A request, not a topic field

The composer accepts a natural-language learning request. It is not labelled
"topic" and does not force the learner to separate content from instructions.
All of these are valid inputs:

- `die Banane`
- `Myślę więc jestem po łacińsku`
- `Help me remember why seasons happen`
- `The difference between mitosis and meiosis`
- A short pasted passage with an instruction about what matters.

The submitted text is the learner's intent and source material together. The
AI must interpret it in the learner's native language, not assume that every
foreign-language phrase is already in the desired target language or that
every imperative is content to memorize literally.

The trimmed request is limited to 2,000 characters. The composer grows from
one line to a practical mobile maximum, then scrolls internally. A character
count appears only near the limit. Validation never clears the request.

### Deck as pedagogical context

The selected deck is not merely a destination folder. Its name and optional
description shape what is taught and how it is tested.

For example, the same request about "Cogito, ergo sum" may produce:

- In **Latin**, a production-focused language card whose prompt is in the
  learner's native language and whose answer practices the Latin expression.
- In **Philosophy**, cards about the quotation, Descartes, and the proposition's
  meaning.

The choice must be resolved before card generation. Moving an already
generated set to another deck does not pretend that the cards were generated
for the new learning goal; changing deck requires regeneration.

### No routine setup

The default composer shows no deck picker, card-count control, image toggle,
domain selector, language selector, or advanced-options disclosure. The
learner writes a request and chooses the one primary action, "Create".

AI chooses the deck, the smallest useful card set, and whether an image would
materially help. One creation produces between one and six cards. The learner
can request a different emphasis after generation instead of configuring a
technical pipeline before seeing any content.

### Content before controls

Ready creations open in presentation mode. The image and learning content are
the visual focus. Text inputs, switches, destructive controls, internal
classification, provider state, raw cloze markup, and job identifiers are not
part of the default view.

## Creation Inbox

### Navigation and naming

The user-facing tab and page title change from "Add" to **"Create"**. The
internal Expo Router path may remain `/add` if preserving it avoids unrelated
navigation churn; user-visible terminology is authoritative.

The page is a creation inbox, not a job dashboard. User-facing copy uses
"creation", "cards", "material", or the source-request excerpt. The word
"job" remains implementation-only.

### Composer

The composer sits at the top of the Create screen and asks:

> What do you want to learn?

Short rotating or static examples may demonstrate the range of natural input,
but they must not animate while the learner is typing. The only prominent
control is "Create".

Submitting provides immediate pressed/haptic feedback. In one local operation,
the application moves the exact request into a durable, user-scoped outbox,
adds an optimistic inbox row, and clears the composer. It then submits that
outbox item with a stable idempotency key until the server acknowledges it.
This permits rapid capture without risking lost text or duplicate creations
across a slow or uncertain transport.

Focus remains suitable for entering another request immediately. A rejected or
offline outbox item remains a row with its original text and a specific retry
action; it is never copied back over newer composer input.

### Groups and priority

The inbox shows non-empty groups in this order:

1. **Needs your choice** — deck routing requires a decision or new-deck
   confirmation.
2. **Ready to review** — generated material awaits review and explicit save.
3. **Creating** — no more than two creations are actively using a generation
   slot for this learner.
4. **Queued** — accepted requests waiting for a generation slot.
5. **Failed** — preserved requests or partial results with a specific recovery
   action.

Each row contains only:

- A one- or two-line excerpt of the original request.
- The selected deck name when known.
- A human state label.
- A thumbnail when a ready image exists.
- A quiet disclosure affordance; the complete row is the touch target.

Rows never expose elapsed timers, raw model classifications, confidence
percentages, retry counters, provider names, or internal stage names.

The tab may show a restrained badge containing the number of items that need
learner action: unresolved deck choices, ready creations, and failures. It does
not display the total number of queued and running operations.

### Empty and cleared states

An empty inbox makes the composer the clear focus. Supporting copy explains
that Mnimi will choose a suitable deck and prepare cards in the background. It
does not describe queues, models, or AI stages.

A saved or discarded creation leaves the inbox. The inbox is not a second note
history; saved material belongs in its deck. A short success surface may offer
"View note" without retaining a permanent completed row.

## Deck Routing

### Structured outcomes

The routing stage receives:

- The complete learner request.
- The learner's native language.
- The id, name, and optional description of every deck owned by the learner.

It returns exactly one server-validated outcome:

- `matched`: one owned deck and a concise interpreted learning goal.
- `ambiguous`: two or three owned candidate decks, each with a one-line
  description of how that choice would shape the cards.
- `newDeck`: a proposed deck name, description, and interpreted learning goal
  when no existing deck is suitable.

The model cannot authorize ownership or invent an existing deck id. The server
maps and validates every returned candidate against the catalog supplied to the
model before persisting it.

### Confident match

A confident existing-deck match proceeds without confirmation. The selected
deck and interpreted learning goal are persisted before card generation so a
reconnect sees the same decision.

Confidence is a server-side routing policy evaluated with representative test
cases. It is not shown as a numeric score. If the router cannot make the
required distinction safely, it must choose `ambiguous` rather than disguise a
guess as confidence.

### Ambiguous match

An ambiguous creation moves to "Needs your choice" and releases its generation
slot. Its selection surface asks:

> Where should this go?

Each option pairs a deck name with the learning angle it would produce, for
example:

- **Latin** — Practice producing the Latin expression.
- **Philosophy** — Learn the quotation, author, and idea.

No internal reasoning trace or confidence percentage is shown.

If the learner is still viewing that creation when routing settles, the choice
dialog may open in context. It must not appear over another screen or interrupt
typing a subsequent request. Otherwise the inbox row and optional notification
carry the decision until the learner returns.

Selecting a candidate atomically stores the deck and learning goal, then
returns the creation to the queue. If the deck was deleted in the meantime,
the server refreshes routing choices instead of accepting a stale id.

### Proposed new deck

AI never creates a deck without approval. A `newDeck` outcome opens the same
decision surface with editable proposed name and description. Confirming:

1. Validates the name and description.
2. Creates the owned deck.
3. Assigns the creation to it.
4. Re-enters the creation in the queue.

Canceling the proposal leaves the creation in "Needs your choice" with an
explicit option to choose an existing deck or discard the request. A learner
with no decks receives this proposal flow rather than an unrelated empty-deck
dead end.

## Queue and Scheduling

### User-visible concurrency

At most two text-generation operations run concurrently per learner. Further
creations remain visibly queued and start automatically in accepted order when
a slot becomes available.

Deck routing is the first stage of a creation's scheduled work. An ambiguous
result releases its slot immediately. AI adjustment, retry, and change-deck
regeneration use the same per-learner slots and cannot bypass queued work.

Image rendering uses an independently bounded server pool because it already
runs concurrently with card generation and may finish later. A slow picture
must not occupy one of the learner's two card-generation slots after the cards
are ready.

Server-wide safeguards may impose a lower effective rate during provider
pressure, but the UI continues to describe those items honestly as queued. It
does not promise a start time.

### Durable authority

The database, not a mounted mobile screen or an in-process map, owns:

- Queue membership and accepted order.
- The selected deck and interpreted learning goal.
- The active attempt and its stage.
- Completed validated cards for the active attempt.
- Independent image status.
- Failure and retry state.
- Manual edits and revision.
- The one available AI-adjustment undo snapshot.

The process-local registry remains an execution and subscription layer. A
server scheduler claims queued work atomically. A stale claim left by a process
restart becomes eligible for recovery, so no item remains permanently marked
"Creating" without live work behind it.

Canceled, superseded, or stale attempts cannot write cards or media after a
newer attempt has claimed the creation. Late media without a valid owner is
removed using the existing generation-owned cleanup pattern.

### Item state model

The persisted creation states are sufficient to derive these learner states:

- Routing or initial scheduled work: `Creating`.
- Awaiting a deck decision: `Needs your choice`.
- Accepted but without a slot: `Queued`.
- Actively generating cards: `Creating`.
- Cards valid and available: `Ready to review`.
- Recoverable stage failure: `Failed` or a ready partial result with a warning.
- Save or discard in progress: an item-local pending state that blocks only a
  duplicate action on that item.

Image status remains independent. A creation can be ready to review while its
picture is generating or has failed.

## Generation Experience

### Immediate response

Opening an active creation shows a full-screen content-building sequence. It
begins immediately from locally known facts rather than waiting for the first
model token:

1. The submitted request contracts into a stable content heading.
2. The chosen deck appears when routing has resolved.
3. The layout acknowledges real stage transitions as they occur.
4. A useful picture and complete cards populate the composition independently.

The initial motion is a brief consequence of the submit or navigation action,
not a decorative looping intro that delays content.

### Honest spectacle

The sequence should feel alive and consequential without fabricating progress.
It uses:

- A restrained active treatment while the current real stage is pending.
- Short completion transitions when routing, image, or a card actually lands.
- A soft image reveal that gives a useful image visual priority.
- A staggered entrance and optional light haptic for each complete card.
- A clear transition from creating to ready.

It does not use:

- Invented percentages.
- A countdown or estimated completion time.
- Raw token streaming or half-written words.
- A three-card skeleton that implies a count the model has not chosen.
- Rapidly rotating fake status messages.
- Ornamental gradients or unrelated celebration art.

Human stage copy may include "Understanding your request", "Choosing the best
fit", "Creating a picture", and "Writing cards" only while the corresponding
server state is true. Assistive announcements occur at meaningful transitions,
not for animation frames or text deltas.

### Complete-card streaming

Each card appears only after the server can validate that individual card as a
complete basic or cloze card. A card is scoped to one generation attempt and
persisted before being announced to clients. Cards from a superseded or failed
attempt never mix with a replacement attempt.

The first valid card appears without waiting for later cards or the image. The
final set still passes complete note-level validation before the creation moves
to "Ready to review". If final validation triggers a model retry, the UI
retains the previous safe persisted set or returns to a truthful creating state;
it never leaves invalid partial content presented as ready.

AI adjustment differs intentionally: the existing reviewed set remains visible
while the replacement is generated, and the new set replaces it atomically
only after complete validation.

### Image behavior

When an image is useful, it becomes the largest visual element as soon as it is
ready. Cards whose question uses it retain their visible cloze hint as the
precise textual cue. The image reinforces memory; it does not hide meaning or
become a decorative banner.

When no useful image is requested, the composition closes the image space
without an empty placeholder. A pending image does not delay cards. An image
failure leaves cards usable and offers a quiet retry rather than turning the
whole creation into a failure.

### Leaving safely

After the initial transition, the screen says:

> You can leave — we'll keep creating.

Navigation away stops only the detail subscription, never the server-owned
work. Returning by inbox row, notification deep link, or application restart
rehydrates from the persisted creation rather than replaying the animation from
zero.

Animations honor the operating system's reduced-motion preference. In reduced
motion, content uses short opacity transitions with no translation, scale, or
stagger that changes reading order.

## Background Completion and Notifications

### Permission timing

The application does not request notification permission during onboarding or
at first launch solely for this feature. The first time a learner leaves an
active creation, a small in-context explanation offers notifications for ready
material. The operating-system permission prompt appears only after the
learner accepts that explanation.

Declining permission does not repeat the prompt during routine creation. The
inbox and tab badge remain complete alternatives, and settings can expose a
later opt-in path.

### Delivery semantics

Completion after application suspension or termination requires a server-
delivered device notification, not a promise based only on a live local timer.
The mobile client registers an installation token after permission, and the
server associates it with the authenticated user without exposing it through
learner APIs.

The server sends notifications only for states that require attention:

- A deck choice is needed.
- One or more creations are ready to review.

Several close completions are grouped into one message such as "3 creations
are ready to review". The system avoids notifying for an item already open in
the foreground when that state is visible. Delivery is best effort; the inbox
is always authoritative.

Opening a single-item notification deep-links to that creation. A grouped
notification opens the Creation inbox with actionable groups first. Signing
out removes or disassociates the installation token so another account does
not receive stale creation notifications.

## Ready-to-Review Experience

### Content-first hierarchy

A ready creation opens in preview mode, not edit mode. It contains, in order:

1. A large useful image when one exists.
2. The chosen deck and original request as quiet context.
3. Cards rendered with the shared learner-facing presentation semantics.
4. The one dominant action, "Save to [deck name]".

There are no active text fields or switches in preview. Each card displays:

- The natural question or cloze sentence.
- The cloze hint before the answer, including on image-cued cards.
- The answer and optional translation or explanation for inspection.
- The open-vocabulary aspect as secondary metadata.
- A quiet indication when the note image is part of the prompt.

Raw `{{c1::...}}` markup is absent from every learner-facing state, including
partial, invalid, error, and fallback rendering.

### Focused single-card editing

Tapping a card opens a dedicated editor for that card only. The rest of the
set does not remain as a stack of editable fields around it.

The default controls depend on card type:

- A basic card uses learner-facing "Prompt" and "Answer" fields.
- A cloze card uses the structured sentence, hidden answer, hint, and optional
  full meaning defined by the card-and-note specification.

"More options" contains the open "Learning focus" aspect and valid image-cue
policy. It does not contain model settings or raw storage format. Changes use
the shared pure cloze and validation model, while the screen keeps one card and
one completion action in focus.

Removing a card is a quiet menu action, not a full-width destructive button.
"Add card" appears after the card list and opens the same focused editor with a
new blank card. Leaving an invalid editor preserves input and identifies the
specific missing or invalid value.

Manual edits save back to the creation draft automatically after local
validation. The final note is still created only through the explicit set-level
save action.

### Adjust with AI

"Adjust with AI" opens a compact instruction composer for the complete card
set. Suggested instructions may include:

- `Make these simpler`
- `Focus on the Latin translation`
- `Use fewer cards`
- `Add an example`

The request includes the original learning request, selected deck context, and
current card set. It adjusts cards only; changing deck and regenerating are a
separate explicit action, and ordinary adjustment does not silently replace a
useful image.

While adjustment is queued or running, the current set remains readable. The
learner can cancel the adjustment to return immediately to the current version.
Saving waits for adjustment or requires canceling it first, so a late result
cannot mutate an already consumed draft.

After the replacement set validates, it applies atomically and the preview
shows a persistent inline action:

> Cards adjusted · Undo

The server stores exactly one undo snapshot. Undo restores the complete prior
card list, including manual edits, additions, removals, order, aspects, cloze
hints, backs, and image-cue settings. It remains available across navigation
and application restart until the learner makes another manual or AI content
change. That next change deliberately clears the older undo boundary.

### Change deck and regenerate

The chosen deck is visible but quiet. "Change deck and regenerate" is a
secondary action, not an always-visible picker. It explains that deck context
changes the generated material.

Choosing another owned deck keeps the current set visible, enqueues a new
attempt with the new context, and replaces the set only after validation. It
may also create a new suitable image. Failure retains the previous deck and
cards until the learner retries or cancels the change.

## Save, Cancel, and Discard

### Explicit save

Generation never automatically creates a note. "Save to [deck name]" commits
the current reviewed cards atomically, consumes only that creation, and leaves
other inbox items untouched.

On success, navigation returns to the Creation inbox and shows concise
confirmation with a secondary "View note" action. The saved item is removed
from the inbox because the owning deck is now its permanent home.

A save failure leaves the learner on the ready preview with every card and
manual edit intact. Retrying is idempotent and cannot mint two notes from one
creation.

### Picture still pending

A valid card set can be saved while its picture is still rendering. Preview
shows "Picture still being created" without making it the primary message. The
running image attempt transfers ownership to the saved note and attaches only
if it is still current.

An image failure offers "Try picture again" and does not disable "Save to
[deck]". The learner may save a useful note without an image.

### Removing work

Removal language matches state:

- A queued item uses "Remove from queue" and a short recoverable Undo.
- A running item uses "Cancel creation" and confirms that active work will
  stop.
- A ready or manually edited item uses "Discard creation" and confirms that
  the generated cards and unsaved edits will be lost.

Destructive actions live in an item menu or quiet secondary region. They never
compete visually with Create, review, retry, or save.

Canceling invalidates the active attempt before deleting its durable row. Any
late card or media result must detect that invalidation and avoid resurrecting
the creation.

## Errors and Recovery

### Source submission

- Empty or over-limit input is explained beside the composer and never clears
  text.
- Offline or transport failure retains the request locally with a visible
  retry action.
- Retrying uses a stable client request id so an uncertain response cannot
  create duplicates.
- Authentication expiry preserves user-scoped local input through sign-in and
  retries only after the same account resumes.

### Routing and deck decisions

- A routing failure preserves the request and exposes "Try again".
- Invalid or deleted candidate decks cause a refreshed decision instead of a
  raw not-found error.
- New-deck validation is local and server-enforced; failure keeps the proposed
  name and description editable.
- A routing failure never silently assigns a default deck.

### Generation

- A provider, validation, or connection failure preserves every complete,
  valid card from the current attempt.
- If at least one useful card exists, the learner may review, edit, and save
  the partial set or retry generation.
- Retrying keeps the current safe set visible until a complete replacement is
  ready.
- A failed picture is independent and retryable.
- A process restart reclaims or requeues stale active work; the UI never trusts
  a persisted `Creating` label without a current lease.
- Repeated failure produces specific learner-facing recovery copy and logs the
  provider detail only on the server.

### Editing, adjustment, and save

- Client validation belongs to one card and does not block viewing or editing
  other cards.
- Draft revisions prevent a background stream, another device, or a late AI
  adjustment from overwriting newer manual work.
- A revision conflict retains local edits and offers a deliberate refresh; it
  does not silently merge card sets.
- Adjustment failure keeps the previous set and its existing undo boundary.
- Save failure preserves the complete draft and selected deck.
- Session recovery deep-links back to the same creation when possible.

## API and Data Contract

### Creation row

The existing draft concept becomes a multi-row creation resource. Exact column
normalization belongs to the implementation plan, but the durable contract must
represent:

- `id`, `userId`, and stable client request id.
- `sourceText` and creation timestamps.
- Lifecycle state and active-attempt identity.
- Nullable selected `deckId`.
- Stored routing outcome and interpreted learning goal.
- Classification needed by generation and saved notes.
- Persisted complete cards scoped to the current attempt.
- Independent image prompt, attempt, status, and draft image id.
- Learner-safe error category and recovery stage.
- Draft revision.
- One nullable card-set undo snapshot.
- A scheduler claim or lease sufficient to recover stale active work.

Removing the unique constraint on `userId` must preserve ownership indexes and
make list ordering deterministic.

### Procedures

The creation boundary provides operations equivalent to:

- List inbox summaries.
- Get one complete creation.
- Idempotently submit a request.
- Resolve a deck choice or approve a proposed deck.
- Watch inbox summaries.
- Watch one active creation.
- Update one ready draft revision-safely.
- Request or cancel AI adjustment.
- Undo the latest AI adjustment.
- Change deck and regenerate.
- Retry the failed routing, cards, or image stage.
- Cancel or discard one creation.
- Atomically save one creation as a note.

Names may retain the existing `drafts` router to limit churn. Contracts and
behavior, rather than a wholesale namespace rename, are required by this
design.

Every procedure enforces ownership from the authenticated context. List and
watch operations never reveal another user's deck names, source excerpts,
status, cards, or notification routing.

### Save compatibility

The existing note-save behavior remains the persistence boundary but gains
idempotency and revision checks appropriate to multiple drafts. It validates
the complete card set, derives card type, preserves image-job ownership, creates
initial scheduling state, consumes exactly the requested creation, and returns
the saved note and deck identifiers.

Saving one creation cannot invalidate all creation queries by replacing them
with an assumed empty state. Cache updates remove only the consumed id, then
reconcile list, notes, cards, deck, and detail queries.

### Migration and client compatibility

The database migration converts every existing draft in place, preserving its
id, owner, deck, source text, classification, cards, image state, error, and
created time. A ready or failed draft becomes the equivalent creation state. A
generating draft without a live post-deploy claim is recovered through the new
stale-work policy rather than silently discarded.

For one mobile compatibility window, the existing single-draft procedures
remain adapters:

- A legacy start request that already supplies an owned deck bypasses automatic
  routing and retains the old one-at-a-time conflict behavior for that client.
- `drafts.current` returns one deterministic legacy-compatible creation at a
  time; saving or discarding it exposes the next.
- Existing id-based update, watch, retry-image, discard, and note-save calls
  continue to target only the supplied creation.

New-only states such as an unresolved deck choice are never serialized into a
legacy status union. They remain visible only to the new list API until the
learner uses an updated client. Compatibility adapters must not delete, merge,
or reassign inbox items that the legacy client cannot display. Their removal is
a separately versioned cleanup after supported clients have migrated.

## Mobile Component Boundaries

### Create screen

The screen orchestrates the composer, grouped summary list, notification
permission education, and navigation. It does not own generation state for
every row in local reducers. Server summary data and narrowly scoped optimistic
submission state drive the inbox.

Suggested focused boundaries are:

- Request composer and its durable unsent state.
- Inbox group and creation summary row.
- Deck-decision dialog.
- Creation detail screen.
- Honest generation-stage presentation.
- Ready creation preview.
- Focused single-card editor.
- AI-adjustment composer and undo notice.

Exact filenames belong to the implementation plan. The design forbids
replacing one oversized Add screen with one oversized Creation screen.

### Subscription and cache ownership

The inbox uses one summary subscription while visible, with ordinary query
rehydration as the baseline. Only an open detail screen subscribes to rich
per-card events. Background application state does not depend on keeping every
stream alive; persisted rows and device notifications cover that interval.

Events identify both creation id and attempt. Cache handlers ignore stale
attempts and cannot apply one creation's cards, image, errors, or deck choice to
another. Local card editing pauses or isolates applicable background hydration
so refetch cannot replace an unsaved edit model.

## Accessibility and Mobile Ergonomics

- The composer remains usable with the keyboard open, including its Create
  action and validation message.
- Inbox rows are at least 56 px high and the complete row is interactive.
- Group headings, state labels, deck name, and request excerpt have a stable
  reading order.
- Busy, queued, needs-attention, and ready states are conveyed in text and
  accessibility state, not color alone.
- Meaningful generation transitions use polite live-region announcements;
  token deltas and decorative motion are never announced.
- Card entrances do not steal accessibility focus or reorder already-read
  content.
- The generation screen exposes an understandable current state without
  requiring the learner to see animation.
- Reduced motion removes translation, scale, and stagger while retaining state
  changes.
- Notification permission education and the operating-system result are
  accessible and never block creation.
- Deck choices explain their different learning outcomes, not only their
  names.
- Ready preview never presents learning content as disabled form controls.
- The focused editor keeps the active field and Done action reachable above
  the keyboard and safe-area inset.
- All actions provide at least a 48 px practical touch target and tolerate
  enlarged system text.
- Destructive confirmations name the affected request and accurately describe
  whether active work, generated cards, or manual edits will be lost.

## Scope

### In scope

- Natural-language typed and pasted text capture.
- A 2,000-character source limit and durable unsent text.
- AI routing against owned deck names and descriptions.
- Ambiguous choice and confirmed AI-proposed deck creation.
- Deck-aware card and image generation.
- A durable multi-creation inbox and two concurrent generation slots per user.
- Honest animated progress and persisted complete-card reveal.
- Background operation and grouped device notifications.
- Ready-before-save review.
- Content-first preview and focused editing of one card at a time.
- Manual add and remove card behavior within a creation.
- Set-level AI adjustment with one durable Undo.
- Change-deck regeneration.
- Independent retry for routing, cards, image, and save.
- Explicit save, cancel, and discard.
- Accessibility, reduced motion, automated tests, and Android visual QA.

### Out of scope

- Camera, document scanning, image upload, or voice as capture sources.
- A chat transcript or conversational assistant interface.
- Batch parsing one submission into multiple creation jobs.
- User-configurable generation concurrency.
- Unlimited parallel generation.
- Pre-generation deck, card-count, domain, language, model, or image controls.
- Automatic note saving without review.
- Editing or manually replacing the generated image.
- A full Deck Library redesign.
- A full saved-note editor redesign or its later simplification pass.
- Review-session, Today, onboarding, account, or settings redesign beyond the
  notification opt-in needed by this slice.
- Dark mode.

## Testing

### Pure and model-boundary tests

- Request normalization, limits, local persistence, and idempotency keys.
- Routing structured output for confident, ambiguous, and new-deck outcomes.
- Rejection of invented, foreign, stale, or duplicated deck ids.
- Different learning goals and generation prompts for the same request routed
  to language and non-language decks.
- One-to-six-card policy without a visible card-count setting.
- Complete-card projection and validation without partial text exposure.
- Attempt scoping so retries never mix cards or media.
- Draft revision, AI adjustment replacement, and exact Undo restoration.
- Learner-safe cloze projection in every partial and error fallback.

Representative routing and generation eval fixtures include ambiguous examples
such as the same quotation belonging plausibly to a language deck or a subject
deck. Tests must assert that uncertainty becomes a learner choice rather than
an arbitrary match.

### Server and database tests

- Migration permits multiple creations per user without changing existing
  draft contents or ownership.
- Deterministic list grouping and ordering.
- Idempotent simultaneous submissions do not duplicate rows.
- No more than two text-generation claims run for one user under races.
- Multiple users retain independent limits and data.
- An ambiguous item releases its slot and re-enters after resolution.
- Queued work starts after success, failure, ambiguity, or cancellation frees a
  slot.
- Stale claims recover after restart without double completion.
- Complete cards persist incrementally and survive reconnect.
- Cancellation and supersession reject late cards and clean late media.
- Image work does not block the next card-generation slot.
- Partial card failure remains reviewable and retry does not erase it.
- Adjustment and change-deck replacement are atomic.
- Revision conflicts do not overwrite manual edits.
- New-deck proposal confirmation validates and assigns in one safe workflow.
- Save consumes exactly one creation, is idempotent, and preserves other inbox
  rows.
- Saving with a pending image transfers only the current image attempt.
- Notification tokens are ownership-scoped, removed on sign-out, and close
  completions are deduplicated or grouped.

### Mobile component and integration tests

- Empty Create screen focuses the natural-language composer.
- No routine deck, card-count, or image controls are rendered.
- Three rapid submissions clear only acknowledged text and create three
  distinct optimistic rows.
- A submit atomically moves text into the local outbox, clears the composer,
  and retries uncertain transport with the same idempotency key.
- Groups and badge reflect needs-choice, ready, creating, queued, and failed
  data without technical metadata.
- Deck choices explain their different learning outcomes.
- A deck proposal remains editable and requires confirmation.
- Complete cards appear one at a time; partial model text never renders.
- Image-ready, image-pending, image-absent, and image-failed layouts retain
  stable hierarchy.
- Leaving and reopening a creation restores persisted progress.
- Ready preview renders no always-on text fields or disabled switches.
- Only one card is editable at a time and raw cloze syntax never appears.
- Manual edit, add, remove, validation, autosave, and revision conflict preserve
  content.
- AI adjustment keeps current cards visible, applies atomically, and exposes
  exact Undo until the next mutation.
- Save success removes only the saved row and offers View note.
- Save, retry, cancellation, and discard failures keep recoverable context.
- Notification education appears just in time, respects denial, groups ready
  work, and deep-links correctly.
- Accessibility roles, names, state, reading order, focus restoration, live
  announcements, and reduced-motion behavior are explicit.

### Android visual and device verification

Record pass/fail evidence and screenshots for:

- Empty inbox and first request.
- Three quick submissions with two creating and one queued.
- Needs-choice candidates and an editable new-deck proposal.
- A short request and a near-limit multiline request with the keyboard open.
- First complete card reveal, multiple card reveals, and a prominent image.
- No-image, slow-image, and failed-image layouts.
- Leaving for another tab, backgrounding the app, terminating and reopening
  the app, and returning through a notification.
- Notification permission acceptance and denial.
- One and many ready creations.
- Basic and cloze preview with visible hint and image cue.
- Focused edit, Add card, Remove card, Adjust with AI, Undo, and change-deck
  regeneration.
- Offline submission, routing failure, partial generation failure, retry, save
  failure, and session renewal.
- Enlarged text, screen reader traversal, reduced motion, Android system Back,
  and gesture navigation.

After focused tests, implementation must pass:

```bash
bun run check
bun run test
git diff --check
```

Native notification configuration requires a rebuilt Android application;
JavaScript-only Expo Go or hot-reload evidence is insufficient for final
acceptance.

## Acceptance Criteria

The slice is complete when:

- A learner can submit at least three different requests in quick succession
  without waiting for the first generation.
- The inbox immediately and durably represents each accepted request.
- At most two card generations run concurrently per learner and queued work
  advances without client orchestration.
- AI selects a deck when the choice is clear, asks when it is not, and proposes
  but never silently creates a missing deck.
- The selected deck changes the learning goal and generated material.
- Generation feels active through real content and stage transitions without
  fake progress or partial text.
- A useful image is visually primary, while cloze hints remain visible.
- The learner may safely leave, restart the app, and return to current work.
- Notifications are contextual, grouped, optional, and never the source of
  truth.
- Generated material remains a draft until explicit review and save.
- Ready cards look like learning content, and editing focuses on one card at a
  time.
- AI adjustment cannot destroy the prior card set because exact Undo remains
  available until the next change.
- Routing, generation, image, network, validation, authentication, and save
  failures preserve the learner's recoverable work.
- Saving or discarding one creation does not disturb any other queue item.
- Raw cloze markup and provider terminology are absent from all learner-facing
  states.
- Automated checks and Android device QA record evidence for functionality,
  accessibility, motion, background behavior, and visual quality.
