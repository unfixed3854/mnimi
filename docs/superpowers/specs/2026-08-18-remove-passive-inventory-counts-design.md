# Remove Passive Inventory Counts

## Goal

Remove low-value, detached inventory totals that make the mobile interface feel
raw, while retaining counts that help a learner decide what to do or understand
their progress.

## Scope

The mobile client will remove trailing numeric `SectionHeader` details from:

- **Deck list:** `Your decks`
- **Deck detail:** `Notes`
- **Note detail:** `Cards`

The list itself remains the inventory representation. Existing loading, error,
and empty states continue to communicate whether content is available.

## Retained Counts

Keep counts that have immediate decision-making or progress value:

- Today’s number of due cards and its `card(s) due` label.
- The deck-detail review call to action, including the number due.
- The active review header’s remaining-card count.

## Behavior and Accessibility

This is presentation-only. It does not change data fetching, list rendering,
navigation, review behavior, empty states, or accessible names/roles. The
shared `SectionHeader` continues to support details for future uses; these
screens simply stop supplying passive totals.

## Verification

Update focused screen tests to assert that the three passive totals are absent
and that useful review/due counts remain. Run the mobile test suite, the
repository test task, formatting/type/build checks available through Deno, and
`git diff --check`.
