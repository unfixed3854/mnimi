# Deck Removal Design

## Goal

Allow an authenticated user to permanently remove one of their decks from
either the deck list or the deck detail screen. Removal includes the deck's
notes, cards, review history, and any active draft associated with the deck.

## Server behavior

Add `decks.remove` with input `{ deckId: string }`. The procedure validates the
identifier and deletes the row only when both its id and `userId` match the
authenticated session. A missing deck and a deck owned by another user both
produce `NOT_FOUND`, so the endpoint does not disclose another user's data.

The existing foreign keys cascade from deck to notes and drafts, from notes to
cards, and from cards to review logs. A single deck deletion therefore removes
all related database state atomically. Tests will verify the complete cascade,
including an active draft, rather than assuming that the schema declarations
are sufficient.

Generated image and audio files are outside the database transaction. The
procedure will collect their paths before deleting the deck, commit the database
deletion, and then make a best-effort attempt to remove those now-unreferenced
files. A missing file or cleanup failure must not turn an already-committed
deletion into a reported failure; cleanup failures are logged for diagnosis.

## Client API and cache behavior

Add `useRemoveDeck`, backed by the new mutation. Successful removal invalidates
the decks query and every query below the removed deck's cache namespace (notes,
due counts, and due cards). The list flow remains on `/decks`, where invalidation
causes the deleted row to disappear. The detail flow navigates to `/decks` after
the mutation succeeds.

## User interface

Create one shared deck-removal control/dialog and use it in both locations:

- Each deck-list row gets a compact destructive action with an accessible label
  containing the deck name. Activating it does not activate the row link.
- The detail screen gets a labeled `Delete deck` destructive action.
- Either action opens the same confirmation dialog. The title names the deck,
  and the copy explicitly says that its notes, cards, review history, and active
  draft will be permanently deleted and cannot be recovered.
- Cancel closes the dialog without mutation. Confirm starts removal, remains
  disabled while pending, and prevents duplicate submissions.
- On failure, the dialog stays open and displays a recoverable error. The deck
  remains visible and no navigation occurs.

The compact list action and detail action may differ visually, but confirmation,
pending state, mutation handling, and error rendering live in the shared unit.

## Testing

Server tests will establish that:

- a user can remove their own deck;
- notes, cards, review logs, and an active draft cascade away;
- a user cannot remove another user's deck;
- missing and foreign-owned ids have the same `NOT_FOUND` result;
- media cleanup receives only paths belonging to the removed deck and cleanup
  failure does not reverse or misreport the database deletion.

Client tests will establish that:

- both list and detail controls open the confirmation dialog;
- cancellation makes no request;
- list-action clicks do not navigate into the deck;
- confirmation submits only once while pending;
- list deletion removes the row after cache refresh;
- detail deletion navigates to `/decks` only after success;
- failures remain visible and allow retry.

All package management, scripts, route generation, and test commands use Deno,
as required by the repository instructions.
