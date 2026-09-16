import { describe, expect, it } from "vitest";
import { projectCompleteCards } from "./complete-cards.ts";

const COMPLETE = {
  aspect: "meaning",
  front: "Das ist eine {{c1::Banane::banana}}.",
  back: "This is a banana.",
  imageCue: true,
};

describe("projectCompleteCards", () => {
  it("keeps the last parsed array item hidden while it may still be growing", () => {
    expect(projectCompleteCards({ cards: [COMPLETE] }, false)).toEqual([]);
  });

  it("reveals a valid closed card after the next array item begins", () => {
    expect(projectCompleteCards({
      cards: [COMPLETE, { aspect: "gender" }],
    }, false)).toEqual([COMPLETE]);
  });

  it("includes the final card only after the structured response completes", () => {
    expect(projectCompleteCards({ cards: [COMPLETE] }, true)).toEqual([
      COMPLETE,
    ]);
  });

  it("returns only a contiguous valid prefix", () => {
    expect(projectCompleteCards({
      cards: [
        COMPLETE,
        { aspect: "broken", front: "No answer", back: null, imageCue: false },
        {
          aspect: "later",
          front: "Question",
          back: "Answer",
          imageCue: false,
        },
      ],
    }, true)).toEqual([COMPLETE]);
  });

  it("never projects half-written cloze markup", () => {
    expect(projectCompleteCards({
      cards: [{
        aspect: "meaning",
        front: "The answer is {{c1::",
        back: null,
        imageCue: false,
      }],
    }, true)).toEqual([]);
  });
});
