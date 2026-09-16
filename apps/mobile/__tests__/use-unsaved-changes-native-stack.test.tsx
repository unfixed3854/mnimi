import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  act,
  cleanup,
  fireEvent,
  renderRouter,
} from "expo-router/testing-library";
import Stack from "expo-router/stack";
import { router } from "expo-router/build/imperative-api";
import { useNavigation } from "expo-router/build/useNavigation";
import { StackActions } from "expo-router/react-navigation";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

jest.mock("expo-router", () => ({
  useNavigation: require("expo-router/build/useNavigation").useNavigation,
}));

let dispatchGesture: (() => void) | undefined;

function Layout() {
  return <Stack />;
}

function Home() {
  return <Text>Home route</Text>;
}

function DirtyEditor() {
  const navigation = useNavigation();
  const [dirty] = useState(true);
  const guard = useUnsavedChanges({ dirty });
  dispatchGesture = () => navigation.dispatch(StackActions.pop(1));

  return (
    <View>
      <Text>Dirty editor</Text>
      {guard.confirming
        ? (
          <Pressable
            accessibilityRole="button"
            onPress={guard.discardAndLeave}
          >
            <Text>Discard changes</Text>
          </Pressable>
        )
        : null}
    </View>
  );
}

describe("native-stack unsaved changes", () => {
  afterEach(async () => {
    dispatchGesture = undefined;
    await cleanup();
    jest.useRealTimers();
  });

  it.each([
    ["native gesture POP", () => dispatchGesture!()],
    ["Android Back GO_BACK", () => router.back()],
  ])("prevents %s until the pending action is confirmed", async (_label, leave) => {
    const navigationView = renderRouter(
      {
        _layout: Layout,
        index: Home,
        edit: DirtyEditor,
      },
      { initialUrl: "/" },
    );
    const view = await navigationView;
    // This route belongs to the test router, not Expo's generated app routes.
    await act(async () => router.push("./edit"));
    expect(navigationView.getPathname()).toBe("/edit");

    await act(async () => leave());

    expect(navigationView.getPathname()).toBe("/edit");
    expect(view.getByText("Dirty editor")).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByRole("button", { name: "Discard changes" }));
    });
    expect(navigationView.getPathname()).toBe("/");
  });
});
