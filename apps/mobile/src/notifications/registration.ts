import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import type { Subscription } from "expo-notifications";

const key = (userId: string, field: string) =>
  `mnimi:notifications:${userId}:${field}`;

let visibleCreationId: string | null = null;

export function getVisibleCreationId(): string | null {
  return visibleCreationId;
}

export function setVisibleCreationId(creationId: string | null): void {
  visibleCreationId = creationId;
}

type RegisterInstallation = (token: string) => Promise<unknown>;
type UnregisterInstallation = (token: string) => Promise<unknown>;

export async function markNotificationEducationAvailable(userId: string) {
  await AsyncStorage.setItem(key(userId, "education"), "available");
}

export async function notificationEducationAvailable(userId: string) {
  return await AsyncStorage.getItem(key(userId, "education")) === "available";
}

export async function notificationEducationState(userId: string) {
  const value = await AsyncStorage.getItem(key(userId, "education"));
  return value === "available" || value === "complete" ? value : null;
}

export type EnableNotificationsResult =
  | { kind: "enabled"; token: string }
  | { kind: "denied" }
  | { kind: "unavailable" };

export async function enableNotifications(
  userId: string,
  registerInstallation: RegisterInstallation,
): Promise<EnableNotificationsResult> {
  if (!Device.isDevice) return { kind: "unavailable" };
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  if (!projectId) {
    if (__DEV__) console.warn("Notifications unavailable: missing EAS project id");
    return { kind: "unavailable" };
  }
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted
    ? current
    : await Notifications.requestPermissionsAsync();
  if (!permission.granted) {
    await AsyncStorage.multiSet([
      [key(userId, "denied"), "true"],
      [key(userId, "education"), "complete"],
    ]);
    return { kind: "denied" };
  }
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await registerInstallation(token);
  await AsyncStorage.multiSet([
    [key(userId, "token"), token],
    [key(userId, "education"), "complete"],
  ]);
  return { kind: "enabled", token };
}

export async function dismissNotificationEducation(userId: string) {
  await AsyncStorage.setItem(key(userId, "education"), "complete");
}

export async function unregisterNotificationsForUser(
  userId: string,
  unregisterInstallation: UnregisterInstallation,
) {
  const token = await AsyncStorage.getItem(key(userId, "token"));
  try {
    if (token) await unregisterInstallation(token);
  } finally {
    await AsyncStorage.multiRemove([
      key(userId, "token"),
      key(userId, "education"),
      key(userId, "denied"),
    ]);
  }
}

export function installForegroundNotificationPolicy(
  visibleCreationId: () => string | null,
) {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data;
      const isVisible = typeof data?.creationId === "string" &&
        data.creationId === visibleCreationId();
      return {
        shouldShowBanner: !isVisible,
        shouldShowList: !isVisible,
        shouldPlaySound: !isVisible,
        shouldSetBadge: false,
      };
    },
  });
}

export function listenForNotificationNavigation(
  navigate: (href: string) => void,
): Subscription {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (typeof data?.creationId === "string") {
      navigate(`/creations/${data.creationId}`);
    } else if (data?.route === "/add") {
      navigate("/add");
    }
  });
}
