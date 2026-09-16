import { Ionicons } from "@expo/vector-icons";
import { type ComponentProps, useState } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { Button, ButtonText } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { nativeColors } from "@/theme/native-colors";

type MenuAction = {
  label: string;
  icon: ComponentProps<typeof Ionicons>["name"];
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void | Promise<void>;
};

/** Secondary actions share one overflow entry point and dialog treatment. */
export function ActionMenu({ label, title, actions, disabled = false }: {
  label: string;
  title: string;
  actions: MenuAction[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { height } = useWindowDimensions();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" disabled={disabled} accessibilityLabel={label}>
          <Ionicons name="ellipsis-horizontal" size={24} color={nativeColors.foreground}
            accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-xs" style={{ maxHeight: Math.max(96, height - 240) }}>
          {actions.map((action) => (
            <Button
              key={action.label}
              variant="ghost"
              className="justify-start py-sm"
              accessibilityLabel={action.label}
              disabled={disabled || action.disabled}
              onPress={() => {
                setOpen(false);
                void action.onPress();
              }}
            >
              <Ionicons name={action.icon} size={20}
                color={action.destructive ? nativeColors.destructive : nativeColors.foreground}
                accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
              <ButtonText className={action.destructive ? "flex-shrink text-destructive" : "flex-shrink"}>
                {action.label}
              </ButtonText>
            </Button>
          ))}
        </ScrollView>
        <Button variant="ghost" onPress={() => setOpen(false)}>
          <ButtonText>Close</ButtonText>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
