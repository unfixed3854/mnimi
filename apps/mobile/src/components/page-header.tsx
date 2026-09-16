import { Ionicons } from "@expo/vector-icons";
import { type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { type Href, Link } from "expo-router";
import { cn } from "@/lib/utils";
import { nativeColors } from "@/theme/native-colors";
import { Text } from "@/components/ui/text";

export type PageHeaderProps = {
  title: string;
  subtitle?: string;
  back?: { href: Href; label: string };
  trailing?: ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  subtitle,
  back,
  trailing,
  className,
}: PageHeaderProps) {
  // Content titles can be whole requests or notes. Give longer text its own
  // row so navigation and actions cannot squeeze it into a narrow column.
  const stacked = Boolean((back || trailing) && (title.length > 40 || title.includes("\n")));
  const heading = (
    <View className={cn("min-w-0 gap-xs", !stacked && "flex-1")}>
      <View className={cn(!stacked && (back || trailing) && "min-h-12 justify-center")}>
        <Text
          accessibilityRole="header"
          className={stacked
            ? "text-[24px] leading-[32px] font-semibold"
            : "text-title font-bold tracking-[-0.5px]"}
        >
          {title}
        </Text>
      </View>
      {subtitle ? <Text className="text-body text-muted-foreground">{subtitle}</Text> : null}
    </View>
  );

  return (
    <View className={cn("gap-sm pt-sm", className)}>
      <View className="flex-row items-start gap-sm">
        {back
          ? (
            <Link href={back.href} asChild>
              <Pressable
                accessibilityLabel={back.label}
                accessibilityRole="link"
                className="h-12 w-12 items-center justify-center rounded-md active:bg-surface-muted active:opacity-80"
              >
                <Ionicons
                  accessibilityElementsHidden
                  color={nativeColors.foreground}
                  importantForAccessibility="no-hide-descendants"
                  name="chevron-back"
                  size={24}
                />
              </Pressable>
            </Link>
          )
          : null}
        {stacked ? <View className="flex-1" /> : heading}
        {trailing
          ? <View className="min-h-12 justify-center">{trailing}</View>
          : null}
      </View>
      {stacked ? heading : null}
    </View>
  );
}
