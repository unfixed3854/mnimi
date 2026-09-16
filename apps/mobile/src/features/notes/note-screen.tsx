import { useRef, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import {
  isNoteNotFoundError,
  type NoteMutationIssue,
  noteMutationIssue,
  useDeleteNote,
  useGenerateNoteImage,
  useNote,
  useUpdateNote,
} from "@/api/notes";
import { ErrorState } from "@/components/error-state";
import { LoadingState } from "@/components/loading-state";
import { PageHeader } from "@/components/page-header";
import { PrimaryButton } from "@/components/primary-button";
import { Screen } from "@/components/screen";
import {
  buildNoteUpdateInput,
  type CardDraft,
  type CardDraftErrors,
  createCardDraft,
  hydrateNoteEditDraft,
  type NoteEditDraft,
  validateCardDraft,
} from "@/lib/card-draft";
import { NoteEditView } from "@/features/notes/note-edit-view";
import { NoteReadView } from "@/features/notes/note-read-view";

const reloadFailureMessage =
  "Couldn't load the latest note. Your changes are still here.";
const deleteConflictMessage =
  "This note changed elsewhere. Review the latest version, then confirm deletion again.";
const deleteConflictReloadFailureMessage =
  "This note changed elsewhere, but the latest version couldn't be loaded. Refresh it before trying again.";

function withoutKey<T>(record: Record<string, T>, key: string) {
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

export function NoteScreen({ noteId }: { noteId: string }) {
  const noteQuery = useNote(noteId);
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const generateImage = useGenerateNoteImage();
  const [draft, setDraft] = useState<NoteEditDraft | null>(null);
  const [startAdding, setStartAdding] = useState(false);
  const [errorsByKey, setErrorsByKey] = useState<
    Record<string, CardDraftErrors>
  >({});
  const [serverErrorsByKey, setServerErrorsByKey] = useState<
    Record<string, string>
  >({});
  const [saveIssue, setSaveIssue] = useState<NoteMutationIssue | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const nextLocalKey = useRef(1);

  function beginEditing(addImmediately = false) {
    if (!noteQuery.data) return;
    setDraft(hydrateNoteEditDraft(noteQuery.data));
    setStartAdding(addImmediately);
    setErrorsByKey({});
    setServerErrorsByKey({});
    setSaveIssue(null);
  }

  function changeCard(key: string, card: CardDraft) {
    setDraft((current) => current
      ? {
        ...current,
        cards: current.cards.map((candidate) =>
          candidate.key === key ? card : candidate
        ),
      }
      : current);
    setErrorsByKey((current) => withoutKey(current, key));
    setServerErrorsByKey((current) => withoutKey(current, key));
  }

  function addCard(kind: CardDraft["kind"]): string {
    const key = `new-${nextLocalKey.current++}`;
    setDraft((current) => current
      ? { ...current, cards: [...current.cards, createCardDraft(kind, key)] }
      : current);
    return key;
  }

  function deleteCardFromDraft(key: string) {
    setDraft((current) => current
      ? {
        ...current,
        cards: current.cards.filter((card) => card.key !== key),
      }
      : current);
    setErrorsByKey((current) => withoutKey(current, key));
    setServerErrorsByKey((current) => withoutKey(current, key));
  }

  function toggleReset(key: string) {
    setDraft((current) => current
      ? {
        ...current,
        cards: current.cards.map((card) =>
          card.key === key
            ? { ...card, resetProgress: !card.resetProgress }
            : card
        ),
      }
      : current);
  }

  async function saveChanges() {
    if (!draft || !noteQuery.data) return;
    const imageCueAllowed = noteQuery.data.note.domain === "language" &&
      noteQuery.data.note.metadata.imagePrompt != null;
    const validationErrors: Record<string, CardDraftErrors> = {};
    for (const card of draft.cards) {
      const errors = validateCardDraft(card, { imageCueAllowed });
      if (Object.keys(errors).length > 0) validationErrors[card.key] = errors;
    }
    setErrorsByKey(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    const input = buildNoteUpdateInput(draft);
    setServerErrorsByKey({});
    setSaveIssue(null);
    try {
      await updateNote.mutateAsync(input);
      setDraft(null);
      setStartAdding(false);
    } catch (cause) {
      const issue = noteMutationIssue(cause);
      if (issue.kind === "card") {
        setServerErrorsByKey({ [issue.cardKey]: issue.message });
      } else {
        setSaveIssue(issue);
      }
    }
  }

  async function reloadLatest() {
    try {
      const result = await noteQuery.refetch();
      if (result.isSuccess && result.data) {
        setDraft(null);
        setStartAdding(false);
        setSaveIssue(null);
        return;
      }
    } catch {
      // React Query usually resolves refetch failures, but preserve the draft
      // if an adapter rejects instead.
    }
    setSaveIssue({ kind: "general", message: reloadFailureMessage });
  }

  async function retryImage() {
    const note = noteQuery.data?.note;
    const prompt = note?.metadata.imagePrompt;
    if (!note || !prompt) return;
    setImageError(null);
    try {
      await generateImage.mutateAsync({ noteId: note.id, prompt });
    } catch {
      setImageError("That didn't work either. Try again in a moment.");
    }
  }

  async function removeNote() {
    const note = noteQuery.data?.note;
    if (!note) return;
    setDeleteError(null);
    try {
      await deleteNote.mutateAsync({
        noteId: note.id,
        expectedRevision: note.revision,
      });
      router.replace({
        pathname: "/decks/[deckId]",
        params: { deckId: note.deckId },
      });
    } catch (cause) {
      if (noteMutationIssue(cause).kind === "conflict") {
        try {
          const result = await noteQuery.refetch();
          setDeleteError(
            result.isSuccess && result.data
              ? deleteConflictMessage
              : deleteConflictReloadFailureMessage,
          );
        } catch {
          setDeleteError(deleteConflictReloadFailureMessage);
        }
        return;
      }
      setDeleteError(
        cause instanceof Error ? cause.message : "Couldn't delete this note.",
      );
    }
  }

  async function retryNoteFetch() {
    await noteQuery.refetch();
  }

  const noteNotFound = noteQuery.isError &&
    isNoteNotFoundError(noteQuery.error);

  if (noteQuery.isLoading && !noteQuery.data) {
    return (
      <Screen>
        <PageHeader
          back={{ href: "/decks", label: "Back to decks" }}
          title="Note"
        />
        <LoadingState layout="note" label="Loading note" />
      </Screen>
    );
  }

  if (noteNotFound || !noteQuery.data) {
    return (
      <Screen>
        <PageHeader
          back={{ href: "/decks", label: "Back to decks" }}
          title="Note"
        />
        <ErrorState
          message={noteNotFound
            ? "This note no longer exists."
            : noteQuery.error instanceof Error
            ? noteQuery.error.message
            : "This note no longer exists."}
        />
        {noteQuery.isError && !noteNotFound
          ? (
            <View className="items-center">
              <PrimaryButton
                variant="outline"
                onPress={retryNoteFetch}
              >
                Retry
              </PrimaryButton>
            </View>
          )
          : null}
      </Screen>
    );
  }

  const data = noteQuery.data;
  const imageCueAllowed = data.note.domain === "language" &&
    data.note.metadata.imagePrompt != null;
  const refreshError = noteQuery.isError
    ? noteQuery.error instanceof Error
      ? noteQuery.error.message
      : "The latest version couldn't be loaded."
    : null;

  return draft
    ? (
      <NoteEditView
        draft={draft}
        errorsByKey={errorsByKey}
        imageCueAllowed={imageCueAllowed}
        refreshError={refreshError}
        saveIssue={saveIssue}
        saving={updateNote.isPending}
        serverErrorsByKey={serverErrorsByKey}
        startAdding={startAdding}
        onAddCard={addCard}
        onCancel={() => setDraft(null)}
        onChangeCard={changeCard}
        onClearSaveIssue={() => setSaveIssue(null)}
        onDeleteCard={deleteCardFromDraft}
        onReloadLatest={reloadLatest}
        onRetryRefresh={retryNoteFetch}
        onResetCard={toggleReset}
        onSave={saveChanges}
      />
    )
    : (
      <NoteReadView
        details={data}
        deleteError={deleteError}
        deletePending={deleteNote.isPending}
        imageError={imageError}
        imagePending={generateImage.isPending}
        refreshError={refreshError}
        onAddCard={() => beginEditing(true)}
        onDelete={removeNote}
        onEdit={() => beginEditing(false)}
        onRetryImage={retryImage}
        onRetryRefresh={retryNoteFetch}
      />
    );
}
