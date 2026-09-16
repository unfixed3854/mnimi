import { useState } from "react";
import { View } from "react-native";
import type { NoteMutationIssue } from "@/api/notes";
import { AddCardDialog } from "@/components/add-card-dialog";
import { CardEditForm } from "@/components/card-edit-form";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { Screen } from "@/components/screen";
import { SectionHeader } from "@/components/section-header";
import { Text } from "@/components/ui/text";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import {
  type CardDraft,
  type CardDraftErrors,
  isNoteEditDirty,
  type NoteEditDraft,
} from "@/lib/card-draft";

export type NoteEditViewProps = {
  draft: NoteEditDraft;
  imageCueAllowed: boolean;
  errorsByKey: Record<string, CardDraftErrors>;
  serverErrorsByKey: Record<string, string>;
  saveIssue: NoteMutationIssue | null;
  refreshError: string | null;
  saving: boolean;
  startAdding: boolean;
  onChangeCard: (key: string, card: CardDraft) => void;
  onAddCard: (kind: CardDraft["kind"]) => string;
  onDeleteCard: (key: string) => void;
  onResetCard: (key: string) => void;
  onCancel: () => void;
  onSave: () => Promise<void>;
  onReloadLatest: () => Promise<void>;
  onRetryRefresh: () => Promise<void>;
  onClearSaveIssue: () => void;
};

type PendingCardAction = {
  kind: "delete" | "reset";
  key: string;
};

type Confirmation = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

export function NoteEditView({
  draft,
  imageCueAllowed,
  errorsByKey,
  serverErrorsByKey,
  saveIssue,
  refreshError,
  saving,
  startAdding,
  onChangeCard,
  onAddCard,
  onDeleteCard,
  onResetCard,
  onCancel,
  onSave,
  onReloadLatest,
  onRetryRefresh,
  onClearSaveIssue,
}: NoteEditViewProps) {
  const [adding, setAdding] = useState(startAdding);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [pendingCardAction, setPendingCardAction] =
    useState<PendingCardAction | null>(null);
  const dirty = isNoteEditDirty(draft);
  const guard = useUnsavedChanges({ dirty });
  const pendingCard = pendingCardAction
    ? draft.cards.find((card) => card.key === pendingCardAction.key)
    : undefined;

  let confirmation: Confirmation | null = null;
  if (pendingCardAction && pendingCard) {
    if (pendingCardAction.kind === "delete") {
      const persisted = pendingCard.persistedId !== null;
      confirmation = {
        title: persisted ? "Delete this card?" : "Remove this new card?",
        message: persisted
          ? "Saving will permanently delete this card and its review history."
          : "This unsaved card will be removed from this editing session.",
        confirmLabel: persisted ? "Delete card" : "Remove card",
        destructive: true,
        onCancel: () => setPendingCardAction(null),
        onConfirm: () => {
          onDeleteCard(pendingCardAction.key);
          setPendingCardAction(null);
        },
      };
    } else {
      confirmation = {
        title: "Reset this card's progress?",
        message:
          "Saving will delete this card's review history and make it due now. Its content will stay.",
        confirmLabel: "Reset progress",
        destructive: true,
        onCancel: () => setPendingCardAction(null),
        onConfirm: () => {
          onResetCard(pendingCardAction.key);
          setPendingCardAction(null);
        },
      };
    }
  } else if (guard.confirming) {
    confirmation = {
      title: "Discard changes?",
      message:
        "Your card edits, additions, deletions, and pending progress resets will be discarded.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
      onCancel: guard.keepEditing,
      onConfirm: guard.discardAndLeave,
    };
  } else if (saveIssue?.kind === "conflict") {
    confirmation = {
      title: "This note changed elsewhere",
      message: `${saveIssue.message} Your local changes are still here.`,
      confirmLabel: "Load latest",
      cancelLabel: "Keep editing",
      onCancel: onClearSaveIssue,
      onConfirm: onReloadLatest,
    };
  }

  return (
    <Screen
      footer={
        <View className="gap-sm">
          {saveIssue?.kind === "general"
            ? (
              <Text
                accessibilityRole="alert"
                className="text-caption text-destructive"
              >
                {saveIssue.message}
              </Text>
            )
            : null}
          <PrimaryButton
            disabled={!dirty}
            pending={saving}
            onPress={onSave}
          >
            Save changes
          </PrimaryButton>
        </View>
      }
    >
      <PageHeader
        title="Edit note"
        trailing={
          <PrimaryButton
            variant="ghost"
            onPress={() => guard.requestLeave(onCancel)}
          >
            Cancel
          </PrimaryButton>
        }
      />

      {refreshError
        ? (
          <View className="mt-md gap-sm rounded-md bg-surface-muted p-md">
            <Text
              accessibilityRole="alert"
              className="text-caption text-muted-foreground"
            >
              Couldn't refresh this note. {refreshError}
            </Text>
            <PrimaryButton variant="outline" onPress={onRetryRefresh}>
              Retry refresh
            </PrimaryButton>
          </View>
        )
        : null}

      <View className="gap-md">
        <SectionHeader
          title="Cards"
          trailing={draft.cards.length > 0
            ? (
              <PrimaryButton variant="ghost" onPress={() => setAdding(true)}>
                Add card
              </PrimaryButton>
            )
            : undefined}
        />
        {draft.cards.length === 0
          ? (
            <EmptyState
              compact
              illustration="cards"
              title="Give this thought a little practice"
              message="Start with one question you'd like to remember the answer to."
              action={
                <PrimaryButton variant="tonal" onPress={() => setAdding(true)}>
                  Add card
                </PrimaryButton>
              }
            />
          )
          : draft.cards.map((card) => (
            <CardEditForm
              key={card.key}
              autoFocus={card.key === focusKey}
              card={card}
              errors={errorsByKey[card.key] ?? {}}
              imageCueAllowed={imageCueAllowed}
              serverError={serverErrorsByKey[card.key]}
              onChange={(nextCard) => onChangeCard(card.key, nextCard)}
              onDelete={() =>
                setPendingCardAction({ kind: "delete", key: card.key })}
              onReset={() => {
                if (card.resetProgress) {
                  onResetCard(card.key);
                  return;
                }
                setPendingCardAction({ kind: "reset", key: card.key });
              }}
            />
          ))}
      </View>

      <AddCardDialog
        open={adding}
        onOpenChange={setAdding}
        onSelect={(kind) => {
          const key = onAddCard(kind);
          setFocusKey(key);
          setAdding(false);
        }}
      />
      {confirmation
        ? (
          <ConfirmDialog
            visible
            cancelLabel={confirmation.cancelLabel}
            confirmLabel={confirmation.confirmLabel}
            destructive={confirmation.destructive}
            message={confirmation.message}
            onCancel={confirmation.onCancel}
            onConfirm={confirmation.onConfirm}
            title={confirmation.title}
          />
        )
        : null}
    </Screen>
  );
}
