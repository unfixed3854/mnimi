# mnimi — AI-assisted flashcards, draft design

**Date:** 2026-07-27
**Status:** approved, pending implementation plan

## 1. Purpose

mnimi captures a thing you want to remember and turns it into a set of well-formed
flashcards, then schedules them with FSRS.

The motivating case is vocabulary. You type `die Banane` — in German, in English, or in
your native Polish — and the app produces an image of the fruit plus several cards, each
testing a different aspect of the word: its meaning, its production from your native
language, its gender, its plural.

The app is not a language app. The same capture flow has to work for a character from a
novel and their relationships, the Roman name of a Greek god, a physics concept, or a
Latin phrase. Language learning gets *extra* rules because it is the highest-volume case
and its best practices are well established, but those rules must not leak into domains
where they make no sense.

Primary platform is Android. Desktop falls out of the same codebase for free.

## 2. Scope

This document specifies a **base draft**: an end-to-end vertical slice where a real user
signs in, captures a note, gets AI-generated cards with an image, and reviews them on an
FSRS schedule.

Deliberate exclusions are recorded in `docs/OUT-OF-SCOPE.md`, which the draft must ship
alongside the code. That document is a first-class deliverable, not an afterthought — its
purpose is to record decisions once so they need not be re-explained.

## 3. Stack

| Concern | Choice |
|---|---|
| Shell | Tauri v2 (existing scaffold), Android target |
| UI | React 19, Vite, TypeScript |
| Routing | `@tanstack/react-router`, file-based |
| Forms | `@tanstack/react-form` |
| Server state | `@tanstack/react-query` |
| AI | `@tanstack/ai` against OpenRouter |
| Styling | Tailwind v4 + shadcn/ui |
| Scheduling | `ts-fsrs` |
| Backend | Supabase — Auth, Postgres, Storage, Edge Functions |

## 4. Local development ports

Supabase's defaults collide with other local stacks. `project_id = "mnimi"` namespaces the
Docker containers, and every port moves to a private 553xx block.

| Service | Supabase default | mnimi |
|---|---|---|
| API gateway | 54321 | 55321 |
| Postgres | 54322 | 55322 |
| Studio | 54323 | 55323 |
| Inbucket (mail catcher) | 54324 | 55324 |
| Analytics | 54327 | 55327 |
| Connection pooler | 54329 | 55329 |
| Shadow database | 54320 | 55320 |

Implementation must confirm the exact `config.toml` keys against the installed CLI version
rather than assuming; the table above specifies intent, not key names.

**Container runtime.** This machine has no Docker. Podman 5.8.4 is installed, so every
`supabase` invocation needs `DOCKER_HOST` pointed at the podman socket. Likewise
`supabase`, `deno`, `java` and the Android SDK are installed through mise rather than on
`PATH`, and the system Java is 25 while Gradle needs 17 — so the project pins its own
toolchain in `mise.toml`.

## 5. Architecture

```
┌─────────────────────────────┐
│  Tauri WebView (Android)    │
│  React + TanStack Router    │
│  ts-fsrs computes schedule  │
└──────────┬──────────────────┘
           │ supabase-js, user JWT
           │
    ┌──────┴───────────────────────────┐
    │                                  │
┌───▼──────────────┐      ┌────────────▼──────────────┐
│ Postgres + RLS   │      │ Edge Functions (Deno)     │
│ notes, cards,    │      │  generate-note            │
│ review_logs      │      │  generate-image           │
└──────────────────┘      └────────────┬──────────────┘
┌──────────────────┐                   │ OPENROUTER_API_KEY
│ Storage: images  │◄──────────────────┤ (Supabase secret)
└──────────────────┘                   ▼
                                   OpenRouter
```

The OpenRouter key never reaches the device. The client calls Edge Functions with its
Supabase JWT; the function verifies the caller and holds the key server-side. This also
means prompts and rule packs can change without shipping a new APK.

Data is **online-only**. Supabase Postgres is the single source of truth; there is no local
database and no sync layer. This is a deliberate draft simplification — see
`OUT-OF-SCOPE.md` for the offline-first migration path.

### FSRS placement

Scheduling is computed client-side by `ts-fsrs` and the resulting state is written back to
Postgres. The database stores state; it does not compute it. This keeps the draft free of
a Postgres FSRS port and matches how `ts-fsrs` is designed to be used.

## 6. Data model

```
profiles
  id              uuid pk → auth.users(id)
  native_language text        -- e.g. 'pl'
  ui_language     text
  created_at      timestamptz

decks
  id, user_id, name, description, created_at

notes
  id          uuid pk
  user_id     uuid
  deck_id     uuid
  source_text text        -- exactly what the user typed
  domain      text        -- classifier output: 'language' | 'concept' | ...
  language    text        -- target language, null for non-language notes
  metadata    jsonb       -- domain-specific extras (part of speech, article, ...)
  image_path  text        -- Storage object path, nullable
  created_at  timestamptz

cards
  id          uuid pk
  note_id     uuid
  user_id     uuid        -- denormalised so RLS needs no join
  aspect      text        -- open vocabulary: 'meaning', 'gender', 'plural', ...
  front, back text
  hint        text        -- nullable
  suspended   boolean
  -- inline FSRS state
  due, stability, difficulty, elapsed_days, scheduled_days,
  learning_steps, reps, lapses, state, last_review

review_logs
  id, card_id, user_id, rating, state, due, stability, difficulty,
  elapsed_days, last_elapsed_days, scheduled_days, learning_steps, review
```

`learning_steps` appears on both tables because `ts-fsrs` v5 carries it on `Card` and
`ReviewLog` alike. Omitting it silently breaks state round-tripping.

