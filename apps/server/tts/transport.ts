import type { Card, Note } from "../db/schema.ts";
import { ttsTextForCard } from "./eligibility.ts";

export function audioCardView(
  card: Card,
  note: Pick<Note, "domain" | "language">,
) {
  const { audioPath: _audioPath, ...publicCard } = card;
  return {
    ...publicCard,
    hasAudio: card.audioPath !== null,
    audioEligible: ttsTextForCard(note, card) !== null,
  };
}
