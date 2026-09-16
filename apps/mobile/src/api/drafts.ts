import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, orpc } from "@/api/orpc";
import { SessionExpiredError } from "@/lib/session-expired";

export type DraftClassification = {
  domain: string;
  language: string | null;
  partOfSpeech: string | null;
};
export type DraftCard = {
  aspect: string | null;
  front: string | null;
  back: string | null;
  imageCue: boolean | null;
};
export type DraftImageStatus = "none" | "generating" | "ready" | "failed";
export type Draft = {
  id: string;
  deckId: string;
  sourceText: string;
  status: "generating" | "ready" | "failed";
  classification: DraftClassification | null;
  cards: DraftCard[];
  imagePrompt: string | null;
  imageStatus: DraftImageStatus;
  draftImageId: string | null;
  error: string | null;
  createdAt: Date | string | number;
};
export type CompleteDraftCard = Required<DraftCard>;
export type DraftEvent =
  | { type: "snapshot"; draft: Draft }
  | { type: "classified"; classification: DraftClassification }
  | { type: "image-prompt"; prompt: string | null }
  | { type: "cards"; cards: DraftCard[] }
  | { type: "retry" }
  | {
    type: "done";
    classification: DraftClassification;
    generation: { imagePrompt: string | null; cards: DraftCard[] };
  }
  | { type: "image"; status: DraftImageStatus; draftImageId: string | null }
  | { type: "failed"; message: string };

export const draftsKey = () => orpc.drafts.key();
export function currentDraftQueryOptions() {
  return orpc.drafts.current.queryOptions({ input: {} }) as never;
}
export function currentDraftQueryKey() {
  return (currentDraftQueryOptions() as { queryKey: readonly unknown[] })
    .queryKey;
}
export function useCurrentDraft() {
  return useQuery<Draft | null>(currentDraftQueryOptions());
}
export function useStartDraft() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.drafts.start.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: draftsKey() }),
    }) as never,
  );
}
export function useDiscardDraft() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.drafts.discard.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: draftsKey() }),
    }) as never,
  );
}
export function useRetryDraftImage() {
  return useMutation(orpc.drafts.retryImage.mutationOptions() as never);
}
export async function updateDraft(
  input: { draftId: string; deckId?: string; cards?: CompleteDraftCard[] },
) {
  return await (client as any).drafts.update(input);
}
export async function* watchDraft(
  draftId: string,
  signal: AbortSignal,
): AsyncGenerator<DraftEvent> {
  try {
    for await (
      const event of await (client as any).drafts.watch({ draftId }, { signal })
    ) yield event as DraftEvent;
  } catch (error) {
    if (signal.aborted) return;
    throw error instanceof Error && error.message === "Your session expired"
      ? new SessionExpiredError()
      : error;
  }
}