Three decisions worth stating explicitly:

**The note owns the image.** An image depicts the concept, so every card generated from
`die Banane` shares one banana picture. Attaching images to cards would duplicate storage
and break the association the image exists to create.

**FSRS state is inline on `cards`.** The due query — "give me this deck's due cards" — is
the hottest query in the app and becomes a single index scan on `(user_id, due)`.

**`review_logs` is append-only and complete.** It mirrors the full `ts-fsrs` `ReviewLog`
shape even though the draft never reads it back, because the FSRS optimizer needs genuine
review history to retrain parameters, and history not captured from day one cannot be
reconstructed.

**`user_id` is denormalised onto `cards`** so RLS policies are `user_id = auth.uid()`
everywhere with no joins. RLS is enabled on every table.

## 7. Generation pipeline

### Rule packs

Card quality is governed by composable **rule packs** — markdown constants in the repo,
injected into the generation prompt.

- `base` — always loaded. Minimum information principle, one fact per card, no
  ambiguous prompts, no cards answerable by elimination.
- `language` — loaded only when the classifier reports a language note. Covers
  recognition vs production as separate cards, grammatical gender as its own card,
  inflection cards, and the rule that images bind to the *referent*, never to a
  translation.

Progressive disclosure is the point: a note about Poseidon or entropy is generated under
`base` alone and is never forced into vocabulary-shaped cards.

Adding a domain pack later is a new file plus a classifier label. It is not a schema
change and not a migration.

### `generate-note`

Input `{ text, deckId, nativeLanguage }`, two passes:

1. **Classify** — cheap model returns `{ domain, language, partOfSpeech }`. This selects
   the rule packs.
2. **Generate** — structured output against a Zod schema, returning aspect-tagged cards
   and an image prompt.

Output is returned to the client and **nothing is persisted yet**.

### `generate-image`

Input `{ noteId, prompt }`. Calls an OpenRouter image model
(`google/gemini-2.5-flash-image`), uploads the result to a per-user Storage bucket, and
returns the object path. Image prompts describe the referent — a banana — never text in
any language.

### Capture flow

Capture → generate → **review and edit** → save. The user always sees generated cards on
an editable screen before anything is written. Individual cards can be edited, deleted or
regenerated. Nothing auto-commits: AI output is a draft proposal, not a fait accompli.

## 8. Error handling

The AI boundary is where this app will actually break.

- **Malformed structured output.** Parsed through Zod. On failure, retry once with the
  validation error fed back to the model. On a second failure, present the capture screen
  with an empty editable card so the user can hand-write it. The user is never stuck.
- **Image generation failure.** Independent of card generation and non-fatal. A note with
  no image is valid; the note screen offers a retry.
- **Connection loss.** Because the draft is online-only, a dropped connection during a
  review session shows an explicit reconnecting state and blocks further grading rather
  than accepting reviews it cannot persist. Silently discarding a review is worse than
  refusing it.
- **Edge Function auth failure.** Expired JWT triggers a refresh via supabase-js and one
  retry, then routes to login.

## 9. Testing

Vitest over the pure logic, which is where correctness actually lives:

- FSRS state ↔ database row mapping, round-tripped in both directions.
- Rule-pack selection from classifier output, including the case where a language note
  must load `base` + `language` and a concept note must load `base` alone.
- Zod parsing of realistic-but-malformed AI responses, including the retry path.

No device E2E and no Supabase integration tests in the draft.

## 10. Screens

| Route | Purpose |
|---|---|
| `/login` | Email + password auth |
| `/` | Today: due count, entry point to review |
| `/decks`, `/decks/$deckId` | Deck list and contents |
| `/add` | Capture → generate → edit → save |
| `/review/$deckId` | FSRS session, Again / Hard / Good / Easy |
| `/settings` | Native language, account |

## 11. Decisions taken without further consultation

- **Email + password auth.** Magic-link deep linking on Android is disproportionate effort
  for a draft.
- **Decks, not free tags,** as the organizing unit.
- **Images via OpenRouter image generation**, not image search, avoiding a second vendor
  and licensing questions.

## 12. Required contents of `OUT-OF-SCOPE.md`

The out-of-scope document must cover at least the following, each with enough reasoning
that the decision need not be re-argued later:

**Language-learning card practice not implemented in the draft**
- Cloze deletion cards and the sentence-mining workflow.
- Audio: TTS for pronunciation, listening-comprehension cards.
- Example sentences in context, and why isolated words are weaker than words in use.
- Verb conjugation tables, separable verbs, case governance for prepositions.
- Cognate and false-friend warnings relative to the user's native language.
- Sibling burying — not showing two cards from the same note in one session.
- Leech handling for cards that repeatedly lapse.

**Architecture deferred**
- Offline-first local SQLite plus a sync layer, with the intended migration path from
  the online-only draft: what changes, what does not, and where conflict resolution
  would have to live.
- FSRS parameter optimization from accumulated `review_logs`.
- Per-user OpenRouter keys as an alternative to the shared server key.
- Rate limiting and cost controls on the Edge Functions.

**Product deferred**
- Shared and importable decks, Anki import/export.
- Statistics and retention graphs.
- Bulk capture — paste a word list, or capture from a book photo via OCR.

## 13. Success criteria

The draft is done when, on a real Android device:

1. A user signs up, sets their native language, and creates a deck.
2. Typing `die Banane` produces an image and multiple aspect-tagged cards.
3. Typing `Poseidon` produces sensible cards under `base` rules with no vocabulary
   scaffolding forced onto it.
4. Cards can be edited before saving.
5. A review session schedules with FSRS and survives an app restart.
6. `docs/OUT-OF-SCOPE.md` exists and covers the deferred work.
