import { type ReactNode } from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";
import { Text } from "@/components/ui/text";

export type SectionHeaderProps = {
  title: string;
  detail?: string;
  trailing?: ReactNode;
  className?: string;
};

export function SectionHeader({
  title,
  detail,
  trailing,
  className,
}: SectionHeaderProps) {
  return (
    <View
      className={cn("flex-row items-end justify-between gap-md", className)}
    >
      <View className="min-w-0 flex-1 gap-xs">
        <Text className="text-[20px] font-semibold">{title}</Text>
        {detail
          ? <Text className="text-caption text-muted-foreground">{detail}</Text>
          : null}
      </View>
      {trailing ? <View className="shrink-0">{trailing}</View> : null}
    </View>
  );
}
