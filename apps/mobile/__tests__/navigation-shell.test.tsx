import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

type Session = {
  user: {
    id: string;
    email: string;
    name: string;
    nativeLanguage: string;
    uiLanguage: string;
    ttsAutoplay: boolean;
  };
};

let mockSession: Session | null = null;
type SessionStatus = "loading" | "ready" | "error";

let mockSessionStatus: SessionStatus = "ready";
let mockSessionState: {
  session: Session | null;
  status: SessionStatus;
} = {
  session: mockSession,
  status: mockSessionStatus,
};
let mockTabsMounts = 0;
let mockTabScreenOptions: Record<string, unknown> | undefined;
const mockTabOptions: Array<{
  title: string;
  tabBarIcon?: unknown;
  tabBarAccessibilityLabel?: string;
  tabBarBadge?: number;
}> = [];
const mockRedirects: Array<{ href: string; withAnchor?: boolean }> = [];
const mockSubscribers = new Set<() => void>();

function setSessionForTest(next: Session | null) {
  mockSession = next;
  mockSessionState = {
    session: mockSession,
    status: mockSessionStatus,
  };
  mockSubscribers.forEach((subscriber) => subscriber());
}

function mockSetSessionStatusForTest(status: SessionStatus) {
  mockSessionStatus = status;
  mockSessionState = { session: mockSession, status };
  mockSubscribers.forEach((subscriber) => subscriber());
}

jest.mock("expo-router/stack", () => {
  const react = require("react");
  const createElement = react["createElement"];
  const Stack = ({ children }: { children?: React.ReactNode }) => {
    // This double selects the same protected branch Expo Router would select
    // for a deep link: signed-in mounts the app, signed-out mounts auth.
    const wrappers = react.Children.toArray(children);
    const appWrapper = wrappers.find((child: unknown) =>
      react.Children.toArray(
        (child as { props?: { children?: React.ReactNode } }).props?.children,
      )
        .some((screen: unknown) =>
          (screen as { props?: { name?: string } }).props?.name === "(tabs)"
        )
    ) as { props?: { guard?: boolean } } | undefined;
    if (!appWrapper) {
      const LoginRoute = require("../app/(auth)/login").default;
      return createElement(LoginRoute);
    }
    if (!appWrapper.props?.guard) {
      const AuthLayout = require("../app/(auth)/_layout").default;
      return createElement(AuthLayout);
    }
    const TabsLayout = require("../app/(tabs)/_layout").default;
    return createElement(TabsLayout);
  };
  Stack.Screen = () => null;
  Stack.Protected = (
    { guard, children }: { guard: boolean; children?: React.ReactNode },
  ) => guard ? children ?? null : null;
  return { Stack };
});

jest.mock("expo-router/tabs", () => {
  const react = require("react");
  const createElement = react["createElement"];
  const { Text, View } = require("react-native");
  const Tabs = ({ children, screenOptions }: {
    children?: React.ReactNode;
    screenOptions?: Record<string, unknown>;
  }) => {
    mockTabsMounts += 1;
    mockTabScreenOptions = screenOptions;
    return createElement(View, { testID: "tabs-navigator" }, children);
  };
  Tabs.Screen = (
    { options }: { options: { title: string; tabBarIcon?: unknown } },
  ) => {
    mockTabOptions.push(options);
    return createElement(Text, undefined, options.title);
  };
  return { Tabs };
});

jest.mock("expo-router/build/link/Redirect", () => ({
  Redirect: ({ href, withAnchor }: { href: string; withAnchor?: boolean }) => {
    mockRedirects.push({ href, withAnchor });
    return null;
  },
}));

jest.mock("expo-router", () => ({
  Link: ({ children, href, asChild }: {
    children: any;
    href: unknown;
    asChild?: boolean;
  }) => {
    const react = require("react");
    const createElement = react["createElement"];
    const { Text } = require("react-native");

    return asChild
      ? react.cloneElement(children, { href })
      : createElement(Text, undefined, children);
  },
}));

jest.mock("expo-router/build/link/Link", () => ({
  Link: require("react-native").Text,
}));

jest.mock("@/auth/session-store", () => ({
  getSession: () => mockSession,
  getSessionState: () => mockSessionState,
  subscribeAuth: (subscriber: () => void) => {
    mockSubscribers.add(subscriber);
    return () => mockSubscribers.delete(subscriber);
  },
  initializeSession: () => Promise.resolve(),
  reloadSession: () => {
    mockSetSessionStatusForTest("loading");
    return Promise.resolve();
  },
  clearRejectedSession: () => Promise.resolve(true),
}));

jest.mock("@/features/auth/use-registration-enabled", () => ({
  useRegistrationEnabled: () => true,
}));

jest.mock("@/api/session-rejection", () => ({
  onSessionRejected: () => () => undefined,
}));

jest.mock("@/api/drafts", () => ({
  useCurrentDraft: () => ({ data: null }),
}));

jest.mock("@/api/creations", () => ({
  useCreationList: () => ({ data: [
    { group: "ready" },
    { group: "creating" },
  ] }),
  actionableCreationCount: (items: Array<{ group: string }>) =>
    items.filter((item) =>
      ["needsChoice", "ready", "failed"].includes(item.group)
    ).length,
}));

jest.mock("@/notifications/registration", () => ({
  getVisibleCreationId: jest.fn(() => null),
  installForegroundNotificationPolicy: jest.fn(),
  listenForNotificationNavigation: jest.fn(() => ({ remove: jest.fn() })),
  unregisterNotificationsForUser: jest.fn(() => Promise.resolve()),
}));

jest.mock("@/hooks/use-query-connectivity", () => ({
  useQueryConnectivity: () => undefined,
}));

