# Foreign-Language Phrase TTS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and store ElevenLabs pronunciation for saved language cloze
cards, show post-save progress, support manual playback and configurable review
autoplay, and recover cleanly from interrupted or failed generation.

**Architecture:** Saved eligible cards persist a four-state audio lifecycle and
start bounded background jobs after the note transaction commits. A focused
ElevenLabs adapter produces MP3 bytes, a storage/HTTP module owns authenticated
files, and a process-local coordinator coalesces jobs and repairs orphaned
active states. The React client renders one reusable pronunciation control in
note detail and post-reveal review, while note detail polls only during active
generation.

**Tech Stack:** Deno, TypeScript, Hono, oRPC, Drizzle/SQLite, better-auth, React
19, TanStack Query/Router, Vitest, Testing Library, ElevenLabs REST API.

## Global Constraints

- Use `deno` for every package, script, test, build, and migration command; do
  not use npm, npx, yarn, or pnpm.
- Use `ELEVENLABS_API_KEY` only on the server.
- Default model: `eleven_multilingual_v2`; override: `ELEVENLABS_MODEL`.
- Default voice: George (`JBFqnCBsd6RMkjVDRZzb`); override:
  `ELEVENLABS_VOICE_ID`.
- ElevenLabs output format: `mp3_44100_128`.
- Audio storage root: `AUDIO_DIR`, default `./data/audio`.
- Only complete revealed sentences from saved language cloze cards are eligible.
- Review audio controls remain hidden until answer reveal.
- `tts_autoplay` defaults to true and persists on the user record.
- TTS failures never roll back note saving or block review grading.
- Each task ends in a conventional, atomic commit after its focused tests pass.

---

## File map

- `shared/cloze.ts`: pure revealed-sentence reconstruction.
- `server/db/schema.ts` and `server/drizzle/0004_tts_audio.sql`: user preference
  and per-card audio persistence.
- `server/auth.ts`, `src/lib/auth.ts`: expose and update `ttsAutoplay` through
  better-auth.
- `server/tts/elevenlabs.ts`: provider configuration and MP3 request.
- `server/audio.ts`: atomic file storage, file existence, and authenticated
  serving.
- `server/tts/jobs.ts`: eligibility, status transitions, coalescing, bounded
  note jobs, and orphan recovery.
- `server/tts/transport.ts`: one sanitized card response shape shared by note
  and review routers.
- `server/router/cards.ts`, `server/router/notes.ts`: generation mutation,
  sanitized audio fields, save launch, and note recovery.
- `src/lib/api/audio.ts`: authenticated audio fetch and generation mutation.
- `src/components/pronunciation-control.tsx`: playback, autoplay, retry, and
  media cleanup.
- `src/lib/audio-progress.ts`: aggregate progress copy and active-state
  detection.
- `src/routes/_authed.settings.tsx`: autoplay setting.
- `src/routes/_authed.review.$deckId.tsx`: post-reveal pronunciation.
- `src/routes/_authed.notes.$noteId.tsx`: aggregate and per-card progress.
- `src/routes/_authed.add.tsx`: redirect successful saves to note detail.

---

### Task 1: Revealed sentence and eligibility primitives

**Files:**

- Modify: `shared/cloze.ts`
- Modify: `shared/cloze.test.ts`
- Create: `server/tts/eligibility.ts`
- Create: `server/tts/eligibility.test.ts`

**Interfaces:**

- Produces: `revealCloze(text: string): string | null`.
- Produces:
  `ttsTextForCard(note: { domain: string; language: string | null }, card: { front: string }): string | null`.

- [ ] **Step 1: Add failing revealed-text tests**

```ts
import { revealCloze } from "./cloze.ts";

expect(revealCloze("Ich mag {{c1::Bananen::banany}} zum Frühstück."))
  .toBe("Ich mag Bananen zum Frühstück.");
expect(revealCloze("{{c1::Żółć}}!")).toBe("Żółć!");
expect(revealCloze("plain text")).toBeNull();
expect(revealCloze("{{c1::one}} and {{c2::two}}")).toBeNull();
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `deno task test -- shared/cloze.test.ts`

Expected: FAIL because `revealCloze` is not exported.

- [ ] **Step 3: Implement reconstruction from the existing strict parser**

```ts
export function revealCloze(text: string): string | null {
  const segments = parseCloze(text);
  return segments
    ? `${segments.before}${segments.answer}${segments.after}`
    : null;
}
```

- [ ] **Step 4: Add failing server eligibility tests**

```ts
expect(ttsTextForCard(
  { domain: "language", language: "de" },
  { front: "Ich mag {{c1::Bananen::banany}}." },
)).toBe("Ich mag Bananen.");
expect(ttsTextForCard(
  { domain: "concept", language: null },
  { front: "{{c1::Entropy}} increases." },
)).toBeNull();
expect(ttsTextForCard(
  { domain: "language", language: "de" },
  { front: "die Banane" },
)).toBeNull();
```

- [ ] **Step 5: Implement the eligibility boundary**

```ts
import { revealCloze } from "@mnimi/shared";

