import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, getDraftsQueryKey, orpc } from "@/api/orpc";
import type { PronunciationSpeed } from "@/api/decks";

export type EditableCard = {
  aspect: string;
  front: string;
  back: string | null;
  imageCue: boolean;
};

export type CardType = "basic" | "cloze";
export type CardAudioStatus =
  | "pending"
  | "generating"
  | "ready"
  | "failed"
  | null;

export type NoteSummary = {
  id: string;
  deckId: string;
  sourceText: string;
};

export type NoteCard = EditableCard & {
  id: string;
  cardType: CardType;
  audioEligible: boolean;
  hasAudio: boolean;
  audioStatus: CardAudioStatus;
};

export type NoteDetails = {
  pronunciationSpeed: PronunciationSpeed;
  note: NoteSummary & {
    revision: number;
    domain: string;
    language: string | null;
    imagePath: string | null;
    metadata: { imagePrompt?: string | null };
  };
  cards: NoteCard[];
  imageGenerating: boolean;
};

export type NoteUpdateInput = {
  noteId: string;
  expectedRevision: number;
  creates: Array<{ clientKey: string; card: EditableCard }>;
  updates: Array<{ cardId: string; card: EditableCard }>;
  deleteCardIds: string[];
  resetCardIds: string[];
};

export type NoteUpdateResult = NoteDetails & {
  createdIds: Array<{ clientKey: string; cardId: string }>;
};

export type NoteMutationIssue =
  | { kind: "conflict"; message: string }
  | {
    kind: "card";
    cardKey: string;
    field: "aspect" | "front" | "back";
    message: string;
  }
  | { kind: "general"; message: string };

export function noteMutationIssue(error: unknown): NoteMutationIssue {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    data?: { cardId?: unknown; clientKey?: unknown; field?: unknown };
  };
  const message = typeof candidate?.message === "string"
    ? candidate.message
    : "Couldn't save this note.";

  if (candidate?.code === "CONFLICT") {
    return { kind: "conflict", message };
  }

  const cardKey = typeof candidate?.data?.cardId === "string"
    ? candidate.data.cardId
    : typeof candidate?.data?.clientKey === "string"
    ? candidate.data.clientKey
    : null;
  const field = candidate?.data?.field;
  if (
    cardKey &&
    (field === "aspect" || field === "front" || field === "back")
  ) {
    return { kind: "card", cardKey, field, message };
  }

  return { kind: "general", message };
}

export function isNoteNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "NOT_FOUND";
}

export function useNotes(deckId: string) {
  return useQuery<NoteSummary[]>(
    orpc.notes.listByDeck.queryOptions({ input: { deckId } }) as never,
  );
}

export function noteHasActiveAudio(
  data: Pick<NoteDetails, "cards"> | undefined,
): boolean {
  return data?.cards.some((card) =>
    card.audioStatus === "pending" || card.audioStatus === "generating"
  ) ?? false;
}

export function useNote(noteId: string) {
  return useQuery<NoteDetails>({
    ...(orpc.notes.get.queryOptions({ input: { noteId } }) as any),
    refetchInterval: (query) =>
      query.state.data?.imageGenerating || noteHasActiveAudio(query.state.data)
        ? 2000
        : false,
  });
}

export function useSaveNote() {
  const queryClient = useQueryClient();
  return useMutation<
    NoteSummary,
    Error,
    { draftId: string; cards: EditableCard[] }
  >(orpc.notes.save.mutationOptions({
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
        queryClient.invalidateQueries({ queryKey: getDraftsQueryKey() }),
      ]),
  }) as never);
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation<NoteUpdateResult, Error, NoteUpdateInput>(
    orpc.notes.update.mutationOptions({
      onSuccess: (result: NoteUpdateResult, input: NoteUpdateInput) => {
        const detailKey = orpc.notes.get.queryOptions({
          input: { noteId: input.noteId },
        }).queryKey;
        queryClient.setQueryData(detailKey, result);
        return Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
        ]);
      },
    }) as never,
  );
}

export function useDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation<
    { id: string; deckId: string },
    Error,
    { noteId: string; expectedRevision: number }
  >(
    orpc.notes.delete.mutationOptions({
      retry: false,
      onSuccess: async (
        _result: { id: string; deckId: string },
        input: { noteId: string; expectedRevision: number },
      ) => {
        const detailKey = orpc.notes.get.queryOptions({
          input: { noteId: input.noteId },
        }).queryKey;
        await queryClient.cancelQueries({ queryKey: detailKey, exact: true });
        queryClient.removeQueries({ queryKey: detailKey, exact: true });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
        ]);
      },
    }) as never,
  );
}

/** Re-runs an image job for a saved note whose original image did not arrive. */
export function useGenerateNoteImage() {
  const queryClient = useQueryClient();
  return useMutation<
    { imagePath: string },
    Error,
    { noteId: string; prompt: string }
  >({
    mutationFn: (input) => (client as any).ai.generateImage(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
  });
}
