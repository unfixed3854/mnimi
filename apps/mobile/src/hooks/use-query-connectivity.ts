import NetInfo from "@react-native-community/netinfo";
import { onlineManager } from "@tanstack/react-query";
import { useEffect } from "react";
import { Platform } from "react-native";

/** Lets TanStack Query pause retries while the device is offline. */
export function useQueryConnectivity(): void {
  useEffect(() => {
    // Browser online/offline events are already handled by TanStack Query.
    // NetInfo's external reachability probe can fail while our API is reachable.
    if (Platform.OS === "web") return;
    onlineManager.setEventListener((setOnline) =>
      NetInfo.addEventListener((state) => {
        setOnline(
          Boolean(state.isConnected) && state.isInternetReachable !== false,
        );
      })
    );
  }, []);
}
