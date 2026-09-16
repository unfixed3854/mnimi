import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing.ts";
import { cards, decks, notes, user } from "../db/schema.ts";
import type { AudioStatus } from "../db/schema.ts";
import { AudioCardIneligibleError, AudioCardNotFoundError, makeAudioJobs, type AudioJobsOptions } from "./audio-jobs.ts";
import { DatabaseFailure, DependencyUnavailable, MediaFailure, ProviderFailure } from "./errors.ts";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  testDb = await createTestDb();
  await testDb.db.insert(user).values([
    { id: "u1", name: "Ada", email: "ada@example.com" },
    { id: "u2", name: "Grace", email: "grace@example.com" },
  ]);
  await testDb.db.insert(decks).values({ id: "deck", userId: "u1", name: "German" });
  await testDb.db.insert(notes).values({ id: "note", userId: "u1", deckId: "deck", sourceText: "Bananas", domain: "language", language: "de" });
});
afterEach(() => { vi.restoreAllMocks(); testDb.close(); });

async function seed(id = "card", values: { audioStatus?: AudioStatus | null; audioPath?: string | null; front?: string } = {}) {
  await testDb.db.insert(cards).values({ id, userId: "u1", noteId: "note", aspect: "sentence", front: "Ich mag {{c1::Bananen}}.", back: "I like bananas.", due: new Date(), audioStatus: "pending", ...values });
}
async function read(id = "card") { return (await testDb.db.select().from(cards).where(eq(cards.id, id)))[0]; }
function gate<A = void>() {
  let resolve!: (a: A) => void;
  const promise = new Promise<A>((r) => { resolve = r; });
  return { promise, resolve };
}
function harness(overrides: Partial<AudioJobsOptions> = {}) {
  const lock = Effect.runSync(Effect.makeSemaphore(1));
  const files = new Map<string, Uint8Array>();
  const texts: string[] = [];
  const media = {
    writeAudio: (owner: string, id: string, bytes: Uint8Array) => Effect.sync(() => {
      const path = `${owner}/${id}.mp3`; files.set(path, bytes); return path;
    }),
    removeAudio: (path: string) => Effect.sync(() => { files.delete(path); }),
    audioExists: (path: string) => Effect.sync(() => files.has(path)),
  };
  const options: AudioJobsOptions = {
    database: { db: testDb.db, withWriteLock: (_operation, effect) => lock.withPermits(1)(effect) },
    elevenLabs: { synthesizeSpeech: (text) => Effect.sync(() => { texts.push(text); return new Uint8Array([1]); }) },
    media,
    ...overrides,
  };
  return { service: makeAudioJobs(options), files, texts, media, options };
}
const run = Effect.runPromise;
const live = (service: ReturnType<typeof makeAudioJobs>, id = "card") => Effect.runSync(service.hasLiveJob(id));

