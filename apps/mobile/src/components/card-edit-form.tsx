import { useState } from "react";
import { View } from "react-native";
import type {
  CardDraft,
  CardDraftErrors,
  ClozeCardDraft,
} from "@/lib/card-draft";
import {
  parseEditableCloze,
  serializeEditableCloze,
  type TextRange,
  updateEditableClozeSentence,
} from "@/lib/native-cloze";
import { CardPresentation, formatAspectLabel } from "@/components/card-presentation";
import { PrimaryButton } from "@/components/primary-button";
import { EditorField } from "@/components/editor-field";
import { ActionMenu } from "@/components/action-menu";
import { MoreOptions } from "@/components/more-options";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";

export type CardEditFormProps = {
  card: CardDraft;
  errors: CardDraftErrors;
  serverError?: string;
  imageCueAllowed: boolean;
  autoFocus?: boolean;
  onChange: (card: CardDraft) => void;
  onDelete: () => void;
  onReset: () => void;
};

function hiddenAnswer(card: ClozeCardDraft): string | null {
  return answerInRange(card.sentence, card.answerRange);
}

function answerInRange(
  sentence: string,
  range: TextRange | null,
): string | null {
  if (
    !range ||
    range.start < 0 ||
    range.start >= range.end ||
    range.end > sentence.length
  ) {
    return null;
  }
  return sentence.slice(range.start, range.end);
}

function FieldError({ children }: { children?: string }) {
  return children
    ? (
      <Text accessibilityRole="alert" className="text-caption text-destructive">
        {children}
      </Text>
    )
    : null;
}

function learnerSafeSentence(sentence: string): string {
  const storedCloze = parseEditableCloze(sentence);
  if (storedCloze) return storedCloze.sentence;
  if (
    sentence.includes("{{") || sentence.includes("}}") ||
    sentence.includes("::")
  ) {
    return "Fix the sentence to preview this card.";
  }
  return sentence;
}

function CardPreview({ card }: { card: CardDraft }) {
  if (card.kind === "cloze") {
    const front = serializeEditableCloze(card);
    if (!front) {
      const hint = card.hint.trim();
      return (
        <View className="gap-xs" accessibilityLabel="Card preview">
          <Text className="text-caption font-semibold text-muted-foreground">
            Preview
          </Text>
          <Text className="text-body leading-[24px]">
            {learnerSafeSentence(card.sentence)}
          </Text>
          {hint
            ? (
              <Text className="text-body italic text-muted-foreground">
                [{hint}]
              </Text>
            )
            : null}
          {card.imageCue && hint
            ? (
              <Text className="text-caption text-muted-foreground">
                Uses the note image as a cue
              </Text>
            )
            : null}
        </View>
      );
    }
    return (
      <CardPresentation
        card={{
          id: card.persistedId ?? card.key,
          cardType: "cloze",
          aspect: card.aspect,
          front,
          back: card.back.trim() || null,
          imageCue: card.imageCue,
        }}
        mode="inspection"
      />
    );
  }
  return (
    <CardPresentation
      card={{
        id: card.persistedId ?? card.key,
        cardType: "basic",
        aspect: card.aspect,
        front: card.question,
        back: card.answer,
        imageCue: card.imageCue,
      }}
      mode="inspection"
    />
  );
}

