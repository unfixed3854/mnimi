# Deck Removal Redirect Design

## Goal

After a user successfully deletes a deck from its detail page, navigate to the
deck list at `/decks` instead of allowing the detail route to render its
missing-deck state. Replace the deleted detail route in browser history so the
Back action cannot reopen it.

## Root cause

`DeckRemoveDialog` currently waits for `useRemoveDeck().mutateAsync()` to
resolve before calling its `onRemoved` callback. The mutation's success handler
awaits invalidation and refetching of the deck query. That refetch can remove
the current deck from the route's data before `mutateAsync()` resolves, causing
the still-mounted detail route to render "This deck no longer exists" before
navigation occurs.

## Client behavior

Extend `useRemoveDeck` with an optional success callback. Its mutation success
handler will await that callback before invalidating deck-related queries.
`DeckRemoveDialog` will supply its existing `onRemoved` callback to the hook
instead of invoking it after `mutateAsync()` resolves.

On the deck detail route, `onRemoved` will navigate to `/decks` with history
replacement enabled. The resulting success sequence is:

1. The server confirms the deck was deleted.
2. The detail route navigates to `/decks` and replaces its history entry.
3. Deck, note, card, and draft queries are invalidated.
4. The dialog's submission completes.

Deletion failures continue to leave the dialog open, display the error, and
avoid navigation. Direct visits to stale or externally deleted deck URLs retain
the existing missing-deck explanation; only a successful user-initiated
deletion triggers this redirect.

## Testing

Add regression coverage proving that:

- the removal success callback completes before deck-query invalidation begins;
- the deck detail route requests navigation to `/decks` with history
  replacement;
- a failed deletion does not invoke the success callback or navigate; and
- existing cache invalidation and dialog behavior remain intact.

All package management, scripts, route generation, and test commands use Deno.
