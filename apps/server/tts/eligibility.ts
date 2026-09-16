import { revealCloze } from "@mnimi/shared";

export function ttsTextForCard(
  note: { domain: string; language: string | null },
  card: { front: string },
): string | null {
  if (note.domain !== "language" || note.language === null) return null;
  const text = revealCloze(card.front)?.trim();
  return text ? text : null;
}
