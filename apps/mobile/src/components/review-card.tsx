import { useMemo } from "react";
import { View } from "react-native";
import { parseCloze } from "@/lib/native-cloze";
import { CardBack, CardFront } from "@/components/card-face";
import { GeneratedImage } from "@/components/generated-image";
import { PrimaryButton } from "@/components/primary-button";
import { Card } from "@/components/ui/card";

export function ReviewCard(
  { card, revealed, onReveal }: {
    card: {
      id: string;
      noteId: string;
      front: string;
      back: string | null;
      imageCue: boolean;
      hasImage: boolean;
    };
    revealed: boolean;
    onReveal: () => void;
  },
) {
  const segments = useMemo(() => parseCloze(card.front), [card.front]);

  return (
    <View className="gap-lg">
      <Card className="items-center gap-md rounded-lg p-xl">
        <GeneratedImage
          scope="notes"
          id={card.noteId}
          present={card.hasImage}
          alt={card.imageCue
            ? segments?.hint ?? "Image cue"
            : segments?.answer ?? card.back ?? "Answer image"}
        />
        {revealed
          ? <CardBack front={card.front} back={card.back} />
          : (
            <CardFront
              front={card.front}
              showHint
            />
          )}
      </Card>
      {!revealed
        ? <PrimaryButton onPress={onReveal}>Show answer</PrimaryButton>
        : null}
    </View>
  );
}
