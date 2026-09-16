import { Effect } from "effect";
import { Application, type ApplicationServices } from "../effect/application.ts";

/**
 * Router dependencies are a projection of the one application graph. Keeping
 * this at the Effect boundary prevents transport code from selecting services
 * from module globals or rebuilding a Layer per request.
 */
export type RouterServices = Readonly<{
  database: ApplicationServices["database"];
  provider: ApplicationServices["provider"];
  workflows: ApplicationServices["workflows"];
  kickText: ApplicationServices["workflows"]["kickText"];
}>;

export const routerServices: Effect.Effect<RouterServices, never, Application> =
  Effect.map(Application, ({ database, provider, workflows }) => ({
    database,
    provider,
    workflows,
    kickText: workflows.kickText,
  }));
