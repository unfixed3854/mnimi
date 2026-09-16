import { makeElevenLabsPromiseFacade } from "../effect/elevenlabs.ts";

const DEFAULT_MODEL = "eleven_multilingual_v2";
const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const elevenLabsModel = () =>
  process.env.ELEVENLABS_MODEL ?? DEFAULT_MODEL;

export const elevenLabsVoiceId = () =>
  process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE;

const getConfig = () => ({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  model: elevenLabsModel(),
  voiceId: elevenLabsVoiceId(),
});

const defaultFacade = makeElevenLabsPromiseFacade({
  getConfig,
  fetcher: (input, init) => fetch(input, init),
});

export async function synthesizeSpeech(
  text: string,
  fetcher: Fetcher = fetch,
): Promise<Uint8Array> {
  const facade = fetcher === fetch
    ? defaultFacade
    : makeElevenLabsPromiseFacade({ fetcher, getConfig });
  return facade.synthesizeSpeech(text);
}
