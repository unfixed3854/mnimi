import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { client, orpc } from "@/api/orpc";
import { SessionExpiredError } from "@/lib/session-expired";

export type CreationGroup =
  | "needsChoice"
  | "ready"
  | "creating"
  | "queued"
  | "failed";

export type CreationSummary = {
  id: string;
  clientRequestId: string;
  sourceText: string;
  deckName: string | null;
  group: CreationGroup;
  stateLabel: string;
  thumbnailId: string | null;
  revision: number;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
};

export type CreationCard = {
  key: string;
  aspect: string;
  front: string;
  back: string | null;
  imageCue: boolean;
};

export type CreationRouting =
  | {
    kind: "matched";
    deckId: string;
    learningGoal: string;
  }
  | {
    kind: "ambiguous";
    candidates: Array<{
      deckId: string;
      deckName: string;
      learningGoal: string;
    }>;
  }
  | {
    kind: "newDeck";
    proposedName: string;
    proposedDescription: string | null;
    learningGoal: string;
  };

export type CreationDetail = {
  id: string;
  clientRequestId: string;
  sourceText: string;
  status: string;
  activity: "adjusting" | "regenerating" | null;
  revision: number;
  attemptId: string | null;
  deck: { id: string; name: string; description: string | null } | null;
  learningGoal: string | null;
  routing: CreationRouting | null;
  cards: CreationCard[];
  attemptCards: CreationCard[];
  undoAvailable: boolean;
  generationSummary: string | null;
  imagePrompt: string | null;
  imageCueAllowed: boolean;
  imageStatus: "none" | "queued" | "generating" | "ready" | "failed";
  draftImageId: string | null;
  errorCategory: string | null;
  errorStage: string | null;
  error: string | null;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
};

export type CreationInboxEvent = {
  type: "snapshot";
  creations: CreationSummary[];
  changedCreationId: string;
  attemptId: string | null;
};

export type CreationDetailEvent = {
  type: "snapshot";
  creation: CreationDetail | null;
  attemptId: string | null;
};

export function creationListQueryOptions() {
  return orpc.drafts.list.queryOptions({ input: {} }) as never;
}

export function creationListKey(): readonly unknown[] {
  return (creationListQueryOptions() as { queryKey: readonly unknown[] }).queryKey;
}

export function creationDetailQueryOptions(creationId: string) {
  return orpc.drafts.get.queryOptions({ input: { creationId } }) as never;
}

export function creationDetailKey(creationId: string): readonly unknown[] {
  return (creationDetailQueryOptions(creationId) as {
    queryKey: readonly unknown[];
  }).queryKey;
}

export function useCreationList() {
  return useQuery<CreationSummary[]>(creationListQueryOptions());
}

export function useCreation(creationId: string) {
  return useQuery<CreationDetail>(creationDetailQueryOptions(creationId));
}

export function applyCreationInboxSnapshot(
  current: CreationSummary[] | undefined,
  incoming: CreationSummary[],
): CreationSummary[] {
  if (!current) return incoming;
  const revisions = new Map(incoming.map((item) => [item.id, item.revision]));
  const stale = current.some((item) => {
    const revision = revisions.get(item.id);
    return revision !== undefined && revision < item.revision;
  });
  return stale ? current : incoming;
}

export function actionableCreationCount(
  summaries: CreationSummary[],
): number {
  return summaries.filter((summary) =>
    summary.group === "needsChoice" || summary.group === "ready" ||
    summary.group === "failed"
  ).length;
}

export function removeCreationFromCache(
  queryClient: QueryClient,
  creationId: string,
): void {
  queryClient.setQueryData<CreationSummary[]>(creationListKey(), (current) =>
    current?.filter((creation) => creation.id !== creationId)
  );
  queryClient.removeQueries({ queryKey: creationDetailKey(creationId), exact: true });
}

export async function submitCreation(input: {
  clientRequestId: string;
  text: string;
}) {
  return await (client as any).drafts.submit(input) as {
    creationId: string;
    clientRequestId: string;
    status: string;
  };
}

export async function* watchCreationInbox(
  signal: AbortSignal,
): AsyncGenerator<CreationInboxEvent> {
  try {
    for await (
      const event of await (client as any).drafts.watchInbox({}, { signal })
    ) yield event as CreationInboxEvent;
  } catch (error) {
    if (signal.aborted) return;
    throw error instanceof Error && error.message === "Your session expired"
      ? new SessionExpiredError()
      : error;
  }
}

export async function* watchCreationDetail(
  creationId: string,
  signal: AbortSignal,
): AsyncGenerator<CreationDetailEvent> {
  try {
    for await (
      const event of await (client as any).drafts.watch(
        { creationId },
        { signal },
      )
    ) yield event as CreationDetailEvent;
  } catch (error) {
    if (signal.aborted) return;
    throw error instanceof Error && error.message === "Your session expired"
      ? new SessionExpiredError()
      : error;
  }
}

export async function creationMutation<T>(
  name: string,
  input: Record<string, unknown>,
): Promise<T> {
  return await (client as any).drafts[name](input) as T;
}

export async function saveCreationWithCache(
  queryClient: QueryClient,
  input: {
    creationId: string;
    expectedRevision: number;
    saveRequestId: string;
  },
): Promise<{ noteId: string; deckId: string; sourceText: string }> {
  const result = await (client as any).drafts.save(input) as {
    noteId: string;
    deckId: string;
    sourceText: string;
  };
  removeCreationFromCache(queryClient, input.creationId);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.decks.key() }),
  ]);
  return result;
}
