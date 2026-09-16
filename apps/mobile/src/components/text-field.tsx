import type { ComponentProps, Ref } from "react";
import { TextInput, View } from "react-native";
import { nativeColors } from "@/theme/native-colors";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

type TextFieldProps =
  & Omit<ComponentProps<typeof TextInput>, "accessibilityLabel">
  & {
    label: string;
    error?: string;
    inputRef?: Ref<TextInput>;
  };

export function TextField(
  { label, error, inputRef, style, ...inputProps }: TextFieldProps,
) {
  return (
    <View className="gap-xs">
      <Text className="text-caption font-semibold">{label}</Text>
      <Input
        ref={inputRef}
        accessibilityLabel={label}
        accessibilityState={{ disabled: inputProps.editable === false }}
        className={error ? "border-destructive" : undefined}
        placeholderTextColor={nativeColors.mutedForeground}
        style={style}
        {...inputProps}
      />
      {error
        ? (
          <Text
            accessibilityRole="alert"
            className="text-[14px] text-destructive"
          >
            {error}
          </Text>
        )
        : null}
    </View>
  );
}
