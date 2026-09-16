import { View } from "react-native";
import type { CreationCard, CreationDetail } from "@/api/creations";
import { CardPresentation } from "@/components/card-presentation";
import { GeneratedImage } from "@/components/generated-image";
import { PrimaryButton } from "@/components/primary-button";
import { Text } from "@/components/ui/text";
import { parseCloze } from "@/lib/native-cloze";
import { CreationArrival, useCreationArrivals } from "@/features/create/creation-arrival";
import { CreationActivity } from "@/features/create/creation-activity";

function presentation(card: CreationCard) {
  return {
    id: card.key,
    cardType: parseCloze(card.front) ? "cloze" as const : "basic" as const,
    aspect: card.aspect,
    front: card.front,
    back: card.back,
    imageCue: card.imageCue,
  };
}

export function CreationProgress({
  creation,
  onRetryImage,
}: {
  creation: CreationDetail;
  onRetryImage?: () => void | Promise<void>;
}) {
  const cards = creation.cards.length > 0
    ? creation.cards
    : creation.attemptCards;
  const writing = ["generating", "adjusting", "regenerating"].includes(
    creation.status,
  );
  const creatingImage = creation.imageStatus === "queued" ||
    creation.imageStatus === "generating";
  const activityTitle = creation.status === "queued"
    ? "Waiting to start"
    : creation.status === "routing"
    ? "Understanding your request"
    : writing
    ? "Writing cards"
    : creatingImage
    ? "Creating a picture"
    : null;
  const activityDescription = creation.status === "queued"
    ? "Your request is in the queue. We'll pick it up automatically."
    : creation.status === "routing"
    ? "Choosing the best fit for what you want to learn."
    : writing && cards.length === 0
    ? "Turning your idea into something that sticks."
    : writing
    ? `${cards.length} ${cards.length === 1 ? "card" : "cards"} created so far`
    : "The picture will appear here when it's ready.";
  const attemptKey = creation.attemptId ?? creation.id;
  const arrivals = useCreationArrivals([
    ...cards.map((card) => `${attemptKey}:${card.key}`),
    ...(creation.imageStatus === "ready" && creation.draftImageId
      ? [`image:${creation.draftImageId}`]
      : []),
  ]);
  return (
    <View className="gap-lg">
      {creation.imageStatus === "ready" && creation.draftImageId
        ? (
          <CreationArrival
            kind="image"
            animate={arrivals.has(`image:${creation.draftImageId}`)}
            testID="creation-image-arrival"
          >
            <GeneratedImage
              scope="drafts"
              id={creation.draftImageId}
              present
              alt={`${creation.sourceText} illustration`}
            />
          </CreationArrival>
        )
        : null}
      {activityTitle
        ? (
          <CreationActivity
            title={activityTitle}
            description={activityDescription}
            secondary={creatingImage && writing ? "Creating a picture" : undefined}
            compact={cards.length > 0 || creation.imageStatus === "ready"}
          />
        )
        : null}
      {creation.imageStatus === "failed"
        ? (
          <View className="gap-sm">
            <Text className="text-body text-muted-foreground">
              The picture didn't come through. Your cards are still available.
            </Text>
            {onRetryImage
              ? (
                <PrimaryButton variant="outline" onPress={onRetryImage}>
                  Try picture again
                </PrimaryButton>
              )
              : null}
          </View>
        )
        : null}
      <View className="gap-md">
        {cards.map((card, index) => {
          const arrivalKey = `${attemptKey}:${card.key}`;
          return (
            <CreationArrival
              key={arrivalKey}
              kind="card"
              position={index}
              animate={arrivals.has(arrivalKey)}
              testID={`creation-card-arrival-${card.key}`}
            >
              <CardPresentation card={presentation(card)} mode="inspection" />
            </CreationArrival>
          );
        })}
      </View>
    </View>
  );
}
