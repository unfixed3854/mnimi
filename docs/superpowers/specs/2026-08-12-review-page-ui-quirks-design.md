# Review Page UI Quirks Design

## Goal

Fix issue #37 so each review transition shows only the active card in its
unrevealed state, review cards no longer have an amber glow, and the
pronunciation action has clear separation from the card above it.

## Root Cause

The review route stores answer visibility as a card-independent boolean. A
successful grade invalidates and refetches the due-card query before the
awaiting click handler clears that boolean. The refetch can therefore replace
`cards[0]` while `revealed` is still true, leaking the previous card's UI state
into the newly active card.

The glow is not a browser or webview artifact. Both ordinary and image-cued
review cards explicitly replace the standard card ring with a primary-colored
box shadow. The pronunciation control has no review-specific top margin, so it
sits directly against a revealed image-cued card.

## Design

Keep the review queue server-backed and continue treating `cards[0]` as the
active card. Replace the shared reveal boolean with the ID of the revealed
card. Derive visibility by comparing that ID with the current card ID. When a
query refetch advances the queue, the comparison becomes false immediately,
even if the grade mutation has not settled yet.

Key the complete card interaction subtree by the current card ID. This makes
the replacement boundary explicit and ensures all card-local controls and DOM
are discarded together. Clear the revealed-card ID after a successful grade.
On failure, leave it unchanged so the same revealed card and rating actions
remain available for retry.

Remove the custom primary-colored shadow and `ring-0` override from prompt
cards, allowing the shared `Card` component's subtle ring to provide surface
separation. Keep the existing accent treatment for the ordinary card's answer
surface. Add review-only top spacing around `PronunciationControl`; do not
change the reusable control itself because note-detail pages have their own
layout spacing.

## Data and Error Flow

1. Revealing a card records its ID.
2. Grading sends the existing atomic grade mutation.
3. Query invalidation may replace the active card before the mutation promise
   resolves; the new ID no longer matches, so the new card remains hidden.
4. Success clears the recorded ID.
5. Failure retains the current ID and existing error message, allowing retry
   without losing context.

No server, schema, scheduling, or query-cache behavior changes.

## Testing

Add a route regression test that reveals the first card, starts grading, then
changes the mocked query result while the grade promise is unresolved. Assert
that the second card is unrevealed, the first card's content and pronunciation
control are gone, and only one prompt card remains.

Add focused DOM/class assertions that ordinary and image-cued prompt cards no
longer carry the primary-colored shadow and that the review-page pronunciation
control has the intended top spacing. Run targeted route and component tests,
then the complete test and build tasks using `deno`.

## Scope

This change is limited to review presentation state, review-card styling, and
review-only spacing. It does not introduce optimistic queue updates, change
pronunciation behavior, alter card scheduling, or redesign other pages.
