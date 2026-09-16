import { useRef } from "react";
import type { TextInput } from "react-native";
import { View } from "react-native";
import { PrimaryButton } from "@/components/primary-button";
import { DraftIndicator } from "@/components/draft-indicator";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { shouldShowCreationCharacterCount } from "@/lib/creation-outbox";

export function RequestComposer({
  actionableCount,
  value,
  onChange,
  onSubmit,
  error,
  ready,
}: {
  actionableCount: number;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<boolean>;
  error: string | null;
  ready: boolean;
}) {
  const input = useRef<TextInput>(null);
  return (
    <View className="gap-sm">
      <View className="flex-row items-center justify-between gap-sm">
        <Text accessibilityRole="header" className="flex-1 text-[24px] leading-[32px] font-semibold">
          What do you want to learn?
        </Text>
        <DraftIndicator count={actionableCount} />
      </View>
      <Input
        ref={input}
        accessibilityLabel="What do you want to learn?"
        className={error ? "border-destructive" : undefined}
        style={{ padding: 16, minHeight: 128 }}
        value={value}
        onChangeText={onChange}
        placeholder="How volcanoes form, Spanish travel phrases, photosynthesis…"
        multiline
        numberOfLines={4}
        textAlignVertical="top"
      />
      {error
        ? <Text accessibilityRole="alert" className="text-[14px] text-destructive">{error}</Text>
        : null}
      {shouldShowCreationCharacterCount(value)
        ? (
          <Text
            accessibilityLabel={`${value.length} of 2,000 characters`}
            className="self-end text-caption text-muted-foreground"
          >
            {value.length.toLocaleString("en-US")} / 2,000
          </Text>
        )
        : null}
      <PrimaryButton
        disabled={!ready}
        onPress={async () => {
          if (await onSubmit()) input.current?.focus();
        }}
      >
        Create cards
      </PrimaryButton>
    </View>
  );
}
