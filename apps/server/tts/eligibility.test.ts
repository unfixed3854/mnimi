import { describe, expect, it } from "vitest";
import { ttsTextForCard } from "./eligibility.ts";

describe("ttsTextForCard", () => {
  it("returns revealed language text for a language note", () => {
    expect(
      ttsTextForCard(
        { domain: "language", language: "de" },
        { front: "Ich mag {{c1::Bananen::banany}}." },
      ),
    ).toBe("Ich mag Bananen.");
  });

  it("returns null for non-language notes", () => {
    expect(
      ttsTextForCard(
        { domain: "concept", language: null },
        { front: "{{c1::Entropy}} increases." },
      ),
    ).toBeNull();
  });

  it("returns null for unrevealed plain text", () => {
    expect(
      ttsTextForCard(
        { domain: "language", language: "de" },
        { front: "die Banane" },
      ),
    ).toBeNull();
  });

  it("returns null for a deletion followed by residual malformed cloze markup", () => {
    expect(
      ttsTextForCard(
        { domain: "language", language: "de" },
        { front: "{{c1::eins}} und {{c2::zwei" },
      ),
    ).toBeNull();
  });
});
