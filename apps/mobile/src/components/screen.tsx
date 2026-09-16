import type { ComponentProps, PropsWithChildren, ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { cn } from "@/lib/utils";

type ScreenProps = PropsWithChildren<{
  className?: string;
  footer?: ReactNode;
  style?: ComponentProps<typeof SafeAreaView>["style"];
  testID?: string;
}>;

/** Insets every app screen, including content above gesture navigation areas. */
export const screenSafeAreaEdges = ["top", "right", "bottom", "left"] as const;
/** Tab navigators already reserve room for Android's system navigation inset. */
export const tabScreenSafeAreaEdges = ["top", "right", "left"] as const;

export function Screen(
  { children, className, footer, safeAreaEdges = screenSafeAreaEdges, style, testID }:
    ScreenProps & {
      safeAreaEdges?: ComponentProps<typeof SafeAreaView>["edges"];
    },
) {
  return (
    <SafeAreaView
      edges={safeAreaEdges}
      className={cn("flex-1 bg-background px-md", className)}
      style={[Platform.OS === "web" && { paddingHorizontal: 16 }, style]}
      testID={testID}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 md:w-full md:max-w-[720px] md:self-center"
      >
        <ScrollView
          contentContainerClassName="grow gap-md pb-xl"
          keyboardShouldPersistTaps="handled"
          testID="screen-scroll-content"
        >
          {children}
        </ScrollView>
        {footer
          ? (
            <View
              className="border-t border-border bg-background py-sm"
              testID="screen-footer"
            >
              {footer}
            </View>
          )
          : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
