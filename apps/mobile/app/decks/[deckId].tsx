import { useLocalSearchParams } from "expo-router";
import { DeckDetailScreen } from "@/features/decks/deck-detail-screen";

export default function DeckDetailRoute() {
  const { deckId } = useLocalSearchParams<{ deckId: string }>();
  return <DeckDetailScreen deckId={deckId} />;
}
