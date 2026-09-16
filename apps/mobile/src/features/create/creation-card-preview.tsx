import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import type { CreationCard } from "@/api/creations";
import { CardPreviewContent } from "@/components/card-preview-content";
import { formatAspectLabel } from "@/components/card-presentation";
import { Text } from "@/components/ui/text";
import { nativeColors } from "@/theme/native-colors";

export function CreationCardPreview({ card, pictureAvailable }: {
  card: CreationCard;
  pictureAvailable: boolean;
}) {
  return (
    <View className="gap-sm rounded-lg border border-border bg-surface p-md">
      <View className="flex-row items-center justify-between gap-sm">
        <Text className="text-[13px] font-semibold leading-[20px] text-muted-foreground">
          {formatAspectLabel(card.aspect)}
        </Text>
        <View className="flex-row items-center gap-sm">
          {card.imageCue && pictureAvailable
            ? <Ionicons name="image-outline" size={16} color={nativeColors.mutedForeground} accessibilityLabel="Picture cue" />
            : null}
          <Ionicons name="pencil-outline" size={16} color={nativeColors.mutedForeground} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        </View>
      </View>
      <CardPreviewContent front={card.front} back={card.back} />
    </View>
  );
}