export function ttsTextForCard(
  note: { domain: string; language: string | null },
  card: { front: string },
): string | null {
  if (note.domain !== "language" || note.language === null) return null;
  const text = revealCloze(card.front)?.trim();
  return text ? text : null;
}
```

- [ ] **Step 6: Run both focused files and commit**

Run: `deno task test -- shared/cloze.test.ts server/tts/eligibility.test.ts`

Expected: PASS.

```bash
git add shared/cloze.ts shared/cloze.test.ts server/tts/eligibility.ts server/tts/eligibility.test.ts
git commit -m "feat(tts): derive eligible revealed sentences"
```

---

### Task 2: Persist audio lifecycle and autoplay preference

**Files:**

- Modify: `server/db/schema.ts`
- Modify: `server/db/schema.test.ts`
- Modify: `server/db/migrations.test.ts`
- Create: `server/drizzle/0004_tts_audio.sql`
- Modify: `server/drizzle/meta/_journal.json`
- Create or modify: `server/drizzle/meta/0004_snapshot.json`
- Modify: `server/auth.ts`
- Modify: `server/auth.test.ts`
- Modify: `src/lib/auth.ts`
- Modify: `src/lib/auth.test.ts`

**Interfaces:**

- Produces: `AudioStatus = "pending" | "generating" | "ready" | "failed"`.
- Produces card fields: `audioPath: string | null`,
  `audioStatus: AudioStatus | null`.
- Produces user/session field: `ttsAutoplay: boolean`.
- Produces: `updateTtsAutoplay(ttsAutoplay: boolean): Promise<void>`.

- [ ] **Step 1: Write failing schema and migration assertions**

Add schema round-trip/default cases:

```ts
expect(insertedUser.ttsAutoplay).toBe(true);
expect(insertedCard.audioPath).toBeNull();
expect(insertedCard.audioStatus).toBeNull();
```

Extend migration replay to assert:

```ts
expect(row.audio_path).toBeNull();
expect(row.audio_status).toBeNull();
const userRow = await client.execute(
  "select tts_autoplay from user where id = 'u1'",
);
expect(userRow.rows[0].tts_autoplay).toBe(1);
```

- [ ] **Step 2: Run schema tests and confirm RED**

Run: `deno task test -- server/db/schema.test.ts server/db/migrations.test.ts`

Expected: FAIL because the columns do not exist.

- [ ] **Step 3: Add typed Drizzle columns**

```ts
export type AudioStatus = "pending" | "generating" | "ready" | "failed";

// user
ttsAutoplay: integer("tts_autoplay", { mode: "boolean" })
  .notNull()
  .default(true),

// cards
audioPath: text("audio_path"),
audioStatus: text("audio_status").$type<AudioStatus>(),
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `deno task db:generate --name=tts_audio`

Expected SQL:

```sql
ALTER TABLE `user` ADD `tts_autoplay` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `cards` ADD `audio_path` text;
--> statement-breakpoint
ALTER TABLE `cards` ADD `audio_status` text;
```

Confirm the generated journal entry is index 4 and the migration does not
recreate or drop FSRS columns/indexes.

- [ ] **Step 5: Add failing auth default/update tests**

```ts
expect(result?.user.ttsAutoplay).toBe(true);
await auth.api.updateUser({
  body: { ttsAutoplay: false },
  headers: authHeaders,
});
expect((await auth.api.getSession({ headers: authHeaders }))?.user.ttsAutoplay)
  .toBe(false);
```

Client test:

```ts
await auth.updateTtsAutoplay(false);
expect(updateUserMock).toHaveBeenCalledWith({ ttsAutoplay: false });
```

- [ ] **Step 6: Expose the boolean through server and client auth schemas**

