import * as z from "zod";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { authed, runRouter } from "./base.ts";
import { pushInstallations } from "../db/schema.ts";
import { isExpoPushToken } from "../notifications/expo-push.ts";
import { Application } from "../effect/application.ts";
import { DatabaseFailure } from "../effect/errors.ts";

const tokenSchema = z.string().trim().min(1).max(300).refine(isExpoPushToken, {
  message: "Invalid notification token",
});

const databaseEffect = <A>(operation: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new DatabaseFailure({ operation, cause }),
  });

const register = authed.input(z.object({
  token: tokenSchema,
  platform: z.literal("android"),
})).handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
  const { database } = yield* Application;
  yield* database.withWriteLock("notifications.register", Effect.gen(function* () {
    const [existing] = yield* databaseEffect(
      "notifications.find-installation",
      () => database.db.select({ id: pushInstallations.id })
        .from(pushInstallations)
        .where(eq(pushInstallations.token, input.token)).limit(1),
    );
    if (existing) {
      yield* databaseEffect("notifications.update-installation", () =>
        database.db.update(pushInstallations).set({
          userId: context.userId,
          platform: input.platform,
          updatedAt: new Date(),
        }).where(eq(pushInstallations.id, existing.id)),
      );
      return;
    }
    yield* databaseEffect("notifications.insert-installation", () =>
      database.db.insert(pushInstallations).values({
        userId: context.userId,
        token: input.token,
        platform: input.platform,
      }),
    );
  }));
  return { ok: true };
})));

const unregister = authed.input(z.object({ token: tokenSchema }))
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    yield* database.withWriteLock("notifications.unregister", databaseEffect(
      "notifications.delete-installation",
      () => database.db.delete(pushInstallations).where(and(
        eq(pushInstallations.userId, context.userId),
        eq(pushInstallations.token, input.token),
      )),
    ));
    return { ok: true };
  })));

export const notificationsRouter = { register, unregister };
