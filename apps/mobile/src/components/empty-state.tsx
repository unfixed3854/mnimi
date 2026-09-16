import type { ReactNode } from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { EmptyStateArt, type EmptyStateIllustration } from "@/components/empty-state-art";
import { Text } from "@/components/ui/text";

type EmptyStateProps = {
  title: string;
  message?: string;
  illustration: EmptyStateIllustration;
  compact?: boolean;
  action?: ReactNode;
};

export function EmptyState({
  title,
  message,
  illustration,
  compact = false,
  action,
}: EmptyStateProps) {
  return (
    <View
      className={cn("items-center px-md", compact ? "gap-md py-lg" : "gap-lg py-xl")}
      testID="empty-state"
    >
      <EmptyStateArt illustration={illustration} compact={compact} />
      <View accessibilityRole="summary" className="w-full max-w-[300px] items-center gap-sm">
        <Text className={cn(
          "text-center font-semibold",
          compact ? "text-body" : "text-[20px] leading-[27px]",
        )}>
          {title}
        </Text>
        {message
          ? <Text className="text-center text-muted-foreground">{message}</Text>
          : null}
      </View>
      {action ? <View className="max-w-full">{action}</View> : null}
    </View>
  );
}
