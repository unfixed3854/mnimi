import { View } from "react-native";
import {
  actionableCreationCount,
  useCreationList,
} from "@/api/creations";
import { Text } from "@/components/ui/text";

export function DraftIndicator({ count }: { count?: number }) {
  const { data } = useCreationList();
  const actionable = count ?? actionableCreationCount(data ?? []);
  if (actionable === 0) return null;
  const label = `${actionable} ${actionable === 1 ? "creation" : "creations"} need attention`;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      className="flex-row items-center gap-xs"
    >
      <View className="h-2 w-2 rounded-full bg-primary" />
      <Text className="text-[12px] text-muted-foreground">{actionable}</Text>
    </View>
  );
}
