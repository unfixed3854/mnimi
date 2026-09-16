# Foreign-language phrase TTS

## Problem

Language cards currently teach a learner to produce a complete phrase, but the
app never lets them hear that phrase. The review screen reveals the written
answer and the note screen lists saved cards, with no pronunciation control in
either place.

Issue #23 adds server-generated pronunciation for saved language cards. Audio
must be available through a play button on review and note detail, and review
may play it automatically according to a user setting.

## Goals

- Generate a recording of the complete revealed target-language sentence for
  every eligible saved card.
- Store audio on the server so pronunciation is consistent across devices.
- Autoplay once when an answer is revealed when the user's setting is enabled.
- Enable autoplay for new and existing users by default.
- Always offer manual playback after reveal and on the saved note detail page.
- Show aggregate and per-card generation progress after saving a note.
- Keep note saving, review, and grading usable when TTS generation or playback
  fails.
- Reuse the existing ElevenLabs API key without exposing it to the client.

## Non-goals

- Device or browser speech synthesis.
- Playing pronunciation before a review answer is revealed.
- Generating audio for non-language notes or basic cards whose target-language
  side cannot be identified reliably.
- Choosing voices per language, deck, note, or user.
- Editing pronunciation, speed, stability, similarity, or style in the UI.
- Generating audio for unsaved drafts.
- Backfilling all existing cards during migration. Existing eligible cards
  generate audio when first played.

## Chosen approach

Use eager generation with lazy recovery.

After a language note is saved, the server starts background generation for each
eligible card. This keeps note saving fast and normally makes audio ready before
the card reaches review. If generation is still running, failed, or was lost
during a server restart, an autoplay or manual-play request joins or restarts
generation and caches the result.

Generation state is persisted per card and shown on the saved note page. The
user sees both overall progress and the state of each recording without the Save
action waiting for provider work.

This is preferable to adding audio to durable drafts. Draft generation already
coordinates cards and a note-level image; adding one audio artifact and status
per partial card would expand streaming, cancellation, cleanup, and claim logic
for no user-visible benefit. It is also preferable to generating only at first
playback, which would make the default autoplay behavior routinely wait on a
provider request.

## Eligibility and spoken text

A card is eligible only when all of these are true:

- its owning note has `domain === "language"` and a non-null `language`;
- its front contains exactly one well-formed cloze deletion; and
- revealing that deletion produces a non-empty sentence.

The server derives the spoken text from the persisted card and note. The client
sends only a card id, never text or a language claim. A shared pure helper
reconstructs the complete sentence by replacing the cloze markup with its answer
while preserving all surrounding punctuation and text. The inline
native-language hint and the optional meaning on `back` are not spoken.

Basic cards are excluded because the schema does not say reliably whether their
target-language text is on the front or back. Current generated language cards
are cloze cards, so this restriction covers the intended path without guessing
from model-written aspect labels.

## Provider configuration

The server calls ElevenLabs directly at its text-to-speech endpoint with:

- API key: required `ELEVENLABS_API_KEY`;
- model: `ELEVENLABS_MODEL`, default `eleven_multilingual_v2`;
- voice: `ELEVENLABS_VOICE_ID`, default George (`JBFqnCBsd6RMkjVDRZzb`); and
- output: `mp3_44100_128`.

`eleven_multilingual_v2` is chosen for pronunciation quality and consistency.
Generation is normally off the interaction's critical path, so the lower latency
of `eleven_flash_v2_5` is less valuable than the quality-oriented model. The
model and voice remain deployment overrides rather than user settings.

The integration is a small fetch-based adapter with an injected fetch seam for
tests. It validates non-success responses before accepting bytes and never logs
the API key or authorization header.

## Persistence and storage

The user table gains `tts_autoplay`, a non-null boolean with default `true`. It
is exposed through better-auth's additional user fields so the existing session
and `updateUser` flow can read and update it.

The cards table gains nullable `audio_path` and nullable `audio_status`.
`audio_status` is one of `pending`, `generating`, `ready`, or `failed`:

- new eligible cards are inserted as `pending` in the note-save transaction;
- a claimed generation is `generating`;
- `ready` requires a stored recording and non-null `audio_path`; and
- `failed` means that the last attempt settled without a usable recording.

Ineligible cards and cards that predate this feature have a null status. A
legacy card that is eligible at read time still receives a play control; its
first playback request enters the same generation state machine. This avoids a
costly migration-time provider backfill while preserving on-demand coverage.

Audio is stored under an `AUDIO_DIR` root, defaulting to `./data/audio`, with
one deterministic MP3 path per user and card. A generation is written to a
temporary file in the same directory and renamed into place before `audio_path`
is recorded, so the serving route never observes partial audio. If the database
update fails after the rename, the next generation may safely overwrite the same
deterministic file.

The API never returns `audio_path`. Due-card and note-detail responses replace
it with `hasAudio`, keep `audioStatus`, and add the server-derived
`audioEligible` boolean, keeping filesystem layout and eligibility decisions
server-side.

## Generation lifecycle

`notes.save` inserts eligible cards with `audio_status = "pending"`. Once its
transaction commits, it starts a detached audio task for those cards and returns
without awaiting provider work. Cards for a single note are generated with
bounded concurrency to avoid a burst against ElevenLabs subscription limits.
Each failure is logged with card context, records `failed`, and does not change
the saved note or the card's scheduling state.

A process-local registry maps card ids to in-flight generation promises. Both
the eager task and the explicit generation procedure use the same function:

1. Return immediately if `audio_status` is `ready` and `audio_path` names a file
   that exists; clear a stale path and continue if the file is missing.
2. Join the existing promise if this card is currently generating.
3. Re-read and authorize the card and note.
4. Derive and validate the spoken sentence on the server.
5. Record `generating` and clear any stale path.
6. Request MP3 audio and atomically store it.
7. Record the path and `ready`, or record `failed` on any unsuccessful settle.
8. Remove the promise from the registry in `finally`.

The authenticated `cards.generateAudio` procedure accepts only `cardId` and
waits for this function.

A process restart can leave a persisted `pending` or `generating` status with no
live promise. `notes.get` compares active statuses with the registry and
restarts any orphaned work after returning the current snapshot. A subsequent
poll observes the resumed generation. Reaching the card in review or pressing
its play button uses the same recovery path, so progress cannot remain stuck
forever merely because the process restarted.

## Serving audio

An authenticated `GET /audio/cards/:cardId` route mirrors the image-serving
security boundary:

- resolve the session from request headers;
- validate the card id;
- select the card by both id and session user id;
- answer 404 for a missing, foreign-owned, or audio-less card; and
- serve the stored MP3 as `audio/mpeg` with private cache headers.

The client fetches audio with its bearer credential and creates an object URL,
as it already does for generated images. Object URLs are revoked whenever the
card changes or the component unmounts.

## Settings UI

Settings adds an `Autoplay pronunciation` checkbox or switch below the native
language control. It reads `session.user.ttsAutoplay`, defaults to true at the
database and auth-schema boundaries, and saves through `updateUser`.

The control disables while its request is pending and shows the existing
settings error treatment on failure. The review screen uses the server-backed
session value; there is no local-storage preference that can diverge between
devices.

## Review behavior

Pronunciation is never exposed before reveal because the recording contains the
cloze answer and would invalidate recall.

After an eligible card is revealed:

- a play control appears with an accessible `Play pronunciation` label;
- if autoplay is enabled, playback begins once for that reveal;
- successful autoplay leaves the control available as replay;
- rerenders, query invalidation, and a failed grade attempt do not replay;
- moving to the next card stops current audio and resets playback state; and
- revealing the same card on a later attempt may autoplay again.

If audio is absent, the same playback action calls `cards.generateAudio`, joins
or starts generation, refreshes the audio query, and plays the result. While
waiting, the control shows `Generating…` and disables duplicate activation.
Provider, disk, fetch, decode, and browser playback failures leave grading
enabled and turn the control into a retryable state with a concise message.

