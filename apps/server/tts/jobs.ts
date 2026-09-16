import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { audioExists, removeAudio, writeAudio } from "../audio.ts";
import type { Db } from "../db/index.ts";
import { cards, notes } from "../db/schema.ts";
import { withWriteLock } from "../db/write-lock.ts";
import { synthesizeSpeech } from "./elevenlabs.ts";
import { ttsTextForCard } from "./eligibility.ts";
import {
  AudioCardIneligibleError,
  AudioCardNotFoundError,
  type AudioCardRow,
} from "../effect/audio-jobs.ts";

export { AudioCardIneligibleError, AudioCardNotFoundError } from "../effect/audio-jobs.ts";
export type { AudioCardRow } from "../effect/audio-jobs.ts";

export type AudioJobDeps = {
  synthesize: (text: string) => Promise<Uint8Array>;
  write: (
    userId: string,
    audioId: string,
    bytes: Uint8Array,
  ) => Promise<string>;
  exists: (relativePath: string) => Promise<boolean>;
  remove: (relativePath: string) => Promise<void>;
};

const defaultDeps: AudioJobDeps = {
  synthesize: synthesizeSpeech,
  write: writeAudio,
  exists: audioExists,
  remove: removeAudio,
};

type RegisteredAudioJob = {
  generation: number;
  promise: Promise<void>;
};

const jobs = new Map<string, RegisteredAudioJob>();
const generations = new Map<string, number>();

function currentGeneration(cardId: string): number {
  return generations.get(cardId) ?? 0;
}

export function invalidateCardAudioJob(cardId: string): void {
  generations.set(cardId, currentGeneration(cardId) + 1);
  jobs.delete(cardId);
}

export function hasAudioJob(cardId: string): boolean {
  return jobs.get(cardId)?.generation === currentGeneration(cardId);
}

export async function generateCardAudio(
  db: Db,
  userId: string,
  cardId: string,
  deps: AudioJobDeps = defaultDeps,
): Promise<void> {
  const generation = currentGeneration(cardId);
  const current = () => currentGeneration(cardId) === generation;

  const [row] = await db
    .select({
      front: cards.front,
      audioPath: cards.audioPath,
      audioStatus: cards.audioStatus,
      domain: notes.domain,
      language: notes.language,
    })
    .from(cards)
    .innerJoin(notes, eq(cards.noteId, notes.id))
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .limit(1);

  if (!row) throw new AudioCardNotFoundError();

  const text = ttsTextForCard(
    { domain: row.domain, language: row.language },
    { front: row.front },
  );
  if (text === null) throw new AudioCardIneligibleError();

  const running = jobs.get(cardId);
  if (running?.generation === generation) return running.promise;

  let job!: Promise<void>;
  job = (async () => {
    try {
      if (
        row.audioStatus === "ready" && row.audioPath !== null &&
        await deps.exists(row.audioPath)
      ) {
        return;
      }

      await withWriteLock(async () => {
        if (!current()) return;
        await db
          .update(cards)
          .set({ audioPath: null, audioStatus: "generating" })
          .where(and(eq(cards.id, cardId), eq(cards.userId, userId)));
      });
      if (!current()) return;

      const bytes = await deps.synthesize(text);
      if (!current()) return;
      const audioPath = await deps.write(userId, uuidv7(), bytes);
      if (!current()) {
        await deps.remove(audioPath);
        return;
      }

      const [updated] = await withWriteLock(async () => {
        if (!current()) return [];
        return await db
          .update(cards)
          .set({ audioPath, audioStatus: "ready" })
          .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
          .returning({ id: cards.id });
      });
      if (!current() || !updated) await deps.remove(audioPath);
    } catch (error) {
      if (!current()) return;
      try {
        await withWriteLock(() =>
          db
            .update(cards)
            .set({ audioPath: null, audioStatus: "failed" })
            .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
        );
      } catch (statusError) {
        console.error(
          "failed to persist card audio failure",
          cardId,
          statusError,
        );
      }
      throw error;
    } finally {
      const registered = jobs.get(cardId);
      if (
        registered?.generation === generation && registered.promise === job
      ) {
        jobs.delete(cardId);
      }
    }
  })();
  if (current()) jobs.set(cardId, { generation, promise: job });
  return job;
}

export async function generateNoteAudio(
  db: Db,
  userId: string,
  cardIds: string[],
  concurrency = 2,
) {
  for (let offset = 0; offset < cardIds.length; offset += concurrency) {
    await Promise.all(cardIds.slice(offset, offset + concurrency).map((cardId) =>
      generateCardAudio(db, userId, cardId)
    ));
  }
}

export function resumeOrphanedAudio(
  db: Db,
  userId: string,
  cardRows: AudioCardRow[],
): void {
  for (const card of cardRows) {
    if (card.audioStatus === "pending" || card.audioStatus === "generating") {
      void generateCardAudio(db, userId, card.id).catch((error) =>
        console.error("orphaned audio recovery failed", error)
      );
    }
  }
}
