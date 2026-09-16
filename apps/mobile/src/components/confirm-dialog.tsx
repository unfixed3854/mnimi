import { useRef, useState } from "react";
import { ActivityIndicator } from "react-native";
import { nativeColors } from "@/theme/native-colors";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ButtonText } from "@/components/ui/button";

type ConfirmDialogProps = {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const actionClosing = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const waiting = pending || submitting;

  function handleOpenChange(open: boolean) {
    if (open || waiting) return;
    queueMicrotask(() => {
      if (actionClosing.current) {
        actionClosing.current = false;
        return;
      }
      onCancel();
    });
  }

  async function handleConfirm() {
    if (waiting) return;
    actionClosing.current = true;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={visible} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[20px]">{title}</AlertDialogTitle>
          <AlertDialogDescription className="leading-[23px]">
            {message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={waiting}>
            <ButtonText>{cancelLabel}</ButtonText>
          </AlertDialogCancel>
          <AlertDialogAction
            accessibilityState={{ busy: waiting, disabled: waiting }}
            disabled={waiting}
            onPress={handleConfirm}
            variant={destructive ? "destructive" : "default"}
          >
            {waiting
              ? <ActivityIndicator color={nativeColors.primaryForeground} />
              : null}
            <ButtonText>{confirmLabel}</ButtonText>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
