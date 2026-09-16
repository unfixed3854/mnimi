import * as React from "react";
import { TextInput, type TextInputProps } from "react-native";
import { cn } from "@/lib/utils";
import { nativeColors } from "@/theme/native-colors";

type InputProps = TextInputProps & {
  className?: string;
};

const Input = React.forwardRef<
  React.ComponentRef<typeof TextInput>,
  InputProps
>(
  ({ className, ...props }, ref) => (
    <TextInput
      ref={ref}
      className={cn(
        "min-h-[48px] rounded-md border border-border bg-surface px-md text-body text-foreground focus:border-focus",
        className,
      )}
      placeholderTextColor={nativeColors.mutedForeground}
      {...props}
    />
  ),
);

Input.displayName = "Input";

export { Input };
export type { InputProps };
