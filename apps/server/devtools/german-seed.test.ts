import { describe, expect, it } from "vitest";
import { parseCloze } from "@mnimi/shared";
import { clozeMarkupIsWellFormed } from "../ai/card-rules.ts";
import { ttsTextForCard } from "../tts/eligibility.ts";
import {
  GERMAN_SEED,
  GERMAN_SEED_NAME,
} from "./german-seed.ts";

describe("German seed fixture", () => {
  it("contains the three noun notes with their meaning, gender, and plural cards", () => {
    expect(GERMAN_SEED_NAME).toBe("German");
    expect(GERMAN_SEED.notes.map((note) => note.sourceText)).toEqual([
      "die Banane",
      "der Apfel",
      "das Haus",
    ]);

    for (const note of GERMAN_SEED.notes) {
      expect(note.imageAsset).toBeTruthy();
      expect(note.imagePrompt).toBeTruthy();
      expect(note.domain).toBe("language");
      expect(note.language).toBe("de");
      expect(note.metadata).toEqual({
        partOfSpeech: "noun",
        imagePrompt: note.imagePrompt,
      });
      expect(note.cards).toHaveLength(3);
      expect(note.cards.map((card) => card.aspect)).toEqual([
        "meaning",
        "gender",
        "plural",
      ]);

      for (const card of note.cards) {
        expect(clozeMarkupIsWellFormed(card)).toBe(true);
        expect(parseCloze(card.front)).not.toBeNull();
        expect(ttsTextForCard(note, card)).not.toBeNull();
        expect(card.audioAsset).toBeTruthy();
        if (card.imageCue) {
          expect(parseCloze(card.front)?.hint).not.toBeNull();
          expect(note.imagePrompt).toBeTruthy();
        }
      }
    }
  });
});
