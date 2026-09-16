import { useEffect, useRef, useState } from "react";
import { router } from "expo-router";
import { View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  creationDetailKey,
  creationListKey,
  creationMutation,
  saveCreationWithCache,
} from "@/api/creations";
import { useDecks } from "@/api/decks";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { LoadingState } from "@/components/loading-state";
import { PageHeader } from "@/components/page-header";
import { Screen } from "@/components/screen";
import { Text } from "@/components/ui/text";
import { PrimaryButton } from "@/components/primary-button";
import { SelectionDialog } from "@/components/selection-dialog";
import { useCreationDetail } from "@/hooks/use-creation-detail";
import { useSession } from "@/auth/session-store";
import { createBlankCreationCardDraft } from "@/lib/creation-card-draft";
import {
  persistBlankCreationCard,
} from "@/hooks/use-creation-card-edit";
import { setVisibleCreationId } from "@/notifications/registration";
import { CreationFailurePanel } from "@/features/create/creation-failure-panel";
import { CreationProgress } from "@/features/create/creation-progress";
import { DeckDecisionDialog } from "@/features/create/deck-decision-dialog";
import { NotificationLeaveEducation } from "@/features/create/notification-leave-education";
import { CreationPreview } from "@/features/create/creation-preview";
import { AdjustCreationDialog } from "@/features/create/adjust-creation-dialog";
import { CreationActions } from "@/features/create/creation-actions";

function learnerMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function CreationDetailScreen({ creationId }: { creationId: string }) {
  const detail = useCreationDetail(creationId);
  const queryClient = useQueryClient();
  const { data: decks = [] } = useDecks();
  const userId = useSession()?.user.id ?? null;
  const creation = detail.creation;
  const [removalOpen, setRemovalOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [deckPickerMode, setDeckPickerMode] = useState<
    "resolve" | "change" | null
  >(null);
  const saveRequestId = useRef(
    `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
  useEffect(() => {
    if (creation?.status === "needs_choice" && creation.routing) {
      setDecisionOpen(true);
    }
  }, [creation?.routing, creation?.status]);
  useEffect(() => {
    setVisibleCreationId(creationId);
    return () => setVisibleCreationId(null);
  }, [creationId]);
  const choosingDeck = creation?.status === "needs_choice";
  useEffect(() => {
    if (!choosingDeck && deckPickerMode === "resolve") {
      setDeckPickerMode(null);
    }
  }, [choosingDeck, deckPickerMode]);

  if (detail.isLoading || !creation) {
    return (
      <Screen>
        <PageHeader title="Creation" back={{ href: "/add", label: "Back to Create" }} />
        {detail.error
          ? <ErrorState message={learnerMessage(detail.error)} />
          : <LoadingState layout="creation" label="Loading creation" />}
      </Screen>
    );
  }

  async function mutate(
    name: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      await creationMutation(name, input);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: creationListKey() }),
        queryClient.invalidateQueries({
          queryKey: creationDetailKey(creationId),
          exact: true,
        }),
      ]);
      return true;
    } catch (cause) {
      setError(learnerMessage(cause));
      return false;
    } finally {
      setPending(false);
    }
  }

  const active = ["queued", "routing", "generating", "adjusting", "regenerating"]
    .includes(creation.status);
  const initialWork = creation.cards.length === 0 &&
    creation.status !== "needs_choice";
  const hasCards = creation.cards.length > 0;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveCreationWithCache(queryClient, {
        creationId,
        expectedRevision: creation.revision,
        saveRequestId: saveRequestId.current,
      });
      router.replace({
        pathname: "/add",
        params: {
          savedNoteId: saved.noteId,
          savedDeckName: creation.deck?.name ?? "your deck",
        },
      });
    } catch (cause) {
      setError(learnerMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  function confirmRemoval() {
    setRemovalOpen(true);
  }

  const queued = creation.status === "queued";
  const running = creation.status === "routing" ||
    creation.status === "generating";
  const removalDialog = (
    <ConfirmDialog
      visible={removalOpen}
      title={queued
        ? "Remove from queue?"
        : running
        ? "Cancel creation?"
        : choosingDeck
        ? "Discard request?"
        : "Discard creation?"}
      message={running
        ? `Stop creating “${creation.sourceText}”? Completed unsaved work will be removed.`
        : choosingDeck
        ? `Discard “${creation.sourceText}”? This request will be removed.`
        : `Remove “${creation.sourceText}”?${queued ? " You can undo this briefly." : " Its unsaved cards will be lost."}`}
      confirmLabel={queued
        ? "Remove"
        : running
        ? "Cancel creation"
        : choosingDeck
        ? "Discard request"
        : "Discard"}
      cancelLabel="Keep"
      destructive
      pending={pending}
      onCancel={() => setRemovalOpen(false)}
      onConfirm={async () => {
        const removed = await mutate(queued || running ? "cancel" : "discard", {
          creationId,
          expectedRevision: creation.revision,
        });
        setRemovalOpen(false);
        if (removed) {
          router.replace({
            pathname: "/add",
            params: queued ? { removedCreationId: creationId } : {},
          });
        }
      }}
    />
  );
  if (initialWork && creation.status === "failed") {
    const routingFailed = creation.errorStage === "routing";
    return (
      <Screen>
        {removalDialog}
        <PageHeader
          title={creation.sourceText}
          back={{ href: "/add", label: "Back to Create" }}
        />
        <CreationFailurePanel
          routingFailed={routingFailed}
          failureMessage={creation.error}
          actionError={error}
          pending={pending}
          onRetry={async () => {
            await mutate("retry", {
              creationId,
              stage: routingFailed ? "routing" : "cards",
            });
          }}
          onDiscard={confirmRemoval}
        />
        {creation.attemptCards.length > 0 || creation.imageStatus === "ready"
          ? (
            <CreationProgress
              creation={creation}
              onRetryImage={async () => {
                await mutate("retryImage", { creationId });
              }}
            />
          )
          : null}
      </Screen>
    );
  }
  return (
    <Screen footer={hasCards
      ? (
        <View className="gap-sm">
          {error
            ? <Text accessibilityRole="alert" className="text-caption text-destructive">{error}</Text>
            : null}
          {creation.activity
            ? <Text className="text-center text-[14px] text-muted-foreground">Wait for the replacement or cancel it before saving.</Text>
            : null}
          <PrimaryButton pending={saving} disabled={pending || Boolean(creation.activity)} onPress={save}>
            Save to {creation.deck?.name ?? "deck"}
          </PrimaryButton>
        </View>
      )
      : undefined}
    >
      {removalDialog}
      <PageHeader
        title={creation.sourceText}
        subtitle={hasCards
          ? [creation.deck?.name, `${creation.cards.length} ${creation.cards.length === 1 ? "card" : "cards"}`].filter(Boolean).join(" · ")
          : creation.deck?.name}
        back={{ href: "/add", label: "Back to Create" }}
        trailing={hasCards
          ? <CreationActions disabled={pending || saving || Boolean(creation.activity)} onChangeDeck={() => setDeckPickerMode("change")} onDiscard={confirmRemoval} />
          : undefined}
      />
      {active && !initialWork
        ? (
          <Text className="text-body text-muted-foreground">
            You can leave — we'll keep creating.
          </Text>
        )
        : null}
      <NotificationLeaveEducation active={active} />
      <DeckDecisionDialog
        open={decisionOpen}
        routing={creation.routing}
        pending={pending}
        error={error}
        onResolve={async (deckId) => {
          await mutate("resolveDeck", {
            creationId,
            expectedRevision: creation.revision,
            deckId,
          });
        }}
        onConfirmNewDeck={async (input) => {
          await mutate("confirmNewDeck", {
            creationId,
            expectedRevision: creation.revision,
            ...input,
          });
        }}
        onChooseExisting={decks.length > 0
          ? () => setDeckPickerMode("resolve")
          : undefined}
        onDiscard={confirmRemoval}
      />
      <AdjustCreationDialog
        open={adjustOpen}
        pending={pending}
        serverError={error}
        onCancel={() => setAdjustOpen(false)}
        onSubmit={async (instruction) => {
          const adjusted = await mutate("adjust", {
            creationId,
            expectedRevision: creation.revision,
            instruction,
          });
          if (adjusted) setAdjustOpen(false);
        }}
      />
      <SelectionDialog
        open={deckPickerMode !== null}
        title={deckPickerMode === "resolve"
          ? "Choose an existing deck"
          : "Choose a new deck"}
        value=""
        options={decks.filter((deck) => deck.id !== creation.deck?.id).map((deck) => ({
          value: deck.id,
          label: deck.name,
        }))}
        footer={
          <Text className="text-caption text-muted-foreground">
            {deckPickerMode === "resolve"
              ? "Mnimi will create the cards for this deck."
              : "A different deck changes the learning angle, so Mnimi will regenerate the cards instead of moving the current set."}
          </Text>
        }
        onOpenChange={(open) => {
          if (!open) setDeckPickerMode(null);
        }}
        onValueChange={(deckId) => void (async () => {
          if (!deckPickerMode) return;
          const changed = await mutate(
            deckPickerMode === "resolve" ? "resolveDeck" : "changeDeck",
            {
            creationId,
            expectedRevision: creation.revision,
            deckId,
            },
          );
          if (changed) setDeckPickerMode(null);
        })()}
      />
      <View>
        {creation.cards.length > 0
          ? (
            <CreationPreview
              creation={creation}
              actionPending={pending || saving}
              onAdjust={() => setAdjustOpen(true)}
              onUndo={creation.undoAvailable
                ? async () => {
                  await mutate("undoAdjustment", {
                    creationId,
                    expectedRevision: creation.revision,
                  });
                }
                : undefined}
              onCancelReplacement={creation.activity
                ? async () => {
                  await mutate("cancelAdjustment", {
                    creationId,
                    expectedRevision: creation.revision,
                  });
                }
                : undefined}
              onRetryImage={creation.imageStatus === "failed"
                ? async () => {
                  await mutate("retryImage", { creationId });
                }
                : undefined}
              onAddCard={async (kind) => {
                if (!userId) return;
                const cardKey = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
                await persistBlankCreationCard(
                  userId,
                  creationId,
                  createBlankCreationCardDraft(kind, cardKey),
                  creation.revision,
                );
                router.push({
                  pathname: "/creations/[creationId]/card/[cardKey]",
                  params: { creationId, cardKey },
                });
              }}
              footer={
                <View className="gap-sm">
                  {creation.status === "failed" && creation.errorStage !== "image"
                    ? (
                      <PrimaryButton
                        variant="outline"
                        pending={pending}
                        onPress={async () => {
                          await mutate("retry", {
                            creationId,
                            stage: creation.errorStage === "routing"
                              ? "routing"
                              : "cards",
                          });
                        }}
                      >
                        Try {creation.errorStage === "routing" ? "deck choice" : "cards"} again
                      </PrimaryButton>
                    )
                    : null}
                </View>
              }
            />
          )
          : (
            <CreationProgress
              creation={creation}
              onRetryImage={async () => {
                await mutate("retryImage", { creationId });
              }}
            />
          )}
      </View>
      {initialWork
        ? (
          <View className="gap-sm">
            {active
              ? (
                <Text className="text-center text-caption text-muted-foreground">
                  You can leave — we'll keep creating.
                </Text>
              )
              : null}
            {error
              ? <Text accessibilityRole="alert" className="text-caption text-destructive">{error}</Text>
              : null}
            <PrimaryButton
              variant="ghost"
              disabled={pending}
              onPress={confirmRemoval}
            >
              {creation.status === "queued"
                ? "Remove from queue"
                : "Cancel creation"}
            </PrimaryButton>
          </View>
        )
        : null}
    </Screen>
  );
}
