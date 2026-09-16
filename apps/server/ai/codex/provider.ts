import { Effect } from "effect";
import type { AiProvider } from "../provider-types.ts";
import {
  CodexRuntime,
  createCodexImageGenerator,
  createCodexModelCalls,
  makeCodexManagedRuntime,
  makeCodexPromiseFacade,
  unwrapCodexFailure,
} from "../../effect/codex-runtime.ts";
import type { CodexRuntimeClientFactory } from "../../effect/codex-runtime.ts";
import { readCodexRoleConfig } from "./config.ts";
import type { runCodexTurn } from "./operation.ts";

// Compatibility exports; the creation jobs and image scheduler remove these
// in their migration child when they consume CodexRuntime directly. The
// provider facade itself moves to unified runtime ownership afterwards.
export { createCodexImageGenerator, createCodexModelCalls };

type CodexProviderOptions = {
  env?: NodeJS.ProcessEnv;
  createClient?: CodexRuntimeClientFactory;
  runTurn?: typeof runCodexTurn;
};

export async function createCodexProvider({
  env = process.env,
  createClient,
  runTurn,
}: CodexProviderOptions = {}): Promise<AiProvider> {
  const config = readCodexRoleConfig(env);
  const runtime = makeCodexManagedRuntime(config, {
    env,
    ...(createClient === undefined ? {} : { createClient }),
    ...(runTurn === undefined ? {} : { runTurn }),
  });

  try {
    const service = await runtime.runPromise(Effect.gen(function* () {
      return yield* CodexRuntime;
    }));
    return makeCodexPromiseFacade(service, {
      run: runtime.runPromise.bind(runtime),
      close: async () => {
        try {
          await runtime.dispose();
        } catch (error) {
          throw unwrapCodexFailure(error);
        }
      },
    });
  } catch (error) {
    const primary = unwrapCodexFailure(error);
    try {
      await runtime.dispose();
    } catch {
      // Preserve the startup failure if cleanup also fails.
    }
    throw primary;
  }
}
