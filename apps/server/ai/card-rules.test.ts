import { describe, expect, it } from "vitest";
import { imageCueHasFallback, imageCuesMatchContext } from "./card-rules.ts";

const hinted = {
  front: "Ich sehe zwei {{c1::Bananen::bananas}}.",
  back: "I see two bananas.",
  imageCue: true,
};

describe("imageCueHasFallback", () => {
  it("requires a real cloze hint only when imageCue is true", () => {
    expect(imageCueHasFallback(hinted)).toBe(true);
    expect(imageCueHasFallback({
      ...hinted,
      front: "Ich sehe zwei {{c1::Bananen}}.",
    })).toBe(false);
    expect(imageCueHasFallback({ ...hinted, front: "plain text" })).toBe(false);
    expect(imageCueHasFallback({
      ...hinted,
      front: "Ich sehe zwei {{c1::Bananen}}.",
      imageCue: false,
    })).toBe(true);
  });
});

describe("imageCuesMatchContext", () => {
  it("allows cues only for image-backed language notes", () => {
    expect(imageCuesMatchContext([hinted], "language", "two bananas")).toBe(
      true,
    );
    expect(imageCuesMatchContext([hinted], "concept", "two bananas")).toBe(
      false,
    );
    expect(imageCuesMatchContext([hinted], "language", null)).toBe(false);
    expect(imageCuesMatchContext(
      [{ ...hinted, imageCue: false }],
      "concept",
      null,
    )).toBe(true);
  });
});
