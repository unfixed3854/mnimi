import "../global.css";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router/stack";
import {
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PortalHost } from "@rn-primitives/portal";
import { onSignedOut } from "@/auth/auth";
import {
  clearRejectedSession,
  getSessionState,
  initializeSession,
  reloadSession,
  subscribeAuth,
} from "@/auth/session-store";
import { onExternalSessionChanged } from "@/auth/session-transport";
import { onSessionRejected } from "@/api/session-rejection";
import { useQueryConnectivity } from "@/hooks/use-query-connectivity";
import { useQueryLifecycle } from "@/hooks/use-query-lifecycle";
import { SystemBars } from "@/components/system-bars";
import { nativeColors } from "@/theme/native-colors";
import { getSession } from "@/auth/session-store";
import {
  getVisibleCreationId,
  installForegroundNotificationPolicy,
  listenForNotificationNavigation,
  unregisterNotificationsForUser,
} from "@/notifications/registration";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  useQueryLifecycle();
  useQueryConnectivity();

  useEffect(() => {
    installForegroundNotificationPolicy(getVisibleCreationId);
    const notificationSubscription = listenForNotificationNavigation((href) =>
      require("expo-router").router.push(href)
    );
    const removeSignOutHandler = onSignedOut(async () => {
      const userId = getSession()?.user.id;
      if (userId) {
        try {
          await unregisterNotificationsForUser(userId, async (token) => {
            const { unregisterNotificationInstallation } = await import(
              "@/api/notifications"
            );
            return await unregisterNotificationInstallation(token);
          });
        } catch (error) {
          console.error("notification unregister failed", error);
        }
      }
      queryClient.clear();
    });
    const removeSessionChangeHandler = onExternalSessionChanged(() => {
      queryClient.clear();
      void reloadSession();
    });
    const removeRejectionHandler = onSessionRejected(async () => {
      if (await clearRejectedSession()) queryClient.clear();
    });
    void initializeSession();
    return () => {
      removeSignOutHandler();
      removeSessionChangeHandler();
      removeRejectionHandler();
      notificationSubscription.remove();
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <SystemBars />
        {children}
        <View
          className="absolute inset-0"
          pointerEvents="box-none"
          testID="nativewind-portal-host"
        >
          <PortalHost />
        </View>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

const startupStyles = StyleSheet.create({
  screen: {
    alignItems: "center",
    backgroundColor: nativeColors.background,
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  content: {
    alignItems: "center",
    gap: 12,
    maxWidth: 360,
  },
  title: {
    color: nativeColors.foreground,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 28,
    textAlign: "center",
  },
  message: {
    color: nativeColors.mutedForeground,
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  retry: {
    alignItems: "center",
    backgroundColor: nativeColors.primary,
    borderRadius: 12,
    justifyContent: "center",
    marginTop: 4,
    minHeight: 48,
    paddingHorizontal: 24,
  },
  retryPressed: {
    opacity: 0.8,
  },
  retryText: {
    color: nativeColors.primaryForeground,
    fontSize: 16,
    fontWeight: "600",
    lineHeight: 24,
  },
});

function StartupState({ status }: { status: "loading" | "error" }) {
  if (status === "loading") {
    return (
      <SafeAreaView style={startupStyles.screen}>
        <View
          accessible
          accessibilityLabel="Connecting to Mnimi"
          accessibilityRole="progressbar"
          accessibilityState={{ busy: true }}
          style={startupStyles.content}
        >
          <ActivityIndicator
            accessibilityElementsHidden
            color={nativeColors.primary}
            importantForAccessibility="no-hide-descendants"
            size="large"
          />
          <Text style={startupStyles.title}>Connecting to Mnimi…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={startupStyles.screen}>
      <View style={startupStyles.content}>
        <Text accessibilityRole="alert" style={startupStyles.title}>
          Can't reach Mnimi
        </Text>
        <Text style={startupStyles.message}>
          Check your connection and make sure the server is available.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void reloadSession()}
          style={({ pressed }) => [
            startupStyles.retry,
            pressed && startupStyles.retryPressed,
          ]}
        >
          <Text style={startupStyles.retryText}>Try again</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

export default function RootLayout() {
  const { session, status } = useSyncExternalStore(
    subscribeAuth,
    getSessionState,
    getSessionState,
  );
  return (
    <AppProviders>
      {status === "ready"
        ? (
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Protected guard={!session}>
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="index" />
            </Stack.Protected>
            <Stack.Protected guard={Boolean(session)}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="decks/[deckId]" />
              <Stack.Screen name="notes/[noteId]" />
              <Stack.Screen name="review/index" />
              <Stack.Screen name="review/[deckId]" />
              <Stack.Screen name="creations/[creationId]" />
              <Stack.Screen name="creations/[creationId]/card/[cardKey]" />
              <Stack.Screen name="devtools" />
            </Stack.Protected>
          </Stack>
        )
        : <StartupState status={status} />}
    </AppProviders>
  );
}
