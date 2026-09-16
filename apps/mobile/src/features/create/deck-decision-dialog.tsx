import { useEffect, useState } from "react";
import { View } from "react-native";
import type { CreationRouting } from "@/api/creations";
import { PrimaryButton } from "@/components/primary-button";
import { TextField } from "@/components/text-field";
import { Text } from "@/components/ui/text";

export function DeckDecisionDialog({
  open,
  routing,
  onResolve,
  onConfirmNewDeck,
  onChooseExisting,
  onDiscard,
  pending = false,
  error = null,
}: {
  open: boolean;
  routing: CreationRouting | null;
  onResolve: (deckId: string) => void | Promise<void>;
  onConfirmNewDeck: (input: {
    name: string;
    description: string | null;
  }) => void | Promise<void>;
  onChooseExisting?: () => void;
  onDiscard: () => void | Promise<void>;
  pending?: boolean;
  error?: string | null;
}) {
  const proposal = routing?.kind === "newDeck" ? routing : null;
  const [name, setName] = useState(proposal?.proposedName ?? "");
  const [description, setDescription] = useState(
    proposal?.proposedDescription ?? "",
  );
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    setName(proposal?.proposedName ?? "");
    setDescription(proposal?.proposedDescription ?? "");
    setLocalError(null);
  }, [proposal?.proposedDescription, proposal?.proposedName]);
  if (!open || !routing || routing.kind === "matched") return null;

  return (
    <View accessibilityRole="summary" className="gap-lg">
      <View className="gap-xs">
        <Text accessibilityRole="header" className="text-[20px] font-semibold">
          {proposal ? "Create a new deck?" : "Where should this go?"}
        </Text>
        <Text className="text-body text-muted-foreground">
          {proposal
            ? onChooseExisting
              ? "Mnimi couldn't find a clear match. Review this suggestion or choose an existing deck."
              : "Mnimi couldn't find a clear match. Review this suggestion before creating the deck."
            : "Choose the deck that best matches what you want to learn."}
        </Text>
      </View>
      {routing.kind === "ambiguous"
        ? (
          <View className="gap-sm">
            {routing.candidates.map((candidate) => (
              <PrimaryButton
                key={candidate.deckId}
                variant="selection"
                disabled={pending}
                accessibilityLabel={`${candidate.deckName}: ${candidate.learningGoal}`}
                onPress={() => onResolve(candidate.deckId)}
              >
                {candidate.deckName} — {candidate.learningGoal}
              </PrimaryButton>
            ))}
          </View>
        )
        : (
          <View className="gap-md">
            <TextField
              label="Deck name"
              value={name}
              onChangeText={setName}
              error={localError ?? undefined}
            />
            <TextField
              label="Description"
              value={description}
              onChangeText={setDescription}
              multiline
            />
            <PrimaryButton
              pending={pending}
              onPress={async () => {
                const trimmed = name.trim();
                if (!trimmed) {
                  setLocalError("Name the deck before creating it.");
                  return;
                }
                setLocalError(null);
                await onConfirmNewDeck({
                  name: trimmed,
                  description: description.trim() || null,
                });
              }}
            >
              Create deck
            </PrimaryButton>
          </View>
        )}
      {error
        ? <Text accessibilityRole="alert" className="text-caption text-destructive">{error}</Text>
        : null}
      {onChooseExisting
        ? (
          <PrimaryButton
            variant="outline"
            disabled={pending}
            onPress={onChooseExisting}
          >
            {routing.kind === "ambiguous"
              ? "Choose a different deck"
              : "Choose an existing deck"}
          </PrimaryButton>
        )
        : null}
      <PrimaryButton
        variant="destructiveQuiet"
        className="mt-sm self-center border-0 bg-transparent"
        disabled={pending}
        onPress={onDiscard}
      >
        Discard request
      </PrimaryButton>
    </View>
  );
}
