import { type PropsWithChildren, type ReactNode, useState } from "react";
import { ActivityIndicator } from "react-native";
import { nativeColors } from "@/theme/native-colors";
import { Button, type ButtonProps, ButtonText } from "@/components/ui/button";

const spinnerColorByVariant: Record<
  NonNullable<ButtonProps["variant"]>,
  string
> = {
  default: nativeColors.primaryForeground,
  destructive: nativeColors.primaryForeground,
  secondary: nativeColors.foreground,
  outline: nativeColors.foreground,
  tonal: nativeColors.primary,
  selection: nativeColors.foreground,
  selected: nativeColors.primary,
  destructiveQuiet: nativeColors.destructive,
  ghost: nativeColors.foreground,
  link: nativeColors.primary,
};

type PrimaryButtonProps = PropsWithChildren<{
  onPress: () => void | Promise<void>;
  disabled?: boolean;
  pending?: boolean;
  destructive?: boolean;
  variant?: ButtonProps["variant"];
  selected?: boolean;
  className?: string;
  accessibilityLabel?: string;
  icon?: ReactNode;
}>;

export function PrimaryButton({
  children,
  onPress,
  disabled = false,
  pending = false,
  destructive = false,
  variant,
  selected,
  className,
  accessibilityLabel,
  icon,
}: PrimaryButtonProps) {
  const [submitting, setSubmitting] = useState(false);
  const unavailable = disabled || pending || submitting;
  const label = accessibilityLabel ??
    (typeof children === "string" ? children : undefined);
  const resolvedVariant = destructive ? "destructive" : variant ?? "default";
  const spinnerColor = spinnerColorByVariant[resolvedVariant];

  async function handlePress() {
    if (unavailable) return;
    setSubmitting(true);
    try {
      await onPress();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Button
      accessibilityLabel={label}
      accessibilityState={{
        disabled: unavailable,
        busy: pending || submitting,
        selected,
      }}
      className={className}
      disabled={unavailable}
      onPress={() => void handlePress()}
      variant={resolvedVariant}
    >
      {pending || submitting
        ? <ActivityIndicator color={spinnerColor} />
        : null}
      {icon}
      <ButtonText>{children}</ButtonText>
    </Button>
  );
}