describe("AudioJobs direct service", () => {
  it("persists generating then ready with revealed text and generation-owned media", async () => {
    await seed();
    const transitions: Array<string | null> = [];
    const { service, files } = harness({ elevenLabs: { synthesizeSpeech: (text) => Effect.promise(async () => {
      expect(text).toBe("Ich mag Bananen."); transitions.push((await read()).audioStatus); return new Uint8Array([9]);
    }) } });
    await run(service.generateCard("u1", "card"));
    const row = await read(); transitions.push(row.audioStatus);
    expect(transitions).toEqual(["generating", "ready"]);
    expect(row.audioPath).toMatch(/^u1\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp3$/);
    expect(files.get(row.audioPath!)).toEqual(new Uint8Array([9]));
    expect(live(service)).toBe(false);
  });

  it("coalesces authorized callers while rejecting another owner before joining", async () => {
    await seed(); const blocked = gate<Uint8Array>(); let calls = 0;
    const { service } = harness({ elevenLabs: { synthesizeSpeech: () => Effect.promise(() => { calls++; return blocked.promise; }) } });
    const first = run(service.generateCard("u1", "card"));
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = run(service.generateCard("u1", "card"));
    const unauthorized = await run(Effect.either(service.generateCard("u2", "card")));
    expect(unauthorized).toMatchObject({ _tag: "Left", left: expect.any(AudioCardNotFoundError) });
    expect(live(service)).toBe(true);
    blocked.resolve(new Uint8Array([9])); await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it("rejects missing and ineligible cards before provider work", async () => {
    const { service, texts } = harness();
    expect(await run(Effect.either(service.generateCard("u1", "missing")))).toMatchObject({ _tag: "Left", left: expect.any(AudioCardNotFoundError) });
    await seed(); await testDb.db.update(notes).set({ domain: "general", language: null });
    expect(await run(Effect.either(service.generateCard("u1", "card")))).toMatchObject({ _tag: "Left", left: expect.any(AudioCardIneligibleError) });
    expect(texts).toEqual([]);
  });

  it("persists provider failure, releases the job, and permits retry", async () => {
    await seed("card", { audioPath: "u1/stale.mp3" });
    const failure = new ProviderFailure({ provider: "elevenlabs", operation: "synthesize", message: "offline" });
    let fail = true;
    const { service } = harness({ elevenLabs: { synthesizeSpeech: () => fail ? Effect.fail(failure) : Effect.succeed(new Uint8Array([2])) } });
    expect(await run(Effect.either(service.generateCard("u1", "card")))).toMatchObject({ _tag: "Left", left: failure });
    expect(await read()).toMatchObject({ audioStatus: "failed", audioPath: null });
    expect(live(service)).toBe(false);
    fail = false; await run(service.generateCard("u1", "card"));
    expect((await read()).audioStatus).toBe("ready");
  });

  it("maps unavailable ElevenLabs configuration to the declared provider error", async () => {
    await seed();
    const { service } = harness({ elevenLabs: { synthesizeSpeech: () => Effect.fail(new DependencyUnavailable({ dependency: "elevenlabs", message: "missing key" })) } });
    expect(await run(Effect.either(service.generateCard("u1", "card")))).toMatchObject({ _tag: "Left", left: { _tag: "ProviderFailure", message: "missing key" } });
    expect((await read()).audioStatus).toBe("failed");
  });

  it("skips existing ready audio and regenerates missing audio", async () => {
    await seed("card", { audioStatus: "ready", audioPath: "u1/old.mp3" });
    const { service, texts, files } = harness(); files.set("u1/old.mp3", new Uint8Array([8]));
    await run(service.generateCard("u1", "card")); expect(texts).toEqual([]);
    files.delete("u1/old.mp3"); await run(service.generateCard("u1", "card"));
    expect(texts).toEqual(["Ich mag Bananen."]); expect((await read()).audioStatus).toBe("ready");
  });

  it("clears a missing path while generation is pending", async () => {
    await seed("card", { audioStatus: "ready", audioPath: "u1/old.mp3" });
    const blocked = gate<Uint8Array>();
    const { service } = harness({ elevenLabs: { synthesizeSpeech: () => Effect.promise(() => blocked.promise) } });
    const pending = run(service.generateCard("u1", "card"));
    await vi.waitFor(async () => expect(await read()).toMatchObject({ audioStatus: "generating", audioPath: null }));
    blocked.resolve(new Uint8Array([2])); await pending;
  });

  it("coalesces while an existing-file check is blocked", async () => {
    await seed("card", { audioStatus: "ready", audioPath: "u1/old.mp3" });
    const blocked = gate<boolean>(); const base = harness(); let checks = 0;
    const { service, texts } = harness({ media: { ...base.media, audioExists: () => Effect.promise(() => { checks++; return blocked.promise; }) } });
    const first = run(service.generateCard("u1", "card"));
    await vi.waitFor(() => expect(checks).toBe(1));
    const second = run(service.generateCard("u1", "card")); blocked.resolve(false);
    await Promise.all([first, second]); expect(texts).toHaveLength(1); expect(checks).toBe(1);
  });

  it("removes unattachable media if the card was deleted", async () => {
    await seed(); const blocked = gate<Uint8Array>();
    const { service, files } = harness({ elevenLabs: { synthesizeSpeech: () => Effect.promise(() => blocked.promise) } });
    const pending = run(service.generateCard("u1", "card"));
    await vi.waitFor(async () => expect((await read()).audioStatus).toBe("generating"));
    await testDb.db.delete(cards).where(eq(cards.id, "card")); blocked.resolve(new Uint8Array([9])); await pending;
    expect(files.size).toBe(0); expect(live(service)).toBe(false);
  });

  it("increments the generation before old synthesis can write and does not clear a replacement job", async () => {
    await seed(); const old = gate<Uint8Array>(); const replacement = gate<Uint8Array>(); let calls = 0;
    const { service, files } = harness({ elevenLabs: { synthesizeSpeech: () => Effect.promise(() => ++calls === 1 ? old.promise : replacement.promise) } });
    const first = run(service.generateCard("u1", "card")); await vi.waitFor(() => expect(calls).toBe(1));
    await run(service.invalidate("card")); expect(live(service)).toBe(false);
    const second = run(service.generateCard("u1", "card")); await vi.waitFor(() => expect(calls).toBe(2));
    old.resolve(new Uint8Array([1])); await first;
    expect(files.size).toBe(0); expect(live(service)).toBe(true);
    replacement.resolve(new Uint8Array([2])); await second;
    expect(files.get((await read()).audioPath!)).toEqual(new Uint8Array([2]));
  });

  it("removes only stale generation bytes after a late disk write", async () => {
    await seed(); const blocked = gate(); const entered = gate(); const base = harness(); let writes = 0; const paths: string[] = [];
    const { service } = harness({ media: { ...base.media, writeAudio: (owner, id, bytes) => Effect.gen(function* () {
      paths.push(`${owner}/${id}.mp3`);
      if (++writes === 1) { entered.resolve(); yield* Effect.promise(() => blocked.promise); }
      return yield* base.media.writeAudio(owner, id, bytes);
    }) } });
    const first = run(service.generateCard("u1", "card")); await entered.promise;
    await run(service.invalidate("card")); await run(service.generateCard("u1", "card"));
    const replacement = (await read()).audioPath;
    blocked.resolve(); await first;
    expect(paths[0]).not.toBe(paths[1]); expect(base.files.has(paths[0])).toBe(false); expect(base.files.has(replacement!)).toBe(true);
  });

  it("keeps job and generation state local to each service", async () => {
    await seed(); const blocked = gate<Uint8Array>(); let calls = 0;
    const provider = { synthesizeSpeech: () => Effect.promise(() => { calls++; return blocked.promise; }) };
    const a = harness({ elevenLabs: provider }); const b = harness({ elevenLabs: provider });
    const first = run(a.service.generateCard("u1", "card")); await vi.waitFor(() => expect(calls).toBe(1));
    expect(live(b.service)).toBe(false);
    const second = run(b.service.generateCard("u1", "card")); await vi.waitFor(() => expect(calls).toBe(2));
    await run(a.service.invalidate("card")); expect(live(b.service)).toBe(true);
    blocked.resolve(new Uint8Array([9])); await Promise.all([first, second]);
    expect(a.files.size).toBe(0); expect(b.files.size).toBe(1);
  });

  it("does not register stale work after an invalidated initial lookup", async () => {
    await seed(); const entered = gate(); const blocked = gate(); const base = harness(); let initial = true;
    const delayed = new Proxy(testDb.db, { get(target, key) {
      if (key === "select" && initial) return () => {
        initial = false;
        const query = { from: () => query, innerJoin: () => query, where: () => query, limit: async () => {
          entered.resolve(); await blocked.promise;
          return [{ front: "Old {{c1::sentence}}", audioPath: null, audioStatus: "pending", domain: "language", language: "de" }];
        } }; return query;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const { service, texts } = harness({ database: { ...base.options.database, db: delayed } });
    const first = run(service.generateCard("u1", "card")); await entered.promise;
    await run(service.invalidate("card")); await run(service.generateCard("u1", "card"));
    blocked.resolve(); await first;
    expect(texts).toEqual(["Ich mag Bananen."]);
  });

  it("compensates media on attachment database failure and preserves the typed failure", async () => {
    await seed(); const { service, files } = harness();
    await testDb.client.execute("CREATE TRIGGER reject_audio BEFORE UPDATE OF audio_status ON cards WHEN NEW.audio_status = 'ready' BEGIN SELECT RAISE(ABORT, 'attach failed'); END");
    expect(await run(Effect.either(service.generateCard("u1", "card")))).toMatchObject({ _tag: "Left", left: expect.any(DatabaseFailure) });
    expect(files.size).toBe(0); expect(await read()).toMatchObject({ audioStatus: "failed", audioPath: null });
  });

  it("reports a failed cleanup without replacing the original attachment error", async () => {
    await seed(); const base = harness(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { service } = harness({ media: { ...base.media, removeAudio: () => Effect.fail(new MediaFailure({ operation: "remove", message: "denied" })) } });
    await testDb.client.execute("CREATE TRIGGER reject_audio BEFORE UPDATE OF audio_status ON cards WHEN NEW.audio_status = 'ready' BEGIN SELECT RAISE(ABORT, 'attach failed'); END");
    expect(await run(Effect.either(service.generateCard("u1", "card")))).toMatchObject({ _tag: "Left", left: expect.any(DatabaseFailure) });
    expect(log).toHaveBeenCalledWith("failed to remove card audio", "card", expect.any(MediaFailure));
  });

  it("returns a cleanup failure when no earlier attachment failure exists", async () => {
    await seed(); const base = harness(); const failure = new MediaFailure({ operation: "remove", message: "denied" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service } = harness({ media: {
      ...base.media,
      writeAudio: (owner, id, bytes) => Effect.gen(function* () {
        yield* Effect.promise(() => testDb.db.delete(cards).where(eq(cards.id, "card")).execute());
        return yield* base.media.writeAudio(owner, id, bytes);
      }),
      removeAudio: () => Effect.fail(failure),
    } });
    expect(await run(Effect.either(service.generateCard("u1", "card")))).toMatchObject({ _tag: "Left", left: failure });
    expect(live(service)).toBe(false);
  });

  it.each([
    { requested: undefined, expected: 2 },
    { requested: 1, expected: 1 },
    { requested: 3, expected: 2 },
    { requested: 0, expected: 1 },
    { requested: 1.8, expected: 1 },
  ])("bounds note provider concurrency requested=$requested to $expected", async ({ requested, expected }) => {
    const ids = ["a", "b", "c", "d", "e"]; for (const id of ids) await seed(id);
    let active = 0; let maximum = 0; const releases: Array<() => void> = [];
    const { service } = harness({ elevenLabs: { synthesizeSpeech: () => Effect.promise(async () => {
      maximum = Math.max(maximum, ++active); await new Promise<void>((resolve) => releases.push(resolve)); active--; return new Uint8Array([1]);
    }) } });
    const pending = run(service.generateNote("u1", ids, requested));
    await vi.waitFor(() => expect(releases.length).toBeGreaterThanOrEqual(expected));
    for (const _id of ids) { await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0)); releases.shift()!(); }
    await pending; expect(maximum).toBe(expected);
    for (const id of ids) expect((await read(id)).audioStatus).toBe("ready");
  });

  it("logs individual note failures and continues remaining cards", async () => {
    await seed(); const log = vi.spyOn(console, "error").mockImplementation(() => {}); const { service } = harness();
    await run(service.generateNote("u1", ["missing", "card"], 1));
    expect((await read()).audioStatus).toBe("ready");
    expect(log).toHaveBeenCalledWith("card audio generation failed", "missing", expect.any(AudioCardNotFoundError));
  });

  it("resumes pending and generating orphans without waiting, skips live/settled rows and logs failures", async () => {
    for (const id of ["pending", "generating", "live", "ready"]) await seed(id);
    const blocked = gate<Uint8Array>(); let calls = 0; const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { service } = harness({ elevenLabs: { synthesizeSpeech: () => Effect.promise(() => { calls++; return blocked.promise; }) } });
    const first = run(service.generateCard("u1", "live")); await vi.waitFor(() => expect(calls).toBe(1));
    await run(service.resumeOrphaned("u1", [
      { id: "pending", audioStatus: "pending" }, { id: "generating", audioStatus: "generating" },
      { id: "live", audioStatus: "generating" }, { id: "ready", audioStatus: "ready" }, { id: "missing", audioStatus: "pending" },
    ]));
    await vi.waitFor(() => expect(calls).toBe(3));
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("orphaned card audio generation failed", "missing", expect.any(AudioCardNotFoundError)));
    blocked.resolve(new Uint8Array([1])); await first;
    await vi.waitFor(async () => {
      expect((await read("pending")).audioStatus).toBe("ready"); expect((await read("generating")).audioStatus).toBe("ready");
      expect(live(service, "pending")).toBe(false); expect(live(service, "generating")).toBe(false);
    });
    expect((await read("ready")).audioStatus).toBe("pending");
  });
});
