import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDraftsQueryKey, orpc } from "@/api/orpc";

export type Deck = {
  id: string;
  name: string;
  description?: string | null;
  pronunciationSpeed: PronunciationSpeed;
  createdAt?: Date | string;
};

export type PronunciationSpeed = "slow" | "normal" | "fast";

export function useDecks() {
  return useQuery<Deck[]>(orpc.decks.list.queryOptions({ input: {} }) as never);
}

export function useDeck(deckId: string) {
  return useQuery<Deck[], Error, Deck | null>({
    ...(orpc.decks.list.queryOptions({ input: {} }) as any),
    select: (decks: Deck[]) => decks.find((deck) => deck.id === deckId) ?? null,
  });
}

export function useCreateDeck() {
  const queryClient = useQueryClient();
  return useMutation<
    Deck,
    Error,
    { name: string; description?: string | null }
  >(orpc.decks.create.mutationOptions({
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
  }) as never);
}

export function useUpdatePronunciationSpeed() {
  const queryClient = useQueryClient();
  return useMutation<
    Deck,
    Error,
    { deckId: string; pronunciationSpeed: PronunciationSpeed }
  >(orpc.decks.updatePronunciationSpeed.mutationOptions({
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
      ]),
  }) as never);
}

export function useRemoveDeck(onSuccess?: () => void | Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation<{ id: string }, Error, { deckId: string }>(
    orpc.decks.remove.mutationOptions({
      onSuccess: async () => {
        await onSuccess?.();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
          queryClient.invalidateQueries({ queryKey: getDraftsQueryKey() }),
        ]);
      },
    }) as never,
  );
}
