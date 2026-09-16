import {
  parseEditableCloze,
  serializeEditableCloze,
  updateEditableClozeSentence,
} from "@/lib/native-cloze";

describe("editable native cloze", () => {
  const parsed = {
    sentence: "Ich mag Bananen.",
    answerRange: { start: 8, end: 15 },
    hint: "banany",
  };

  it("hydrates storage markup into plain learner-facing fields", () => {
    expect(
      parseEditableCloze("Ich mag {{c1::Bananen::banany}}."),
    ).toEqual(parsed);
  });

  it("serializes a valid selection without leaking an empty hint", () => {
    expect(serializeEditableCloze(parsed)).toBe(
      "Ich mag {{c1::Bananen::banany}}.",
    );
    expect(serializeEditableCloze({ ...parsed, hint: "" })).toBe(
      "Ich mag {{c1::Bananen}}.",
    );
  });

  it("moves a selection when text is inserted before it", () => {
    expect(updateEditableClozeSentence(parsed, "Heute: Ich mag Bananen."))
      .toEqual({
        ...parsed,
        sentence: "Heute: Ich mag Bananen.",
        answerRange: { start: 15, end: 22 },
      });
  });

  it("keeps a selection when text changes after it", () => {
    expect(updateEditableClozeSentence(parsed, "Ich mag Bananen sehr."))
      .toEqual({ ...parsed, sentence: "Ich mag Bananen sehr." });
  });

  it("invalidates a selection when the hidden answer is edited", () => {
    expect(updateEditableClozeSentence(parsed, "Ich mag Äpfel.")).toEqual({
      ...parsed,
      sentence: "Ich mag Äpfel.",
      answerRange: null,
    });
  });

  it("refuses delimiters that cannot round-trip through storage", () => {
    expect(serializeEditableCloze({
      sentence: "A {{ broken",
      answerRange: { start: 0, end: 1 },
      hint: "cue",
    })).toBeNull();
    expect(serializeEditableCloze({
      sentence: "Answer",
      answerRange: { start: 0, end: 6 },
      hint: "bad::hint",
    })).toBeNull();
  });
});
