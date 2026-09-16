import { router } from "expo-router";
import { View } from "react-native";
import type { CardDraft, ClozeCardDraft } from "@/lib/card-draft";
import { updateEditableClozeSentence } from "@/lib/native-cloze";
import { LoadingState } from "@/components/loading-state";
import { PageHeader } from "@/components/page-header";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "@/components/ui/button";
import { ActionMenu } from "@/components/action-menu";
import { EditorField } from "@/components/editor-field";
import { MoreOptions } from "@/components/more-options";
import { nativeColors } from "@/theme/native-colors";
import { PrimaryButton } from "@/components/primary-button";
import { Screen } from "@/components/screen";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useCreationCardEdit } from "@/hooks/use-creation-card-edit";

function hiddenAnswer(card: ClozeCardDraft): string {
  const range = card.answerRange;
  return range ? card.sentence.slice(range.start, range.end) : "";
}

function replaceHiddenAnswer(card: ClozeCardDraft, answer: string): ClozeCardDraft {
  const range = card.answerRange;
  if (!range) {
    const start = answer ? card.sentence.indexOf(answer) : -1;
    return start < 0
      ? card
      : { ...card, answerRange: { start, end: start + answer.length } };
  }
  return {
    ...card,
    sentence: `${card.sentence.slice(0, range.start)}${answer}${card.sentence.slice(range.end)}`,
    answerRange: answer
      ? { start: range.start, end: range.start + answer.length }
      : null,
  };
}

export function CreationCardEditorScreen({
  creationId,
  cardKey,
}: {
  creationId: string;
  cardKey: string;
}) {
  const edit = useCreationCardEdit(creationId, cardKey);
  const card = edit.card;
  if (!edit.ready || !card) {
    return (
      <Screen>
        <PageHeader
          title="Edit card"
          back={{ href: { pathname: "/creations/[creationId]", params: { creationId } }, label: "Back to creation" }}
        />
        <LoadingState layout="editor" label="Loading card" />
      </Screen>
    );
  }

  function change(next: CardDraft) {
    edit.change(next);
  }

  return (
    <Screen
      footer={
        <PrimaryButton
          pending={edit.saving}
          onPress={async () => {
            if (await edit.done()) router.back();
          }}
        >
          Done
        </PrimaryButton>
      }
    >
      <View className="flex-row items-center gap-sm pt-sm">
        <Button variant="ghost" size="icon" accessibilityLabel="Back to creation" onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={nativeColors.foreground} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        </Button>
        <Text accessibilityRole="header" className="flex-1 text-[24px] leading-[32px] font-semibold">Edit card</Text>
        <ActionMenu
          label="More card actions"
          title="Card actions"
          disabled={edit.saving}
          actions={[{
            label: "Remove card",
            icon: "trash-outline",
            destructive: true,
            onPress: async () => {
              if (await edit.remove()) router.back();
            },
          }]}
        />
      </View>
      <View className="gap-md rounded-lg border border-border bg-surface p-md">
        {card.kind === "basic"
          ? (
            <>
              <EditorField
                label="Prompt"
                value={card.question}
                error={edit.errors.question}
                multiline
                onChangeText={(question) => change({ ...card, question })}
              />
              <EditorField
                label="Answer"
                value={card.answer}
                error={edit.errors.answer}
                multiline
                onChangeText={(answer) => change({ ...card, answer })}
              />
            </>
          )
          : (
            <>
              <EditorField
                label="Sentence"
                value={card.sentence}
                error={edit.errors.sentence}
                multiline
                onChangeText={(sentence) =>
                  change({
                    ...card,
                    ...updateEditableClozeSentence(card, sentence),
                  })}
              />
              <EditorField
                label="Hidden answer"
                value={hiddenAnswer(card)}
                error={edit.errors.answerRange}
                onChangeText={(answer) => change(replaceHiddenAnswer(card, answer))}
              />
              <EditorField
                label="Hint"
                value={card.hint}
                error={edit.errors.hint}
                onChangeText={(hint) => change({ ...card, hint })}
              />
              <EditorField
                label="Full meaning (optional)"
                value={card.back}
                multiline
                onChangeText={(back) => change({ ...card, back })}
              />
            </>
          )}
        <MoreOptions invalid={Boolean(edit.errors.aspect)}>
          <EditorField
            label="Learning focus"
            value={card.aspect}
            error={edit.errors.aspect}
            onChangeText={(aspect) => change({ ...card, aspect })}
          />
          {edit.imageCueAllowed
            ? (
              <View className="min-h-[48px] flex-row items-center justify-between gap-md">
                <Text className="flex-1 text-body">Use the creation image as a cue</Text>
                <Switch
                  accessibilityLabel="Use the creation image as a cue"
                  checked={card.imageCue}
                  onCheckedChange={(imageCue) => change({ ...card, imageCue })}
                />
              </View>
            )
            : null}
        </MoreOptions>
        {edit.serverError
          ? (
            <View className="gap-sm">
              <Text accessibilityRole="alert" className="text-caption text-destructive">
                {edit.serverError}
              </Text>
              <PrimaryButton
                variant="outline"
                onPress={async () => {
                  await edit.retry();
                }}
              >
                Try again
              </PrimaryButton>
              <PrimaryButton variant="ghost" onPress={edit.refresh}>Refresh from creation</PrimaryButton>
            </View>
          )
          : null}
      </View>
    </Screen>
  );
}
