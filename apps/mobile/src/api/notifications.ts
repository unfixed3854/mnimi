import { client } from "@/api/orpc";

export async function registerNotificationInstallation(token: string) {
  return await (client as any).notifications.register({
    token,
    platform: "android",
  }) as { ok: true };
}

export async function unregisterNotificationInstallation(token: string) {
  return await (client as any).notifications.unregister({ token }) as { ok: true };
}
