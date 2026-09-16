import { useEffect, useState } from "react";
import { View } from "react-native";
import { type Grade, Rating } from "ts-fsrs";
import { useDueCards, useGradeCard } from "@/api/review";
import { useSession } from "@/auth/session-store";
import { EmptyState } from "@/components/empty-state";
import { LoadingState } from "@/components/loading-state";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { PronunciationControl } from "@/components/pronunciation-control";
import { ReviewCard } from "@/components/review-card";
import { Screen } from "@/components/screen";
import { SectionHeader } from "@/components/section-header";
import { Text } from "@/components/ui/text";
import { RATINGS } from "@/lib/fsrs";

/** Native review keeps the server's session-stable queue at index zero. */
export function ReviewScreen({ deckId }: { deckId?: string }) {
  const [shuffleSeed] = useState(() =>
    Math.floor(Math.random() * 0x1_0000_0000)
  );
  const { data: cards, isLoading, isError, error, refetch } = useDueCards(
    deckId,
    shuffleSeed,
  );
  const grade = useGradeCard();
  const session = useSession();
  const [revealedCardId, setRevealedCardId] = useState<string | null>(null);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [sessionQueue, setSessionQueue] = useState<{
    deckId?: string;
    ids: string[];
  } | null>(null);

  useEffect(() => {
    if (cards && sessionQueue?.deckId !== deckId) {
      setSessionQueue({ deckId, ids: cards.map((card) => card.id) });
    }
  }, [cards, deckId, sessionQueue?.deckId]);

  const sessionIds = sessionQueue && sessionQueue.deckId === deckId
    ? sessionQueue.ids
    : cards?.map((card) => card.id);
  const cardsById = new Map(cards?.map((card) => [card.id, card]) ?? []);
  const sessionCards = sessionIds?.flatMap((id) => {
    const card = cardsById.get(id);
    return card ? [card] : [];
  });
  const back = deckId
    ? {
      href: { pathname: "/decks/[deckId]" as const, params: { deckId } },
      label: "Back to deck",
    }
    : { href: "/(tabs)" as const, label: "Back to Today" };

  if (isLoading) {
    return (
      <Screen>
        <PageHeader
          back={back}
          title="Review"
        />
        <LoadingState layout="review" label="Loading review" />
      </Screen>
    );
  }
  if (isError) {
    return (
      <Screen>
        <PageHeader
          back={back}
          title="Review"
        />
        <View accessibilityRole="alert" className="mt-xl gap-md">
          <Text className="text-body text-destructive">
            {error instanceof Error
              ? error.message
              : "Couldn't load due cards."}
          </Text>
          <PrimaryButton onPress={() => void refetch()}>
            Try again
          </PrimaryButton>
        </View>
      </Screen>
    );
  }

  // Keep the initial cohort: invalidation removes graded cards and refreshes
  // their data, but cards outside this mounted session never join its queue.
  const card = sessionCards?.[0];
  if (!card) {
    return (
      <Screen>
        <PageHeader
          back={back}
          title="Review"
        />
        <View className="flex-1 justify-center">
          <EmptyState
            illustration="rest"
            title="You're all caught up"
            message={deckId
              ? "This deck is clear for now. Take a moment to let it sink in."
              : "Nothing more to review right now. Take a moment to let it sink in."}
          />
        </View>
      </Screen>
    );
  }
  const revealed = revealedCardId === card.id;

  async function submit(rating: Grade) {
    setGradeError(null);
    try {
      await grade.mutateAsync({ card, rating });
      setRevealedCardId(null);
    } catch {
      // Keep both card and reveal state: a retry must never silently skip it.
      setGradeError(
        "Couldn't save that grade. Check your connection and try again.",
      );
    }
  }

  return (
    <Screen>
      <PageHeader
        back={back}
        subtitle={`${sessionCards?.length ?? 0} left · ${card.aspect}`}
        title="Review"
      />
      <View key={card.id} className="mt-lg gap-lg">
        <ReviewCard
          card={card}
          revealed={revealed}
          onReveal={() => setRevealedCardId(card.id)}
        />
        {revealed
          ? (
            <>
              <PronunciationControl
                card={card}
                autoplay={session?.user.ttsAutoplay ?? true}
              />
              {gradeError
                ? (
                  <Text
                    accessibilityRole="alert"
                    className="text-body text-destructive"
                  >
                    {gradeError}
                  </Text>
                )
                : null}
              <View className="gap-sm">
                <SectionHeader title="How well did you remember?" />
                <View
                  className="flex-row gap-sm"
                  testID="review-grade-row-again-hard"
                >
                  {RATINGS.slice(0, 2).map((rating) => (
                    <PrimaryButton
                      key={rating.value}
                      className="flex-1"
                      disabled={grade.isPending}
                      onPress={() => submit(rating.value)}
                      variant={rating.value === Rating.Again
                        ? "destructiveQuiet"
                        : "selection"}
                    >
                      {rating.label}
                    </PrimaryButton>
                  ))}
                </View>
                <View
                  className="flex-row gap-sm"
                  testID="review-grade-row-good-easy"
                >
                  {RATINGS.slice(2).map((rating) => (
                    <PrimaryButton
                      key={rating.value}
                      className="flex-1"
                      disabled={grade.isPending}
                      onPress={() => submit(rating.value)}
                      variant={rating.value === Rating.Good
                        ? "tonal"
                        : "outline"}
                    >
                      {rating.label}
                    </PrimaryButton>
                  ))}
                </View>
              </View>
            </>
          )
          : null}
      </View>
    </Screen>
  );
}
