import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  creationDetailKey,
  creationMutation,
  useCreation,
} from "@/api/creations";
import type { CreationCard, CreationDetail } from "@/api/creations";
import { useSession } from "@/auth/session-store";
import type { CardDraft, CardDraftErrors } from "@/lib/card-draft";
import { validateCardDraft } from "@/lib/card-draft";
import {
  createBlankCreationCardDraft,
  hydrateCreationCardDraft,
  serializeCreationCardDraft,
} from "@/lib/creation-card-draft";

export function creationCardRecoveryKey(
  userId: string,
  creationId: string,
  cardKey: string,
): string {
  return `mnimi:creation-card:${userId}:${creationId}:${cardKey}`;
}

type RecoveryDocument = { revision: number; card: CardDraft; dirty?: boolean };

function parseRecovery(value: string | null): RecoveryDocument | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as RecoveryDocument;
    return parsed && typeof parsed.revision === "number" && parsed.card
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function persistBlankCreationCard(
  userId: string,
  creationId: string,
  card: CardDraft,
  revision: number,
): Promise<void> {
  await AsyncStorage.setItem(
    creationCardRecoveryKey(userId, creationId, card.key),
    JSON.stringify({ revision, card, dirty: true } satisfies RecoveryDocument),
  );
}

export function useCreationCardEdit(creationId: string, cardKey: string) {
  const userId = useSession()?.user.id ?? null;
  const query = useCreation(creationId);
  const queryClient = useQueryClient();
  const [card, setCard] = useState<CardDraft | null>(null);
  const [errors, setErrors] = useState<CardDraftErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const cardRef = useRef<CardDraft | null>(null);
  const revisionRef = useRef(0);
  const cardsRef = useRef<CreationCard[]>([]);
  const dirtyRef = useRef(false);
  const pausedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeChain = useRef(Promise.resolve());
  const mutationChain = useRef<Promise<unknown>>(Promise.resolve());
  const versionRef = useRef(0);
  const imageCueAllowed = query.data?.imageCueAllowed ?? false;

  useEffect(() => {
    let active = true;
    const creation = query.data;
    if (!userId || !creation) return () => {
      active = false;
    };
    revisionRef.current = creation.revision;
    cardsRef.current = creation.cards;
    const serverCard = creation.cards.find((candidate) => candidate.key === cardKey);
    void AsyncStorage.getItem(
      creationCardRecoveryKey(userId, creationId, cardKey),
    ).then((stored) => {
      if (!active) return;
      const recovered = parseRecovery(stored);
      const next = recovered?.card ?? (serverCard
        ? hydrateCreationCardDraft(serverCard)
        : createBlankCreationCardDraft("basic", cardKey));
      revisionRef.current = recovered?.revision ?? creation.revision;
      dirtyRef.current = recovered?.dirty ?? !serverCard;
      cardRef.current = next;
      setCard(next);
      setErrors(validateCardDraft(next, { imageCueAllowed }));
      setReady(true);
    });
    return () => {
      active = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [cardKey, creationId, query.data?.id, userId]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const persist = useCallback((next: CardDraft, dirty = true) => {
    if (!userId) return Promise.resolve();
    const document: RecoveryDocument = {
      revision: revisionRef.current,
      card: next,
      dirty,
    };
    const write = writeChain.current.catch(() => undefined).then(() =>
      AsyncStorage.setItem(
        creationCardRecoveryKey(userId, creationId, cardKey),
        JSON.stringify(document),
      )
    );
    writeChain.current = write;
    return write;
  }, [cardKey, creationId, userId]);

  const flush = useCallback(async (next = cardRef.current): Promise<boolean> => {
    if (!next || !userId) return false;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const nextErrors = validateCardDraft(next, { imageCueAllowed });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return false;
    const serialized = serializeCreationCardDraft(next);
    if (!serialized) return false;
    const version = versionRef.current;
    await writeChain.current;
    const operation = mutationChain.current.catch(() => undefined).then(
      async (): Promise<boolean> => {
        const index = cardsRef.current.findIndex((candidate) =>
          candidate.key === cardKey
        );
        const cards = index < 0
          ? [...cardsRef.current, serialized]
          : cardsRef.current.map((candidate, candidateIndex) =>
            candidateIndex === index ? serialized : candidate
          );
        if (cards.length > 6) {
          setServerError("A creation can contain up to six cards.");
          return false;
        }
        setSaving(true);
        setServerError(null);
        try {
          const result = await creationMutation<{ ok: true; revision: number }>(
            "update",
            {
              creationId,
              expectedRevision: revisionRef.current,
              cards,
            },
          );
          revisionRef.current = result.revision;
          cardsRef.current = cards;
          if (versionRef.current === version) dirtyRef.current = false;
          pausedRef.current = false;
          queryClient.setQueryData<CreationDetail>(
            creationDetailKey(creationId),
            (current) => current
              ? {
                ...current,
                cards,
                revision: result.revision,
                undoAvailable: false,
              }
              : current,
          );
          await persist(
            cardRef.current ?? next,
            versionRef.current !== version,
          );
          return true;
        } catch (cause) {
          pausedRef.current = true;
          setServerError(
            cause instanceof Error && /changed|conflict/i.test(cause.message)
              ? "This creation changed. Your fields are safe — refresh deliberately or retry."
              : "Couldn't save this card. Your fields are safe — try again.",
          );
          return false;
        } finally {
          setSaving(false);
        }
      },
    );
    mutationChain.current = operation;
    return await operation;
  }, [cardKey, creationId, imageCueAllowed, persist, queryClient, userId]);

  function change(next: CardDraft) {
    cardRef.current = next;
    setCard(next);
    dirtyRef.current = true;
    versionRef.current += 1;
    const nextErrors = validateCardDraft(next, { imageCueAllowed });
    setErrors(nextErrors);
    void persist(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (Object.keys(nextErrors).length === 0 && !pausedRef.current) {
      timerRef.current = setTimeout(() => void flush(next), 600);
    }
  }

  return {
    ready,
    card,
    errors,
    serverError,
    saving,
    imageCueAllowed,
    change,
    async done(): Promise<boolean> {
      const saved = dirtyRef.current ? await flush() : true;
      if (!saved || !userId) return false;
      await AsyncStorage.removeItem(
        creationCardRecoveryKey(userId, creationId, cardKey),
      );
      return true;
    },
    async remove(): Promise<boolean> {
      if (!userId) return false;
      await mutationChain.current.catch(() => undefined);
      const cards = cardsRef.current.filter((candidate) => candidate.key !== cardKey);
      if (cards.length === 0) {
        setServerError("Keep at least one card in this creation.");
        return false;
      }
      setSaving(true);
      try {
        const result = await creationMutation<{ ok: true; revision: number }>(
          "update",
          { creationId, expectedRevision: revisionRef.current, cards },
        );
        cardsRef.current = cards;
        revisionRef.current = result.revision;
        await AsyncStorage.removeItem(
          creationCardRecoveryKey(userId, creationId, cardKey),
        );
        return true;
      } catch {
        setServerError("Couldn't remove this card. Try again.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    async retry(): Promise<boolean> {
      pausedRef.current = false;
      return await flush();
    },
    async refresh(): Promise<void> {
      const current = query.data?.cards.find((candidate) => candidate.key === cardKey);
      if (!current || !userId) return;
      const next = hydrateCreationCardDraft(current);
      cardRef.current = next;
      cardsRef.current = query.data?.cards ?? [];
      revisionRef.current = query.data?.revision ?? revisionRef.current;
      dirtyRef.current = false;
      pausedRef.current = false;
      setCard(next);
      setErrors({});
      setServerError(null);
      await AsyncStorage.removeItem(
        creationCardRecoveryKey(userId, creationId, cardKey),
      );
    },
  };
}
