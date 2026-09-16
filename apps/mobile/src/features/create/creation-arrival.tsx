import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import Animated, {
  FadeIn,
  FadeInUp,
  useReducedMotion,
} from "react-native-reanimated";

type CreationArrivalKind = "card" | "image";

export function useCreationArrivals(keys: string[]): Set<string> {
  const seen = useRef(new Set(keys));
  const arrivals = new Set(keys.filter((key) => !seen.current.has(key)));
  useEffect(() => {
    for (const key of keys) seen.current.add(key);
  });
  return arrivals;
}

export function creationArrivalMotion(
  kind: CreationArrivalKind,
  reducedMotion: boolean,
  position: number,
) {
  if (reducedMotion) {
    return { duration: 120, delay: 0, translate: false } as const;
  }
  return {
    duration: kind === "image" ? 260 : 220,
    delay: kind === "card" ? Math.min(position * 60, 180) : 0,
    translate: kind === "card",
  } as const;
}

export function CreationArrival({
  children,
  animate,
  kind,
  position = 0,
  testID,
}: {
  children: ReactNode;
  animate: boolean;
  kind: CreationArrivalKind;
  position?: number;
  testID?: string;
}) {
  const reducedMotion = useReducedMotion();
  if (!animate) {
    return (
      <View testID={testID} accessibilityLiveRegion="none">
        {children}
      </View>
    );
  }
  const motion = creationArrivalMotion(kind, reducedMotion, position);
  const entering = (motion.translate ? FadeInUp : FadeIn)
    .duration(motion.duration)
    .delay(motion.delay);
  return (
    <Animated.View
      testID={testID}
      accessibilityLiveRegion="polite"
      entering={entering}
    >
      {children}
    </Animated.View>
  );
}
