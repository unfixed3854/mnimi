import { useState } from "react";
import { View } from "react-native";
import type { NoteDetails } from "@/api/notes";
import { CardPresentation } from "@/components/card-presentation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { GeneratedImage } from "@/components/generated-image";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { PronunciationControl } from "@/components/pronunciation-control";
import { Screen } from "@/components/screen";
import { ActionMenu } from "@/components/action-menu";
import { PictureStatus } from "@/components/picture-status";
import { Text } from "@/components/ui/text";

export type NoteReadViewProps = {
  details: NoteDetails;
  imagePending: boolean;
  imageError: string | null;
  deletePending: boolean;
  deleteError: string | null;
  refreshError: string | null;
  onEdit: () => void;
  onAddCard: () => void;
  onRetryImage: () => Promise<void>;
  onRetryRefresh: () => Promise<void>;
  onDelete: () => Promise<void>;
};

/** Displays a saved note's learning material without taking ownership of data or mutations. */
export function NoteReadView({
  details,
  imagePending,
  imageError,
  deletePending,
  deleteError,
  refreshError,
  onEdit,
  onAddCard,
  onRetryImage,
  onRetryRefresh,
  onDelete,
}: NoteReadViewProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { note, cards, imageGenerating, pronunciationSpeed } = details;
  const canRetryImage = note.imagePath === null &&
    Boolean(note.metadata.imagePrompt) && !imageGenerating;
  const hasPictureContent = note.imagePath !== null || imageGenerating ||
    canRetryImage || imageError !== null;

  return (
    <Screen>
      <PageHeader
        back={{
          href: {
            pathname: "/decks/[deckId]",
            params: { deckId: note.deckId },
          },
          label: "Back to deck",
        }}
        title={note.sourceText}
        subtitle={`${cards.length} card${cards.length === 1 ? "" : "s"}`}
        trailing={
          <View className="flex-row items-center">
            <PrimaryButton variant="ghost" onPress={onEdit} disabled={deletePending}>Edit</PrimaryButton>
            <ActionMenu
              label="More note actions"
              title="Note actions"
              disabled={deletePending}
              actions={[{ label: "Delete note", icon: "trash-outline", destructive: true, onPress: () => setConfirmDelete(true) }]}
            />
          </View>
        }
      />
      {refreshError
        ? (
          <View className="gap-sm rounded-md bg-surface-muted p-md">
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
      {hasPictureContent
        ? (
          <View className="gap-sm">
            <GeneratedImage
              alt={note.sourceText}
              id={note.id}
              present={note.imagePath !== null}
              scope="notes"
            />
            {note.imagePath === null && (imageGenerating || canRetryImage)
              ? <PictureStatus generating={imageGenerating} pending={imagePending} onRetry={canRetryImage ? onRetryImage : undefined} />
              : null}
            {imageError
              ? <Text accessibilityRole="alert" className="text-caption text-destructive">{imageError}</Text>
              : null}
          </View>
        )
        : null}
      <View className="gap-sm">
        {cards.length
          ? cards.map((card) => (
            <CardPresentation
              key={card.id}
              card={card}
              footer={card.audioEligible
                ? (
                  <PronunciationControl
                    autoplay={false}
                    card={{ ...card, pronunciationSpeed }}
                  />
                )
                : undefined}
              mode="inspection"
            />
          ))
          : (
            <EmptyState
              compact
              illustration="cards"
              title="Give this thought a little practice"
              message="Add a card to turn this note into something you can remember."
              action={
                <PrimaryButton variant="tonal" onPress={onAddCard}>
                  Add card
                </PrimaryButton>
              }
            />
          )}
      </View>
      {deleteError
        ? <Text accessibilityRole="alert" className="text-caption text-destructive">{deleteError}</Text>
        : null}
      <ConfirmDialog
        destructive
        pending={deletePending}
        visible={confirmDelete}
        title="Delete this note?"
        message="This permanently deletes the note, all of its cards, review history, picture, and pronunciation audio. This can't be undone."
        confirmLabel="Delete note"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await onDelete();
          setConfirmDelete(false);
        }}
      />
    </Screen>
  );
}
