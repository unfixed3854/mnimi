import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  elevenLabsModel,
  elevenLabsVoiceId,
  synthesizeSpeech,
} from "./elevenlabs.ts";
import type { Fetcher } from "./elevenlabs.ts";

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
const previousApiKey = process.env.ELEVENLABS_API_KEY;
const previousModel = process.env.ELEVENLABS_MODEL;
const previousVoiceId = process.env.ELEVENLABS_VOICE_ID;

describe("ElevenLabs speech adapter", () => {
  beforeEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_MODEL;
    delete process.env.ELEVENLABS_VOICE_ID;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = previousApiKey;
    if (previousModel === undefined) delete process.env.ELEVENLABS_MODEL;
    else process.env.ELEVENLABS_MODEL = previousModel;
    if (previousVoiceId === undefined) delete process.env.ELEVENLABS_VOICE_ID;
    else process.env.ELEVENLABS_VOICE_ID = previousVoiceId;
  });

  it("posts language text to ElevenLabs with the default voice, model, and MP3 format", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    let recordedUrl: string | URL | Request | undefined;
    let recordedInit: RequestInit | undefined;
    const fetcher: Fetcher = async (url, init) => {
      recordedUrl = url;
      recordedInit = init;
      return new Response(MP3);
    };

    const bytes = await synthesizeSpeech("Ich mag Bananen.", fetcher);

    expect(bytes).toEqual(MP3);
    expect(recordedUrl).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128",
    );
    expect(recordedInit?.method).toBe("POST");
    expect(recordedInit?.headers).toMatchObject({
      "xi-api-key": "test-key",
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    });
    expect(JSON.parse(String(recordedInit?.body))).toEqual({
      text: "Ich mag Bananen.",
      model_id: "eleven_multilingual_v2",
    });
  });

  it("uses explicit ElevenLabs model and voice environment overrides", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    process.env.ELEVENLABS_MODEL = "eleven_turbo_v2_5";
    process.env.ELEVENLABS_VOICE_ID = "voice/with space";
    let recordedUrl: string | URL | Request | undefined;
    let recordedInit: RequestInit | undefined;
    const fetcher: Fetcher = async (url, init) => {
      recordedUrl = url;
      recordedInit = init;
      return new Response(MP3);
    };

    await synthesizeSpeech("Bonjour.", fetcher);

    expect(elevenLabsModel()).toBe("eleven_turbo_v2_5");
    expect(elevenLabsVoiceId()).toBe("voice/with space");
    expect(recordedUrl).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fwith%20space?output_format=mp3_44100_128",
    );
    expect(JSON.parse(String(recordedInit?.body))).toEqual({
      text: "Bonjour.",
      model_id: "eleven_turbo_v2_5",
    });
  });

  it("rejects synthesis when ELEVENLABS_API_KEY is missing", async () => {
    const fetcher = vi.fn<Fetcher>();

    await expect(synthesizeSpeech("Ich mag Bananen.", fetcher)).rejects.toThrow(
      "ELEVENLABS_API_KEY is not set",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-2xx ElevenLabs responses with the response status", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const fetcher: Fetcher = async () =>
      new Response("bad request", { status: 400 });

    await expect(synthesizeSpeech("Ich mag Bananen.", fetcher)).rejects.toThrow(
      "ElevenLabs TTS failed: 400",
    );
  });

  it("rejects successful ElevenLabs responses that contain no audio bytes", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const fetcher: Fetcher = async () => new Response(new Uint8Array());

    await expect(synthesizeSpeech("Ich mag Bananen.", fetcher)).rejects.toThrow(
      "ElevenLabs returned empty audio",
    );
  });

  it("resolves the default fetcher at invocation time", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const staleFetcher = vi.fn(async () => new Response(MP3));
    vi.stubGlobal("fetch", staleFetcher);
    vi.resetModules();
    const freshModule = await import("./elevenlabs.ts");
    const currentFetcher = vi.fn(async () => new Response(MP3));
    vi.stubGlobal("fetch", currentFetcher);

    await expect(freshModule.synthesizeSpeech("Hallo.")).resolves.toEqual(MP3);

    expect(currentFetcher).toHaveBeenCalledOnce();
    expect(staleFetcher).not.toHaveBeenCalled();
  });
});
