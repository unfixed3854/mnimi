# Cloze cards

A card stops being a pair of dictionary entries and becomes a sentence with a
hole in it. `die Banane → banan` teaches a mapping between two lookup results;
`Ich mag {{c1::Bananen::banany}} zum Frühstück.` teaches the word where it is
actually used, which is where it will have to be recalled.

Closes [#10](https://github.com/unfixed3854/mnimi/issues/10).

## Problem

The cards the generator writes are correct and pedagogically weak. `LANGUAGE_PACK`
in `server/ai/rule-packs.ts` mandates the isolated pair directly:

```
- Generate recognition and production as separate cards. Recognition goes
  from the target language to the learner's language; production goes the
  other way.
```

So the shape the issue complains about is not the model drifting — it is the
prompt working as written. A word learned in isolation is recalled in
isolation: it surfaces when you are translating and fails to surface when you
are speaking, because nothing ever bound it to a syntactic frame, a collocation,
or a register.

`docs/OUT-OF-SCOPE.md` deferred this twice, as §1.1 (cloze) and §1.3 (example
sentences), on two grounds: that cloze is a different card *shape* the
`front`/`back` pair cannot express, and that generated sentences multiply the
vetting burden on the review-and-edit screen. That document has been deleted as
part of this change — the deferral is being reversed deliberately, not
forgotten. The first objection is answered below by making the shape explicit
rather than implicit. The second is accepted as a real cost.

## Approach

Cloze **replaces** the isolated pair rather than supplementing it, and applies
to every domain rather than only to language notes.

Replacing rather than supplementing is the pedagogical call: context-first is
the better-supported practice, and keeping a recognition card alongside every
cloze would grow `die Banane` from four cards to five while re-teaching the
isolation the change exists to remove. The obvious objection — that a cloze
tests something the learner was never shown — is answered by the inline hint,
not by a second card. `Ich mag [banany] zum Frühstück.` is answerable on first
exposure, and new cards run through FSRS learning steps anyway, where an early
lapse is expected and cheap.

Applying it to every domain follows from the same reasoning: nothing about
context-aids-encoding is specific to vocabulary. `Poseidon's Roman counterpart
is {{c1::Neptune}}` is a better card than `Poseidon's Roman counterpart →
Neptune` for the same reason the German one is.

## The markup

Anki-compatible, one deletion per card:

```
Ich mag {{c1::Bananen::banany}} zum Frühstück.
Ich mag {{c1::Bananen}} zum Frühstück.          # hint optional
```

The hint lives **inside** the braces rather than trailing the sentence, so it
renders at the point of retrieval — the blank carries its own signal about what
is wanted, instead of the reader's eye leaving the sentence to find it.

One deletion per card, not several per shared sentence. Under a design where
cloze replaces the pair, a note's cards want *different* sentences anyway — the
gender card and the plural card are not the same sentence masked twice — so
multi-deletion siblings buy nothing here and would drag in sibling burying,
which this codebase has no notion of.

There is no escape mechanism. A sentence containing a literal `::` or `}}` is
not supported. This is a documented limitation, not an oversight: the escaping
grammar costs more than the case is worth, and the validation refinement below
rejects the ambiguous input rather than silently mis-parsing it.

## `@mnimi/shared`

The parser is needed by the server, to validate, and by the browser, to render.
It cannot live in `server/`: `src/lib/server-boundary.test.ts` enforces that
client code names server *types* and nothing else, and that rule is load-bearing
— one value import from `~server/db/schema` was measured taking a client chunk
from 1.02 kB to 27.51 kB.

So it becomes a third Deno workspace member alongside `./server`:

```jsonc
// shared/deno.json
{ "name": "@mnimi/shared", "version": "0.1.0", "exports": { ".": "./cloze.ts" } }
```

added to the root `deno.json` `workspace` array, with one alias each in
`vite.config.ts`, `vitest.config.ts` and `tsconfig.json` so the browser build
resolves the same specifier. The boundary test needs no change, because
`@mnimi/shared` is not `~server/…`.

**The package is pure logic with zero dependencies.** No React, no JSX, no
imports from `src/`, an empty `imports` map. It exports functions returning
plain data; each consumer decides what to do with that. The constraint enforces
itself rather than relying on review: the server imports this package and is
type-checked by `deno task check:api`, which has no React types available, so a
stray UI import fails CI as a type error.

Two exports, because validation and streaming need different tolerances:

- `parseCloze(text)` — strict. Returns `{ before, answer, hint, after }` for
  exactly one well-formed deletion, or `null`. This is what decides whether a
  card is cloze and whether saved input is legal.
- `parseClozePartial(text)` — lenient, for text still arriving from the model.
  A truncated `Ich mag {{c1::Ban` renders as its readable prefix instead of
  flashing brace noise across the streaming list.

## Storage

`cards` gains one column:

```
card_type text not null default 'basic'    -- 'basic' | 'cloze'
```

Existing rows become `basic` with no backfill, and no existing card is
regenerated.

**`card_type` is derived server-side from the markup, never requested from the
model.** Asking the model for it creates a state the schema cannot forbid: a
card claiming `basic` while containing braces, or claiming `cloze` with nothing
deleted. Deriving it makes those unrepresentable. The column is still
authoritative for every reader; it is simply computed once, at insert.

`back` becomes **nullable**, which in SQLite means Drizzle recreates the table.
For a cloze card the answer is inside `front`, so a `back` holding the answer
would be duplication — two fields to edit and two to disagree. The reveal is
derived: the same sentence with the deletion resolved.

The `drafts` table needs no change. It stores cards as JSON, and a draft card's
`front` simply carries the markup like any other string; `card_type` is derived
at `notes.save`, which is the only point where a card becomes a scheduled row.

`back` is not dead for cloze rows, though. It carries the sentence's *meaning*
where one applies — `Lubię banany na śniadanie.` — rendered under the resolved
sentence as secondary text rather than as "the answer". Without it a learner can
reveal a sentence that confirms the word and still not parse the sentence, and
context nobody can parse is not yet context. It is null for non-language notes,
where there is no analogue.

## Generation

`BASE_PACK` gains the cloze rules, since cloze now applies to every domain:
prefer testing a fact inside a sentence that shows it in use; exactly one
deletion per card; the surrounding sentence must make the answer inferable in
principle rather than guessable by shape; supply a native-language hint whenever
the blank would otherwise admit several answers.

`LANGUAGE_PACK` changes most, because it is where the isolated pair was
mandated. The recognition/production rule is replaced by cloze-in-context.
Gender becomes an article deletion (`{{c1::Die}} Banane ist gelb.`); plural
becomes a sentence that forces it (`Ich habe zwei {{c1::Bananen}}.`). The image
rule is untouched — the picture still depicts the referent and still must
contain no text.

`generatedCardSchema` gains a refinement: if `front` contains `{{`, it must
parse under `parseCloze` with a non-empty answer. This rides the existing
one-retry loop in `server/ai/generate.ts` at no cost — a malformed deletion
produces a Zod issue, and `validationFeedback` already feeds the issue list back
to the model verbatim for correction.

## Rendering

`src/components/cloze-text.tsx` is the only place segments become JSX, and every
display site goes through it.

- **Review front** (`_authed.review.$deckId.tsx:137`) — `Ich mag [banany] zum
  Frühstück.`, the hint in muted italic brackets, a plain rule where there is no
  hint. Basic cards render as today.
- **Review reveal** (line 151) — the resolved sentence with the answer
  emphasized in the accent colour, `back` beneath it as secondary text when
  present, then the image. The image `alt` currently reads `card.back`
  (line 160); for a cloze row it must be the answer instead.
- **Note detail** (`_authed.notes.$noteId.tsx:116`) — resolved, answer
  emphasized. A browse view is not a test, so nothing is hidden.
- **Streaming** (`streaming-cards.tsx:32`) — `parseClozePartial`, and the back
  row appears only once there is a back.

## Editing

`CardEditor` keeps `front` as a raw `<Input>` showing the markup, with the
rendered preview directly beneath it, through the same component the review
screen uses. Raw-plus-preview rather than select-text-to-mark: the preview costs
almost nothing on top of a renderer that has to exist anyway, and it makes
malformed markup visible *before* a card is saved and scheduled. A
selection-based editor is a worthwhile follow-up and needs no schema change.

Because the hint moved inline, it becomes editable for the first time — today
`hint` is generated and has no editor field at all.

`isSavable` (`src/lib/draft-state.ts:207`) currently requires a non-empty back
on every card. It becomes: front non-empty, and a back required only for basic
cards. The copy at `_authed.add.tsx:362` is reworded to match, and the save
mutation at line 387 sends `null` rather than `""` for an empty back. The
hand-editable fallback card at `src/lib/draft-state.ts:69` — the one a failed
generation leaves behind — stays basic, with its `back` now `null` instead of
`""`.

`server/router/notes.ts:16-25` mirrors it: `back` nullable, `front` refined
against `parseCloze`, `card_type` derived. That refinement is the real guard —
a user can hand-type `{{c1::}}` in the editor, and this is where it is rejected
rather than persisted as a card that renders an empty blank forever.

## Testing

`vitest.config.ts` needs `shared/**/*.test.ts` added to `include`; the current
globs cover only `src/` and `server/`, so tests in the new package would
silently not run.

- `shared/cloze.test.ts` — strict parse with and without a hint; malformed
  forms (`{{c1::}}`, unclosed, two deletions); text with no markup; and the
  lenient parse against truncation at each boundary.
- `server/ai/rule-packs.test.ts` — existing pack-selection assertions still
  hold; new ones covering the cloze rules in the base pack.
- `server/router/notes.test.ts` — a cloze card persists as `card_type: 'cloze'`
  with a null back; malformed markup is rejected; a basic card is unchanged.
- Component tests for the review reveal and the editor preview, alongside the
  existing `_authed.add.test.tsx`.

## Out of scope

Multi-deletion siblings from one sentence, sibling burying, select-text-to-mark
editing, and regenerating existing cards — they stay `basic` and keep working.
