import { View } from "react-native";
import { CardBack, CardFront } from "@/components/card-face";
import { Text } from "@/components/ui/text";
import { parseCloze } from "@/lib/native-cloze";

/** The same prompt, answer divider, and translation hierarchy in every preview. */
export function CardPreviewContent({ front, back }: { front: string; back: string | null }) {
  const cloze = parseCloze(front);
  return (
    <>
      <CardFront front={front} />
      <View className="gap-xs border-t border-border/60 pt-sm">
        {cloze
          ? <CardBack front={front} back={null} />
          : <Text className="font-medium text-primary">{back}</Text>}
        {cloze && back
          ? <Text className="text-[14px] leading-[20px] text-muted-foreground">{back}</Text>
          : null}
      </View>
    </>
  );
}
