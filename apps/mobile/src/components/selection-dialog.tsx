import type { ReactNode } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { PrimaryButton } from "@/components/primary-button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type SelectionDialogOption = {
  label: string;
  value: string;
};

type SelectionDialogProps = {
  open: boolean;
  title: string;
  value: string;
  options: SelectionDialogOption[];
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: string) => void;
  footer?: ReactNode;
  overlayTestID?: string;
};

/** App selection flow composed from the React Native Reusables dialog primitive. */
export function SelectionDialog({
  open,
  title,
  value,
  options,
  onOpenChange,
  onValueChange,
  footer,
  overlayTestID,
}: SelectionDialogProps) {
  const { height } = useWindowDimensions();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="absolute bottom-md left-md right-md w-auto max-w-none"
        overlayTestID={overlayTestID}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <ScrollView
              accessibilityLabel={`${title} options`}
          accessibilityRole="list"
          contentContainerClassName="gap-sm"
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: Math.max(96, height - 240) }}
          testID="selection-options"
        >
          {options.map((option) => (
            <PrimaryButton
              key={option.value}
              selected={option.value === value}
              variant={option.value === value ? "selected" : "selection"}
              onPress={() => {
                onValueChange(option.value);
                onOpenChange(false);
              }}
            >
              {option.label}
            </PrimaryButton>
          ))}
        </ScrollView>
        {footer ? <View className="gap-sm">{footer}</View> : null}
      </DialogContent>
    </Dialog>
  );
}
