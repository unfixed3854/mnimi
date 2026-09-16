import { type ComponentProps, type Ref } from "react";
import { type TextInput, View } from "react-native";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

export function EditorField({ label, error, style, inputRef, ...props }: ComponentProps<typeof Input> & {
  label: string;
  error?: string;
  inputRef?: Ref<TextInput>;
}) {
  return (
    <View className="gap-xs">
      <Text className="text-[13px] font-medium text-muted-foreground">{label}</Text>
      <Input
        {...props}
        ref={inputRef}
        accessibilityLabel={label}
        className={error ? "border-destructive bg-background" : "bg-background"}
        style={[{ paddingVertical: 12, paddingHorizontal: 12, minHeight: 48 }, style]}
        textAlignVertical={props.multiline ? "top" : "center"}
      />
      {error ? <Text accessibilityRole="alert" className="text-[14px] text-destructive">{error}</Text> : null}
    </View>
  );
}
