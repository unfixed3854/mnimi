import { useEffect, useState } from "react";
import { View } from "react-native";
import { PrimaryButton } from "@/components/primary-button";
import { TextField } from "@/components/text-field";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";

const SUGGESTIONS = [
  "Make these simpler",
  "Focus on the translation",
  "Use fewer cards",
  "Add an example",
];

export function AdjustCreationDialog({
  open,
  onSubmit,
  onCancel,
  pending = false,
  serverError = null,
}: {
  open: boolean;
  onSubmit: (instruction: string) => void | Promise<void>;
  onCancel: () => void;
  pending?: boolean;
  serverError?: string | null;
}) {
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setInstruction("");
      setError(null);
    }
  }, [open]);
  if (!open) return null;
  return (
    <Card className="gap-md">
      <Text className="text-[20px] font-semibold">Adjust with AI</Text>
      <Text className="text-body text-muted-foreground">
        Describe how the complete card set should change. The current cards stay
        available until the replacement is ready.
      </Text>
      <View className="flex-row flex-wrap gap-sm">
        {SUGGESTIONS.map((suggestion) => (
          <PrimaryButton
            key={suggestion}
            variant="outline"
            disabled={pending}
            onPress={() => {
              setInstruction(suggestion);
              setError(null);
            }}
          >
            {suggestion}
          </PrimaryButton>
        ))}
      </View>
      <TextField
        label="How should the cards change?"
        value={instruction}
        onChangeText={(value) => {
          setInstruction(value);
          setError(null);
        }}
        multiline
        error={error ?? undefined}
      />
      {serverError
        ? <Text accessibilityRole="alert" className="text-caption text-destructive">{serverError}</Text>
        : null}
      <PrimaryButton
        pending={pending}
        onPress={async () => {
          const trimmed = instruction.trim();
          if (!trimmed) {
            setError("Describe how the cards should change.");
            return;
          }
          if (trimmed.length > 500) {
            setError("Keep the instruction to 500 characters.");
            return;
          }
          await onSubmit(trimmed);
        }}
      >
        Adjust cards
      </PrimaryButton>
      <PrimaryButton variant="ghost" disabled={pending} onPress={onCancel}>
        Cancel
      </PrimaryButton>
    </Card>
  );
}
