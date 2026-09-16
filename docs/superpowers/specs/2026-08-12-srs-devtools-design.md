# SRS Devtools Design

## Purpose

Make repeated review-flow testing practical without recreating cards. In a
development build, an authenticated developer can reset the SRS state for all
their cards, one deck, or one card. Production builds expose neither the
devtools shell nor a working reset operation.

## User experience

TanStack Devtools supplies the floating trigger and dockable panel shell. Mnimi
registers one product-owned plugin named **SRS**. It is a tool overlay, not an
application route or a normal navigation destination.

The SRS panel contains a scope selector with three choices:

- **All cards** targets every card owned by the signed-in user.
- **Deck** reveals a deck selector and targets cards in that deck.
- **Card** reveals a deck selector followed by a card selector. Selecting the
  deck first keeps the card list small and gives otherwise similar cards useful
  context. Each card option identifies the card by its aspect and a truncated
  front; the full card id remains available as secondary text.

The panel loads development-only summary data containing the user's decks,
cards, and the number of cards affected by the current selection. Empty scopes
disable the reset action and explain that there is nothing to reset. Loading
and request failures remain visible inside the panel.

Pressing **Reset SRS state** opens a confirmation that names the scope and exact
affected-card count. Confirmation runs the reset and reports the returned count.
The panel then refreshes its summary, and the application invalidates card and
deck-related queries so due counts and active review queues update immediately.
Cancelling makes no change.

## Reset semantics

Every targeted card is restored to the same persisted FSRS scheduling state as
a newly saved card:

- `due`: the reset operation's current time
- `stability`: `0`
- `difficulty`: `0`
- `elapsedDays`: `0`
- `scheduledDays`: `0`
- `learningSteps`: `0`
- `reps`: `0`
- `lapses`: `0`
- `state`: FSRS `New` (`0`)
- `lastReview`: `null`

All review-log rows belonging to the targeted cards are deleted. The card
updates and log deletion occur in one write-locked database transaction, so a
partial reset cannot be observed.

The operation preserves card and note content, deck membership, images, audio,
generation metadata, and suspension. A suspended card is reset but remains
suspended and therefore does not become due until separately unsuspended.

## Client architecture

Add `@tanstack/react-devtools` and `@tanstack/devtools-vite` as development
dependencies using Deno. The Vite integration is registered before the existing
plugins and retains its default production-removal behavior.

A small `MnimiDevtools` component owns all TanStack Devtools integration. It
registers an `SrsDevtoolsPanel` as a custom plugin and is mounted beside the
router provider at the application root. Keeping the alpha package behind this
boundary limits churn if its API changes or the shell is replaced.

The panel uses React Query and the existing oRPC client directly. An event
client is deliberately omitted: the current feature performs ordinary queries
and mutations and does not need a live event stream. TanStack-specific concerns
do not enter SRS reset logic or normal application components.

The component is guarded by `import.meta.env.DEV` in addition to production
stripping. This makes its intended lifecycle explicit during tests and in case
the build plugin's defaults change.

## Server architecture and development gate

Add an authenticated `debug` router with two procedures:

- `summary` returns only the signed-in user's deck/card choices and counts
  required by the panel.
- `resetSrs` accepts a discriminated union: `{ scope: "all" }`,
  `{ scope: "deck", deckId }`, or `{ scope: "card", cardId }`. It returns the
  number of reset cards.

The server gate is independent of the browser build. `deno task dev:api`
launches `server/main.ts` with an explicit devtools argument; normal
`deno task start` does not. The enabled value is passed through application and
router construction rather than read implicitly throughout the codebase.
Both debug procedures reject requests when the flag is disabled. This means a
production client cannot activate the operation by constructing an RPC call
manually.

Authentication and ownership checks are mandatory even in development. Deck
and card scopes are constrained in SQL by the current `userId`. A nonexistent
or other user's selection behaves as an empty target and returns a reset count
of zero, without revealing whether the identifier exists.

The reset timestamp is captured once per request so every targeted card receives
the same `due` value. The targeted card IDs determine both the update and the
review-log deletion within the same transaction.

## Error handling and safety

- The destructive action always requires explicit confirmation.
- The UI cannot submit deck or card scope without a selected identifier.
- Pending mutations disable repeated submissions.
- Server-side validation rejects malformed scope payloads.
- Disabled debug procedures return a clear forbidden/not-found-style oRPC error
  without leaking development data.
- Database errors roll back both scheduling changes and review-log deletion and
  remain visible in the panel.
- Resets never broaden beyond the authenticated user's rows, even when supplied
  an identifier belonging to another user.

## Testing

Implementation follows test-driven development.

Server tests use the real temporary SQLite database to prove:

- all, deck, and card scopes reset exactly the intended owned cards;
- reset fields match a newly created FSRS card and share one due timestamp;
- matching review logs are deleted while unrelated logs remain;
- suspension and non-SRS card data are preserved;
- other users' rows cannot be read or reset;
- an unknown identifier resets zero cards;
- reset and log deletion roll back together on a database failure;
- both procedures reject calls when devtools are disabled.

Component tests prove:

- all/deck/card controls reveal the correct selectors;
- card choices are filtered by the chosen deck;
- empty or incomplete scopes cannot be submitted;
- confirmation includes the scope and affected count;
- cancellation performs no mutation;
- success and error feedback are rendered;
- successful reset refreshes debug summary and application card/deck queries.

Build verification runs the production build and checks that the TanStack
Devtools component and custom SRS panel are absent from output, in addition to
the complete test and type-check suites.

## Scope boundaries

This first plugin resets SRS state only. It does not edit individual FSRS
values, unsuspend cards, replay review history, seed cards, expose arbitrary
database access, or add live runtime inspection. The custom-plugin boundary
allows those tools to be added later without expanding this implementation.
