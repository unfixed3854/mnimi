import { Fragment, useRef, useState } from "react";
import { View } from "react-native";
import { useCreateDeck, useDecks } from "@/api/decks";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ListRow } from "@/components/list-row";
import { LoadingState } from "@/components/loading-state";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { Screen, tabScreenSafeAreaEdges } from "@/components/screen";
import { SectionHeader } from "@/components/section-header";
import { TextField } from "@/components/text-field";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";

export function DeckListScreen() {
  const { data: decks, isLoading, isError, error } = useDecks();
  const createDeck = useCreateDeck();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createInFlight, setCreateInFlight] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createInFlightRef = useRef(false);
  const createPending = createDeck.isPending || createInFlight;
  const empty = !isLoading && !isError && !decks?.length;

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || createPending || createInFlightRef.current) return;
    createInFlightRef.current = true;
    setCreateInFlight(true);
    setCreateError(null);
    try {
      await createDeck.mutateAsync({ name: trimmed });
      setName("");
      setCreateError(null);
      setCreating(false);
    } catch (cause) {
      setCreateError(
        cause instanceof Error ? cause.message : "Failed to create deck",
      );
    } finally {
      createInFlightRef.current = false;
      setCreateInFlight(false);
    }
  }

  function cancelCreate() {
    if (createPending || createInFlightRef.current) return;
    setCreating(false);
    setName("");
    setCreateError(null);
  }

  return (
    <Screen safeAreaEdges={tabScreenSafeAreaEdges}>
      <PageHeader
        title="Decks"
        trailing={!creating && !empty
          ? (
            <PrimaryButton variant="outline" onPress={() => setCreating(true)}>
              New deck
            </PrimaryButton>
          )
          : undefined}
      />
      {creating
        ? (
          <Card className="rounded-lg">
            <TextField
              label="New deck name"
              placeholder="New deck name"
              value={name}
              onChangeText={setName}
            />
            {createError
              ? (
                <Text
                  accessibilityRole="alert"
                  className="text-caption text-destructive"
                >
                  {createError}
                </Text>
              )
              : null}
            <View className="flex-row gap-sm">
              <PrimaryButton
                className="flex-1"
                disabled={createPending}
                variant="outline"
                onPress={cancelCreate}
              >
                Cancel
              </PrimaryButton>
              <PrimaryButton
                className="flex-1"
                disabled={!name.trim() || createPending}
                pending={createPending}
                onPress={create}
              >
                Create deck
              </PrimaryButton>
            </View>
          </Card>
        )
        : null}
      <View className={empty ? "flex-1 justify-center" : "gap-md"}>
        {!empty ? <SectionHeader title="Your decks" /> : null}
        {isLoading
          ? <LoadingState layout="decks" label="Loading decks" />
          : isError
          ? (
            <ErrorState
              message={error instanceof Error
                ? error.message
                : "Couldn't load decks."}
            />
          )
          : decks?.length
          ? (
            <View
              className="overflow-hidden rounded-md border border-border bg-surface"
              testID="deck-list"
            >
              {decks.map((deck, index) => (
                <Fragment key={deck.id}>
                  <ListRow
                    href={{
                      pathname: "/decks/[deckId]",
                      params: { deckId: deck.id },
                    }}
                    leadingIcon="layers-outline"
                    title={deck.name}
                  />
                  {index < decks.length - 1
                    ? <View className="h-px bg-border" />
                    : null}
                </Fragment>
              ))}
            </View>
          )
          : !creating ? (
            <EmptyState
              illustration="decks"
              title="A little curiosity goes a long way"
              message="Make your first deck. Give something you want to learn a place to grow."
              action={
                <PrimaryButton onPress={() => setCreating(true)}>
                  New deck
                </PrimaryButton>
              }
            />
          ) : null}
      </View>
    </Screen>
  );
}
