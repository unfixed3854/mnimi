const mockStorage = new Map<string, string>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  }),
  multiSet: jest.fn((entries: Array<[string, string]>) => {
    for (const [key, value] of entries) mockStorage.set(key, value);
    return Promise.resolve();
  }),
  multiRemove: jest.fn((keys: string[]) => {
    for (const key of keys) mockStorage.delete(key);
    return Promise.resolve();
  }),
}));
jest.mock("expo-device", () => ({ isDevice: true }));
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
}));
jest.mock("@/api/notifications", () => ({
  registerNotificationInstallation: jest.fn(),
  unregisterNotificationInstallation: jest.fn(),
}));

import * as Notifications from "expo-notifications";
import * as NotificationApi from "@/api/notifications";
import {
  enableNotifications,
  installForegroundNotificationPolicy,
  listenForNotificationNavigation,
  markNotificationEducationAvailable,
  notificationEducationAvailable,
  unregisterNotificationsForUser,
} from "@/notifications/registration";

const mockRegister = jest.mocked(NotificationApi.registerNotificationInstallation);
const mockUnregister = jest.mocked(
  NotificationApi.unregisterNotificationInstallation,
);
const mockGetPermissions = jest.mocked(Notifications.getPermissionsAsync);
const mockRequestPermissions = jest.mocked(Notifications.requestPermissionsAsync);
const mockGetToken = jest.mocked(Notifications.getExpoPushTokenAsync);
const mockSetHandler = jest.mocked(Notifications.setNotificationHandler);
const mockAddResponse = jest.mocked(
  Notifications.addNotificationResponseReceivedListener,
);

describe("notification registration", () => {
  beforeEach(() => {
    mockStorage.clear();
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = "project-1";
    mockGetPermissions.mockResolvedValue({ granted: false } as never);
    mockRequestPermissions.mockResolvedValue({ granted: true } as never);
    mockGetToken.mockResolvedValue({
      data: "ExponentPushToken[device-one]",
    } as never);
    mockRegister.mockResolvedValue({ ok: true });
    mockUnregister.mockResolvedValue({ ok: true });
  });

  it("does not request permission until the learner explicitly enables it", async () => {
    await markNotificationEducationAvailable("user-1");
    expect(await notificationEducationAvailable("user-1")).toBe(true);
    expect(mockRequestPermissions).not.toHaveBeenCalled();

    await expect(enableNotifications("user-1", mockRegister)).resolves.toEqual({
      kind: "enabled",
      token: "ExponentPushToken[device-one]",
    });
    expect(mockGetToken).toHaveBeenCalledWith({ projectId: "project-1" });
    expect(mockRegister).toHaveBeenCalledWith("ExponentPushToken[device-one]");
  });

  it("persists denial without registering an installation", async () => {
    mockRequestPermissions.mockResolvedValue({ granted: false } as never);
    await expect(enableNotifications("user-1", mockRegister)).resolves.toEqual({
      kind: "denied",
    });
    expect(mockRegister).not.toHaveBeenCalled();
    expect([...mockStorage.values()]).toContain("true");
  });

  it("suppresses the visible detail and routes single or grouped responses", async () => {
    installForegroundNotificationPolicy(() => "creation-1");
    const handler = (mockSetHandler.mock.calls[0][0] as any).handleNotification;
    await expect(handler({
      request: { content: { data: { creationId: "creation-1" } } },
    } as any)).resolves.toMatchObject({ shouldShowBanner: false });

    const navigate = jest.fn();
    mockAddResponse.mockReturnValue({ remove: jest.fn() });
    listenForNotificationNavigation(navigate);
    const listener = mockAddResponse.mock.calls[0][0]!;
    listener({ notification: { request: { content: { data: {
      creationId: "creation-2",
    } } } } } as any);
    listener({
      notification: { request: { content: { data: { route: "/add" } } } },
    } as any);
    expect(navigate).toHaveBeenNthCalledWith(1, "/creations/creation-2");
    expect(navigate).toHaveBeenNthCalledWith(2, "/add");
  });

  it("unregisters the stored token before clearing local state", async () => {
    mockStorage.set(
      "mnimi:notifications:user-1:token",
      "ExponentPushToken[device-one]",
    );
    await unregisterNotificationsForUser("user-1", mockUnregister);
    expect(mockUnregister).toHaveBeenCalledWith("ExponentPushToken[device-one]");
    expect(mockStorage.size).toBe(0);
  });

  it("clears local installation state when unregister transport fails", async () => {
    mockStorage.set(
      "mnimi:notifications:user-1:token",
      "ExponentPushToken[device-one]",
    );
    mockUnregister.mockRejectedValue(new Error("offline"));

    await expect(unregisterNotificationsForUser("user-1", mockUnregister))
      .rejects.toThrow("offline");
    expect(mockStorage.size).toBe(0);
  });
});
