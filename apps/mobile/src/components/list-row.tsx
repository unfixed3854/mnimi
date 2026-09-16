import { Ionicons } from "@expo/vector-icons";
import { type ComponentProps, type ReactNode } from "react";
import { type AccessibilityState, Pressable, View } from "react-native";
import { type Href, Link } from "expo-router";
import { cn } from "@/lib/utils";
import { nativeColors } from "@/theme/native-colors";
import { Text } from "@/components/ui/text";

export type ListRowProps = {
  title: string;
  description?: string;
  href?: Href;
  onPress?: () => void;
  leadingIcon?: ComponentProps<typeof Ionicons>["name"];
  trailing?: ReactNode;
  showChevron?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityState?: AccessibilityState;
  className?: string;
};

export function ListRow({
  title,
  description,
  href,
  onPress,
  leadingIcon,
  trailing,
  showChevron,
  disabled = false,
  accessibilityLabel,
  accessibilityState,
  className,
}: ListRowProps) {
  if (__DEV__ && href && onPress) {
    throw new Error("ListRow accepts either href or onPress, not both.");
  }

  const rowClassName = cn(
    "min-h-[56px] flex-row items-center gap-md px-md py-sm",
    href || onPress
      ? "w-full active:bg-surface-muted active:opacity-80"
      : undefined,
    className,
  );
  const label = accessibilityLabel ?? title;
  const shouldShowChevron = showChevron ?? Boolean(href || onPress);
  const rowContent = (
    <>
      {leadingIcon
        ? (
          <Ionicons
            accessibilityElementsHidden
            color={nativeColors.primary}
            importantForAccessibility="no-hide-descendants"
            name={leadingIcon}
            size={22}
          />
        )
        : null}
      <View className="min-w-0 flex-1 gap-xs">
        <Text className="text-body font-semibold">{title}</Text>
        {description
          ? (
            <Text className="text-caption text-muted-foreground">
              {description}
            </Text>
          )
          : null}
      </View>
      {trailing ? <View className="shrink-0">{trailing}</View> : null}
      {shouldShowChevron
        ? (
          <Ionicons
            accessibilityElementsHidden
            color={nativeColors.mutedForeground}
            importantForAccessibility="no-hide-descendants"
            name="chevron-forward"
            size={20}
          />
        )
        : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} asChild>
        <Pressable
          accessibilityLabel={label}
          accessibilityRole="link"
          accessibilityState={accessibilityState}
          className={rowClassName}
          disabled={disabled}
        >
          {rowContent}
        </Pressable>
      </Link>
    );
  }

  if (onPress) {
    return (
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        className={rowClassName}
        disabled={disabled}
        onPress={onPress}
      >
        {rowContent}
      </Pressable>
    );
  }

  return <View className={rowClassName}>{rowContent}</View>;
}