jest.mock("@/hooks/use-query-lifecycle", () => ({
  useQueryLifecycle: () => undefined,
}));

jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);

import RootLayout from "../app/_layout";
import LoginRoute from "../app/(auth)/login";
import SignupRoute from "../app/(auth)/signup";
import { PrimaryButton } from "@/components/primary-button";
import {
  screenSafeAreaEdges,
  tabScreenSafeAreaEdges,
} from "@/components/screen";

describe("native navigation shell", () => {
  beforeEach(() => {
    mockSession = null;
    mockSessionStatus = "ready";
    mockSessionState = {
      session: mockSession,
      status: mockSessionStatus,
    };
    mockTabsMounts = 0;
    mockTabScreenOptions = undefined;
    mockTabOptions.length = 0;
    mockRedirects.length = 0;
    mockSubscribers.clear();
  });

  it("keeps signed-out root content out of the protected navigator", async () => {
    setSessionForTest(null);
    await render(<RootLayout />);

    expect(mockTabsMounts).toBe(0);
    expect(mockRedirects).toEqual([]);
  });

  it("shows connection progress while restoring a persisted session", async () => {
    mockSessionStatus = "loading";
    mockSessionState = {
      session: mockSession,
      status: mockSessionStatus,
    };

    await render(<RootLayout />);

    expect(
      screen.getByRole("progressbar", { name: "Connecting to Mnimi" }),
    ).toBeTruthy();
    expect(screen.getByText("Connecting to Mnimi…")).toBeTruthy();
    expect(screen.queryByRole("header", { name: "Sign in" })).toBeNull();
    expect(mockTabsMounts).toBe(0);
  });

  it("shows a recoverable connection error and returns to progress on retry", async () => {
    mockSessionStatus = "error";
    mockSessionState = {
      session: mockSession,
      status: mockSessionStatus,
    };

    const view = await render(<RootLayout />);

    expect(view.getByRole("alert")).toHaveTextContent("Can't reach Mnimi");
    await fireEvent.press(view.getByRole("button", { name: "Try again" }));

    expect(
      view.getByRole("progressbar", { name: "Connecting to Mnimi" }),
    ).toBeTruthy();
    expect(view.queryByText("Can't reach Mnimi")).toBeNull();
  });

  it("removes the root shell tab history when the session expires", async () => {
    setSessionForTest({
      user: {
        id: "user-1",
        email: "ada@example.com",
        name: "Ada",
        nativeLanguage: "en",
        uiLanguage: "en",
        ttsAutoplay: true,
      },
    });
    const view = await render(<RootLayout />);
    expect(view.getByTestId("tabs-navigator")).toBeTruthy();
    const tabsMountsBeforeExpiration = mockTabsMounts;

    act(() => setSessionForTest(null));

    expect(mockTabsMounts).toBe(tabsMountsBeforeExpiration);
    expect(view.queryByTestId("tabs-navigator")).toBeNull();
    expect(mockRedirects).toEqual([]);
  });

  it("provides a native icon callback for every primary tab", async () => {
    setSessionForTest({
      user: {
        id: "user-1",
        email: "ada@example.com",
        name: "Ada",
        nativeLanguage: "en",
        uiLanguage: "en",
        ttsAutoplay: true,
      },
    });

    await render(<RootLayout />);

    expect(mockTabOptions).toHaveLength(4);
    for (const options of mockTabOptions) {
      expect(options.tabBarIcon).toEqual(expect.any(Function));
    }
  });

  it("labels the Create tab and badges only actionable work", async () => {
    setSessionForTest({
      user: {
        id: "user-1",
        email: "ada@example.com",
        name: "Ada",
        nativeLanguage: "en",
        uiLanguage: "en",
        ttsAutoplay: true,
      },
    });

    await render(<RootLayout />);

    expect(mockTabScreenOptions).toEqual(
      expect.objectContaining({ headerShown: false }),
    );
    expect(mockTabOptions.find((options) => options.title === "Create"))
      .toEqual(expect.objectContaining({
        tabBarAccessibilityLabel: "Create tab",
        tabBarBadge: 1,
      }));
  });

  it("styles the sign-up link with the shared link variant", async () => {
    await render(<LoginRoute />);

    expect(
      screen.getByRole("link", { name: "Create an account" }).props.className,
    ).toContain("text-primary");
  });

  it("renders one compact shared header for each auth route", async () => {
    await render(
      <>
        <LoginRoute />
        <SignupRoute />
      </>,
    );

    const signInHeader = screen.getAllByRole("header", { name: "Sign in" });
    const signupHeader = screen.getAllByRole("header", {
      name: "Create an account",
    });

    expect(signInHeader).toHaveLength(1);
    expect(signupHeader).toHaveLength(1);
    expect(signInHeader[0].parent?.parent?.parent?.parent?.props.className).toContain(
      "pt-sm",
    );
    expect(signupHeader[0].parent?.parent?.parent?.parent?.props.className).toContain(
      "pt-sm",
    );
  });

  it("protects all screen content from the bottom system inset", () => {
    expect(screenSafeAreaEdges).toEqual(["top", "right", "bottom", "left"]);
  });

  it("does not duplicate the bottom system inset inside tab screens", () => {
    expect(tabScreenSafeAreaEdges).toEqual(["top", "right", "left"]);
  });

  it("does not start a second mutation while a button press is pending", async () => {
    let finish!: () => void;
    const mutation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onPress = jest.fn(() => mutation);
    const view = await render(
      <PrimaryButton onPress={onPress}>Save</PrimaryButton>,
    );

    await fireEvent.press(view.getByRole("button", { name: "Save" }));
    await fireEvent.press(view.getByRole("button", { name: "Save" }));

    expect(onPress).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
});
