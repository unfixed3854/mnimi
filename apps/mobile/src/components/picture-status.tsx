import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { PrimaryButton } from "@/components/primary-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { nativeColors } from "@/theme/native-colors";

export function PictureStatus({ generating = false, pending = false, onRetry }: {
  generating?: boolean;
  pending?: boolean;
  onRetry?: () => void | Promise<void>;
}) {
  if (generating) {
    return (
      <Skeleton
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Generating a picture"
        accessibilityState={{ busy: true }}
        className="mb-lg h-48 w-48 self-center"
      />
    );
  }

  return (
    <View className="min-h-12 flex-row items-center gap-sm rounded-md bg-surface-muted pl-sm">
      <Ionicons name="image-outline" size={18} color={nativeColors.mutedForeground}
        accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <Text className="flex-1 py-sm text-[14px] text-muted-foreground" accessibilityLiveRegion="polite">
        Picture unavailable
      </Text>
      {onRetry
        ? <PrimaryButton variant="ghost" pending={pending} onPress={onRetry} accessibilityLabel="Try picture again">Retry</PrimaryButton>
        : null}
    </View>
  );
}
