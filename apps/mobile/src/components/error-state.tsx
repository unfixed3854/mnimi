import { View } from "react-native";
import { PrimaryButton } from "@/components/primary-button";
import { Text } from "@/components/ui/text";

type ErrorStateProps = {
  message: string;
  onRetry?: () => void | Promise<void>;
};

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <View accessibilityRole="alert" className="items-center gap-sm py-xl px-md">
      <Text className="text-body font-semibold">Something went wrong</Text>
      <Text className="text-center text-muted-foreground">{message}</Text>
      {onRetry
        ? <PrimaryButton onPress={onRetry}>Try again</PrimaryButton>
        : null}
    </View>
  );
}
