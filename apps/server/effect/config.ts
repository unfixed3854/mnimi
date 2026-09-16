import { Context, Effect, Layer } from "effect";
import * as Redacted from "effect/Redacted";
import { browserOrigins } from "../browser-origins.ts";
import { isRegistrationEnabled } from "../registration.ts";
import { resolveDatabaseUrl, resolveRuntimePath } from "../runtime-paths.ts";
import { InfrastructureFailure } from "./errors.ts";

export type AppConfigValue = Readonly<{
  server: Readonly<{ hostname: string; port: number }>;
  browser: Readonly<{ corsOrigin: string; origins: readonly string[] }>;
  registration: Readonly<{ enabled: boolean }>;
  database: Readonly<{ url: string }>;
  media: Readonly<{ imagesDir: string; audioDir: string }>;
  auth: Readonly<{
    baseURL: string;
    secret: Redacted.Redacted<string>;
    useSecureCookies: boolean;
  }>;
  ai: Readonly<{
    selected: string;
    openRouter: Readonly<{
      apiKey: Redacted.Redacted<string>;
      classifyModel: string;
      generateModel: string;
      imageModel: string;
      classifyEffort: string | undefined;
      generateEffort: string | undefined;
    }>;
    codex: Readonly<{
      classifyModel: string | undefined;
      classifyEffort: string | undefined;
      generateModel: string | undefined;
      generateEffort: string | undefined;
      codexHome: string;
    }>;
  }>;
  elevenLabs: Readonly<{
    apiKey: Redacted.Redacted<string>;
    model: string;
    voiceId: string;
  }>;
  runtime: Readonly<{
    nodeEnv: string | undefined;
    devtoolsEnabled: boolean;
    readyToken: Redacted.Redacted<string>;
  }>;
  legacyEnvironment: Readonly<Record<string, Redacted.Redacted<string> | undefined>>;
}>;

export class AppConfig extends Context.Tag("@mnimi/server/AppConfig")<
  AppConfig,
  AppConfigValue
>() {}

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value);
  }
  return value;
}

export function captureAppConfig(input: {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
} = {}): AppConfigValue {
  const env = { ...(input.env ?? process.env) };
  const argv = [...(input.argv ?? process.argv.slice(2))];

  const portValue = env.PORT ?? "8788";
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const corsOrigin = env.CORS_ORIGIN ?? "http://localhost:8081,http://127.0.0.1:8081";
  const baseURL = env.BETTER_AUTH_URL ?? "http://127.0.0.1:8788";
  const legacyEnvironment = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value === undefined ? undefined : Redacted.make(value),
    ]),
  );
  const configuredCodexHome = env.CODEX_HOME;
  const codexHome = configuredCodexHome === undefined
    ? resolveRuntimePath("./data/codex")
    : configuredCodexHome === "" ? "" : resolveRuntimePath(configuredCodexHome);

  return freezeDeep({
    server: {
      hostname: env.HOST ?? "0.0.0.0",
      port,
    },
    browser: {
      corsOrigin,
      origins: browserOrigins(corsOrigin),
    },
    registration: {
      enabled: isRegistrationEnabled(env.REGISTRATION_ENABLED),
    },
    database: {
      url: resolveDatabaseUrl(env.DATABASE_URL ?? "file:./data/mnimi.db"),
    },
    media: {
      imagesDir: resolveRuntimePath(env.IMAGES_DIR ?? "./data/images"),
      audioDir: resolveRuntimePath(env.AUDIO_DIR ?? "./data/audio"),
    },
    auth: {
      baseURL,
      secret: Redacted.make(env.BETTER_AUTH_SECRET ?? ""),
      useSecureCookies: env.NODE_ENV === "production" || baseURL.startsWith("https://"),
    },
    ai: {
      selected: env.AI_PROVIDER ?? "openrouter",
      openRouter: {
        apiKey: Redacted.make(env.OPENROUTER_API_KEY ?? ""),
        classifyModel: env.CLASSIFY_MODEL ?? "google/gemini-2.5-flash",
        generateModel: env.GENERATE_MODEL ?? "anthropic/claude-sonnet-4.5",
        imageModel: env.IMAGE_MODEL ?? "black-forest-labs/flux.2-klein-4b",
        classifyEffort: env.CLASSIFY_EFFORT,
        generateEffort: env.GENERATE_EFFORT,
      },
      codex: {
        classifyModel: env.CLASSIFY_MODEL,
        classifyEffort: env.CLASSIFY_EFFORT,
        generateModel: env.GENERATE_MODEL,
        generateEffort: env.GENERATE_EFFORT,
        codexHome,
      },
    },
    elevenLabs: {
      apiKey: Redacted.make(env.ELEVENLABS_API_KEY ?? ""),
      model: env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2",
      voiceId: env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb",
    },
    runtime: {
      nodeEnv: env.NODE_ENV,
      devtoolsEnabled: argv.includes("--devtools"),
      readyToken: Redacted.make(env.MNIMI_DEV_READY_TOKEN ?? ""),
    },
    legacyEnvironment,
  });
}

export function makeAppConfigLayer(input: {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
} = {}): Layer.Layer<AppConfig, InfrastructureFailure, never> {
  const env = { ...(input.env ?? process.env) };
  const argv = [...(input.argv ?? process.argv.slice(2))];
  return Layer.effect(
    AppConfig,
    Effect.try({
      try: () => captureAppConfig({ env, argv }),
      catch: (cause) => new InfrastructureFailure({
        operation: "config.capture",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
    }),
  );
}

export const AppConfigLive = makeAppConfigLayer();

export function materializeLegacyEnvironment(config: AppConfigValue): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(config.legacyEnvironment).map(([key, value]) => [
      key,
      value === undefined ? undefined : Redacted.value(value),
    ]),
  );
}
