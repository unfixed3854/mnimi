# ElevenLabs German Seed Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all nine checked-in German seed MP3s with natural pronunciation generated through the application's existing ElevenLabs adapter.

**Architecture:** Run a temporary Deno script that imports `GERMAN_SEED`, derives each spoken sentence through `ttsTextForCard`, and calls `synthesizeSpeech`. Generate the complete set in a temporary directory, validate it, and only then copy the MP3s over their existing repository paths.

**Tech Stack:** Deno, TypeScript, ElevenLabs text-to-speech, `file`, `ffprobe`, Vitest

## Global Constraints

- Use `deno` for all package management and script execution; never use `npm`, `npx`, `yarn`, or `pnpm`.
- Use `ELEVENLABS_API_KEY` from `.env` without printing or committing it.
- Use the runtime defaults from `server/tts/elevenlabs.ts`: `eleven_multilingual_v2`, George (`JBFqnCBsd6RMkjVDRZzb`), and `mp3_44100_128`.
- Do not change application code, seed content, filenames, images, database schema, or UI.
- Do not add a permanent provider-backed generation task.
- Do not replace any checked-in MP3 unless all nine generations succeed.

---

### Task 1: Regenerate and verify the complete seed audio set

**Files:**
- Modify: `server/devtools/seed-assets/german/banana-meaning.mp3`
- Modify: `server/devtools/seed-assets/german/banana-gender.mp3`
- Modify: `server/devtools/seed-assets/german/banana-plural.mp3`
- Modify: `server/devtools/seed-assets/german/apple-meaning.mp3`
- Modify: `server/devtools/seed-assets/german/apple-gender.mp3`
- Modify: `server/devtools/seed-assets/german/apple-plural.mp3`
- Modify: `server/devtools/seed-assets/german/house-meaning.mp3`
- Modify: `server/devtools/seed-assets/german/house-gender.mp3`
- Modify: `server/devtools/seed-assets/german/house-plural.mp3`

**Interfaces:**
- Consumes: `GERMAN_SEED`, `ttsTextForCard(note, card): string | null`, and `synthesizeSpeech(text): Promise<Uint8Array>`.
- Produces: nine valid MP3 fixtures at the existing `audioAsset` paths.

- [ ] **Step 1: Record the existing asset hashes and confirm fixture uniqueness**

Run:

```bash
sha256sum server/devtools/seed-assets/german/*.mp3
deno eval 'import { GERMAN_SEED } from "./server/devtools/german-seed.ts"; const names = GERMAN_SEED.notes.flatMap((note) => note.cards.map((card) => card.audioAsset)); if (names.length !== 9 || new Set(names).size !== 9) throw new Error(`Expected 9 unique audio assets, got ${names.length}/${new Set(names).size}`); console.log("9 unique audio assets")'
```

Expected: nine hashes and `9 unique audio assets`.

- [ ] **Step 2: Generate all recordings into an isolated temporary directory**

Load the local environment and run a temporary script from standard input. It fails before copying anything if a card is ineligible, a filename is duplicated, or ElevenLabs rejects a request:

```bash
set -a
source .env
set +a
SEED_AUDIO_TMP="$(mktemp -d)"
export SEED_AUDIO_TMP
deno run --allow-env=ELEVENLABS_API_KEY,ELEVENLABS_MODEL,ELEVENLABS_VOICE_ID,SEED_AUDIO_TMP --allow-net=api.elevenlabs.io --allow-write="$SEED_AUDIO_TMP" - <<'TS'
import { GERMAN_SEED } from "./server/devtools/german-seed.ts";
import { synthesizeSpeech } from "./server/tts/elevenlabs.ts";
import { ttsTextForCard } from "./server/tts/eligibility.ts";

const outputRoot = Deno.env.get("SEED_AUDIO_TMP");
if (!outputRoot) throw new Error("SEED_AUDIO_TMP is not set");

const seen = new Set<string>();
for (const note of GERMAN_SEED.notes) {
  for (const card of note.cards) {
    if (seen.has(card.audioAsset)) {
      throw new Error(`Duplicate seed audio asset: ${card.audioAsset}`);
    }
    seen.add(card.audioAsset);
    const text = ttsTextForCard(note, card);
    if (!text) throw new Error(`Ineligible seed card: ${card.audioAsset}`);
    const bytes = await synthesizeSpeech(text);
    await Deno.writeFile(`${outputRoot}/${card.audioAsset}`, bytes, {
      createNew: true,
    });
    console.log(`${card.audioAsset}: ${text} (${bytes.byteLength} bytes)`);
  }
}

if (seen.size !== 9) throw new Error(`Expected 9 assets, generated ${seen.size}`);
TS
```

Expected: nine filename/sentence/byte-count lines and exit status 0. The API key is never printed.

- [ ] **Step 3: Validate the isolated results before replacement**

Run:

```bash
test "$(find "$SEED_AUDIO_TMP" -maxdepth 1 -type f -name '*.mp3' | wc -l)" -eq 9
file "$SEED_AUDIO_TMP"/*.mp3
for generated in "$SEED_AUDIO_TMP"/*.mp3; do
  ffprobe -v error -show_entries format=filename,duration,size:stream=codec_name,codec_type,sample_rate -of default=noprint_wrappers=1 "$generated"
done
```

Expected: exactly nine MPEG audio files; every file has an MP3 audio stream, 44100 Hz sample rate, a positive duration, and a non-zero size.

- [ ] **Step 4: Replace the checked-in fixtures atomically per file**

Run only after Step 3 passes:

```bash
for generated in "$SEED_AUDIO_TMP"/*.mp3; do
  destination="server/devtools/seed-assets/german/$(basename "$generated")"
  cp "$generated" "$destination.next"
  mv "$destination.next" "$destination"
done
```

Expected: all nine existing paths now contain the validated ElevenLabs bytes.

- [ ] **Step 5: Prove every fixture changed and revalidate destinations**

Run:

```bash
sha256sum server/devtools/seed-assets/german/*.mp3
file server/devtools/seed-assets/german/*.mp3
for generated in server/devtools/seed-assets/german/*.mp3; do
  ffprobe -v error -show_entries format=filename,duration,size:stream=codec_name,codec_type,sample_rate -of default=noprint_wrappers=1 "$generated"
done
```

Expected: all nine hashes differ from Step 1 and all destination MP3s satisfy the same media checks as Step 3.

- [ ] **Step 6: Run focused tests**

Run:

```bash
deno task test -- server/devtools/german-seed.test.ts server/german-seed-media.integration.test.ts server/tts/elevenlabs.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Run the repository checks declared by Deno configuration**

Inspect available tasks, then run the check and test tasks through Deno:

```bash
deno task
deno task check:api
deno task build
deno task test
```

Expected: API type checking, the production build, and the complete test suite
pass.

- [ ] **Step 8: Remove temporary output and review scope**

Run:

```bash
rm -r "$SEED_AUDIO_TMP"
unset SEED_AUDIO_TMP
git status --short
git diff --stat
git diff --check
```

Expected: no temporary directory remains; only the implementation plan and nine approved MP3 fixtures are uncommitted; `git diff --check` passes.

- [ ] **Step 9: Commit the refreshed assets**

```bash
git add docs/superpowers/plans/2026-08-12-elevenlabs-seed-audio.md server/devtools/seed-assets/german/*.mp3
git commit -m "feat: refresh German seed audio with ElevenLabs"
```

Expected: one commit containing the implementation plan and nine regenerated MP3s.
