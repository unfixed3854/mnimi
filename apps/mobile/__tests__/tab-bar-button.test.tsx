import { Text } from "react-native";
import type { BottomTabBarButtonProps } from "expo-router/build/react-navigation/bottom-tabs";
import { TabBarButton } from "@/components/tab-bar-button";

describe("TabBarButton", () => {
  it("keeps press feedback inside the app tab bar", () => {
    const onPress = jest.fn();
    const button = TabBarButton({
      children: <Text>Today</Text>,
      onPress,
      testID: "today-tab-button",
    } as BottomTabBarButtonProps);

    expect(button.props.android_ripple).toEqual({
      borderless: false,
      color: "rgba(49, 92, 77, 0.12)",
    });

    (button.props.onPress as () => void)();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
