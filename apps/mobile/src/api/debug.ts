import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/api/orpc";

export type DebugSummary = {
  totalCards: number;
  decks: Array<{ id: string; name: string; cardCount: number }>;
  cards: Array<{ id: string; deckId: string; aspect: string; front: string }>;
};

/** These endpoints retain the server's --devtools authorization; the app only exposes them in development. */
export function useDebugSummary() {
  return useQuery<DebugSummary>(
    orpc.debug.summary.queryOptions({ input: {} }) as never,
  );
}

export function useResetSrs() {
  const queryClient = useQueryClient();
  return useMutation(orpc.debug.resetSrs.mutationOptions({
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.debug.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
      ]),
  }) as never);
}

export function useSeedGerman() {
  const queryClient = useQueryClient();
  return useMutation(orpc.debug.seedGerman.mutationOptions({
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.debug.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
      ]),
  }) as never);
}
