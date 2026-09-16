import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { CardPreviewContent } from "@/components/card-preview-content";
import type { NoteCard } from "@/api/notes";
import { CardBack, CardFront } from "@/components/card-face";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type CardPresentationModel = Pick<
  NoteCard,
  "id" | "cardType" | "aspect" | "front" | "back" | "imageCue"
>;

type CardPresentationProps = {
  card: CardPresentationModel;
  mode: "inspection" | "review";
  revealed?: boolean;
  image?: ReactNode;
  footer?: ReactNode;
};

export function formatAspectLabel(aspect: string): string {
  const readable = aspect.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return readable ? `${readable[0].toUpperCase()}${readable.slice(1)}` : "Card";
}

export function CardPresentation(
  { card, mode, revealed = false, image, footer }: CardPresentationProps,
) {
  const inspection = mode === "inspection";
  const isCloze = card.cardType === "cloze";
  const cardKind = isCloze ? "Fill in the blank" : "Question and answer";

  return (
    <Card accessibilityLabel={`${formatAspectLabel(card.aspect)} card`} className={inspection ? "rounded-lg" : undefined}>
      {inspection
        ? <Text className="text-[13px] font-semibold leading-[20px] text-muted-foreground">{formatAspectLabel(card.aspect)}</Text>
        : (
          <CardHeader>
            <CardTitle>{formatAspectLabel(card.aspect)}</CardTitle>
            <CardDescription>{cardKind}</CardDescription>
          </CardHeader>
        )}
      <CardContent>
        {image ? <View>{image}</View> : null}
        {inspection
          ? (
            <View className="gap-sm">
              <CardPreviewContent front={card.front} back={card.back} />
              {card.imageCue
                ? (
                  <CardDescription>
                    Uses the note image as a cue
                  </CardDescription>
                )
                : null}
            </View>
          )
          : revealed
          ? <CardBack front={card.front} back={card.back} />
          : <CardFront front={card.front} />}
      </CardContent>
      {footer ? <CardFooter className="flex-col items-stretch">{footer}</CardFooter> : null}
    </Card>
  );
}
