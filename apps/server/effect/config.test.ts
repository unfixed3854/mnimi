import { describe, expect, it } from "vitest";
import { Effect, Exit, Redacted } from "effect";
import {
  AppConfig,
  captureAppConfig,
  makeAppConfigLayer,
  materializeLegacyEnvironment,
} from "./config.ts";
import { InfrastructureFailure } from "./errors.ts";
import { makeTestRuntime } from "./testing.ts";
import { repositoryRoot, resolveDatabaseUrl, resolveRuntimePath } from "../runtime-paths.ts";

const required = {
  BETTER_AUTH_SECRET: "auth-secret",
  OPENROUTER_API_KEY: "router-secret",
  ELEVENLABS_API_KEY: "tts-secret",
  MNIMI_DEV_READY_TOKEN: "ready-secret",
};

describe("AppConfig", () => {
  it("captures every default and raw provider/media field once", () => {
    const config = captureAppConfig({ env: required, argv: ["--devtools"] });
    expect(config.server).toEqual({ hostname: "0.0.0.0", port: 8788 });
    expect(config.browser).toEqual({
      corsOrigin: "http://localhost:8081,http://127.0.0.1:8081",
      origins: ["http://localhost:8081", "http://127.0.0.1:8081"],
    });
    expect(config.registration.enabled).toBe(false);
    expect(config.database.url).toMatch(/\/data\/mnimi\.db$/);
    expect(config.media.imagesDir).toMatch(/\/data\/images$/);
    expect(config.media.audioDir).toMatch(/\/data\/audio$/);
    expect(config.auth.baseURL).toBe("http://127.0.0.1:8788");
    expect(Redacted.value(config.auth.secret)).toBe("auth-secret");
    expect(config.ai.selected).toBe("openrouter");
    expect(Redacted.value(config.ai.openRouter.apiKey)).toBe("router-secret");
    expect(config.ai.openRouter.classifyModel).toBe("google/gemini-2.5-flash");
    expect(config.ai.openRouter.generateModel).toBe("anthropic/claude-sonnet-4.5");
    expect(config.ai.openRouter.imageModel).toBe("black-forest-labs/flux.2-klein-4b");
    expect(config.ai.codex.classifyModel).toBeUndefined();
    expect(config.ai.codex.classifyEffort).toBeUndefined();
    expect(config.ai.codex.generateModel).toBeUndefined();
    expect(config.ai.codex.generateEffort).toBeUndefined();
    expect(config.ai.codex.codexHome).toMatch(/\/data\/codex$/);
    expect(Redacted.value(config.elevenLabs.apiKey)).toBe("tts-secret");
    expect(config.elevenLabs.model).toBe("eleven_multilingual_v2");
    expect(config.elevenLabs.voiceId).toBe("JBFqnCBsd6RMkjVDRZzb");
    expect(config.runtime.nodeEnv).toBeUndefined();
    expect(config.runtime.devtoolsEnabled).toBe(true);
    expect(Redacted.value(config.runtime.readyToken)).toBe("ready-secret");
    const legacy = materializeLegacyEnvironment(config);
    expect(legacy.BETTER_AUTH_SECRET).toBe("auth-secret");
    expect(legacy.MNIMI_DEV_READY_TOKEN).toBe("ready-secret");
  });

  it.each(["invalid", "", "8787.5", "0", "-1", "65536"])(
    "keeps the exact direct PORT error for %j",
    (PORT) => expect(() => captureAppConfig({ env: { PORT } }))
      .toThrow("PORT must be an integer between 1 and 65535"),
  );

  it.each(["1", "65535"])("accepts PORT boundary %j", (PORT) => {
    expect(captureAppConfig({ env: { PORT } }).server.port).toBe(Number(PORT));
  });

  it("distinguishes unset and explicitly empty values and preserves raw fields", () => {
    const defaults = captureAppConfig({ env: {}, argv: [] });
    const empty = captureAppConfig({
      env: {
        CORS_ORIGIN: "",
        HOST: "",
        BETTER_AUTH_URL: "",
        DATABASE_URL: "",
        IMAGES_DIR: "",
        AUDIO_DIR: "",
        AI_PROVIDER: " ",
        CLASSIFY_MODEL: "",
        CLASSIFY_EFFORT: " ",
        GENERATE_MODEL: "",
        GENERATE_EFFORT: " ",
        CODEX_HOME: "",
        ELEVENLABS_MODEL: "",
        ELEVENLABS_VOICE_ID: "",
      },
      argv: ["--other"],
    });
    expect(defaults.browser.origins).toEqual([
      "http://localhost:8081", "http://127.0.0.1:8081",
    ]);
    expect(empty.browser.corsOrigin).toBe("");
    expect(empty.browser.origins).toEqual([]);
    expect(empty.server.hostname).toBe("");
    expect(empty.auth.baseURL).toBe("");
    expect(empty.database.url).toBe("");
    expect(empty.media.imagesDir).toBe(repositoryRoot);
    expect(empty.media.audioDir).toBe(repositoryRoot);
    expect(empty.ai.selected).toBe(" ");
    expect(empty.ai.openRouter.classifyModel).toBe("");
    expect(empty.ai.openRouter.classifyEffort).toBe(" ");
    expect(empty.ai.codex.classifyModel).toBe("");
    expect(empty.ai.codex.classifyEffort).toBe(" ");
    expect(empty.ai.codex.generateModel).toBe("");
    expect(empty.ai.codex.generateEffort).toBe(" ");
    expect(empty.ai.codex.codexHome).toBe("");
    expect(empty.elevenLabs.model).toBe("");
    expect(empty.elevenLabs.voiceId).toBe("");
    expect(empty.runtime.devtoolsEnabled).toBe(false);
  });

  it("covers absolute, relative, non-file, and empty URL/path forms", () => {
    expect(captureAppConfig({ env: { DATABASE_URL: "file:./custom.db" }, argv: [] }).database.url)
      .toBe(resolveDatabaseUrl("file:./custom.db"));
    expect(captureAppConfig({ env: { DATABASE_URL: "file:/tmp/mnimi.db" }, argv: [] }).database.url)
      .toBe("file:/tmp/mnimi.db");
    expect(captureAppConfig({ env: { DATABASE_URL: "file::memory:" }, argv: [] }).database.url)
      .toBe("file::memory:");
    expect(captureAppConfig({ env: { DATABASE_URL: "libsql://example.turso.io" }, argv: [] }).database.url)
      .toBe("libsql://example.turso.io");
    expect(captureAppConfig({ env: { DATABASE_URL: "" }, argv: [] }).database.url).toBe("");
    expect(captureAppConfig({ env: { IMAGES_DIR: "./var/images" }, argv: [] }).media.imagesDir)
      .toBe(resolveRuntimePath("./var/images"));
    expect(captureAppConfig({ env: { IMAGES_DIR: "/tmp/images" }, argv: [] }).media.imagesDir).toBe("/tmp/images");
    expect(captureAppConfig({ env: { IMAGES_DIR: "" }, argv: [] }).media.imagesDir).toBe(repositoryRoot);
    expect(captureAppConfig({ env: { AUDIO_DIR: "./var/audio" }, argv: [] }).media.audioDir)
      .toBe(resolveRuntimePath("./var/audio"));
    expect(captureAppConfig({ env: { AUDIO_DIR: "/tmp/audio" }, argv: [] }).media.audioDir).toBe("/tmp/audio");
    expect(captureAppConfig({ env: { AUDIO_DIR: "" }, argv: [] }).media.audioDir).toBe(repositoryRoot);
  });

  it("trims CORS entries while preserving the raw CORS string", () => {
    const config = captureAppConfig({ env: { CORS_ORIGIN: "  https://a.test, ,https://b.test  " }, argv: [] });
    expect(config.browser.corsOrigin).toBe("  https://a.test, ,https://b.test  ");
    expect(config.browser.origins).toEqual(["https://a.test", "https://b.test"]);
  });

  it("redacts every supplied legacy environment value and preserves an empty ready token", () => {
    const env = {
      BETTER_AUTH_SECRET: "auth", OPENROUTER_API_KEY: "openrouter",
      ELEVENLABS_API_KEY: "eleven", MNIMI_DEV_READY_TOKEN: "",
      HOST: "127.0.0.1", PORT: "9999", CORS_ORIGIN: "https://a.test",
      DATABASE_URL: "file:/tmp/db", IMAGES_DIR: "/tmp/images", AUDIO_DIR: "./audio",
      AI_PROVIDER: "codex", CLASSIFY_MODEL: "classify", CLASSIFY_EFFORT: "high",
      GENERATE_MODEL: "generate", GENERATE_EFFORT: "low", IMAGE_MODEL: "image", CODEX_HOME: "/tmp/codex",
      ELEVENLABS_MODEL: "model", ELEVENLABS_VOICE_ID: "voice",
    };
    const config = captureAppConfig({ env, argv: [] });
    for (const [key, value] of Object.entries(env)) {
      expect(Redacted.value(config.legacyEnvironment[key]!)).toBe(value);
    }
    expect(Redacted.value(config.runtime.readyToken)).toBe("");
    expect(materializeLegacyEnvironment(config)).toMatchObject(env);
  });

  it("uses exact registration and secure-cookie rules without eager provider validation", () => {
    expect(captureAppConfig({ env: { REGISTRATION_ENABLED: "true" } }).registration.enabled).toBe(true);
    expect(captureAppConfig({ env: { REGISTRATION_ENABLED: "TRUE" } }).registration.enabled).toBe(false);
    expect(captureAppConfig({ env: { NODE_ENV: "production" } }).auth.useSecureCookies).toBe(true);
    expect(captureAppConfig({ env: { BETTER_AUTH_URL: "https://example.test" } }).auth.useSecureCookies).toBe(true);
    expect(captureAppConfig({ env: { BETTER_AUTH_URL: "http://example.test" } }).auth.useSecureCookies).toBe(false);
    expect(captureAppConfig({ env: { BETTER_AUTH_URL: "" } }).auth.useSecureCookies).toBe(false);
    expect(captureAppConfig({ env: { AI_PROVIDER: "unknown", OPENROUTER_API_KEY: "" } }).ai.selected).toBe("unknown");
  });

  it("is deeply frozen and stable after source objects change", () => {
    const env: NodeJS.ProcessEnv = { HOST: "before", CLASSIFY_MODEL: "before" };
    const argv = ["--devtools"];
    const config = captureAppConfig({ env, argv });
    env.HOST = "after";
    env.CLASSIFY_MODEL = "after";
    argv[0] = "--other";
    expect(config.server.hostname).toBe("before");
    expect(config.ai.codex.classifyModel).toBe("before");
    expect(config.runtime.devtoolsEnabled).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.browser.origins)).toBe(true);
    expect(() => (config as { server: { hostname: string } }).server.hostname = "mutated").toThrow();
  });

  it("maps direct parser failure to InfrastructureFailure in its Layer", async () => {
    const runtime = makeTestRuntime(makeAppConfigLayer({ env: { PORT: "bad" }, argv: [] }));
    const exit = await runtime.runPromiseExit(Effect.gen(function* () {
      return yield* AppConfig;
    }));
    await runtime.dispose();
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(failure).toBeInstanceOf(InfrastructureFailure);
      expect(failure).toMatchObject({ operation: "config.capture", message: "PORT must be an integer between 1 and 65535" });
    }
  });

  it("acquires AppConfig once and reuses the same frozen object", async () => {
    const runtime = makeTestRuntime(makeAppConfigLayer({ env: { HOST: "one" }, argv: [] }));
    const read = Effect.gen(function* () { return yield* AppConfig; });
    const first = await runtime.runPromise(read);
    const second = await runtime.runPromise(read);
    expect(second).toBe(first);
    await runtime.dispose();
  });
});
