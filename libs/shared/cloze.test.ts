import { describe, expect, it } from "vitest";
import {
  hasClozeMarkup,
  parseCloze,
  revealCloze,
  stripPartialCloze,
} from "./cloze.ts";

describe("parseCloze", () => {
  it("splits a deletion with a hint into segments", () => {
    expect(parseCloze("Ich mag {{c1::Bananen::banany}} zum Frühstück."))
      .toEqual({
        before: "Ich mag ",
        answer: "Bananen",
        hint: "banany",
        after: " zum Frühstück.",
      });
  });

  it("reads a deletion with no hint", () => {
    expect(parseCloze("Ich mag {{c1::Bananen}} zum Frühstück.")).toEqual({
      before: "Ich mag ",
      answer: "Bananen",
      hint: null,
      after: " zum Frühstück.",
    });
  });

  it("keeps a deletion at the very start of the sentence", () => {
    expect(parseCloze("{{c1::Die}} Banane ist gelb.")).toEqual({
      before: "",
      answer: "Die",
      hint: null,
      after: " Banane ist gelb.",
    });
  });

  it("returns null for text with no markup", () => {
    expect(parseCloze("die Banane")).toBeNull();
  });

  it("rejects an empty answer", () => {
    expect(parseCloze("Ich mag {{c1::}} zum Frühstück.")).toBeNull();
  });

  it("rejects a whitespace-only answer", () => {
    expect(parseCloze("Ich mag {{c1::   }} zum Frühstück.")).toBeNull();
  });

  it("rejects an unclosed deletion", () => {
    expect(parseCloze("Ich mag {{c1::Bananen")).toBeNull();
  });

  it.each([
    "{{c1::one {{c2::two}}",
    "{{c1::one::hint {{broken}}",
    "{{c1::one }}::hint}}",
  ])(
    "rejects nested or residual delimiters inside a deletion in %s",
    (text) => {
      expect(parseCloze(text)).toBeNull();
    },
  );

  it("rejects two deletions in one card", () => {
    expect(parseCloze("{{c1::Ich}} mag {{c2::Bananen}}.")).toBeNull();
  });

  it.each([
    "{{c1::one}} and {{c2::two",
    "{{c1::one}} and c2::two}}",
  ])("rejects residual malformed cloze markup in %s", (text) => {
    expect(parseCloze(text)).toBeNull();
  });

  it("rejects a third :: section", () => {
    expect(parseCloze("Ich mag {{c1::Bananen::banany::extra}}.")).toBeNull();
  });

  it("treats an empty hint as no hint", () => {
    expect(parseCloze("Ich mag {{c1::Bananen::}}.")?.hint).toBeNull();
  });
});

describe("revealCloze", () => {
  it("reveals a deletion and drops the hint", () => {
    expect(revealCloze("Ich mag {{c1::Bananen::banany}} zum Frühstück.")).toBe(
      "Ich mag Bananen zum Frühstück.",
    );
  });

  it("reveals a deletion at the start of the text", () => {
    expect(revealCloze("{{c1::Żółć}}!")).toBe("Żółć!");
  });

  it("returns null for plain text", () => {
    expect(revealCloze("plain text")).toBeNull();
  });

  it("returns null for multiple deletions", () => {
    expect(revealCloze("{{c1::one}} and {{c2::two}}")).toBeNull();
  });

  it("returns null instead of revealing text with residual malformed markup", () => {
    expect(revealCloze("{{c1::one}} and {{c2::two")).toBeNull();
  });
});

describe("stripPartialCloze", () => {
  it("drops an incomplete deletion at the tail", () => {
    expect(stripPartialCloze("Ich mag {{c1::Ban")).toBe("Ich mag ");
  });

  it("drops a bare opening brace pair", () => {
    expect(stripPartialCloze("Ich mag {{")).toBe("Ich mag ");
  });

  it("leaves text with no markup alone", () => {
    expect(stripPartialCloze("Ich mag Bananen.")).toBe("Ich mag Bananen.");
  });

  it("keeps a completed deletion untouched", () => {
    expect(stripPartialCloze("Ich mag {{c1::Bananen}} zum")).toBe(
      "Ich mag {{c1::Bananen}} zum",
    );
  });
});

describe("hasClozeMarkup", () => {
  it("is true as soon as an opening brace pair appears", () => {
    expect(hasClozeMarkup("Ich mag {{")).toBe(true);
  });

  it("is false for plain text", () => {
    expect(hasClozeMarkup("die Banane")).toBe(false);
  });
});