The same behavior is composed into both the normal and image-cued review
branches so cue presentation remains unchanged. Only the review route owns the
reveal boundary; a focused pronunciation component owns fetching, generation
recovery, playback, and cleanup.

## Note-detail behavior

The saved note page is the primary progress surface. Near the page heading it
shows aggregate pronunciation status:

- while work is active: `Generating pronunciation · 1 of 3 ready`;
- when all eligible cards settle successfully: `Pronunciation ready`; and
- when some fail: `2 of 3 ready · 1 needs retry`.

A legacy note whose eligible cards all have null status instead says
`Pronunciation available on demand`; it does not pretend that generation is
queued.

After a successful Save, the add screen navigates to this new note's detail
route instead of back to the deck, using the note id already returned by
`notes.save`. A failed save remains on the draft exactly as it does now.

Each eligible card independently displays `Queued`, `Generating…`, Play, or
Retry beside its fully revealed sentence. It uses the same pronunciation
component and recovery path as review, but never autoplays. Ineligible cards
display exactly as they do now. A legacy null-status card starts with Play;
pressing it generates the recording and then plays it.

The note query polls at a modest interval only while at least one eligible card
is `pending` or `generating`, then stops automatically. Polling is preferred to
adding another subscription protocol for a small, bounded post-save job.

The note-level image and image retry flow are unchanged. TTS status is per card
because different cards may contain different complete sentences.

## Error handling

- Missing `ELEVENLABS_API_KEY` fails only the background/requested TTS attempt.
- ElevenLabs non-success responses are reported without leaking credentials or
  returning provider bodies verbatim to the client.
- Empty provider output is rejected and never persisted.
- Provider, disk, or database failures record `failed` with a null path when
  possible and remain retryable.
- Missing files behind a non-null path return 404 and are logged as storage/DB
  divergence; the next generation request transitions through `generating`,
  clears the stale path, and replaces the file.
- Audio fetch, decode, or `HTMLMediaElement.play()` rejection is visible near
  the play control but never blocks reveal or grading.
- Non-owned card ids are indistinguishable from nonexistent ids.

## Testing

Tests cover the feature at each boundary:

- shared text logic reconstructs revealed sentences, preserves punctuation and
  Unicode, removes hints, and rejects non-cloze or malformed fronts;
- migration replay adds `tts_autoplay = true`, nullable `audio_path`, and
  nullable `audio_status` while preserving existing users, cards, FSRS values,
  and indexes;
- the ElevenLabs adapter sends the configured/default model, voice, and MP3
  format, returns bytes, and handles missing keys, empty output, and non-2xx
  responses;
- storage uses deterministic owner/card paths and atomic replacement;
- generation enforces ownership and eligibility, coalesces concurrent calls,
  persists every status transition, skips completed cards, restarts orphaned
  work, and leaves failures retryable;
- note save returns before audio settles and keeps a successfully saved note
  when generation fails;
- audio HTTP routes enforce authentication and ownership, return the expected
  content type, and handle missing rows/files without disclosure;
- APIs expose `hasAudio`, `audioStatus`, and `audioEligible` rather than
  `audio_path`;
- settings render the default, persist changes, prevent overlapping writes, and
  report failures;
- review tests cover no pre-reveal control, one-shot autoplay, manual replay,
  missing-audio generation, retry, playback failure, rerenders, failed grades,
  and stopping audio on card change;
- note-detail tests cover aggregate progress, active-only polling, each per-card
  state, retry, and the absence of controls on ineligible cards; and
- add-route tests prove a successful save opens the new note's progress page
  while a failed save does not navigate; and
- existing image-cued, cloze, grading, and note-save behavior remains intact.

## Documentation

`.env.example` and the README document `ELEVENLABS_API_KEY`, the default model
and voice overrides, `AUDIO_DIR`, stored server-side audio, autoplay behavior,
post-save progress, and the fact that only complete revealed language cloze
sentences are spoken.
