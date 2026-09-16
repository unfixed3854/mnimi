import { ActionMenu } from "@/components/action-menu";

export function CreationActions({ disabled, onChangeDeck, onDiscard }: {
  disabled: boolean;
  onChangeDeck: () => void;
  onDiscard: () => void;
}) {
  return (
    <ActionMenu
      label="More creation actions"
      title="Creation actions"
      disabled={disabled}
      actions={[
        { label: "Change deck and regenerate", icon: "swap-horizontal-outline", onPress: onChangeDeck },
        { label: "Discard creation", icon: "trash-outline", destructive: true, onPress: onDiscard },
      ]}
    />
  );
}
