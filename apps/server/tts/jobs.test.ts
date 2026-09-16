import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { cards, decks, notes, user } from "../db/schema.ts";
import type { AudioStatus } from "../db/schema.ts";
import { withWriteLock } from "../db/write-lock.ts";

const defaultAudio = vi.hoisted(() => ({
  synthesize: vi.fn<(text: string) => Promise<Uint8Array>>(),
  write: vi.fn<
    (userId: string, cardId: string, bytes: Uint8Array) => Promise<string>
  >(),
  exists: vi.fn<(relativePath: string) => Promise<boolean>>(),
  remove: vi.fn<(relativePath: string) => Promise<void>>(),
}));

vi.mock("./elevenlabs.ts", () => ({
  synthesizeSpeech: defaultAudio.synthesize,
}));
vi.mock("../audio.ts", () => ({
  writeAudio: defaultAudio.write,
  audioExists: defaultAudio.exists,
  removeAudio: defaultAudio.remove,
}));

import {
  AudioCardIneligibleError,
  AudioCardNotFoundError,
  generateCardAudio,
  generateNoteAudio,
  hasAudioJob,
  invalidateCardAudioJob,
  resumeOrphanedAudio,
} from "./jobs.ts";
import type { AudioJobDeps } from "./jobs.ts";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => void;
let noteId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(user).values([
    {
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "u2",
      name: "Grace",
      email: "grace@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  const [deck] = await db
    .insert(decks)
    .values({ id: "deck-1", userId: "u1", name: "German" })
    .returning();
  const [note] = await db
    .insert(notes)
    .values({
      id: "note-1",
      userId: "u1",
      deckId: deck.id,
      sourceText: "Bananas",
      domain: "language",
      language: "de",
    })
    .returning();
  noteId = note.id;

  defaultAudio.synthesize.mockReset();
  defaultAudio.write.mockReset();
  defaultAudio.exists.mockReset();
  defaultAudio.remove.mockReset();
  defaultAudio.synthesize.mockResolvedValue(new Uint8Array([1, 2, 3]));
  defaultAudio.write.mockImplementation(async (userId, cardId) =>
    `${userId}/${cardId}.mp3`
  );
  defaultAudio.exists.mockResolvedValue(false);
  defaultAudio.remove.mockResolvedValue(undefined);
});

afterEach(() => close());

async function seedCard(
  id: string,
  values: {
    noteId?: string;
    userId?: string;
    front?: string;
    audioPath?: string | null;
    audioStatus?: AudioStatus | null;
  } = {},
) {
  const [card] = await db
    .insert(cards)
    .values({
      id,
      noteId: values.noteId ?? noteId,
      userId: values.userId ?? "u1",
      aspect: "sentence",
      front: values.front ?? "Ich mag {{c1::Bananen}}.",
      back: "I like bananas.",
      due: new Date(),
      audioPath: values.audioPath,
      audioStatus: values.audioStatus,
    })
    .returning();
  return card;
}

async function readCard(id: string) {
  const [card] = await db.select().from(cards).where(eq(cards.id, id));
  return card;
}

function jobDeps(overrides: Partial<AudioJobDeps> = {}): AudioJobDeps {
  return {
    synthesize: vi.fn(async () => new Uint8Array([4, 5, 6])),
    write: vi.fn(async (userId, audioId) => `${userId}/${audioId}.mp3`),
    exists: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
    ...overrides,
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function withDelayedInitialAudioLookup(
  source: typeof db,
  started: ReturnType<typeof deferred>,
  gate: ReturnType<typeof deferred>,
  continued: ReturnType<typeof deferred>,
  front: string,
): typeof db {
  let delayNextSelect = true;
  return new Proxy(source, {
    get(target, prop) {
      if (prop === "select" && delayNextSelect) {
        return () => {
          delayNextSelect = false;
          const query = {
            from: () => query,
            innerJoin: () => query,
            where: () => query,
            limit: async () => {
              started.release();
              await gate.promise;
              // The first turn lets this query settle and enqueue its caller;
              // the second signals after generateCardAudio has made its
              // synchronous registry/coalescing decision.
              queueMicrotask(() => queueMicrotask(continued.release));
              return [{
                front,
                audioPath: null,
                audioStatus: "pending" as const,
                domain: "language",
                language: "de",
              }];
            },
          };
          return query;
        };
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("generateCardAudio", () => {
  it("persists generating then ready and synthesizes the revealed sentence", async () => {
    await seedCard("card-1", { audioStatus: "pending" });
    const transitions: AudioStatus[] = [];
    let savedText = "";
    const deps = jobDeps({
      synthesize: vi.fn(async (text) => {
        savedText = text;
        transitions.push((await readCard("card-1")).audioStatus!);
        return new Uint8Array([9]);
      }),
    });

    await generateCardAudio(db, "u1", "card-1", deps);
    const reloaded = await readCard("card-1");
    transitions.push(reloaded.audioStatus!);

    expect(transitions).toEqual(["generating", "ready"]);
    expect(savedText).toBe("Ich mag Bananen.");
    expect(reloaded.audioPath).toMatch(
      /^u1\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp3$/,
    );
  });

  it("coalesces simultaneous calls into one provider request", async () => {
    await seedCard("card-1", { audioStatus: "pending" });
    const synthesize = vi.fn(async () => new Uint8Array([9]));
    const deps = jobDeps({ synthesize });

    await Promise.all([
      generateCardAudio(db, "u1", "card-1", deps),
      generateCardAudio(db, "u1", "card-1", deps),
    ]);

    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("marks provider failures failed, clears the path, and releases the job", async () => {
    await seedCard("card-1", {
      audioStatus: "pending",
      audioPath: "u1/stale.mp3",
    });
    const failure = new Error("provider unavailable");
    const failingDeps = jobDeps({
      synthesize: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(
      generateCardAudio(db, "u1", "card-1", failingDeps),
    ).rejects.toThrow("provider unavailable");

    const reloaded = await readCard("card-1");
    expect(reloaded.audioStatus).toBe("failed");
    expect(reloaded.audioPath).toBeNull();
    expect(hasAudioJob("card-1")).toBe(false);

    const retrySynthesize = vi.fn(async () => new Uint8Array([7]));
    await generateCardAudio(
      db,
      "u1",
      "card-1",
      jobDeps({ synthesize: retrySynthesize }),
    );
    expect(retrySynthesize).toHaveBeenCalledTimes(1);
  });

  it("authorizes before joining a live job", async () => {
    await seedCard("card-1", { audioStatus: "pending" });
    const gate = deferred();
    const synthesize = vi.fn(async () => {
      await gate.promise;
      return new Uint8Array([9]);
    });
    const run = generateCardAudio(
      db,
      "u1",
      "card-1",
      jobDeps({ synthesize }),
    );
    await vi.waitFor(() => expect(hasAudioJob("card-1")).toBe(true));

    await expect(
      generateCardAudio(db, "u2", "card-1", jobDeps()),
    ).rejects.toBeInstanceOf(AudioCardNotFoundError);
    expect(synthesize).toHaveBeenCalledTimes(1);

    gate.release();
    await run;
  });

  it("rejects missing and ineligible cards without calling the provider", async () => {
    const missingDeps = jobDeps();
    await expect(
      generateCardAudio(db, "u1", "missing", missingDeps),
    ).rejects.toBeInstanceOf(AudioCardNotFoundError);
    expect(missingDeps.synthesize).not.toHaveBeenCalled();

    const [generalNote] = await db
      .insert(notes)
      .values({
        id: "note-general",
        userId: "u1",
        deckId: "deck-1",
        sourceText: "Concept",
        domain: "general",
        language: null,
      })
      .returning();
    await seedCard("card-ineligible", {
      noteId: generalNote.id,
      audioStatus: "pending",
    });
    const ineligibleDeps = jobDeps();
    await expect(
      generateCardAudio(db, "u1", "card-ineligible", ineligibleDeps),
    ).rejects.toBeInstanceOf(AudioCardIneligibleError);
    expect(ineligibleDeps.synthesize).not.toHaveBeenCalled();
  });

  it("skips a ready card whose audio file still exists", async () => {
    await seedCard("card-1", {
      audioStatus: "ready",
      audioPath: "u1/card-1.mp3",
    });
    const exists = vi.fn(async () => true);
    const deps = jobDeps({ exists });

    await generateCardAudio(db, "u1", "card-1", deps);

    expect(exists).toHaveBeenCalledWith("u1/card-1.mp3");
    expect(deps.synthesize).not.toHaveBeenCalled();
    expect((await readCard("card-1")).audioStatus).toBe("ready");
  });

  it("regenerates a ready card whose audio file is missing", async () => {
    await seedCard("card-1", {
      audioStatus: "ready",
      audioPath: "u1/card-1.mp3",
    });
    const synthesize = vi.fn(async () => new Uint8Array([9]));
    const deps = jobDeps({
      exists: vi.fn(async () => false),
      synthesize,
    });

    await generateCardAudio(db, "u1", "card-1", deps);

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect((await readCard("card-1")).audioStatus).toBe("ready");
  });

  it("clears a missing ready file path before delayed regeneration", async () => {
    await seedCard("card-1", {
      audioStatus: "ready",
      audioPath: "u1/card-1.mp3",
    });
    const gate = deferred();
    const deps = jobDeps({
      exists: vi.fn(async () => false),
      synthesize: vi.fn(async () => {
        await gate.promise;
        return new Uint8Array([9]);
      }),
    });

    const run = generateCardAudio(db, "u1", "card-1", deps);
    await vi.waitFor(async () => {
      const active = await readCard("card-1");
      expect(active.audioStatus).toBe("generating");
      expect(active.audioPath).toBeNull();
    });

    gate.release();
    await run;
  });

  it("removes late audio when replacement deleted the card before completion", async () => {
    await seedCard("card-1", { audioStatus: "pending" });
    const gate = deferred();
    const remove = vi.fn(async () => {});
    const deps = jobDeps({
      synthesize: vi.fn(async () => {
        await gate.promise;
        return new Uint8Array([9]);
      }),
      remove,
    });

    const run = generateCardAudio(db, "u1", "card-1", deps);
    await vi.waitFor(async () => {
      expect((await readCard("card-1")).audioStatus).toBe("generating");
    });
    await db.delete(cards).where(eq(cards.id, "card-1"));

    gate.release();
    await run;

    expect(remove).toHaveBeenCalledWith(expect.stringMatching(
      /^u1\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp3$/,
    ));
  });

  it("prevents an invalidated job from attaching stale speech over its replacement", async () => {
    await seedCard("card-1", {
      front: "Ich mag {{c1::Bananen}}.",
      audioStatus: "pending",
    });
    const oldSynthesis = deferredValue<Uint8Array>();
    const replacementSynthesis = deferredValue<Uint8Array>();
    const synthesize = vi.fn()
      .mockImplementationOnce(() => oldSynthesis.promise)
      .mockImplementationOnce(() => replacementSynthesis.promise);
    const write = vi.fn(async (_userId, _cardId, _bytes: Uint8Array) =>
      "u1/card-1-new.mp3"
    );
    const remove = vi.fn(async () => {});
    const deps = jobDeps({ synthesize, write, remove });

    const oldRun = generateCardAudio(db, "u1", "card-1", deps);
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));

    invalidateCardAudioJob("card-1");
    await db.update(cards).set({
      front: "Ich esse {{c1::Äpfel}}.",
      audioPath: null,
      audioStatus: "pending",
    }).where(eq(cards.id, "card-1"));
    const replacementRun = generateCardAudio(db, "u1", "card-1", deps);
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));

    oldSynthesis.resolve(new Uint8Array([1]));
    await oldRun;
    expect(write).not.toHaveBeenCalled();

    const replacementBytes = new Uint8Array([2, 3]);
    replacementSynthesis.resolve(replacementBytes);
    await replacementRun;

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      "u1",
      expect.not.stringMatching(/^card-1$/),
      replacementBytes,
    );
    expect(await readCard("card-1")).toMatchObject({
      audioPath: "u1/card-1-new.mp3",
      audioStatus: "ready",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes only an invalidated generation's bytes when its write finishes late", async () => {
    await seedCard("card-1", {
      front: "Ich mag {{c1::Bananen}}.",
      audioStatus: "pending",
    });
    const staleWriteEntered = deferred();
    const staleWriteGate = deferred();
    const files = new Map<string, Uint8Array>();
    const writtenPaths: string[] = [];
    const write = vi.fn(async (
      userId: string,
      audioId: string,
      bytes: Uint8Array,
    ) => {
      const path = `${userId}/${audioId}.mp3`;
      writtenPaths.push(path);
      if (write.mock.calls.length === 1) {
        staleWriteEntered.release();
        await staleWriteGate.promise;
      }
      files.set(path, bytes);
      return path;
    });
    const remove = vi.fn(async (path: string) => {
      files.delete(path);
    });
    const staleBytes = new Uint8Array([1]);
    const replacementBytes = new Uint8Array([2, 3]);
    const synthesize = vi.fn()
      .mockResolvedValueOnce(staleBytes)
      .mockResolvedValueOnce(replacementBytes);
    const deps = jobDeps({ synthesize, write, remove });

    const staleRun = generateCardAudio(db, "u1", "card-1", deps);
    await staleWriteEntered.promise;

    invalidateCardAudioJob("card-1");
    await db.update(cards).set({
      front: "Ich esse {{c1::Äpfel}}.",
      audioPath: null,
      audioStatus: "pending",
    }).where(eq(cards.id, "card-1"));

    const replacementRun = generateCardAudio(db, "u1", "card-1", deps);
    await replacementRun;
    const replacement = await readCard("card-1");
    expect(files.get(replacement.audioPath!)).toEqual(replacementBytes);

    staleWriteGate.release();
    await staleRun;

    expect(write).toHaveBeenCalledTimes(2);
    expect(writtenPaths[0]).not.toBe(writtenPaths[1]);
    expect(files.get(replacement.audioPath!)).toEqual(replacementBytes);
    expect(remove).toHaveBeenCalledWith(writtenPaths[0]);
  });

  it("does not let an invalidated pre-registration lookup suppress replacement synthesis", async () => {
    await seedCard("card-1", {
      front: "Ich mag {{c1::Bananen}}.",
      audioStatus: "pending",
    });
    const lookupStarted = deferred();
    const lookupGate = deferred();
    const staleLookupContinued = deferred();
    const delayedDb = withDelayedInitialAudioLookup(
      db,
      lookupStarted,
      lookupGate,
      staleLookupContinued,
      "Ich mag {{c1::Bananen}}.",
    );
    const staleSynthesize = vi.fn(async () => new Uint8Array([1]));
    const staleRun = generateCardAudio(
      delayedDb,
      "u1",
      "card-1",
      jobDeps({ synthesize: staleSynthesize }),
    );
    await lookupStarted.promise;

    invalidateCardAudioJob("card-1");
    await db.update(cards).set({
      front: "Ich esse {{c1::Äpfel}}.",
      audioPath: null,
      audioStatus: "pending",
    }).where(eq(cards.id, "card-1"));

    const lockEntered = deferred();
    const lockGate = deferred();
    const heldLock = withWriteLock(async () => {
      lockEntered.release();
      await lockGate.promise;
    });
    await lockEntered.promise;

    lookupGate.release();
    await staleLookupContinued.promise;

    let replacementText = "";
    const replacementSynthesize = vi.fn(async (text: string) => {
      replacementText = text;
      return new Uint8Array([2]);
    });
    const replacementLookupStarted = deferred();
    const replacementLookupGate = deferred();
    const replacementLookupContinued = deferred();
    const replacementDb = withDelayedInitialAudioLookup(
      db,
      replacementLookupStarted,
      replacementLookupGate,
      replacementLookupContinued,
      "Ich esse {{c1::Äpfel}}.",
    );
    const replacementRun = generateCardAudio(
      replacementDb,
      "u1",
      "card-1",
      jobDeps({
        synthesize: replacementSynthesize,
        write: vi.fn(async () => "u1/card-1-replacement.mp3"),
      }),
    );
    await replacementLookupStarted.promise;
    replacementLookupGate.release();
    await replacementLookupContinued.promise;
    await vi.waitFor(() => expect(hasAudioJob("card-1")).toBe(true));

    lockGate.release();
    await Promise.all([heldLock, staleRun, replacementRun]);

    expect(staleSynthesize).not.toHaveBeenCalled();
    expect(replacementText).toBe("Ich esse Äpfel.");
    expect(replacementSynthesize).toHaveBeenCalledTimes(1);
    expect(await readCard("card-1")).toMatchObject({
      audioPath: "u1/card-1-replacement.mp3",
      audioStatus: "ready",
    });
  });

  it("coalesces while a ready card's missing-file check is still running", async () => {
    await seedCard("card-1", {
      audioStatus: "ready",
      audioPath: "u1/card-1.mp3",
    });
    const fileCheckGate = deferred();
    const exists = vi.fn(async () => {
      if (exists.mock.calls.length === 1) await fileCheckGate.promise;
      return false;
    });
    const synthesize = vi.fn(async () => new Uint8Array([9]));
    const deps = jobDeps({ exists, synthesize });

    const slowCall = generateCardAudio(db, "u1", "card-1", deps);
    await vi.waitFor(() => expect(exists).toHaveBeenCalledTimes(1));
    const overlappingCall = generateCardAudio(db, "u1", "card-1", deps);
    await vi.waitFor(() => {
      const firstCallOwnsRegistry = exists.mock.calls.length === 1 &&
        hasAudioJob("card-1");
      const overlappingJobAlreadyFinished = exists.mock.calls.length === 2 &&
        synthesize.mock.calls.length === 1 && !hasAudioJob("card-1");
      expect(firstCallOwnsRegistry || overlappingJobAlreadyFinished).toBe(true);
    });
    fileCheckGate.release();
    await Promise.all([slowCall, overlappingCall]);

    expect(synthesize).toHaveBeenCalledTimes(1);
  });
});

describe("generateNoteAudio", () => {
  it("never exceeds the requested provider concurrency", async () => {
    const cardIds = ["card-1", "card-2", "card-3", "card-4", "card-5"];
    await Promise.all(
      cardIds.map((id) => seedCard(id, { audioStatus: "pending" })),
    );
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    defaultAudio.synthesize.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          active--;
          resolve();
        });
      });
      return new Uint8Array([1]);
    });

    const run = generateNoteAudio(db, "u1", cardIds, 2);
    for (let completed = 0; completed < cardIds.length; completed++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      releases.shift()!();
    }
    await run;

    expect(maximum).toBe(2);
    expect(defaultAudio.synthesize).toHaveBeenCalledTimes(cardIds.length);
  });
});

describe("resumeOrphanedAudio", () => {
  it("restarts pending and generating rows but leaves a live job alone", async () => {
    await seedCard("card-pending", { audioStatus: "pending" });
    await seedCard("card-generating", { audioStatus: "generating" });
    await seedCard("card-live", { audioStatus: "pending" });

    const gate = deferred();
    const liveSynthesize = vi.fn(async () => {
      await gate.promise;
      return new Uint8Array([8]);
    });
    const liveRun = generateCardAudio(
      db,
      "u1",
      "card-live",
      jobDeps({ synthesize: liveSynthesize }),
    );
    await vi.waitFor(() => expect(hasAudioJob("card-live")).toBe(true));

    resumeOrphanedAudio(db, "u1", [
      { id: "card-pending", audioStatus: "pending" },
      { id: "card-generating", audioStatus: "generating" },
      { id: "card-live", audioStatus: "generating" },
    ]);

    await vi.waitFor(async () => {
      expect((await readCard("card-pending")).audioStatus).toBe("ready");
      expect((await readCard("card-generating")).audioStatus).toBe("ready");
    });
    expect(defaultAudio.synthesize).toHaveBeenCalledTimes(2);
    expect(liveSynthesize).toHaveBeenCalledTimes(1);

    gate.release();
    await liveRun;
  });
});
