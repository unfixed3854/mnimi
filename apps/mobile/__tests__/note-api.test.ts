jest.mock("@/api/orpc", () => ({
  orpc: {},
}));

import { noteMutationIssue } from "@/api/notes";

describe("saved note mutation errors", () => {
  it("recognizes a revision conflict without depending on an error class", () => {
    expect(noteMutationIssue({
      code: "CONFLICT",
      message: "This note changed somewhere else.",
    })).toEqual({
      kind: "conflict",
      message: "This note changed somewhere else.",
    });
  });

  it("preserves a card-local server validation identity", () => {
    expect(noteMutationIssue({
      code: "BAD_REQUEST",
      message: "Malformed cloze deletion.",
      data: { cardId: "card-1", field: "front" },
    })).toEqual({
      kind: "card",
      cardKey: "card-1",
      field: "front",
      message: "Malformed cloze deletion.",
    });
  });

  it("normalizes an ordinary network error", () => {
    expect(noteMutationIssue(new Error("Network request failed"))).toEqual({
      kind: "general",
      message: "Network request failed",
    });
  });
});
