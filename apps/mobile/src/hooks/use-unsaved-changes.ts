import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";

export function useUnsavedChanges({ dirty }: { dirty: boolean }) {
  const navigation = useNavigation();
  const pending = useRef<null | (() => void)>(null);
  const [confirming, setConfirming] = useState(false);
  const allowTraversal = useRef(false);

  useEffect(() => {
    if (Platform.OS !== "web" || !dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const requestLeave = useCallback((action: () => void) => {
    if (!dirty) return action();
    pending.current = action;
    setConfirming(true);
  }, [dirty]);

  useEffect(() => {
    if (Platform.OS !== "web" || !dirty || !window.navigation) return;
    const browserNavigation = window.navigation;
    const navigate = (event: NavigateEvent) => {
      if (event.navigationType !== "traverse" || !event.destination.sameDocument) return;
      if (allowTraversal.current) {
        allowTraversal.current = false;
        return;
      }
      if (!event.cancelable) return;
      // Expo restores browser history with resetRoot, which bypasses the native
      // removal guard. Cancel before either the URL or navigation state changes.
      event.preventDefault();
      const destination = event.destination.key;
      requestLeave(() => {
        allowTraversal.current = true;
        void browserNavigation.traverseTo(destination).finished?.catch(() => {
          allowTraversal.current = false;
        });
      });
    };
    browserNavigation.addEventListener("navigate", navigate);
    return () => browserNavigation.removeEventListener("navigate", navigate);
  }, [dirty, requestLeave]);

  const keepEditing = useCallback(() => {
    pending.current = null;
    setConfirming(false);
  }, []);

  const discardAndLeave = useCallback(() => {
    const action = pending.current;
    pending.current = null;
    setConfirming(false);
    if (!action) return;
    action();
  }, []);

  usePreventRemove(dirty, ({ data }) => {
    requestLeave(() => navigation.dispatch(data.action));
  });

  return { confirming, requestLeave, keepEditing, discardAndLeave };
}