```ts
// server/auth.ts additionalFields
ttsAutoplay: { type: "boolean", required: false, defaultValue: true },

// src/lib/auth.ts Session.user and inferAdditionalFields
ttsAutoplay: boolean;
ttsAutoplay: { type: "boolean", required: false },

export async function updateTtsAutoplay(ttsAutoplay: boolean) {
  let result: Awaited<ReturnType<typeof authClient.updateUser>>;
  try {
    result = await authClient.updateUser({ ttsAutoplay });
  } catch {
    throw new Error("Failed to update autoplay");
  }
  if (result.error) {
    throw new Error(result.error.message ?? "Failed to update autoplay");
  }
}
```

- [ ] **Step 7: Run persistence/auth tests and commit**

Run:
`deno task test -- server/db/schema.test.ts server/db/migrations.test.ts server/auth.test.ts src/lib/auth.test.ts`

Expected: PASS.

```bash
git add server/db/schema.ts server/db/schema.test.ts server/db/migrations.test.ts server/drizzle server/auth.ts server/auth.test.ts src/lib/auth.ts src/lib/auth.test.ts
git commit -m "feat(tts): persist audio status and autoplay preference"
```

---

### Task 3: ElevenLabs speech adapter

**Files:**

- Create: `server/tts/elevenlabs.ts`
- Create: `server/tts/elevenlabs.test.ts`

**Interfaces:**

- Produces: `elevenLabsModel(): string`.
- Produces: `elevenLabsVoiceId(): string`.
- Produces:
  `synthesizeSpeech(text: string, fetcher?: typeof fetch): Promise<Uint8Array>`.

- [ ] **Step 1: Write failing request-contract tests**

Use a mock fetch that records URL/init and returns `new Response(MP3)`; assert:

```ts
expect(url).toBe(
  "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128",
);
expect(init.headers).toMatchObject({
  "xi-api-key": "test-key",
  "Content-Type": "application/json",
  Accept: "audio/mpeg",
});
expect(JSON.parse(String(init.body))).toEqual({
  text: "Ich mag Bananen.",
  model_id: "eleven_multilingual_v2",
});
```

Also cover model/voice overrides, missing key, non-2xx response, and empty
bytes.

- [ ] **Step 2: Run the provider test and confirm RED**

Run: `deno task test -- server/tts/elevenlabs.test.ts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement the minimal fetch adapter**

```ts
const DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";

export const elevenLabsModel = () =>
  Deno.env.get("ELEVENLABS_MODEL") ?? DEFAULT_MODEL;
export const elevenLabsVoiceId = () =>
  Deno.env.get("ELEVENLABS_VOICE_ID") ?? DEFAULT_VOICE;

export async function synthesizeSpeech(
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const key = Deno.env.get("ELEVENLABS_API_KEY");
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const voice = encodeURIComponent(elevenLabsVoiceId());
  const response = await fetcher(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: elevenLabsModel() }),
    },
  );
  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error("ElevenLabs returned empty audio");
  }
  return bytes;
}
```

- [ ] **Step 4: Run provider tests and commit**

Run: `deno task test -- server/tts/elevenlabs.test.ts`

Expected: PASS.

```bash
git add server/tts/elevenlabs.ts server/tts/elevenlabs.test.ts
git commit -m "feat(tts): add ElevenLabs speech adapter"
```

---

### Task 4: Atomic audio storage and authenticated serving

**Files:**

- Create: `server/audio.ts`
- Create: `server/audio.test.ts`
- Create: `server/write-audio.test.ts`
- Modify: `server/app.ts`

**Interfaces:**

- Produces: `AUDIO_DIR`.
- Produces:
  `writeAudio(userId: string, cardId: string, bytes: Uint8Array): Promise<string>`.
- Produces: `audioExists(relativePath: string): Promise<boolean>`.
- Produces: `createAudioRoute({ db, auth }): Hono`.

- [ ] **Step 1: Write failing disk tests with `AUDIO_DIR` set before dynamic
      import**

```ts
const path = await writeAudio(USER_ID, CARD_ID, new Uint8Array([1, 2, 3]));
expect(path).toBe(`${USER_ID}/${CARD_ID}.mp3`);
expect(new Uint8Array(readFileSync(join(dir, path))))
  .toEqual(new Uint8Array([1, 2, 3]));
expect(await audioExists(path)).toBe(true);
```

Write twice and assert only the second byte sequence remains and no `.tmp` file
remains.

- [ ] **Step 2: Run disk tests and confirm RED**

Run: `deno task test -- server/write-audio.test.ts`

Expected: FAIL because `server/audio.ts` is absent.

- [ ] **Step 3: Implement deterministic atomic storage**

```ts
export const AUDIO_DIR = Deno.env.get("AUDIO_DIR") ?? "./data/audio";

