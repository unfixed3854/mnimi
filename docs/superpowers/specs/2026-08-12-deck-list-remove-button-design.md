# Deck List Remove Button Design

## Goal

Keep deck removal available on the deck details page, but remove the trash
icon/remove button from the `/decks` list page.

## UI behavior

The deck list continues to render each deck name as a link to its details page.
List rows no longer render `DeckRemoveDialog` or any delete trigger. The deck
details page keeps its existing labeled `Delete deck` action, confirmation
dialog, mutation, error handling, and navigation behavior unchanged.

## Implementation

Modify `src/routes/_authed.decks.index.tsx` to remove the list-only
`DeckRemoveDialog` and `Trash2` imports and the action rendered beside each
deck link. No shared dialog, API, server, or detail-route code changes are
needed.

## Testing and verification

Update `src/routes/-_authed.decks.test.tsx` so the list test verifies that deck
rows still render and link correctly but expose no `Delete <deck name>`
buttons. Existing detail-route tests remain as regression coverage for the
retained delete action and successful navigation.

Run the focused route tests with Deno, followed by the project build. All
package management and scripts use Deno per `AGENTS.md`.
