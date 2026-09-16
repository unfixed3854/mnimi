import { useMemo, useState } from "react";
import { View } from "react-native";
import { useDebugSummary, useResetSrs, useSeedGerman } from "@/api/debug";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { Screen } from "@/components/screen";
import { SectionHeader } from "@/components/section-header";
import { Text } from "@/components/ui/text";
import { ConfirmDialog } from "@/components/confirm-dialog";

type Scope = "all" | "deck" | "card";
type Tool = "reset" | "seed";
const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** Native controls over the debug router; no browser devtools are embedded. */
export function DevtoolsScreen() {
  const summary = useDebugSummary();
  const reset = useResetSrs();
  const seed = useSeedGerman();
  const [scope, setScope] = useState<Scope>("all");
  const [deckId, setDeckId] = useState("");
  const [cardId, setCardId] = useState("");
  const [confirmation, setConfirmation] = useState<Tool | null>(null);
  const [status, setStatus] = useState<
    {
      tool: Tool;
      message: string;
    } | null
  >(null);
  const decks = summary.data?.decks ?? [];
  const cards = useMemo(
    () => summary.data?.cards.filter((card) => card.deckId === deckId) ?? [],
    [deckId, summary.data?.cards],
  );
  const selectedDeck = decks.find((deck) => deck.id === deckId);
  const count = scope === "all"
    ? summary.data?.totalCards ?? 0
    : scope === "deck"
    ? selectedDeck?.cardCount ?? 0
    : cardId
    ? 1
    : 0;
  const canReset = !summary.isLoading && !reset.isPending && count > 0 &&
    (scope === "all" || scope === "deck"
      ? Boolean(deckId) || scope === "all"
      : Boolean(cardId));

  function selectScope(next: Scope) {
    setScope(next);
    setDeckId("");
    setCardId("");
  }

  async function resetSrs() {
    const payload = scope === "all"
      ? { scope: "all" as const }
      : scope === "deck"
      ? { scope: "deck" as const, deckId }
      : { scope: "card" as const, cardId };
    try {
      const result = await reset.mutateAsync(payload as never) as {
        resetCount: number;
      };
      setStatus({
        tool: "reset",
        message: `Reset ${result.resetCount} card${
          result.resetCount === 1 ? "" : "s"
        }.`,
      });
    } catch (error) {
      setStatus({
        tool: "reset",
        message: errorText(error, "Couldn't reset SRS."),
      });
    }
  }
  function confirmReset() {
    setConfirmation("reset");
  }
  async function seedGerman(replace: boolean) {
    try {
      const result = await seed.mutateAsync({ replace } as never) as {
        status: string;
        noteCount?: number;
        cardCount?: number;
        replaced?: boolean;
      };
      if (result.status === "needs-confirmation") {
        setConfirmation("seed");
        return;
      }
      setStatus({
        tool: "seed",
        message: `${
          result.replaced ? "Replaced" : "Created"
        } German seed (${result.noteCount} notes, ${result.cardCount} cards).`,
      });
    } catch (error) {
      setStatus({
        tool: "seed",
        message: errorText(error, "Couldn't seed German."),
      });
    }
  }

  return (
    <Screen>
      <ConfirmDialog
        visible={confirmation !== null}
        title={confirmation === "reset" ? "Reset SRS?" : "Replace German seed?"}
        message={confirmation === "reset"
          ? `Reset ${count} card${count === 1 ? "" : "s"}?`
          : "Replace the existing German deck and its cards?"}
        confirmLabel={confirmation === "reset" ? "Reset" : "Replace"}
        destructive
        pending={reset.isPending || seed.isPending}
        onCancel={() => setConfirmation(null)}
        onConfirm={async () => {
          if (confirmation === "reset") await resetSrs();
          else await seedGerman(true);
          setConfirmation(null);
        }}
      />
      <PageHeader
        back={{ href: "/settings", label: "Back to Settings" }}
        subtitle="Available only when the server was started with devtools enabled."
        title="Development tools"
      />
      <View className="mt-lg gap-md">
        <SectionHeader title="Reset SRS" />
        <View className="gap-sm">
          {(["all", "deck", "card"] as Scope[]).map((next) => (
            <PrimaryButton
              key={next}
              disabled={reset.isPending}
              selected={scope === next}
              variant={scope === next ? "selected" : "selection"}
              onPress={() => selectScope(next)}
            >
              {next === "all"
                ? "All cards"
                : next === "deck"
                ? "One deck"
                : "One card"}
            </PrimaryButton>
          ))}
        </View>
        {scope !== "all"
          ? (
            <View className="gap-sm">
              {decks.map((deck) => (
                <PrimaryButton
                  key={deck.id}
                  disabled={reset.isPending}
                  selected={deckId === deck.id}
                  variant={deckId === deck.id ? "selected" : "selection"}
                  onPress={() => {
                    setDeckId(deck.id);
                    setCardId("");
                  }}
                >
                  {deck.name}
                </PrimaryButton>
              ))}
            </View>
          )
          : null}
        {scope === "card" && deckId
          ? (
            <View className="gap-sm">
              {cards.map((card) => (
                <PrimaryButton
                  key={card.id}
                  disabled={reset.isPending}
                  selected={cardId === card.id}
                  variant={cardId === card.id ? "selected" : "selection"}
                  onPress={() => setCardId(card.id)}
                >
                  {card.aspect} · {card.front}
                </PrimaryButton>
              ))}
            </View>
          )
          : null}
        <Text className="text-body text-muted-foreground">
          Affected cards: {count}
        </Text>
        <PrimaryButton
          destructive
          disabled={!canReset}
          pending={reset.isPending}
          onPress={confirmReset}
        >
          Reset SRS
        </PrimaryButton>
        {status?.tool === "reset"
          ? (
            <Text
              accessibilityRole="alert"
              className="text-body text-muted-foreground"
            >
              {status.message}
            </Text>
          )
          : null}
      </View>
      <View className="mt-lg gap-md">
        <SectionHeader title="Seed German" />
        <Text className="text-body text-muted-foreground">
          Creates the deterministic German deck and cards.
        </Text>
        <PrimaryButton
          pending={seed.isPending}
          onPress={() => void seedGerman(false)}
        >
          Seed German
        </PrimaryButton>
        {status?.tool === "seed"
          ? (
            <Text
              accessibilityRole="alert"
              className="text-body text-muted-foreground"
            >
              {status.message}
            </Text>
          )
          : null}
      </View>
    </Screen>
  );
}
