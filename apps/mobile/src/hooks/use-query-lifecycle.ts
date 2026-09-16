import { focusManager } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

/** Keeps TanStack Query's focus state aligned with the native app lifecycle. */
export function useQueryLifecycle(): void {
  useEffect(() => {
    // TanStack Query already tracks browser visibility changes.
    if (Platform.OS === "web") return;
    focusManager.setFocused(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", (state) => {
      focusManager.setFocused(state === "active");
    });
    return () => subscription.remove();
  }, []);
}
