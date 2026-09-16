import { useSyncExternalStore } from "react";
import { Redirect } from "expo-router/build/link/Redirect";
import { Stack } from "expo-router/stack";
import { getSession, subscribeAuth } from "@/auth/session-store";

export default function AuthLayout() {
  const session = useSyncExternalStore(subscribeAuth, getSession, getSession);

  if (session) return <Redirect href="/(tabs)" withAnchor />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="signup" />
    </Stack>
  );
}
