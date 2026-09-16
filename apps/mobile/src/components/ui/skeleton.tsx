import * as React from "react";
import { View, type ViewProps } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { cn } from "@/lib/utils";

type SkeletonProps = ViewProps & {
  className?: string;
};

/** React Native Reusables skeleton adapted to the app's semantic tokens. */
function Skeleton({ className, ...props }: SkeletonProps) {
  const reducedMotion = useReducedMotion();
  return (
    <View
      className={cn("rounded-md bg-surface-muted", !reducedMotion && "animate-pulse", className)}
      {...props}
    />
  );
}

export { Skeleton };
export type { SkeletonProps };
