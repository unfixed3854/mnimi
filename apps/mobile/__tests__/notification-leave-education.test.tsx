let mockPrevent: ((event: any) => void) | null = null;
const mockDispatch = jest.fn();
const mockEnable = jest.fn((_userId: string, _register: unknown) =>
  Promise.resolve({ kind: "enabled" })
);
const mockDismiss = jest.fn((_userId: string) => Promise.resolve());

jest.mock("expo-router", () => ({
  useNavigation: () => ({ dispatch: mockDispatch }),
}));
jest.mock("expo-router/react-navigation", () => ({
  usePreventRemove: (prevent: boolean, callback: (event: any) => void) => {
    if (prevent) mockPrevent = callback;
  },
}));
jest.mock("@/auth/session-store", () => ({
  useSession: () => ({ user: { id: "user-1" } }),
}));
jest.mock("@/api/notifications", () => ({
  registerNotificationInstallation: jest.fn(),
}));
jest.mock("@/notifications/registration", () => ({
  notificationEducationState: jest.fn(() => Promise.resolve("available")),
  markNotificationEducationAvailable: jest.fn(() => Promise.resolve()),
  dismissNotificationEducation: (userId: string) => mockDismiss(userId),
  enableNotifications: (userId: string, register: unknown) =>
    mockEnable(userId, register),
}));

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { NotificationLeaveEducation } from "@/features/create/notification-leave-education";

describe("notification education on leave", () => {
  beforeEach(() => {
    mockPrevent = null;
    jest.clearAllMocks();
  });

  it("preserves the intended navigation after a one-time decline", async () => {
    const view = await render(<NotificationLeaveEducation active />);
    await waitFor(() => expect(mockPrevent).toEqual(expect.any(Function)));
    const action = { type: "GO_BACK" };
    await act(async () => mockPrevent?.({ data: { action } }));
    expect(view.getByText(/notify you when this creation is ready/i)).toBeTruthy();
    await act(async () =>
      fireEvent.press(view.getByRole("button", {
        name: "Continue without notifications",
      }))
    );
    await waitFor(() => expect(mockDispatch).toHaveBeenCalledWith(action));
    expect(mockEnable).not.toHaveBeenCalled();
    expect(mockDismiss).toHaveBeenCalledWith("user-1");
  });
});
