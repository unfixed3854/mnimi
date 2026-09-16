import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Grade } from "ts-fsrs";
import { type CardRow, gradeCard } from "@/lib/fsrs";
import { orpc } from "@/api/orpc";
import type { PronunciationSpeed } from "@/api/decks";

export type DueCard = CardRow & {
  id: string;
  noteId: string;
  aspect: string;
  front: string;
  back: string | null;
  imageCue: boolean;
  hasImage: boolean;
  audioEligible: boolean;
  hasAudio: boolean;
  audioStatus: "pending" | "generating" | "ready" | "failed" | null;
  pronunciationSpeed: PronunciationSpeed;
};

export function dueCardsHaveActiveAudio(data: DueCard[] | undefined): boolean {
  return data?.some((card) =>
    card.audioStatus === "pending" || card.audioStatus === "generating"
  ) ?? false;
}

export function useDueCards(deckId?: string, shuffleSeed?: number) {
  return useQuery<DueCard[]>({
    ...(orpc.cards.due.queryOptions({
      input: { deckId: deckId ?? null, shuffleSeed },
    }) as any),
    refetchInterval: (query: { state: { data: DueCard[] | undefined } }) =>
      dueCardsHaveActiveAudio(query.state.data) ? 2000 : false,
  });
}

export function useDueCount(deckId?: string) {
  return useQuery<number>(
    orpc.cards.dueCount.queryOptions({
      input: { deckId: deckId ?? null },
    }) as never,
  );
}

/** Keeps the native FSRS calculation client-side and submits its exact result. */
export function useGradeCard() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { card: CardRow; rating: Grade }>({
    mutationFn: async ({ card, rating }) => {
      const { card: columns, log } = gradeCard(card, rating);
      await orpc.cards.grade.call({ cardId: card.id, card: columns, log });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
  });
}

/** Starts server-side pronunciation generation and refreshes card projections. */
export function useGenerateCardAudio() {
  const queryClient = useQueryClient();
  return useMutation<
    { hasAudio: boolean; audioStatus: "ready" },
    Error,
    { cardId: string }
  >(
    orpc.cards.generateAudio.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
    }) as never,
  );
}
