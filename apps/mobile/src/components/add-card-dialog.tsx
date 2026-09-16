import { SelectionDialog } from "@/components/selection-dialog";

const options = [
  { value: "basic", label: "Question and answer" },
  { value: "cloze", label: "Fill in the blank" },
] as const;

export function AddCardDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (kind: "basic" | "cloze") => void;
}) {
  return (
    <SelectionDialog
      open={open}
      options={[...options]}
      title="Choose a card type"
      value=""
      onOpenChange={onOpenChange}
      onValueChange={(value) => onSelect(value as "basic" | "cloze")}
    />
  );
}
