import { useEffect, useState } from "react";
import { Animated, AppState, Easing, Platform, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Text } from "@/components/ui/text";
import { nativeColors } from "@/theme/native-colors";

/** Decorative activity only: this never represents a count or completion estimate. */
export function CreationActivity({
  title,
  description,
  secondary,
  compact,
}: {
  title: string;
  description: string;
  secondary?: string;
  compact: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [phase] = useState(() => new Animated.Value(0));

  useEffect(() => {
    phase.setValue(0);
    if (reducedMotion) return;
    const animation = Animated.loop(Animated.timing(phase, {
      toValue: 1,
      duration: 2800,
      easing: Easing.linear,
      useNativeDriver: Platform.OS !== "web",
      isInteraction: false,
    }));
    if (AppState.currentState === "active") animation.start();
    const subscription = AppState.addEventListener("change", (state) => {
      animation.stop();
      animation.reset();
      if (state === "active") animation.start();
    });
    return () => {
      animation.stop();
      subscription.remove();
    };
  }, [phase, reducedMotion]);

  const wave = (outputRange: number[]) => phase.interpolate({
    inputRange: [0, 0.5, 1], outputRange,
  });

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={[title, description, secondary].filter(Boolean).join(". ")}
      accessibilityLiveRegion="polite"
      className={compact
        ? "flex-row items-center gap-md rounded-lg bg-primary-soft p-md"
        : "items-center rounded-lg border border-primary-soft-strong bg-primary-soft px-lg pb-lg pt-md"}
    >
      {!compact
        ? (
          <View
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.illustration}
          >
            <Animated.View
              style={[styles.halo, {
                opacity: reducedMotion ? 0.65 : wave([0.45, 0.8, 0.45]),
                transform: [{ scale: reducedMotion ? 1 : wave([0.94, 1.04, 0.94]) }],
              }]}
            />
            <Animated.View
              style={[styles.card, {
                backgroundColor: "#D2E0DA",
                transform: [
                  { translateX: -16 },
                  { translateY: reducedMotion ? 4 : wave([4, 0, 4]) },
                  { rotate: "-14deg" },
                ],
              }]}
            />
            <Animated.View
              style={[styles.card, {
                backgroundColor: "#E4ECE8",
                transform: [
                  { translateX: 16 },
                  { translateY: reducedMotion ? 3 : wave([3, -3, 3]) },
                  { rotate: "12deg" },
                ],
              }]}
            />
            <Animated.View
              testID="creation-activity-card"
              style={[styles.card, styles.front, {
                transform: [
                  { translateY: reducedMotion ? 0 : wave([0, -9, 0]) },
                  { rotate: reducedMotion ? "-3deg" : phase.interpolate({
                    inputRange: [0, 0.5, 1],
                    outputRange: ["-3deg", "2deg", "-3deg"],
                  }) },
                ],
              }]}
            >
              <View className="mb-xs h-6 w-6 items-center justify-center rounded-full bg-primary-soft">
                <View className="h-2 w-2 rotate-45 rounded-sm bg-primary" />
              </View>
              <View className="h-2 w-20 rounded-full bg-primary/70" />
              <Animated.View
                style={[styles.line, { opacity: reducedMotion ? 1 : wave([0.4, 1, 0.4]) }]}
              />
            </Animated.View>
          </View>
        )
        : null}
      <View
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className={compact ? "flex-row gap-xs" : "mb-md flex-row gap-xs"}
      >
        {[0, 1, 2].map((index) => (
          <Animated.View
            key={index}
            testID={`creation-activity-dot-${index}`}
            style={[styles.dot, {
              opacity: reducedMotion ? 0.65 : phase.interpolate({
                inputRange: [0, 0.25, 0.5, 0.75, 1],
                outputRange: [0, 1, 2, 3, 4].map((step) =>
                  step === index + 1 ? 1 : 0.3
                ),
              }),
            }]}
          />
        ))}
      </View>
      <View className={compact ? "flex-1 gap-xs" : "items-center gap-sm"}>
        <Text className={compact
          ? "text-body font-semibold text-primary"
          : "text-center text-[22px] font-semibold leading-7 text-primary"}
        >
          {title}
        </Text>
        <Text className={compact
          ? "text-caption text-muted-foreground"
          : "text-center text-body text-muted-foreground"}
        >
          {description}
        </Text>
        {secondary
          ? (
            <Text className={compact
              ? "text-caption text-primary"
              : "mt-xs text-center text-caption text-primary"}
            >
              {secondary}
            </Text>
          )
          : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  illustration: { width: 208, height: 170, alignItems: "center", justifyContent: "center" },
  // Core Animated.View needs explicit styles; NativeWind styles the plain Views below it.
  halo: {
    position: "absolute", width: 156, height: 156, borderRadius: 78,
    backgroundColor: "#D2E0DA",
  },
  card: {
    position: "absolute", width: 128, height: 104, borderRadius: 12,
    borderWidth: 1, borderColor: "#315C4D33",
  },
  front: { justifyContent: "center", gap: 8, padding: 16, backgroundColor: "#FFFFFF" },
  line: { height: 8, width: 56, borderRadius: 4, backgroundColor: "#315C4D4D" },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: nativeColors.primary },
});
