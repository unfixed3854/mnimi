import {
  type CardDraft,
  createCardDraft,
  hydrateCardDraft,
  serializeCardDraft,
} from "@/lib/card-draft";
import { parseCloze } from "@/lib/native-cloze";

export type CreationCard = {
  key: string;
  aspect: string;
  front: string;
  back: string | null;
  imageCue: boolean;
};

export function hydrateCreationCardDraft(card: CreationCard): CardDraft {
  return hydrateCardDraft({
    id: card.key,
    cardType: parseCloze(card.front) ? "cloze" : "basic",
    aspect: card.aspect,
    front: card.front,
    back: card.back,
    imageCue: card.imageCue,
  });
}

export function createBlankCreationCardDraft(
  kind: CardDraft["kind"],
  key: string,
): CardDraft {
  return createCardDraft(kind, key);
}

export function serializeCreationCardDraft(
  card: CardDraft,
): CreationCard | null {
  const serialized = serializeCardDraft(card);
  return serialized ? { key: card.key, ...serialized } : null;
}

export function learnerSafeCreationPreview(card: CardDraft): string {
  const serialized = serializeCreationCardDraft(card);
  if (!serialized) return "Fix the card fields to preview it.";
  if (
    serialized.front.includes("{{") || serialized.front.includes("}}") ||
    serialized.front.includes("::")
  ) {
    const cloze = parseCloze(serialized.front);
    return cloze
      ? `${cloze.before}[${cloze.hint ?? "…"}]${cloze.after}`
      : "Fix the card fields to preview it.";
  }
  return serialized.front;
}
