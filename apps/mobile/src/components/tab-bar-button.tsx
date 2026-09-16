import type { ComponentProps } from "react";
import { Pressable } from "react-native";
import type { BottomTabBarButtonProps } from "expo-router/build/react-navigation/bottom-tabs";

export function TabBarButton({
  android_ripple: _androidRipple,
  ...props
}: BottomTabBarButtonProps) {
  return (
    <Pressable
      {...(props as ComponentProps<typeof Pressable>)}
      android_ripple={{ borderless: false, color: "rgba(49, 92, 77, 0.12)" }}
    />
  );
}
