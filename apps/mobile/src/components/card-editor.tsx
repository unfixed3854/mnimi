import type { ReactNode } from "react";
import { View } from "react-native";
import type { EditableCard } from "@/api/notes";
import { PrimaryButton } from "@/components/primary-button";
import { TextField } from "@/components/text-field";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";

export function CardEditor<T extends EditableCard>(
  { cards, editable, onChange, renderCardFooter }: {
    cards: T[];
    editable: boolean;
    onChange: (cards: T[]) => void;
    renderCardFooter?: (card: T, index: number) => ReactNode;
  },
) {
  return (
    <View className="gap-md">
      {cards.map((card, index) => (
        <Card key={`${card.aspect}-${index}`}>
          <Text className="text-[14px] font-bold text-muted-foreground">
            {card.aspect}
          </Text>
          <TextField
            editable={editable}
            label="Front"
            value={card.front}
            onChangeText={(front) =>
              onChange(
                cards.map((current, i) =>
                  i === index ? { ...current, front } : current
                ),
              )}
          />
          <TextField
            editable={editable}
            label="Back"
            value={card.back ?? ""}
            onChangeText={(back) =>
              onChange(
                cards.map((current, i) =>
                  i === index ? { ...current, back: back || null } : current
                ),
              )}
          />
          <View className="flex-row items-center justify-between">
            <Text>Use picture as prompt</Text>
            <Switch
              accessibilityLabel="Use picture as prompt"
              checked={card.imageCue}
              disabled={!editable}
              onCheckedChange={(imageCue) =>
                onChange(
                  cards.map((current, i) =>
                    i === index ? { ...current, imageCue } : current
                  ),
                )}
            />
          </View>
          {editable && cards.length > 1
            ? (
              <PrimaryButton
                variant="destructiveQuiet"
                onPress={() => onChange(cards.filter((_, i) => i !== index))}
              >
                Remove card
              </PrimaryButton>
            )
            : null}
          {renderCardFooter?.(card, index)}
        </Card>
      ))}
    </View>
  );
}
