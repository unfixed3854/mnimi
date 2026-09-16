import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { PrimaryButton } from "@/components/primary-button";
import { Text } from "@/components/ui/text";
import { nativeColors } from "@/theme/native-colors";

type CreationFailurePanelProps = {
  routingFailed: boolean;
  failureMessage: string | null;
  actionError: string | null;
  pending: boolean;
  onRetry: () => void | Promise<void>;
  onDiscard: () => void;
};

export function CreationFailurePanel({
  routingFailed,
  failureMessage: message,
  actionError,
  pending,
  onRetry,
  onDiscard,
}: CreationFailurePanelProps) {
  const failureMessage = message?.trim();
  const standardFailure = !failureMessage || [
    "We couldn't choose a deck. Try again.",
    "We couldn't create these cards. Try again.",
  ].includes(failureMessage);
  return (
    <View className="gap-md rounded-lg border border-border bg-surface p-md">
      <View accessible accessibilityRole="alert" className="gap-sm">
        <View className="flex-row items-center gap-sm">
          <Ionicons
            name="alert-circle-outline"
            size={22}
            color={nativeColors.mutedForeground}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
          <Text className="flex-1 text-body font-semibold">
            {routingFailed ? "Couldn't choose a deck" : "Couldn't create cards"}
          </Text>
        </View>
        <Text className="text-body text-muted-foreground">
          {standardFailure
            ? "Your request is saved. Try again to continue."
            : failureMessage}
        </Text>
      </View>
      {actionError
        ? <Text accessibilityRole="alert" className="text-caption text-destructive">{actionError}</Text>
        : null}
      <View className="gap-xs">
        <PrimaryButton
          pending={pending}
          onPress={onRetry}
        >
          Try again
        </PrimaryButton>
        <PrimaryButton variant="ghost" disabled={pending} onPress={onDiscard}>
          Discard creation
        </PrimaryButton>
      </View>
    </View>
  );
}
