jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  acknowledgeRequest,
  creationOutboxKey,
  emptyCreationOutbox,
  enqueueRequest,
  loadCreationOutbox,
  markFailed,
  markSending,
  normalizeCreationRequest,
  saveCreationOutbox,
  shouldShowCreationCharacterCount,
} from "@/lib/creation-outbox";

describe("creation outbox", () => {
  beforeEach(() => jest.clearAllMocks());

  it("validates the trimmed request while preserving the exact source until ack", () => {
    expect(normalizeCreationRequest("   ")).toEqual({
      ok: false,
      error: "Describe what you want to learn.",
    });
    expect(normalizeCreationRequest(` ${"x".repeat(2_001)} `)).toEqual({
      ok: false,
      error: "Keep your request to 2,000 characters.",
    });

    const source = "  German\nseparable verbs  ";
    const result = enqueueRequest(
      { composer: source, items: [] },
      { clientRequestId: "opaque-1", createdAt: 42 },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected valid request");
    expect(result.item).toEqual({
      clientRequestId: "opaque-1",
      sourceText: source,
      createdAt: 42,
      state: "pending",
      error: null,
    });
    expect(result.submissionText).toBe("German\nseparable verbs");
    expect(result.document.composer).toBe("");
  });

  it("keeps independent rapid requests and changes only the addressed item", () => {
    let document = emptyCreationOutbox();
    for (const [index, text] of ["one", "two", "three"].entries()) {
      const result = enqueueRequest(
        { ...document, composer: text },
        { clientRequestId: `id-${index}`, createdAt: index },
      );
      if (!result.ok) throw new Error("expected valid request");
      document = result.document;
    }
    expect(document.items.map((item) => item.clientRequestId)).toEqual([
      "id-0",
      "id-1",
      "id-2",
    ]);
    document = markSending(document, "id-1");
    document = markFailed(document, "id-1", "You're offline.");
    expect(document.items[1]).toMatchObject({
      sourceText: "two",
      state: "failed",
      error: "You're offline.",
    });
    expect(acknowledgeRequest(document, "id-1").items.map((item) => item.sourceText))
      .toEqual(["one", "three"]);
  });

  it("shows the count only near the limit and scopes persistence by user", async () => {
    expect(shouldShowCreationCharacterCount("x".repeat(1_799))).toBe(false);
    expect(shouldShowCreationCharacterCount("x".repeat(1_800))).toBe(true);
    expect(creationOutboxKey("user-a")).not.toBe(creationOutboxKey("user-b"));

    const document = { composer: "draft", items: [] };
    await saveCreationOutbox("user-a", document);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      creationOutboxKey("user-a"),
      JSON.stringify(document),
    );
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(document));
    await expect(loadCreationOutbox("user-a")).resolves.toEqual(document);
  });
});
