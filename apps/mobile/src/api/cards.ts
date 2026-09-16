import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/api/orpc";

/** Server-side count deliberately avoids the 100-card review queue cap. */
export function useDueCount(deckId?: string) {
  return useQuery<number>(
    orpc.cards.dueCount.queryOptions({
      input: { deckId: deckId ?? null },
    }) as never,
  );
}
