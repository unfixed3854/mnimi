import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { View } from "react-native";
import type { AuthError } from "@/auth/auth-error";
import { Button, ButtonText } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { nativeColors } from "@/theme/native-colors";

export function AuthErrorAlert({ error }: { error: AuthError }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View className="gap-sm rounded-lg border border-destructive/20 bg-destructive-soft p-md">
      <View accessible accessibilityRole="alert" className="gap-xs">
        <View className="flex-row items-start gap-sm">
          <Ionicons
            name="alert-circle-outline"
            size={22}
            color={nativeColors.destructive}
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
          <Text className="flex-1 text-body font-semibold">{error.title}</Text>
        </View>
        <Text className="text-body text-muted-foreground">{error.message}</Text>
      </View>
      {__DEV__ && error.technicalDetails ? (
        <View className="gap-xs">
          <Button
            variant="ghost"
            size="sm"
            className="self-start px-0"
            accessibilityState={{ expanded }}
            aria-expanded={expanded}
            onPress={() => setExpanded(!expanded)}
          >
            <ButtonText className="text-caption text-muted-foreground">Technical details</ButtonText>
            <Ionicons
              name={expanded ? "chevron-up" : "chevron-down"}
              size={16}
              color={nativeColors.mutedForeground}
              aria-hidden
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          </Button>
          {expanded ? <Text selectable className="text-caption text-muted-foreground">{error.technicalDetails}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
