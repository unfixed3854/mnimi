import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCreateDeck, useDecks } from "@/api/decks";
import { client, orpc } from "@/api/orpc";
import {
  type CompleteDraftCard,
  currentDraftQueryKey,
  type Draft,
  type DraftCard,
  updateDraft,
  useCurrentDraft,
  useDiscardDraft,
  useRetryDraftImage,
  useStartDraft,
  watchDraft,
} from "@/api/drafts";
import { draftReducer, initialDraftState, isSavable } from "@/lib/draft-state";
import { runDraftWatch } from "@/lib/watch-draft";

const AUTOSAVE_MS = 1000;
const editable = (status: string) => status === "ready" || status === "failed";

function writable(cards: DraftCard[], trim = false): CompleteDraftCard[] {
  return cards.map((card) => ({
    aspect: card.aspect ?? "",
    front: trim ? (card.front ?? "").trim() : card.front ?? "",
    back: trim ? (card.back ?? "").trim() || null : card.back ?? null,
    imageCue: card.imageCue ?? false,
  }));
}

/** Owns the transient watch and debounce so leaving Add cannot retain either. */
export function useDraftSession() {
  const { data: decks = [] } = useDecks();
  const current = useCurrentDraft();
  const startDraft = useStartDraft();
  const discardDraft = useDiscardDraft();
  const retryImage = useRetryDraftImage();
  const createDeckMutation = useCreateDeck();
  const queryClient = useQueryClient();
  const saveNote = useMutation({
    mutationFn: (input: { draftId: string; cards: CompleteDraftCard[] }) =>
      (client as any).notes.save(input),
  });
  const [state, dispatch] = useReducer(draftReducer, initialDraftState);
  const [text, setText] = useState("");
  const [deckId, setDeckId] = useState("");
  const autosave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAutosave = useRef<
    { draftId: string; deckId: string; cards: CompleteDraftCard[] } | null
  >(null);
  const firstAutosave = useRef(true);
  const hydratedCardsJson = useRef<string | null>(null);
  const loadedDraftId = useRef<string | null | undefined>(undefined);

  useLayoutEffect(() => {
    if (current.isPending) return;
    const nextDraftId = current.data?.id ?? null;
    // A status-only cache update after a watch terminal event is for the
    // header. Do not reload this reducer for the same draft: it may hold
    // newer local card edits waiting for autosave.
    if (loadedDraftId.current === nextDraftId) return;
    loadedDraftId.current = nextDraftId;
    firstAutosave.current = true;
    hydratedCardsJson.current = current.data
      ? JSON.stringify(writable(current.data.cards))
      : null;
    dispatch({ type: "loaded", draft: current.data ?? null });
  }, [current.data, current.isPending]);

  const draftId = state.status === "loading" || state.status === "none"
    ? null
    : state.draftId;
  const live = state.status !== "loading" && state.status !== "none" &&
    (state.status === "generating" || state.imageStatus === "generating");
  useEffect(() => {
    if (!draftId || !live) return;
    const controller = new AbortController();
    void runDraftWatch(draftId, watchDraft, (event) => {
      const terminalStatus = event.type === "done"
        ? "ready"
        : event.type === "failed"
        ? "failed"
        : event.type === "snapshot" && event.draft.status !== "generating"
        ? event.draft.status
        : null;
      dispatch(
        event.type === "snapshot" && terminalStatus
          ? { type: "terminal-snapshot", draft: event.draft }
          : event,
      );
      if (terminalStatus) {
        queryClient.setQueryData<Draft | null>(
          currentDraftQueryKey(),
          (currentDraft) =>
            currentDraft
              ? { ...currentDraft, status: terminalStatus }
              : currentDraft,
        );
        void queryClient.invalidateQueries({
          queryKey: currentDraftQueryKey(),
        });
      }
    }, controller.signal);
    return () => controller.abort();
  }, [draftId, live, queryClient]);

  const cardsJson = state.status !== "loading" && state.status !== "none" &&
      editable(state.status)
    ? JSON.stringify(writable(state.cards))
    : null;
  const autosaveDeckId =
    state.status !== "loading" && state.status !== "none" &&
      editable(state.status)
      ? state.deckId
      : null;
  function flushAutosave() {
    if (autosave.current) clearTimeout(autosave.current);
    autosave.current = null;
    const pending = pendingAutosave.current;
    pendingAutosave.current = null;
    if (pending) void updateDraft(pending).catch(() => undefined);
  }
  useLayoutEffect(() => {
    if (autosave.current) clearTimeout(autosave.current);
    pendingAutosave.current = null;
    if (!draftId || cardsJson === null || autosaveDeckId === null) return;
    if (firstAutosave.current && cardsJson === hydratedCardsJson.current) {
      firstAutosave.current = false;
      return;
    }
    firstAutosave.current = false;
    pendingAutosave.current = {
      draftId,
      deckId: autosaveDeckId,
      cards: JSON.parse(cardsJson),
    };
    autosave.current = setTimeout(() => {
      flushAutosave();
    }, AUTOSAVE_MS);
  }, [autosaveDeckId, cardsJson, draftId]);
  useEffect(() => () => flushAutosave(), []);

  const canStart = Boolean(text.trim() && deckId && !startDraft.isPending);
  return useMemo(() => ({
    state,
    decks,
    text,
    setText,
    deckId,
    setDeckId,
    startPending: startDraft.isPending,
    createDeckPending: createDeckMutation.isPending,
    startError: startDraft.error,
    discardPending: discardDraft.isPending,
    discardError: discardDraft.error,
    retryPending: retryImage.isPending,
    retryError: retryImage.error,
    savePending: saveNote.isPending,
    saveError: saveNote.error,
    canStart,
    canSave: isSavable(state),
    dispatch,
    start: async () => {
      if (canStart) {
        await startDraft.mutateAsync({ deckId, text: text.trim() } as never);
      }
    },
    createDeck: async (name: string) => {
      const deck = await createDeckMutation.mutateAsync({ name } as never) as {
        id: string;
      };
      setDeckId(deck.id);
    },
    discard: async () => {
      if (draftId) await discardDraft.mutateAsync({ draftId } as never);
    },
    retryImage: async () => {
      if (!draftId) return;
      await retryImage.mutateAsync({ draftId } as never);
      dispatch({ type: "image", status: "generating", draftImageId: null });
    },
    save: async () => {
      if (
        !draftId || state.status === "loading" || state.status === "none" ||
        !isSavable(state)
      ) return null;
      const note = await saveNote.mutateAsync(
        { draftId, cards: writable(state.cards, true) } as never,
      ) as { id: string };
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.notes.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.cards.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.drafts.key() }),
      ]);
      return note;
    },
  }), [
    autosaveDeckId,
    canStart,
    createDeckMutation,
    deckId,
    decks,
    discardDraft,
    draftId,
    queryClient,
    retryImage,
    saveNote,
    startDraft,
    state,
    text,
  ]);
}
