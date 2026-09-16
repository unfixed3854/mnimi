# ElevenLabs German seed audio refresh

## Goal

Replace the nine robotic German seed pronunciation recordings with natural
ElevenLabs speech while preserving the existing seed content, filenames, and
runtime behavior.

## Scope

Regenerate every MP3 referenced by `GERMAN_SEED` under
`server/devtools/seed-assets/german/`. No application code, database schema,
seed structure, card text, image asset, or user interface changes are needed.

## Generation path

Use the existing `synthesizeSpeech` adapter from `server/tts/elevenlabs.ts` so
fixture generation has the same behavior as application TTS:

- API credentials come from `ELEVENLABS_API_KEY`;
- the model comes from `ELEVENLABS_MODEL`, defaulting to
  `eleven_multilingual_v2`;
- the voice comes from `ELEVENLABS_VOICE_ID`, defaulting to George
  (`JBFqnCBsd6RMkjVDRZzb`); and
- output is 128 kbps, 44.1 kHz MP3.

For every seed card, derive the spoken sentence with `ttsTextForCard` rather
than maintaining a second transcription. Write the returned bytes to the
card's existing `audioAsset` path. Generate all recordings before replacing
any checked-in asset, so a failed request cannot leave a partially refreshed
fixture set.

The generation helper is temporary and is not added as a permanent project
task. This keeps paid provider use out of normal seed and development flows.

## Failure handling

Stop without replacing existing assets if a sentence is ineligible, two cards
target the same filename, an ElevenLabs request fails, or a response is empty.
Use a temporary directory for generated files and replace the nine destination
files only after every request succeeds.

## Verification

- Confirm exactly nine distinct seed audio references were regenerated.
- Use `file` and `ffprobe` to verify that each result is a readable, non-empty
  MP3 with an audio stream and plausible positive duration.
- Run the focused German seed tests and the relevant TTS adapter tests with
  `deno task test`.
- Run the project's broader required checks with `deno`.
- Review the resulting Git diff to ensure only the approved design record and
  nine MP3 fixtures changed.

## Repository policy

All project scripts run through `deno`. The committed seed action remains
deterministic and makes no provider request; it continues copying the refreshed
checked-in recordings into account-scoped storage.
