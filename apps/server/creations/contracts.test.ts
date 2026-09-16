import { describe, expect, it } from "vitest";
import {
  actionableCreationCount,
  legacyStatus,
  normalizeStoredCards,
  toCreationDetail,
  toCreationSummary,
} from "./contracts.ts";

const BASE = {
  id: "creation-1",
  clientRequestId: "request-1",
  sourceText: "Myślę więc jestem po łacińsku",
  status: "ready" as const,
  revision: 3,
  activeAttemptId: "attempt-1",
  deckId: "deck-latin",
  learningGoal: "Practice producing the Latin expression.",
  routing: null,
  classification: { domain: "language", language: "la", partOfSpeech: null },
  cards: [{
    aspect: "meaning",
    front: "Cogito, ergo {{c1::sum::jestem}}.",
    back: "Myślę, więc jestem.",
    imageCue: false,
  }],
  attemptCards: [],
  undoCards: null,
  generationSummary: "Practise the meaning and grammar of this Latin phrase.",
  imagePrompt: null,
  imageStatus: "none" as const,
  draftImageId: null,
  errorCategory: null,
  errorStage: null,
  error: null,
  createdAt: new Date(100),
  updatedAt: new Date(200),
};

describe("creation contracts", () => {
  it("assigns deterministic keys to legacy cards without changing content", () => {
    expect(normalizeStoredCards("creation-1", BASE.cards)).toEqual([{
      key: "legacy-0",
      ...BASE.cards[0],
    }]);
  });

  it("keeps an existing stable card key", () => {
    expect(normalizeStoredCards("creation-1", [{
      key: "card-stable",
      ...BASE.cards[0],
    }])).toEqual([{ key: "card-stable", ...BASE.cards[0] }]);
  });

  it.each([
    ["needs_choice", "needsChoice", "Needs your choice"],
    ["ready", "ready", "Ready to review"],
    ["routing", "creating", "Creating"],
    ["generating", "creating", "Creating"],
    ["adjusting", "creating", "Creating"],
    ["regenerating", "creating", "Creating"],
    ["queued", "queued", "Queued"],
    ["failed", "failed", "We couldn't create these cards. Try again."],
  ] as const)("maps %s to a learner-facing summary", (status, group, label) => {
    expect(toCreationSummary({ ...BASE, status }, "Latin")).toMatchObject({
      id: BASE.id,
      group,
      stateLabel: label,
      deckName: "Latin",
    });
  });

  it("does not project a removed row into the inbox", () => {
    expect(toCreationSummary({ ...BASE, status: "removed" }, "Latin"))
      .toBeNull();
  });

  it("counts only rows that need learner action", () => {
    const summaries = [
      "needs_choice",
      "ready",
      "failed",
      "queued",
      "generating",
    ] as const;
    const projected = summaries
      .map((status) =>
        toCreationSummary({ ...BASE, id: status, status }, "Latin")
      )
      .filter((summary) => summary !== null);
    expect(actionableCreationCount(projected)).toBe(3);
  });

  it("projects complete detail without lease or provider state", () => {
    const detail = toCreationDetail({ ...BASE, imagePrompt: "a Roman inscription" }, {
      id: "deck-latin",
      name: "Latin",
      description: "Latin production",
    });
    expect(detail.cards[0]).toEqual(expect.objectContaining({
      key: "legacy-0",
      front: "Cogito, ergo {{c1::sum::jestem}}.",
    }));
    expect(detail).not.toHaveProperty("leaseOwner");
    expect(detail).not.toHaveProperty("leaseExpiresAt");
    expect(detail).not.toHaveProperty("classification");
    expect(detail.imageCueAllowed).toBe(true);
  });

  it("projects the durable generation summary for the creation preview", () => {
    expect(toCreationDetail(BASE, null).generationSummary)
      .toBe("Practise the meaning and grammar of this Latin phrase.");
  });

  it("replaces stored diagnostic text with learner-safe error copy", () => {
    const detail = toCreationDetail({
      ...BASE,
      status: "failed",
      errorCategory: "generation_failed",
      errorStage: "cards",
      error: "upstream provider returned 429 with secret request metadata",
    }, null);

    expect(detail.error).toBe("We couldn't create these cards. Try again.");
    expect(detail.error).not.toContain("provider");
  });

  it.each([
    ["routing_failed", "We couldn't choose a deck. Try again."],
    ["generation_failed", "We couldn't create these cards. Try again."],
    [null, "We couldn't create these cards. Try again."],
  ] as const)("explains failed summaries and details for category %s", (errorCategory, message) => {
    const row = { ...BASE, status: "failed" as const, errorCategory, error: "private provider diagnostics" };
    expect(toCreationSummary(row, null)?.stateLabel).toBe(message);
    expect(toCreationDetail(row, null).error).toBe(message);
  });

  it("projects replacement activity without exposing its internal operation", () => {
    const detail = toCreationDetail({
      ...BASE,
      status: "queued",
      operation: "adjust",
    }, null);
    expect(detail.activity).toBe("adjusting");
    expect(detail).not.toHaveProperty("operation");
  });

  it.each([
    ["queued", "generating"],
    ["routing", "generating"],
    ["generating", "generating"],
    ["adjusting", "generating"],
    ["regenerating", "generating"],
    ["ready", "ready"],
    ["failed", "failed"],
  ] as const)("maps %s into legacy status %s", (status, legacy) => {
    expect(legacyStatus(status)).toBe(legacy);
  });
});
