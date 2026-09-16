import { View } from "react-native";
import type { DraftState } from "@/lib/draft-state";
import { draftStatusText, formatElapsed } from "@/lib/draft-status";
import { useElapsed } from "@/hooks/use-elapsed";
import { Text } from "@/components/ui/text";

export function DraftStatus({ state }: { state: DraftState }) {
  const elapsed = useElapsed(
    state.status === "loading" || state.status === "none"
      ? null
      : state.startedAt,
    state.status === "generating",
  );
  if (state.status === "loading" || state.status === "none") return null;
  return (
    <View className="flex-row justify-between">
      <Text accessibilityRole="alert" className="text-muted-foreground">
        {draftStatusText(state)}
      </Text>
      <Text className="text-caption text-muted-foreground">
        {formatElapsed(elapsed)}
      </Text>
    </View>
  );
}
