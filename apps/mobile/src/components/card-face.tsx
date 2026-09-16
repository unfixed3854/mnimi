import { Text } from "react-native";
import { parseCloze } from "@/lib/native-cloze";

export function CardFront(
  { front, showHint = true }: { front: string; showHint?: boolean },
) {
  const segments = parseCloze(front);
  if (!segments) return <Text className="text-body leading-[24px]">{front}</Text>;
  const prompt = showHint && segments.hint ? `[${segments.hint}]` : "____";
  return (
    <Text className="text-body leading-[24px]">
      {segments.before}
      <Text className="italic text-muted-foreground">{prompt}</Text>
      {segments.after}
    </Text>
  );
}

export function CardBack(
  { front, back }: { front: string; back: string | null },
) {
  const segments = parseCloze(front);
  if (!segments) {
    return (
      <Text className="text-body leading-[24px]">
        {front}
        {back ? `\n${back}` : ""}
      </Text>
    );
  }
  return (
    <Text className="text-body leading-[24px]">
      {segments.before}
      <Text className="text-primary underline">{segments.answer}</Text>
      {segments.after}
      {back ? `\n${back}` : ""}
    </Text>
  );
}
