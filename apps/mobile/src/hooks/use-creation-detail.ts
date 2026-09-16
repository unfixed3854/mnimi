import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import {
  creationDetailKey,
  useCreation,
  watchCreationDetail,
} from "@/api/creations";
import type { CreationDetail } from "@/api/creations";

export function acceptCreationSnapshot(
  current: CreationDetail | undefined,
  incoming: CreationDetail,
): CreationDetail {
  if (current && incoming.revision < current.revision) return current;
  if (
    current && incoming.revision === current.revision && current.attemptId &&
    incoming.attemptId && incoming.attemptId !== current.attemptId
  ) return current;
  return incoming;
}

export function useCreationDetail(creationId: string) {
  const queryClient = useQueryClient();
  const query = useCreation(creationId);
  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (
          const event of watchCreationDetail(creationId, controller.signal)
        ) {
          if (!event.creation) {
            queryClient.removeQueries({
              queryKey: creationDetailKey(creationId),
              exact: true,
            });
            continue;
          }
          queryClient.setQueryData<CreationDetail>(
            creationDetailKey(creationId),
            (current) => acceptCreationSnapshot(current, event.creation!),
          );
        }
      } catch {
        // The persisted query snapshot remains usable after a transport drop.
      }
    })();
    return () => controller.abort();
  }, [creationId, queryClient]));

  return {
    creation: query.data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
