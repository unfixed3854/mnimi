import { useCallback, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, View } from "react-native";
import { Link } from "expo-router";
import type { CreationDetail } from "@/api/creations";
import { AddCardDialog } from "@/components/add-card-dialog";
import { GeneratedImage, type GeneratedImageStatus } from "@/components/generated-image";
import { PictureStatus } from "@/components/picture-status";
import { PrimaryButton } from "@/components/primary-button";
import { Text } from "@/components/ui/text";
import { nativeColors } from "@/theme/native-colors";
import { CreationArrival, useCreationArrivals } from "@/features/create/creation-arrival";
import { CreationCardPreview } from "@/features/create/creation-card-preview";

export function CreationPreview({
  creation,
  onAddCard,
  onAdjust,
  onUndo,
  onCancelReplacement,
  onRetryImage,
  actionPending = false,
  footer,
}: {
  creation: CreationDetail;
  onAddCard: (kind: "basic" | "cloze") => void | Promise<void>;
  onAdjust?: () => void;
  onUndo?: () => void | Promise<void>;
  onCancelReplacement?: () => void | Promise<void>;
  onRetryImage?: () => void | Promise<void>;
  actionPending?: boolean;
  footer?: React.ReactNode;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null);
  const onImageStatusChange = useCallback((status: GeneratedImageStatus) => {
    setLoadedImageId(status === "ready" ? creation.draftImageId : null);
  }, [creation.draftImageId]);
  const editingDisabled = actionPending || Boolean(creation.activity);
  const pictureAvailable = creation.imageStatus === "ready" &&
    Boolean(loadedImageId) && loadedImageId === creation.draftImageId;
  const attemptKey = creation.attemptId ?? creation.id;
  const arrivals = useCreationArrivals([
    ...creation.cards.map((card) => `${attemptKey}:${card.key}`),
    ...(creation.imageStatus === "ready" && creation.draftImageId
      ? [`image:${creation.draftImageId}`]
      : []),
  ]);
  return (
    <View className="gap-md">
      {creation.imageStatus === "ready" && creation.draftImageId
        ? (
          <CreationArrival
            kind="image"
            animate={arrivals.has(`image:${creation.draftImageId}`)}
            testID="creation-image-arrival"
          >
            <GeneratedImage
              scope="drafts"
              id={creation.draftImageId}
              present
              alt={`${creation.sourceText} illustration`}
              onStatusChange={onImageStatusChange}
            />
          </CreationArrival>
        )
        : creation.imageStatus === "queued" || creation.imageStatus === "generating"
        ? <PictureStatus generating />
        : null}
      {creation.imageStatus === "failed"
        ? <PictureStatus pending={actionPending} onRetry={onRetryImage} />
        : null}
      {creation.generationSummary
        ? (
          <View className="gap-xs rounded-md border border-border bg-surface p-md">
            <Text className="text-caption font-semibold text-muted-foreground">
              Generation summary
            </Text>
            <Text className="text-body">{creation.generationSummary}</Text>
          </View>
        )
        : null}
      <View className="gap-sm">
        {creation.cards.map((card, index) => {
          const arrivalKey = `${attemptKey}:${card.key}`;
          const cardPreview = <CreationCardPreview card={card} pictureAvailable={pictureAvailable} />;
          const editLabel = `Edit ${card.aspect} card`;
          return (
            <CreationArrival
              key={arrivalKey}
              kind="card"
              position={index}
              animate={arrivals.has(arrivalKey)}
            >
              {editingDisabled
                ? (
                  <Pressable
                    disabled
                    accessibilityRole="link"
                    accessibilityLabel={editLabel}
                    accessibilityState={{ disabled: true }}
                  >
                    {cardPreview}
                  </Pressable>
                )
                : (
                  <Link
                    href={{
                      pathname: "/creations/[creationId]/card/[cardKey]",
                      params: { creationId: creation.id, cardKey: card.key },
                    }}
                    asChild
                  >
                    <Pressable
                      accessibilityRole="link"
                      accessibilityLabel={editLabel}
                      className="active:opacity-80"
                    >
                      {cardPreview}
                    </Pressable>
                  </Link>
                )}
            </CreationArrival>
          );
        })}
      </View>
      {creation.error && creation.errorStage !== "image"
        ? (
          <Text accessibilityRole="alert" className="text-caption text-destructive">
            {creation.error}
          </Text>
        )
        : null}
      {creation.activity
        ? (
          <View className="gap-sm rounded-md border border-border bg-surface p-md">
            <Text className="text-body font-semibold">
              {creation.activity === "adjusting"
                ? "Adjusting cards"
                : "Regenerating for the new deck"}
            </Text>
            <Text className="text-caption text-muted-foreground">
              Your current cards stay visible. Wait for the replacement or cancel it.
            </Text>
            {onCancelReplacement
              ? (
                <PrimaryButton
                  variant="outline"
                  pending={actionPending}
                  onPress={onCancelReplacement}
                >
                  Cancel replacement
                </PrimaryButton>
              )
              : null}
          </View>
        )
        : null}
      {creation.undoAvailable && onUndo
        ? (
          <View className="flex-row items-center justify-between gap-md">
            <Text className="text-body">Cards adjusted</Text>
            <PrimaryButton variant="ghost" pending={actionPending} disabled={Boolean(creation.activity)} onPress={onUndo}>
              Undo
            </PrimaryButton>
          </View>
        )
        : null}
      <View className="flex-row flex-wrap items-center justify-between gap-sm">
        {creation.cards.length < 6
          ? (
            <PrimaryButton variant="ghost" disabled={editingDisabled} onPress={() => setAddOpen(true)}
              icon={<Ionicons name="add" size={20} color={nativeColors.foreground} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />}
            >
              Add card
            </PrimaryButton>
          )
          : null}
        {onAdjust
          ? (
            <PrimaryButton
              variant="tonal"
              disabled={editingDisabled}
              onPress={onAdjust}
              icon={<Ionicons name="sparkles-outline" size={18} color={nativeColors.primary} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />}
            >
              Adjust with AI
            </PrimaryButton>
          )
          : null}
      </View>
      {footer}
      <AddCardDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSelect={async (kind) => {
          setAddOpen(false);
          await onAddCard(kind);
        }}
      />
    </View>
  );
}
