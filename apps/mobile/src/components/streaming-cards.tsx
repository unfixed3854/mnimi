import { View } from "react-native";
import type { DraftCard } from "@/api/drafts";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";

function StreamingCard({ card }: { card: DraftCard | null }) {
  const aspect = card?.aspect;
  const front = card?.front;
  const back = card?.back;
  const isComplete =
    aspect !== null &&
    aspect !== undefined &&
    front !== null &&
    front !== undefined &&
    back !== null &&
    back !== undefined;
  const label = aspect ? `Generating card: ${aspect}` : "Generating card";

  return (
    <View
      accessible={!isComplete}
      accessibilityLabel={isComplete ? undefined : label}
      accessibilityRole={isComplete ? undefined : "progressbar"}
      className="gap-sm"
    >
      {aspect !== null && aspect !== undefined
        ? <Text className="font-bold text-muted-foreground">{aspect}</Text>
        : <Skeleton className="h-[20px] w-2/5" />}
      {front !== null && front !== undefined
        ? <Text className="min-h-[24px]">{front}</Text>
        : <Skeleton className="h-[24px] w-full" />}
      {back !== null && back !== undefined
        ? <Text className="min-h-[24px]">{back}</Text>
        : <Skeleton className="h-[24px] w-4/5" />}
    </View>
  );
}

/** Fixed placeholder count avoids the streamed list jumping as cards arrive. */
export function StreamingCards({ cards }: { cards: DraftCard[] }) {
  const visible = [
    ...cards,
    ...Array.from({ length: Math.max(0, 3 - cards.length) }, () => null),
  ];
  return (
    <View accessibilityState={{ busy: true }} className="gap-md">
      {visible.map((card, index) => (
        <Card key={index}>
          <StreamingCard card={card} />
        </Card>
      ))}
    </View>
  );
}
