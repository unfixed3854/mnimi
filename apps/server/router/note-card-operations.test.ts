import { describe, expect, it } from "vitest";
import {
  initialScheduling,
  noteUpdateInput,
  validateOperationSets,
} from "./note-card-operations.ts";

const basic = {
  aspect: "arbitrary domain focus",
  front: "Question",
  back: "Answer",
  imageCue: false,
};

describe("saved-note card operations", () => {
  it("uses the persisted new-card scheduling defaults", () => {
    const now = new Date("2026-08-27T10:00:00Z");
    expect(initialScheduling(now)).toEqual({
      due: now,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      lastReview: null,
    });
  });

  it("accepts open aspects and an empty final card set", () => {
    expect(noteUpdateInput.safeParse({
      noteId: "018f4f5c-1111-7111-8111-111111111111",
      expectedRevision: 2,
      creates: [],
      updates: [],
      deleteCardIds: ["018f4f5c-2222-7222-8222-222222222222"],
      resetCardIds: [],
    }).success).toBe(true);
  });

  it("rejects duplicate and intersecting operation identities", () => {
    const input = {
      noteId: "018f4f5c-1111-7111-8111-111111111111",
      expectedRevision: 2,
      creates: [{ clientKey: "new-1", card: basic }],
      updates: [{
        cardId: "018f4f5c-2222-7222-8222-222222222222",
        card: basic,
      }],
      deleteCardIds: ["018f4f5c-2222-7222-8222-222222222222"],
      resetCardIds: [],
    };
    expect(() => validateOperationSets(input)).toThrow(
      "A card cannot be updated and deleted in the same save",
    );
  });

  it.each([
    {
      name: "create client keys",
      patch: { creates: [
        { clientKey: "new-1", card: basic },
        { clientKey: "new-1", card: basic },
      ] },
      message: "Create client keys must be unique",
    },
    {
      name: "update card IDs",
      patch: { updates: [
        {
          cardId: "018f4f5c-2222-7222-8222-222222222222",
          card: basic,
        },
        {
          cardId: "018f4f5c-2222-7222-8222-222222222222",
          card: basic,
        },
      ] },
      message: "Update card IDs must be unique",
    },
    {
      name: "delete card IDs",
      patch: { deleteCardIds: [
        "018f4f5c-2222-7222-8222-222222222222",
        "018f4f5c-2222-7222-8222-222222222222",
      ] },
      message: "Delete card IDs must be unique",
    },
    {
      name: "reset card IDs",
      patch: { resetCardIds: [
        "018f4f5c-2222-7222-8222-222222222222",
        "018f4f5c-2222-7222-8222-222222222222",
      ] },
      message: "Reset card IDs must be unique",
    },
  ])("rejects duplicate $name", ({ patch, message }) => {
    expect(() => validateOperationSets({
      noteId: "018f4f5c-1111-7111-8111-111111111111",
      expectedRevision: 2,
      creates: [],
      updates: [],
      deleteCardIds: [],
      resetCardIds: [],
      ...patch,
    })).toThrow(message);
  });

  it("allows an update and reset together but rejects reset with deletion", () => {
    const cardId = "018f4f5c-2222-7222-8222-222222222222";
    const input = {
      noteId: "018f4f5c-1111-7111-8111-111111111111",
      expectedRevision: 2,
      creates: [],
      updates: [{ cardId, card: basic }],
      deleteCardIds: [],
      resetCardIds: [cardId],
    };

    expect(() => validateOperationSets(input)).not.toThrow();
    expect(() => validateOperationSets({
      ...input,
      updates: [],
      deleteCardIds: [cardId],
    })).toThrow("A card cannot be reset and deleted in the same save");
  });

  it("rejects a no-op save so revisions only advance for operation sets", () => {
    expect(() => validateOperationSets({
      noteId: "018f4f5c-1111-7111-8111-111111111111",
      expectedRevision: 2,
      creates: [],
      updates: [],
      deleteCardIds: [],
      resetCardIds: [],
    })).toThrow("At least one card operation is required");
  });
});