export function CardEditForm({
  card,
  errors,
  serverError,
  imageCueAllowed,
  autoFocus = false,
  onChange,
  onDelete,
  onReset,
}: CardEditFormProps) {
  const [pendingSelection, setPendingSelection] = useState<TextRange | null>(
    null,
  );
  const [clozeAnnouncement, setClozeAnnouncement] = useState<string | null>(
    null,
  );
  const focusCardContent = autoFocus && card.persistedId === null;
  const currentHiddenAnswer = card.kind === "cloze" ? hiddenAnswer(card) : null;
  const clozeStatus = errors.answerRange ?? clozeAnnouncement ??
    (currentHiddenAnswer
      ? `Hidden answer: “${currentHiddenAnswer}”.`
      : "No hidden answer selected. Select a word or phrase to hide.");

  return (
    <Card accessibilityLabel="Card editor" className="gap-md rounded-lg">
      <View className="flex-row items-center justify-between gap-sm">
        <Text className="flex-1 text-[13px] font-semibold text-muted-foreground">{formatAspectLabel(card.aspect)}</Text>
        <ActionMenu
          label="More card actions"
          title="Card actions"
          actions={[
            ...(card.persistedId !== null && !card.resetProgress
              ? [{ label: "Reset progress", icon: "refresh-outline" as const, destructive: true, onPress: onReset }]
              : []),
            { label: card.persistedId === null ? "Remove card" : "Delete card", icon: "trash-outline", destructive: true, onPress: onDelete },
          ]}
        />
      </View>
      {card.kind === "basic"
        ? (
          <>
            <EditorField
              autoFocus={focusCardContent}
              error={errors.question}
              label="Question"
              multiline
              value={card.question}
              onChangeText={(question) => onChange({ ...card, question })}
            />
            <EditorField
              error={errors.answer}
              label="Answer"
              multiline
              value={card.answer}
              onChangeText={(answer) => onChange({ ...card, answer })}
            />
          </>
        )
        : (
          <>
            <EditorField
              accessibilityHint="Select a word or phrase, then activate Hide selection to make it the hidden answer."
              autoFocus={focusCardContent}
              error={errors.sentence}
              label="Sentence"
              multiline
              value={card.sentence}
              onChangeText={(sentence) => {
                setPendingSelection(null);
                setClozeAnnouncement(
                  "Text selection cleared after the sentence changed.",
                );
                onChange({
                  ...card,
                  ...updateEditableClozeSentence(card, sentence),
                });
              }}
              onSelectionChange={({ nativeEvent }) => {
                const selection = nativeEvent.selection;
                const selectedAnswer = answerInRange(card.sentence, selection);
                setPendingSelection(selection);
                setClozeAnnouncement(
                  selectedAnswer
                    ? `Selected “${selectedAnswer}”. Activate Hide selection to make it the hidden answer.`
                    : "Selection cleared. Select a word or phrase to hide.",
                );
              }}
            />
            <View className="flex-row items-center gap-sm">
            <PrimaryButton
              className="flex-1"
              disabled={!pendingSelection ||
                pendingSelection.start === pendingSelection.end}
              variant="ghost"
              onPress={() => {
                if (pendingSelection) {
                  const selectedAnswer = answerInRange(
                    card.sentence,
                    pendingSelection,
                  );
                  onChange({
                    ...card,
                    answerRange: pendingSelection,
                  });
                  if (selectedAnswer) {
                    setClozeAnnouncement(
                      `Hidden answer set to “${selectedAnswer}”.`,
                    );
                  }
                }
              }}
            >
              Hide selection
            </PrimaryButton>
            {hiddenAnswer(card)
              ? (
                  <PrimaryButton
                    className="flex-1"
                    variant="ghost"
                    accessibilityLabel="Clear hidden answer"
                    onPress={() => {
                      setClozeAnnouncement(
                        "Hidden answer cleared. Select a word or phrase to hide.",
                      );
                      onChange({ ...card, answerRange: null });
                    }}
                  >
                    Clear
                  </PrimaryButton>
              )
              : null}
            </View>
            <Text
              accessibilityLiveRegion={errors.answerRange
                ? "assertive"
                : "polite"}
              accessibilityRole={errors.answerRange ? "alert" : undefined}
              aria-live={errors.answerRange ? "assertive" : "polite"}
              className={errors.answerRange
                ? "text-caption text-destructive"
                : "text-caption text-muted-foreground"}
              testID="hidden-answer-status"
            >
              {clozeStatus}
            </Text>
            <EditorField
              error={errors.hint}
              label="Text cue"
              value={card.hint}
              onChangeText={(hint) =>
                onChange({
                  ...card,
                  hint,
                  imageCue: hint.trim() ? card.imageCue : false,
                })}
            />
            <EditorField
              label="Translation or explanation (optional)"
              multiline
              value={card.back}
              onChangeText={(back) => onChange({ ...card, back })}
            />
          </>
        )}

      <MoreOptions invalid={Boolean(errors.aspect)}>
        <EditorField
          error={errors.aspect}
          label="Learning focus"
          value={card.aspect}
          onChangeText={(aspect) => onChange({ ...card, aspect })}
        />
        {card.kind === "cloze" && imageCueAllowed && card.hint.trim().length > 0
          ? (
            <View className="min-h-[48px] flex-row items-center justify-between gap-md">
              <Text className="flex-1 text-body">Use the note image as the main cue</Text>
              <Switch
                accessibilityLabel="Use the note image as the main cue"
                checked={card.imageCue}
                hitSlop={12}
                onCheckedChange={(imageCue) => onChange({ ...card, imageCue })}
              />
            </View>
          )
          : null}
      </MoreOptions>
      {serverError ? <FieldError>{serverError}</FieldError> : null}
      <CardPreview card={card} />
      {card.resetProgress
        ? (
          <View className="gap-xs rounded-md bg-surface-muted p-sm">
            <Text className="text-[14px] text-muted-foreground">Progress will reset when you save.</Text>
            <PrimaryButton selected variant="ghost" onPress={onReset}>
              Keep existing progress
            </PrimaryButton>
          </View>
        )
        : null}
    </Card>
  );
}