export async function writeAudio(
  userId: string,
  cardId: string,
  bytes: Uint8Array,
) {
  const relative = `${userId}/${cardId}.mp3`;
  const directory = `${AUDIO_DIR}/${userId}`;
  const temporary = `${directory}/${cardId}.${uuidv7()}.tmp`;
  await Deno.mkdir(directory, { recursive: true });
  try {
    await Deno.writeFile(temporary, bytes);
    await Deno.rename(temporary, `${AUDIO_DIR}/${relative}`);
  } catch (error) {
    try {
      await Deno.remove(temporary);
    } catch (cleanup) {
      if (!(cleanup instanceof Deno.errors.NotFound)) console.error(cleanup);
    }
    throw error;
  }
  return relative;
}

export async function audioExists(relativePath: string) {
  try {
    return (await Deno.stat(`${AUDIO_DIR}/${relativePath}`)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
```

- [ ] **Step 4: Write failing HTTP ownership tests**

Seed two users and cards. Assert owner gets 200 plus `audio/mpeg`,
unauthenticated gets 401, and
malformed/unknown/foreign-owned/null-path/missing-file cases all get 404.

- [ ] **Step 5: Implement and mount the route**

Use the same session and UUIDv7 checks as `createImagesRoute`, select
`cards.audioPath` under both card id and session user id, and return:

```ts
new Response(bytes as BodyInit, {
  status: 200,
  headers: {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "private, no-cache",
  },
});
```

Mount with `app.route("/audio", createAudioRoute({ db, auth }))` before the oRPC
handler.

- [ ] **Step 6: Run storage/route/app tests and commit**

Run:
`deno task test -- server/write-audio.test.ts server/audio.test.ts server/app.test.ts`

Expected: PASS.

```bash
git add server/audio.ts server/audio.test.ts server/write-audio.test.ts server/app.ts
git commit -m "feat(tts): store and serve card audio securely"
```

---

### Task 5: Audio job coordinator and recovery

**Files:**

- Create: `server/tts/jobs.ts`
- Create: `server/tts/jobs.test.ts`

**Interfaces:**

- Consumes: `ttsTextForCard`, `synthesizeSpeech`, `writeAudio`, `audioExists`.
- Produces:
  `generateCardAudio(db: Db, userId: string, cardId: string, deps?: AudioJobDeps): Promise<void>`.
- Produces: `hasAudioJob(cardId: string): boolean`.
- Produces:
  `generateNoteAudio(db: Db, userId: string, cardIds: string[], concurrency?: number): Promise<void>`.
- Produces: `AudioCardRow = Pick<Card, "id" | "audioStatus">`.
- Produces:
  `resumeOrphanedAudio(db: Db, userId: string, cardRows: AudioCardRow[]): void`.

- [ ] **Step 1: Write failing coordinator tests with injected seams**

Cover these exact cases:

```ts
// eligible path
expect(transitions).toEqual(["generating", "ready"]);
expect(savedText).toBe("Ich mag Bananen.");

// two simultaneous calls
await Promise.all([
  generateCardAudio(db, userId, cardId, deps),
  generateCardAudio(db, userId, cardId, deps),
]);
expect(synthesize).toHaveBeenCalledTimes(1);

// provider failure
await expect(generateCardAudio(db, userId, cardId, failingDeps)).rejects
  .toThrow();
expect(reloaded.audioStatus).toBe("failed");
expect(reloaded.audioPath).toBeNull();
```

Also assert wrong-owner/not-found and ineligible cards do not call the provider;
ready plus existing file skips; ready plus missing file regenerates; a failure
clears the registry; note generation never exceeds the passed concurrency;
orphaned pending/generating rows restart while live jobs do not.

- [ ] **Step 2: Run coordinator tests and confirm RED**

Run: `deno task test -- server/tts/jobs.test.ts`

Expected: FAIL because the coordinator is absent.

- [ ] **Step 3: Implement authorization-before-coalescing and durable
      transitions**

Define dependencies exactly:

```ts
export type AudioJobDeps = {
  synthesize: (text: string) => Promise<Uint8Array>;
  write: (userId: string, cardId: string, bytes: Uint8Array) => Promise<string>;
  exists: (relativePath: string) => Promise<boolean>;
};

const jobs = new Map<string, Promise<void>>();
```

Query the card joined to its note under both `cards.id` and `cards.userId`;
throw a local `AudioCardNotFoundError` when absent and
`AudioCardIneligibleError` when `ttsTextForCard` returns null. Only after that
authorization/eligibility query may a caller join `jobs.get(cardId)`.

Use `withWriteLock` for each status update. On success write
`{ audioPath, audioStatus: "ready" }`; on failure write
`{ audioPath: null, audioStatus: "failed" }` in a guarded catch and rethrow;
always delete the matching promise in `finally`.

- [ ] **Step 4: Implement bounded note generation and orphan resumption**

```ts
export async function generateNoteAudio(
  db: Db,
  userId: string,
  cardIds: string[],
  concurrency = 2,
) {
  let next = 0;
  const worker = async () => {
    while (next < cardIds.length) {
      const cardId = cardIds[next++];
      try {
        await generateCardAudio(db, userId, cardId);
      } catch (error) {
        console.error("card audio generation failed", cardId, error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cardIds.length) }, worker),
  );
}
```

`resumeOrphanedAudio` filters `pending`/`generating` rows for which
`hasAudioJob(id)` is false and starts `generateCardAudio` with a terminal
`.catch` so no detached rejection escapes.

- [ ] **Step 5: Run coordinator tests and commit**

Run: `deno task test -- server/tts/jobs.test.ts`

Expected: PASS.

```bash
git add server/tts/jobs.ts server/tts/jobs.test.ts
git commit -m "feat(tts): coordinate durable card audio jobs"
```

---

### Task 6: Integrate save, APIs, recovery, and post-save navigation

**Files:**

- Modify: `server/router/notes.ts`
- Modify: `server/router/notes.test.ts`
- Modify: `server/router/cards.ts`
- Modify: `server/router/cards.test.ts`
- Create: `server/tts/transport.ts`
- Modify: `src/lib/api/notes.ts`
- Create: `src/lib/api/notes.test.ts`
- Modify: `src/routes/_authed.add.tsx`
- Modify: `src/routes/-_authed.add.test.tsx`

**Interfaces:**

- Consumes: `generateCardAudio`, `generateNoteAudio`, `resumeOrphanedAudio`,
  `ttsTextForCard`.
- Produces sanitized card transport fields: `hasAudio`, `audioStatus`,
  `audioEligible`.
- Produces oRPC mutation:
  `cards.generateAudio({ cardId }): { hasAudio: true; audioStatus: "ready" }`.

- [ ] **Step 1: Write failing save tests**

Add a hoisted partial module mock before the router import:

```ts
const { generateNoteAudioMock } = vi.hoisted(() => ({
  generateNoteAudioMock: vi.fn(async () => undefined),
}));
vi.mock("../tts/jobs.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../tts/jobs.ts")>(),
  generateNoteAudio: generateNoteAudioMock,
}));
```

Then prove:

```ts
const saved = await call(notesRouter.save, input, { context });
expect(saved.id).toBeTruthy();
expect((await db.select().from(cards))[0].audioStatus).toBe("pending");
expect(generateNoteAudioMock).toHaveBeenCalledWith(
  db,
  userId,
  expect.arrayContaining([expect.any(String)]),
);
```

Add non-language/basic cases whose status remains null, and a deferred launcher
case proving `save` resolves before generation settles.

- [ ] **Step 2: Generate card ids before the transaction and launch after the
      lock**

Build card values before `withWriteLock`:

```ts
const cardValues = input.cards.map((card) => {
  const id = uuidv7();
  const eligible = ttsTextForCard(classification, card) !== null;
  return {
    id,
    noteId,
    userId: context.userId,
    ...card,
    cardType: parseCloze(card.front) ? "cloze" as const : "basic" as const,
    audioStatus: eligible ? "pending" as const : null,
    due: now,
  };
});
```

Because classification is read inside the existing locked section, construct
these values after reading the draft but before the transaction. Have the locked
callback return both values needed outside it:

```ts
// Replace the current callback's final `return await settleImage(...)` with:
const settled = await settleImage(context, note, draft);
return {
  note: settled,
  eligibleCardIds: cardValues
    .filter((card) => card.audioStatus === "pending")
    .map((card) => card.id),
};
```

Change the handler's current `return await withWriteLock(async () => {`
declaration to `const saved = await withWriteLock(async () => {`. After
replacing the callback's final return with the block above, launch after its
closing `});`:

```ts
void generateNoteAudio(context.db, context.userId, saved.eligibleCardIds)
  .catch((error) =>
    console.error("note audio generation failed", saved.note.id, error)
  );
return saved.note;
```

This launches only after the locked image settle and draft deletion complete.

- [ ] **Step 3: Write failing API sanitization and mutation tests**

For `cards.due` and `notes.get`, assert eligible cards return:

```ts
expect(card).toMatchObject({
  hasAudio: false,
  audioStatus: "pending",
  audioEligible: true,
});
expect(card).not.toHaveProperty("audioPath");
```

Assert `cards.generateAudio` rejects wrong-owner ids as NOT_FOUND, rejects
ineligible cards as BAD_REQUEST, joins generation, and returns ready.

- [ ] **Step 4: Add one shared server transport mapper**

Create `server/tts/transport.ts` and reuse it from both routers:

```ts
export function audioCardView(
  card: Card,
  note: Pick<Note, "domain" | "language">,
) {
  const { audioPath, ...publicCard } = card;
  return {
    ...publicCard,
    hasAudio: audioPath !== null,
    audioEligible: ttsTextForCard(note, card) !== null,
  };
}
```

Have `notes.get` call `resumeOrphanedAudio` after loading rows, then return the
current sanitized snapshot. Extend `cardsRouter` with the generation mutation
and map local coordinator errors to `notFound`/`ORPCError("BAD_REQUEST")`.

- [ ] **Step 5: Make note polling observe both image and audio work**

```ts
export function noteHasActiveAudio(
  data: { cards: Array<{ audioStatus: AudioStatus | null }> } | undefined,
) {
  return data?.cards.some((card) =>
    card.audioStatus === "pending" || card.audioStatus === "generating"
  ) ?? false;
}

refetchInterval: (query) =>
  query.state.data?.imageGenerating || noteHasActiveAudio(query.state.data)
    ? 2000
    : false,
```

Create `src/lib/api/notes.test.ts` and exercise the exported
`noteHasActiveAudio` function directly rather than mounting React Query.

- [ ] **Step 6: Redirect successful saves to note detail**

Capture the mutation result:

```ts
const note = await saveNote.mutateAsync({
  draftId: state.draftId,
  cards: writableCards(state.cards, { trimForSave: true }),
});
navigate({ to: "/notes/$noteId", params: { noteId: note.id } });
```

Update the add-route mock so `mutateAsync` returns `{ id: "note-1" }`; assert
the navigate mock receives the note route, and keep the existing rejected-save
no-navigation assertion.

- [ ] **Step 7: Run integrated server/client tests and commit**

Run:
`deno task test -- server/router/notes.test.ts server/router/cards.test.ts src/lib/api/notes.test.ts src/routes/-_authed.add.test.tsx`

Expected: PASS.

```bash
git add server/router/notes.ts server/router/notes.test.ts server/router/cards.ts server/router/cards.test.ts server/tts/transport.ts src/lib/api/notes.ts src/lib/api/notes.test.ts src/routes/_authed.add.tsx src/routes/-_authed.add.test.tsx
git commit -m "feat(tts): launch audio generation after note save"
```

---

### Task 7: Client audio transport and reusable pronunciation control

**Files:**

- Create: `src/lib/api/audio.ts`
- Create: `src/lib/api/audio.test.ts`
- Create: `src/components/pronunciation-control.tsx`
- Create: `src/components/pronunciation-control.test.tsx`

**Interfaces:**

- Produces: `fetchCardAudio(cardId: string): Promise<Blob>`.
- Produces: `useGenerateCardAudio()`.
- Produces:
  `PronunciationCard = { id: string; hasAudio: boolean; audioEligible: boolean; audioStatus: AudioStatus | null }`.
- Produces:
  `PronunciationControl({ card, autoplay }: { card: PronunciationCard; autoplay: boolean })`.

- [ ] **Step 1: Write failing authenticated-fetch tests**

```ts
await fetchCardAudio("card-1");
expect(fetchMock).toHaveBeenCalledWith(
  "http://api.test/audio/cards/card-1",
  { headers: { authorization: "Bearer t0ken" } },
);
```

Assert Blob return, non-2xx throw, and no raw token when absent.

- [ ] **Step 2: Implement transport and mutation invalidation**

```ts
export async function fetchCardAudio(cardId: string): Promise<Blob> {
  const token = getToken();
  const response = await sessionAwareFetch(`${apiUrl}/audio/cards/${cardId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`Audio request failed: ${response.status}`);
  return await response.blob();
}
```

`useGenerateCardAudio` calls `orpc.cards.generateAudio` and invalidates
`orpc.cards.key()` plus `orpc.notes.key()` on success.

- [ ] **Step 3: Write failing component tests**

Mock `fetchCardAudio`, `useGenerateCardAudio`, `URL.createObjectURL`,
`URL.revokeObjectURL`, and `Audio`. Cover:

- ineligible returns null;
- pending/generating shows disabled `Generating…`;
- failed shows Retry;
- ready shows `Play pronunciation`;
- manual click fetches and plays;
- null-status click generates, fetches, and plays;
- autoplay runs exactly once across rerenders;
- provider/fetch/play rejection shows a concise retryable error;
- card change/unmount pauses media and revokes the object URL.

- [ ] **Step 4: Implement one playback pipeline**

Use refs for `HTMLAudioElement`, object URL, and `autoplayAttempted`. The
central action is:

```ts
async function play() {
  setError(null);
  try {
    if (!card.hasAudio || card.audioStatus !== "ready") {
      await generate.mutateAsync({ cardId: card.id });
    }
    const blob = await fetchCardAudio(card.id);
    stop();
    const url = URL.createObjectURL(blob);
    objectUrl.current = url;
    const next = new Audio(url);
    audio.current = next;
    await next.play();
  } catch {
    setError("Pronunciation isn't available. Try again.");
  }
}
```

The autoplay effect checks `autoplay && !autoplayAttempted.current`, marks the
ref before calling `play`, and depends on the stable card id rather than
render-time mutation state. Cleanup calls `pause()`, clears `src`, and revokes
the URL.

- [ ] **Step 5: Run client control tests and commit**

Run:
`deno task test -- src/lib/api/audio.test.ts src/components/pronunciation-control.test.tsx`

Expected: PASS.

```bash
git add src/lib/api/audio.ts src/lib/api/audio.test.ts src/components/pronunciation-control.tsx src/components/pronunciation-control.test.tsx
git commit -m "feat(ui): add reusable pronunciation playback control"
```

---

### Task 8: Autoplay setting UI

**Files:**

- Modify: `src/routes/_authed.settings.tsx`
- Create: `src/routes/-_authed.settings.test.tsx`

**Interfaces:**

- Consumes: `session.user.ttsAutoplay`, `updateTtsAutoplay(boolean)`.

- [ ] **Step 1: Write failing settings tests**

Mock `useSession` with `ttsAutoplay: true` and assert:

```ts
const toggle = screen.getByRole("checkbox", { name: "Autoplay pronunciation" });
expect(toggle).toBeChecked();
fireEvent.click(toggle);
await waitFor(() => expect(updateTtsAutoplayMock).toHaveBeenCalledWith(false));
```

Also cover disabled while pending, no overlapping second write, and friendly
error rendering.

- [ ] **Step 2: Implement the persisted control**

Add a second mutation and synchronous in-flight ref following the
native-language race guard. Render below the native-language select and before
the separator:

```tsx
<div className="flex items-start gap-3">
  <input
    id="tts-autoplay"
    type="checkbox"
    className="mt-1 size-4 accent-primary"
    checked={updateAutoplay.isPending
      ? updateAutoplay.variables
      : (session?.user.ttsAutoplay ?? true)}
    disabled={!session || updateAutoplay.isPending}
    onChange={(event) => saveAutoplay(event.currentTarget.checked)}
  />
  <div>
    <Label htmlFor="tts-autoplay">Autoplay pronunciation</Label>
    <p className="text-sm text-muted-foreground">
      Play the complete foreign-language sentence when an answer is revealed.
    </p>
  </div>
</div>;
```

- [ ] **Step 3: Run settings/auth tests and commit**

Run:
`deno task test -- src/routes/-_authed.settings.test.tsx src/lib/auth.test.ts server/auth.test.ts`

Expected: PASS.

```bash
git add src/routes/_authed.settings.tsx src/routes/-_authed.settings.test.tsx
git commit -m "feat(settings): configure pronunciation autoplay"
```

---

### Task 9: Review playback and note-detail progress

**Files:**

- Create: `src/lib/audio-progress.ts`
- Create: `src/lib/audio-progress.test.ts`
- Modify: `src/routes/_authed.review.$deckId.tsx`
- Modify: `src/routes/-routes.test.ts`
- Modify: `src/routes/_authed.notes.$noteId.tsx`
- Create: `src/routes/-_authed.notes.$noteId.test.tsx`

**Interfaces:**

- Consumes: `PronunciationControl`, sanitized audio card fields, `useSession`.
- Produces:
  `audioProgress(cards: Array<{ audioEligible: boolean; audioStatus: AudioStatus | null }>): string | null`.
- Produces: `hasActiveAudio(cards): boolean` for query polling tests if not
  already exported from Task 6.

- [ ] **Step 1: Write failing aggregate-progress tests**

```ts
expect(audioProgress([])).toBeNull();
expect(audioProgress([{ audioEligible: true, audioStatus: null }]))
  .toBe("Pronunciation available on demand");
expect(audioProgress([
  { audioEligible: true, audioStatus: "ready" },
  { audioEligible: true, audioStatus: "generating" },
  { audioEligible: true, audioStatus: "pending" },
])).toBe("Generating pronunciation · 1 of 3 ready");
expect(audioProgress([
  { audioEligible: true, audioStatus: "ready" },
  { audioEligible: true, audioStatus: "failed" },
])).toBe("1 of 2 ready · 1 needs retry");
```

- [ ] **Step 2: Implement the pure summary and active predicate**

Filter to eligible cards, count statuses, prioritize active copy, then failed
copy, then all-ready copy; use the on-demand copy only when every eligible
status is null.

- [ ] **Step 3: Write failing review integration tests**

Assert no pronunciation control exists before reveal. After `Show answer`,
assert it receives `autoplay={true}` from the session setting. Repeat with
false. Grade to the next card and assert the old keyed control unmounts. Run
these cases for both ordinary and image-cued card fixtures.

- [ ] **Step 4: Integrate pronunciation after reveal**

Read `const autoplay = useSession()?.user.ttsAutoplay ?? true;`. Render below
the revealed answer card but above ratings:

```tsx
{
  revealed && card.audioEligible && (
    <PronunciationControl
      key={card.id}
      card={card}
      autoplay={autoplay}
    />
  );
}
```

The placement is shared after the image-cue/normal branch so both flows behave
identically and no control leaks before reveal.

- [ ] **Step 5: Write failing note-detail route tests**

Cover loading/error regression, aggregate active/ready/failed/on-demand copy,
`Queued`/`Generating…`/Play/Retry per card through mocked pronunciation
controls, and no control for an ineligible card.

- [ ] **Step 6: Render aggregate and per-card progress**

Near `PageTitle`, render the non-null `audioProgress(cards)` in muted text.
Inside each eligible card, render:

```tsx
<PronunciationControl card={card} autoplay={false} />;
```

Do not alter image generation/retry behavior. Rely on Task 6's active-only
`useNote` polling so progress settles without a manual refresh.

- [ ] **Step 7: Run all focused UI tests and commit**

Run:
`deno task test -- src/lib/audio-progress.test.ts src/routes/-routes.test.ts src/routes/-_authed.notes.\$noteId.test.tsx src/components/pronunciation-control.test.tsx`

Expected: PASS.

```bash
git add src/lib/audio-progress.ts src/lib/audio-progress.test.ts src/routes/_authed.review.\$deckId.tsx src/routes/-routes.test.ts src/routes/_authed.notes.\$noteId.tsx src/routes/-_authed.notes.\$noteId.test.tsx
git commit -m "feat(ui): show TTS progress and review playback"
```

---

### Task 10: Configuration documentation and full verification

**Files:**

- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**

- Documents all runtime configuration and user-visible behavior.

- [ ] **Step 1: Add exact environment examples**

```dotenv
ELEVENLABS_API_KEY=
ELEVENLABS_MODEL=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
AUDIO_DIR=./data/audio
```

Keep the real key only in the gitignored `.env`; do not copy it into tests,
docs, logs, commits, or command output.

- [ ] **Step 2: Document behavior in README**

State that saved language cloze cards generate the complete revealed sentence
after Save, note detail shows progress and retry, review exposes playback only
after reveal, autoplay defaults on and is configurable in Settings, and older
eligible cards generate on first play.

- [ ] **Step 3: Run formatting/static gates**

Run:

```bash
deno fmt --check
deno task check:api
deno task build
```

Expected: all commands exit 0.

- [ ] **Step 4: Run the complete suite**

Run: `deno task test`

Expected: all tests pass with no request reaching ElevenLabs.

- [ ] **Step 5: Inspect the final diff and repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -12
```

Expected: only the documentation changes remain uncommitted before the final
commit; the log shows one coherent commit per task.

- [ ] **Step 6: Commit documentation**

```bash
git add .env.example README.md
git commit -m "docs: document ElevenLabs pronunciation"
```

- [ ] **Step 7: Re-run the final completion gate**

Run:

```bash
deno fmt --check
deno task check:api
deno task build
deno task test
git status --short
```

Expected: every command exits 0 and `git status --short` is empty.
