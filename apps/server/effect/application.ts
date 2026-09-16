import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { Scope } from "effect";
import { makeBackgroundWorkflows, BackgroundWorkflows, type BackgroundWorkflowsService } from "./background-workflows.ts";
import { acquireBackgroundProvider, BackgroundProvider, type BackgroundProviderService } from "./background-provider.ts";
import { AppConfig, type AppConfigValue } from "./config.ts";
import { Auth, type AuthService } from "./auth.ts";
import { Database, type DatabaseService } from "./database.ts";
import { makeElevenLabs, type ElevenLabsService } from "./elevenlabs.ts";
import { makeExpoPush, type ExpoPushService } from "./expo-push.ts";
import { makeAppLayer, type CoreLayerError, type CoreServices } from "./live.ts";
import { makeMediaStore, MediaStore, type MediaStoreService } from "./media.ts";
import { ProviderFailure } from "./errors.ts";

export type ApplicationServices = Readonly<{
  config: AppConfigValue;
  database: DatabaseService;
  auth: AuthService;
  provider: BackgroundProviderService;
  media: MediaStoreService;
  workflows: BackgroundWorkflowsService;
}>;

export class Application extends Context.Tag(
  "@mnimi/server/Application",
)<Application, ApplicationServices>() {}

type ApplicationLayerDependencies = Readonly<{
  core: Layer.Layer<CoreServices, CoreLayerError, never>;
  acquireProvider: (
    config: AppConfigValue,
  ) => Effect.Effect<BackgroundProviderService, ProviderFailure, Scope.Scope>;
  makeWorkflows: typeof makeBackgroundWorkflows;
  makeMedia: (config: AppConfigValue["media"]) => MediaStoreService;
  makeElevenLabs: (config: AppConfigValue["elevenLabs"]) => ElevenLabsService;
  makeExpoPush: () => ExpoPushService;
}>;

const liveDependencies: ApplicationLayerDependencies = {
  core: makeAppLayer(),
  acquireProvider: (config) => acquireBackgroundProvider({ config }),
  makeWorkflows: makeBackgroundWorkflows,
  makeMedia: makeMediaStore,
  makeElevenLabs,
  makeExpoPush,
};

/**
 * Builds the server's one owned application graph. The returned layer exports
 * only Application so adapters cannot acquire ad-hoc copies of its services.
 */
export function makeApplicationLayer(
  overrides: Partial<ApplicationLayerDependencies> = {},
): Layer.Layer<Application, CoreLayerError | ProviderFailure, never> {
  const dependencies = { ...liveDependencies, ...overrides };
  const provider = Layer.scoped(
    BackgroundProvider,
    Effect.flatMap(AppConfig, dependencies.acquireProvider),
  );
  const coreAndProvider = Layer.provideMerge(provider, dependencies.core);
  const media = Layer.effect(
    MediaStore,
    Effect.map(AppConfig, (config) => dependencies.makeMedia(config.media)),
  );
  const coreProviderAndMedia = Layer.provideMerge(media, coreAndProvider);
  const workflows = Layer.scoped(
    BackgroundWorkflows,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const config = yield* AppConfig;
        const database = yield* Database;
        const provider = yield* BackgroundProvider;
        return dependencies.makeWorkflows({
          database,
          provider,
          media: yield* MediaStore,
          elevenLabs: dependencies.makeElevenLabs(config.elevenLabs),
          push: dependencies.makeExpoPush(),
        });
      }),
      (service) => Effect.ensuring(service.stop(), service.settle()),
    ),
  );
  const graph = Layer.provideMerge(workflows, coreProviderAndMedia);
  const application = Layer.effect(
    Application,
    Effect.gen(function* () {
      return {
        config: yield* AppConfig,
        database: yield* Database,
        auth: yield* Auth,
        provider: yield* BackgroundProvider,
        media: yield* MediaStore,
        workflows: yield* BackgroundWorkflows,
      } satisfies ApplicationServices;
    }),
  );
  return Layer.provide(application, graph);
}

export type ApplicationRuntime = ManagedRuntime.ManagedRuntime<
  Application,
  CoreLayerError | ProviderFailure
>;

export function makeApplicationRuntime(
  overrides: Partial<ApplicationLayerDependencies> = {},
): ApplicationRuntime {
  return ManagedRuntime.make(makeApplicationLayer(overrides));
}

export function acquireApplication(
  runtime: ApplicationRuntime,
): Promise<ApplicationServices> {
  return runtime.runPromise(Application);
}
