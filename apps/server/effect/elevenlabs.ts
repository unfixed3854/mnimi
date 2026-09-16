import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import * as Redacted from "effect/Redacted";
import { AppConfig } from "./config.ts";
import { DependencyUnavailable, ProviderFailure } from "./errors.ts";

export type ElevenLabsFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ElevenLabsOptions = Readonly<{
  apiKey?: string | Redacted.Redacted<string>;
  model?: string;
  voiceId?: string;
  fetcher?: ElevenLabsFetcher;
  getConfig?: () => Readonly<{ apiKey: string | Redacted.Redacted<string>; model: string; voiceId: string }>;
}>;

export type ElevenLabsService = Readonly<{
  synthesizeSpeech(text: string): Effect.Effect<Uint8Array, ProviderFailure | DependencyUnavailable>;
}>;

export class ElevenLabs extends Context.Tag("@mnimi/server/ElevenLabs")<
  ElevenLabs,
  ElevenLabsService
>() {}

const DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";

const value = (secret: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(secret) ? Redacted.value(secret) : secret;

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export function makeElevenLabs(options: ElevenLabsOptions): ElevenLabsService {
  const fetcher = options.fetcher ?? fetch;
  return {
    synthesizeSpeech: (text) => Effect.suspend((): Effect.Effect<Uint8Array, ProviderFailure | DependencyUnavailable> => {
      const current = options.getConfig?.() ?? {
        apiKey: options.apiKey ?? "",
        model: options.model ?? DEFAULT_MODEL,
        voiceId: options.voiceId ?? DEFAULT_VOICE,
      };
      const key = value(current.apiKey);
      if (!key) {
        return Effect.fail(new DependencyUnavailable({
          dependency: "elevenlabs",
          message: "ELEVENLABS_API_KEY is not set",
        }));
      }
      const voice = encodeURIComponent(current.voiceId);
      return Effect.tryPromise({
        try: async () => {
          const response = await fetcher(
            `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
            {
              method: "POST",
              headers: {
                "xi-api-key": key,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
              },
              body: JSON.stringify({ text, model_id: current.model }),
            },
          );
          if (!response.ok) {
            const message = `ElevenLabs TTS failed: ${response.status}`;
            throw new ProviderFailure({
              provider: "elevenlabs",
              operation: "elevenlabs.synthesizeSpeech",
              message,
              cause: new Error(message),
            });
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength === 0) {
            const message = "ElevenLabs returned empty audio";
            throw new ProviderFailure({
              provider: "elevenlabs",
              operation: "elevenlabs.synthesizeSpeech",
              message,
              cause: new Error(message),
            });
          }
          return bytes;
        },
        catch: (cause) => cause instanceof ProviderFailure ? cause : new ProviderFailure({
          provider: "elevenlabs",
          operation: "elevenlabs.synthesizeSpeech",
          message: messageOf(cause),
          cause,
        }),
      });
    }),
  };
}

export function makeElevenLabsLayer(
  dependencies: Pick<ElevenLabsOptions, "fetcher"> = {},
): Layer.Layer<ElevenLabs, never, AppConfig> {
  return Layer.effect(
    ElevenLabs,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return makeElevenLabs({
        apiKey: config.elevenLabs.apiKey,
        model: config.elevenLabs.model,
        voiceId: config.elevenLabs.voiceId,
        fetcher: dependencies.fetcher,
      });
    }),
  );
}

export const ElevenLabsLive = makeElevenLabsLayer();

export type ElevenLabsPromiseFacade = Readonly<{
  synthesizeSpeech(text: string): Promise<Uint8Array>;
}>;

export function makeElevenLabsPromiseFacade(service: ElevenLabsService): ElevenLabsPromiseFacade;
export function makeElevenLabsPromiseFacade(options: {
  fetcher?: ElevenLabsFetcher;
  getConfig: () => Readonly<{ apiKey: string; model: string; voiceId: string }>;
}): ElevenLabsPromiseFacade;
export function makeElevenLabsPromiseFacade(input: ElevenLabsService | {
  fetcher?: ElevenLabsFetcher;
  getConfig: () => Readonly<{ apiKey: string; model: string; voiceId: string }>;
}): ElevenLabsPromiseFacade {
  const implementation = "synthesizeSpeech" in input ? input : makeElevenLabs({
    fetcher: input.fetcher,
    getConfig: input.getConfig,
  });
  return {
    synthesizeSpeech: async (text) => {
      const exit = await Effect.runPromiseExit(implementation.synthesizeSpeech(text));
      if (Exit.isSuccess(exit)) return exit.value;
      const typed = Option.getOrUndefined(Cause.failureOption(exit.cause));
      if (typed instanceof DependencyUnavailable || typed instanceof ProviderFailure) {
        if (typed.cause !== undefined) throw typed.cause;
        throw new Error(typed.message);
      }
      throw Cause.squash(exit.cause);
    },
  };
}
