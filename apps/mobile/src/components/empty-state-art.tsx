import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { nativeColors } from "@/theme/native-colors";

export type EmptyStateIllustration = "decks" | "notes" | "cards" | "rest" | "locked";

/** Small, decorative paper compositions shared by native and web. */
export function EmptyStateArt({
  illustration,
  compact = false,
}: {
  illustration: EmptyStateIllustration;
  compact?: boolean;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      pointerEvents="none"
      style={{ width: compact ? 132 : 176, height: compact ? 102 : 136 }}
    >
      <View
        className="absolute h-[136px] w-[176px]"
        style={compact
          ? { top: -17, left: -22, transform: [{ scale: 0.75 }] }
          : { top: 0, left: 0 }}
      >
        <View className="absolute left-[16px] top-[24px] h-[100px] w-[144px] rounded-full bg-primary-soft" />
        <View className="absolute left-[17px] top-[18px] h-[7px] w-[7px] rounded-full bg-primary-soft-strong" />
        <View className="absolute right-[10px] top-[88px] h-[5px] w-[5px] rounded-full bg-primary/30" />
        <View className="absolute right-[18px] top-[14px]">
          <Ionicons name="sparkles-outline" size={18} color={nativeColors.primary} />
        </View>
        {illustration === "rest" || illustration === "locked"
          ? (
            <>
              <View className="absolute left-[42px] top-[18px] h-[88px] w-[88px] items-center justify-center rounded-full border border-primary/15 bg-background">
                <Ionicons
                  name={illustration === "rest" ? "sunny-outline" : "lock-closed-outline"}
                  size={48}
                  color={nativeColors.primary}
                />
              </View>
              {illustration === "rest"
                ? (
                  <View className="absolute bottom-[17px] right-[32px] h-[36px] w-[36px] items-center justify-center rounded-full border-[3px] border-background bg-primary">
                    <Ionicons name="checkmark" size={21} color={nativeColors.primaryForeground} />
                  </View>
                )
                : null}
              <View className="absolute bottom-[21px] left-[26px] h-[2px] w-[32px] rounded-full bg-primary/20" />
            </>
          )
          : illustration === "notes"
          ? (
            <>
              <View
                className="absolute left-[46px] top-[20px] h-[96px] w-[76px] rounded-md border border-primary/15 bg-primary-soft-strong"
                style={{ transform: [{ rotate: "-10deg" }] }}
              />
              <View
                className="absolute left-[55px] top-[13px] h-[96px] w-[76px] gap-[9px] rounded-md border border-border bg-surface px-[13px] py-[17px]"
                style={{ transform: [{ rotate: "5deg" }] }}
              >
                <View className="h-[5px] w-[22px] rounded-full bg-primary/55" />
                <View className="h-[3px] w-[46px] rounded-full bg-border" />
                <View className="h-[3px] w-[38px] rounded-full bg-border" />
                <View className="h-[3px] w-[42px] rounded-full bg-border" />
              </View>
              <View className="absolute bottom-[14px] right-[24px] h-[38px] w-[38px] items-center justify-center rounded-full border-[3px] border-background bg-primary">
                <Ionicons name="pencil-outline" size={19} color={nativeColors.primaryForeground} />
              </View>
            </>
          )
          : (
            <>
              <View
                className="absolute left-[35px] top-[24px] h-[88px] w-[68px] rounded-md border border-primary/15 bg-primary-soft-strong"
                style={{ transform: [{ rotate: "-18deg" }] }}
              />
              <View
                className="absolute left-[75px] top-[24px] h-[88px] w-[68px] rounded-md border border-primary/20 bg-background"
                style={{ transform: [{ rotate: "17deg" }] }}
              />
              <View className="absolute left-[54px] top-[13px] h-[92px] w-[70px] items-center justify-center gap-[12px] rounded-md border border-border bg-surface">
                <View className="h-[34px] w-[34px] items-center justify-center rounded-full bg-primary-soft">
                  <Ionicons
                    name={illustration === "decks" ? "leaf-outline" : "add"}
                    size={22}
                    color={nativeColors.primary}
                  />
                </View>
                <View className="h-[3px] w-[30px] rounded-full bg-primary/25" />
              </View>
            </>
          )}
      </View>
    </View>
  );
}
