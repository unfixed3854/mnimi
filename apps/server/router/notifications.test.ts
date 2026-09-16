import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createTestServer } from "./testing.ts";
import { notificationsRouter } from "./notifications.ts";
import { pushInstallations } from "../db/schema.ts";

let server: Awaited<ReturnType<typeof createTestServer>>;
beforeEach(async () => server = await createTestServer());
afterEach(() => server.close());

describe("notification installations", () => {
  it("validates, upserts ownership, and unregisters only the current token", async () => {
    const ada = await server.signIn("ada@example.com");
    const bob = await server.signIn("bob@example.com");
    const token = "ExponentPushToken[device-one]";

    await expect(call(notificationsRouter.register, {
      token: "not-a-token",
      platform: "android",
    }, { context: ada.context })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await call(notificationsRouter.register, { token, platform: "android" }, {
      context: ada.context,
    });
    await call(notificationsRouter.register, { token, platform: "android" }, {
      context: bob.context,
    });
    expect((await server.db.select().from(pushInstallations))[0].userId)
      .toBe(bob.userId);

    await call(notificationsRouter.unregister, { token }, { context: ada.context });
    expect(await server.db.select().from(pushInstallations)).toHaveLength(1);
    await call(notificationsRouter.unregister, { token }, { context: bob.context });
    expect(await server.db.select().from(pushInstallations)
      .where(eq(pushInstallations.token, token))).toHaveLength(0);
  });
});
