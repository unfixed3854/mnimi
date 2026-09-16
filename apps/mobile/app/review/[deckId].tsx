import { useLocalSearchParams } from "expo-router";
import { ReviewScreen } from "@/features/review/review-screen";

export default function ReviewRoute() {
  const { deckId } = useLocalSearchParams<{ deckId: string }>();
  return <ReviewScreen deckId={deckId} />;
}
