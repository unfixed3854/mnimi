import { Ionicons } from "@expo/vector-icons";
import { type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, ButtonText } from "@/components/ui/button";
import { nativeColors } from "@/theme/native-colors";

export function MoreOptions({ children, invalid = false }: { children: ReactNode; invalid?: boolean }) {
  const [open, setOpen] = useState(invalid);
  useEffect(() => {
    if (invalid) setOpen(true);
  }, [invalid]);
  return (
    <>
      <Button
        variant="ghost"
        className="justify-between border-t border-border/60 rounded-none px-0"
        accessibilityLabel={open ? "Fewer options" : "More options"}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
      >
        <ButtonText className="text-[14px] text-muted-foreground">{open ? "Fewer options" : "More options"}</ButtonText>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={nativeColors.mutedForeground}
          accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      </Button>
      {open ? <View className="gap-md">{children}</View> : null}
    </>
  );
}
