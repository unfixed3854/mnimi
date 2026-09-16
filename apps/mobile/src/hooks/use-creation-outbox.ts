import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyCreationInboxSnapshot,
  creationListKey,
  submitCreation,
  useCreationList,
  watchCreationInbox,
} from "@/api/creations";
import type { CreationSummary } from "@/api/creations";
import { useSession } from "@/auth/session-store";
import {
  acknowledgeRequest,
  emptyCreationOutbox,
  enqueueRequest,
  loadCreationOutbox,
  markFailed,
  markSending,
  normalizeCreationRequest,
  saveCreationOutbox,
} from "@/lib/creation-outbox";
import type {
  CreationOutboxDocument,
  CreationOutboxItem,
} from "@/lib/creation-outbox";

const PRIORITY = {
  needsChoice: 0,
  ready: 1,
  creating: 2,
  queued: 3,
  failed: 4,
} as const;

function optimisticSummary(item: CreationOutboxItem): CreationSummary {
  return {
    id: `outbox:${item.clientRequestId}`,
    clientRequestId: item.clientRequestId,
    sourceText: item.sourceText,
    deckName: null,
    group: item.state === "failed" ? "failed" : "queued",
    stateLabel: item.state === "failed" ? "Needs attention" : "Queued",
    thumbnailId: null,
    revision: 0,
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
  };
}

function time(value: Date | string | number): number {
  return new Date(value).getTime();
}

export function useCreationOutbox() {
  const session = useSession();
  const userId = session?.user.id ?? null;
  const queryClient = useQueryClient();
  const list = useCreationList();
  const [document, setDocument] = useState<CreationOutboxDocument>(
    emptyCreationOutbox,
  );
  const [ready, setReady] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const documentRef = useRef(document);
  const writeChain = useRef(Promise.resolve());
  const sending = useRef(new Set<string>());

  const persist = useCallback((next: CreationOutboxDocument) => {
    documentRef.current = next;
    setDocument(next);
    if (!userId) return Promise.resolve();
    const write = writeChain.current.catch(() => undefined).then(() =>
      saveCreationOutbox(userId, next)
    );
    writeChain.current = write;
    return write;
  }, [userId]);

  const send = useCallback(async (item: CreationOutboxItem) => {
    if (!userId || sending.current.has(item.clientRequestId)) return;
    const normalized = normalizeCreationRequest(item.sourceText);
    if (!normalized.ok) {
      await persist(markFailed(
        documentRef.current,
        item.clientRequestId,
        normalized.error,
      ));
      return;
    }
    sending.current.add(item.clientRequestId);
    documentRef.current = markSending(
      documentRef.current,
      item.clientRequestId,
    );
    setDocument(documentRef.current);
    try {
      const result = await submitCreation({
        clientRequestId: item.clientRequestId,
        text: normalized.text,
      });
      queryClient.setQueryData<CreationSummary[]>(creationListKey(), (current) => {
        const withoutRequest = (current ?? []).filter((creation) =>
          creation.clientRequestId !== item.clientRequestId
        );
        return [{
          id: result.creationId,
          clientRequestId: result.clientRequestId,
          sourceText: normalized.text,
          deckName: null,
          group: "queued",
          stateLabel: "Queued",
          thumbnailId: null,
          revision: 0,
          createdAt: item.createdAt,
          updatedAt: Date.now(),
        }, ...withoutRequest];
      });
      await persist(acknowledgeRequest(
        documentRef.current,
        item.clientRequestId,
      ));
    } catch {
      await persist(markFailed(
        documentRef.current,
        item.clientRequestId,
        "Couldn't send this request. Try again.",
      ));
    } finally {
      sending.current.delete(item.clientRequestId);
    }
  }, [persist, queryClient, userId]);

  useEffect(() => {
    let active = true;
    setReady(false);
    setValidationError(null);
    sending.current.clear();
    if (!userId) {
      const empty = emptyCreationOutbox();
      documentRef.current = empty;
      setDocument(empty);
      return () => {
        active = false;
      };
    }
    void loadCreationOutbox(userId).then((loaded) => {
      if (!active) return;
      const recovered = {
        ...loaded,
        items: loaded.items.map((item) =>
          item.state === "sending" ? { ...item, state: "pending" as const } : item
        ),
      };
      documentRef.current = recovered;
      setDocument(recovered);
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  useEffect(() => {
    if (!ready || !onlineManager.isOnline()) return;
    for (const item of documentRef.current.items) void send(item);
  }, [ready, send]);

  useEffect(() => onlineManager.subscribe((online) => {
    if (!online || !ready) return;
    for (const item of documentRef.current.items) void send(item);
  }), [ready, send]);

  useEffect(() => {
    if (!ready || !userId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of watchCreationInbox(controller.signal)) {
          queryClient.setQueryData<CreationSummary[]>(
            creationListKey(),
            (current) => applyCreationInboxSnapshot(current, event.creations),
          );
        }
      } catch {
        // The list query and reconnect lifecycle remain the recovery source.
      }
    })();
    return () => controller.abort();
  }, [queryClient, ready, userId]);

  const creations = useMemo(() => {
    const server = list.data ?? [];
    const serverRequests = new Set(server.map((item) => item.clientRequestId));
    return [...server, ...document.items
      .filter((item) => !serverRequests.has(item.clientRequestId))
      .map(optimisticSummary)]
      .sort((left, right) =>
        PRIORITY[left.group] - PRIORITY[right.group] ||
        time(right.updatedAt) - time(left.updatedAt)
      );
  }, [document.items, list.data]);

  return {
    ready,
    composer: document.composer,
    items: document.items,
    creations,
    validationError,
    listError: list.error,
    isLoading: list.isLoading && !ready,
    actionableCount: creations.filter((creation) =>
      creation.group === "needsChoice" || creation.group === "ready" ||
      creation.group === "failed"
    ).length,
    setComposer(value: string) {
      setValidationError(null);
      void persist({ ...documentRef.current, composer: value });
    },
    async submit(): Promise<boolean> {
      const result = enqueueRequest(documentRef.current);
      if (!result.ok) {
        setValidationError(result.error);
        return false;
      }
      setValidationError(null);
      await persist(result.document);
      await send(result.item);
      return true;
    },
    async retry(clientRequestId: string): Promise<void> {
      const item = documentRef.current.items.find((candidate) =>
        candidate.clientRequestId === clientRequestId
      );
      if (item) await send(item);
    },
  };
}
