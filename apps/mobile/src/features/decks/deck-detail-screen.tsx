import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { useDueCount } from "@/api/cards";
import {
  type PronunciationSpeed,
  useDeck,
  useRemoveDeck,
  useUpdatePronunciationSpeed,
} from "@/api/decks";
import { useNotes } from "@/api/notes";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ListRow } from "@/components/list-row";
import { LoadingState } from "@/components/loading-state";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { Screen } from "@/components/screen";
import { SelectionDialog } from "@/components/selection-dialog";
import { SectionHeader } from "@/components/section-header";
import { ActionMenu } from "@/components/action-menu";
import { Text } from "@/components/ui/text";
import { nativeColors } from "@/theme/native-colors";

const pronunciationSpeeds: Array<{
  value: PronunciationSpeed;
  label: string;
}> = [
  { value: "slow", label: "Slow" },
  { value: "normal", label: "Normal" },
  { value: "fast", label: "Fast" },
];

export function DeckDetailScreen({ deckId }: { deckId: string }) {
  const {
    data: deck,
    isLoading: deckLoading,
    isError: deckIsError,
    error: deckError,
  } = useDeck(deckId);
  const { data: notes, isLoading, isError, error } = useNotes(deckId);
  const { data: due } = useDueCount(deckId);
  const remove = useRemoveDeck();
  const updatePronunciationSpeed = useUpdatePronunciationSpeed();
  const [confirming, setConfirming] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [speedPickerOpen, setSpeedPickerOpen] = useState(false);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);

  async function savePronunciationSpeed(pronunciationSpeed: PronunciationSpeed) {
    setPreferenceError(null);
    try {
      await updatePronunciationSpeed.mutateAsync({ deckId, pronunciationSpeed });
    } catch (cause) {
      setPreferenceError(
        cause instanceof Error
          ? cause.message
          : "Failed to update pronunciation speed",
      );
    }
  }

  async function removeDeck() {
    try {
      await remove.mutateAsync({ deckId });
      router.replace("/decks");
      setConfirming(false);
    } catch (cause) {
      setRemoveError(
        cause instanceof Error ? cause.message : "Failed to remove deck",
      );
    }
  }

  if (deckLoading) {
    return (
      <Screen>
        <PageHeader
          back={{ href: "/decks", label: "Back to decks" }}
          title="Deck"
        />
        <LoadingState layout="deck" label="Loading deck" />
      </Screen>
    );
  }
  if (deckIsError) {
    return (
      <Screen>
        <PageHeader
          back={{ href: "/decks", label: "Back to decks" }}
          title="Deck"
        />
        <ErrorState
          message={deckError instanceof Error
            ? deckError.message
            : "Couldn't load deck."}
        />
      </Screen>
    );
  }
  if (!deck) {
    return (
      <Screen>
        <PageHeader
          back={{ href: "/decks", label: "Back to decks" }}
          title="Deck"
        />
        <ErrorState message="This deck no longer exists." />
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader
        back={{ href: "/decks", label: "Back to decks" }}
        title={deck.name}
        subtitle={`${notes?.length ?? "—"} ${notes?.length === 1 ? "note" : "notes"}${due ? ` · ${due} due` : ""}`}
        trailing={
          <ActionMenu
            label="More deck actions"
            title="Deck actions"
            disabled={remove.isPending}
            actions={[
              {
                label: `Pronunciation speed: ${pronunciationSpeeds.find((speed) => speed.value === deck.pronunciationSpeed)?.label ?? "Normal"}`,
                icon: "speedometer-outline",
                disabled: updatePronunciationSpeed.isPending,
                onPress: () => setSpeedPickerOpen(true),
              },
              { label: "Remove deck", icon: "trash-outline", destructive: true, onPress: () => setConfirming(true) },
            ]}
          />
        }
      />
      {due
        ? (
          <PrimaryButton
            onPress={() =>
              router.push({ pathname: "/review/[deckId]", params: { deckId } })}
          >
            Review {due} due
          </PrimaryButton>
        )
        : (
          <View className="flex-row items-center gap-sm rounded-md bg-primary-soft px-md py-sm">
            <Ionicons
              name="checkmark-circle-outline"
              size={20}
              color={nativeColors.primary}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
            <Text className="flex-1 text-body text-primary">
              Nothing due right now
            </Text>
          </View>
        )}
      <View className="gap-md">
        <SectionHeader title="Notes" />
        {isLoading
          ? <LoadingState layout="notes" label="Loading notes" />
          : isError
          ? (
            <ErrorState
              message={error instanceof Error
                ? error.message
                : "Couldn't load notes."}
            />
          )
          : notes?.length
          ? (
            <View className="overflow-hidden rounded-md border border-border bg-surface">
              {notes.map((note, index) => (
                <View key={note.id}>
                  <ListRow
                    href={{
                      pathname: "/notes/[noteId]",
                      params: { noteId: note.id },
                    }}
                    title={note.sourceText}
                  />
                  {index < notes.length - 1
                    ? <View className="h-px bg-border" />
                    : null}
                </View>
              ))}
            </View>
          )
          : (
            <EmptyState
              compact
              illustration="notes"
              title="Every deck starts with a thought"
              message="Turn a word, a question, or an idea into a note. Choose this deck when you save it."
              action={
                <PrimaryButton variant="tonal" onPress={() => router.push("/add")}>
                  Create a note
                </PrimaryButton>
              }
            />
          )}
      </View>
      {preferenceError || removeError
        ? (
          <Text accessibilityRole="alert" className="text-caption text-destructive">
            {removeError ?? preferenceError}
          </Text>
        )
        : null}
      <SelectionDialog
        onOpenChange={setSpeedPickerOpen}
        onValueChange={(next) =>
          void savePronunciationSpeed(next as PronunciationSpeed)}
        open={speedPickerOpen}
        options={pronunciationSpeeds}
        title="Pronunciation speed"
        value={deck.pronunciationSpeed}
      />
      <ConfirmDialog
        confirmLabel="Remove"
        destructive
        message={`Remove ${deck.name} and all of its notes?`}
        onCancel={() => setConfirming(false)}
        onConfirm={removeDeck}
        pending={remove.isPending}
        title="Remove deck?"
        visible={confirming}
      />
    </Screen>
  );
}
