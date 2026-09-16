import { useEffect, useRef, useState } from "react";
import { useNavigation } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { View } from "react-native";
import { registerNotificationInstallation } from "@/api/notifications";
import { useSession } from "@/auth/session-store";
import { PrimaryButton } from "@/components/primary-button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import {
  dismissNotificationEducation,
  enableNotifications,
  markNotificationEducationAvailable,
  notificationEducationState,
} from "@/notifications/registration";

export function NotificationLeaveEducation({ active }: { active: boolean }) {
  const userId = useSession()?.user.id ?? null;
  const navigation = useNavigation();
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const action = useRef<unknown>(null);

  useEffect(() => {
    let mounted = true;
    if (!active || !userId) {
      setArmed(false);
      return () => {
        mounted = false;
      };
    }
    void (async () => {
      let state = await notificationEducationState(userId);
      if (state === "complete") return;
      if (state !== "available") {
        await markNotificationEducationAvailable(userId);
        state = "available";
      }
      if (mounted) setArmed(state === "available");
    })();
    return () => {
      mounted = false;
    };
  }, [active, userId]);

  usePreventRemove(active && armed, ({ data }) => {
    action.current = data.action;
    setOpen(true);
  });

  async function continueNavigation(enable: boolean) {
    if (!userId || !action.current) return;
    setPending(true);
    try {
      if (enable) {
        await enableNotifications(userId, registerNotificationInstallation);
      }
      await dismissNotificationEducation(userId);
      const next = action.current;
      action.current = null;
      setArmed(false);
      setOpen(false);
      setTimeout(() => navigation.dispatch(next as never), 0);
    } finally {
      setPending(false);
    }
  }

  if (!open) return null;
  return (
    <Card className="gap-md">
      <Text className="text-[20px] font-semibold">Ready when you are</Text>
      <Text className="text-body text-muted-foreground">
        Mnimi can notify you when this creation is ready or needs a choice.
      </Text>
      <View className="gap-sm">
        <PrimaryButton pending={pending} onPress={() => continueNavigation(true)}>
          Notify me
        </PrimaryButton>
        <PrimaryButton
          variant="outline"
          disabled={pending}
          onPress={() => continueNavigation(false)}
        >
          Continue without notifications
        </PrimaryButton>
      </View>
    </Card>
  );
}
