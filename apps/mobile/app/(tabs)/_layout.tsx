import { useSyncExternalStore } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Redirect } from "expo-router/build/link/Redirect";
import { Tabs } from "expo-router/tabs";
import { getSession, subscribeAuth } from "@/auth/session-store";
import { TabBarButton } from "@/components/tab-bar-button";
import { nativeColors } from "@/theme/native-colors";
import {
  actionableCreationCount,
  useCreationList,
} from "@/api/creations";

export default function TabsLayout() {
  const session = useSyncExternalStore(subscribeAuth, getSession, getSession);
  const { data: creations } = useCreationList();
  const creationBadge = actionableCreationCount(creations ?? []);

  // Do not mount the navigator until the synchronous auth store confirms a
  // session. This makes a boot-time null and a live expiry equally safe.
  if (!session) return <Redirect href="/login" withAnchor />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: nativeColors.primary,
        tabBarInactiveTintColor: nativeColors.mutedForeground,
        tabBarButton: TabBarButton,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Today",
          tabBarAccessibilityLabel: "Today tab",
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons
              name={focused ? "calendar" : "calendar-outline"}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="decks"
        options={{
          title: "Decks",
          tabBarAccessibilityLabel: "Decks tab",
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons
              name={focused ? "layers" : "layers-outline"}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="add"
        options={{
          title: "Create",
          tabBarAccessibilityLabel: "Create tab",
          tabBarBadge: creationBadge || undefined,
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons
              name={focused ? "add-circle" : "add-circle-outline"}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarAccessibilityLabel: "Settings tab",
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons
              name={focused ? "settings" : "settings-outline"}
              color={color}
              size={size}
            />
          ),
        }}
      />
    </Tabs>
  );
}
