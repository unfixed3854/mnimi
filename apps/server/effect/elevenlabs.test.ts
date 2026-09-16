import { describe, expect, it, vi } from "vitest";
import { Effect, Exit, Layer, Redacted } from "effect";
import {
  ElevenLabs,
  makeElevenLabs,
  makeElevenLabsLayer,
  makeElevenLabsPromiseFacade,
  type ElevenLabsFetcher,
} from "./elevenlabs.ts";
import { AppConfig, type AppConfigValue } from "./config.ts";
import { makeTestRuntime, testService } from "./testing.ts";
import { DependencyUnavailable, ProviderFailure } from "./errors.ts";

const MP3 = new Uint8Array([0x49, 0x44, 0x33]);

describe("ElevenLabs Effect service", () => {
  it("does no request during construction and sends the exact request", async () => {
    const fetcher = vi.fn<ElevenLabsFetcher>(async () => new Response(MP3));
    const service = makeElevenLabs({ apiKey: "secret", model: "model", voiceId: "voice/with space", fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(Effect.runPromise(service.synthesizeSpeech("hello"))).resolves.toEqual(MP3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%2Fwith%20space?output_format=mp3_44100_128");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "xi-api-key": "secret", "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text: "hello", model_id: "model" }),
    });
  });

  it("fails lazily with DependencyUnavailable when the key is missing", async () => {
    const fetcher = vi.fn<ElevenLabsFetcher>();
    const service = makeElevenLabs({ apiKey: "", model: "model", voiceId: "voice", fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    const exit = await Effect.runPromiseExit(service.synthesizeSpeech("hello"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("DependencyUnavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps non-success and empty responses to ProviderFailure without retry", async () => {
    const fetcher = vi.fn<ElevenLabsFetcher>(async () => new Response("bad", { status: 400 }));
    const service = makeElevenLabs({ apiKey: "secret", model: "model", voiceId: "voice", fetcher });
    const statusFailure = await Effect.runPromise(Effect.flip(service.synthesizeSpeech("hello")));
    expect(statusFailure).toBeInstanceOf(ProviderFailure);
    expect(statusFailure.message).toBe("ElevenLabs TTS failed: 400");
    expect(statusFailure.cause).toEqual(new Error("ElevenLabs TTS failed: 400"));
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockImplementation(async () => new Response(new Uint8Array()));
    const emptyFailure = await Effect.runPromise(Effect.flip(service.synthesizeSpeech("hello")));
    expect(emptyFailure).toBeInstanceOf(ProviderFailure);
    expect(emptyFailure.message).toBe("ElevenLabs returned empty audio");
    expect(emptyFailure.cause).toEqual(new Error("ElevenLabs returned empty audio"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains fetch rejection as the ProviderFailure cause", async () => {
    const cause = new Error("network down");
    const fetcher = vi.fn<ElevenLabsFetcher>(async () => { throw cause; });
    const service = makeElevenLabs({ apiKey: "secret", model: "model", voiceId: "voice", fetcher });
    const exit = await Effect.runPromiseExit(service.synthesizeSpeech("hello"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("network down");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("unwraps the original fetch rejection through the Promise facade", async () => {
    const cause = Object.assign(new Error("network down"), { code: "ECONNRESET" });
    const fetcher = vi.fn<ElevenLabsFetcher>(async () => { throw cause; });
    const service = makeElevenLabs({ apiKey: "secret", model: "model", voiceId: "voice", fetcher });
    const facade = makeElevenLabsPromiseFacade(service);
    await expect(facade.synthesizeSpeech("hello")).rejects.toBe(cause);
  });

  it("uses the immutable AppConfig values in its Layer", async () => {
    const fetcher = vi.fn<ElevenLabsFetcher>(async () => new Response(MP3));
    const config = {
      elevenLabs: {
        apiKey: Redacted.make("layer-secret"),
        model: "layer-model",
        voiceId: "layer/voice",
      },
    } as AppConfigValue;
    const runtime = makeTestRuntime(makeElevenLabsLayer({ fetcher }).pipe(
      Layer.provide(testService(AppConfig, config)),
    ));
    try {
      const service = await runtime.runPromise(Effect.gen(function* () {
        return yield* ElevenLabs;
      }));
      await expect(Effect.runPromise(service.synthesizeSpeech("layer text"))).resolves.toEqual(MP3);
      expect(fetcher.mock.calls[0]?.[0]).toContain("layer%2Fvoice");
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ text: "layer text", model_id: "layer-model" });
    } finally {
      await runtime.dispose();
    }
  });

  it("exports the typed failure classes used by the service", () => {
    expect(DependencyUnavailable).toBeDefined();
    expect(ProviderFailure).toBeDefined();
  });
});
