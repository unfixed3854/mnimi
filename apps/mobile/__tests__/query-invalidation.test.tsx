import { renderHook } from "@testing-library/react-native";

const mockInvalidateQueries = jest.fn(() => Promise.resolve());
const mockCancelQueries = jest.fn(() => Promise.resolve());
const mockRemoveQueries = jest.fn();
const mockSetQueryData = jest.fn();
const mockUseMutation = jest.fn((options) => options);

jest.mock("@tanstack/react-query", () => ({
  useMutation: (options: unknown) => mockUseMutation(options),
  useQueryClient: () => ({
    cancelQueries: mockCancelQueries,
    invalidateQueries: mockInvalidateQueries,
    removeQueries: mockRemoveQueries,
    setQueryData: mockSetQueryData,
  }),
}));
jest.mock("@/api/orpc", () => ({
  orpc: {
    cards: { key: () => ["cards"] },
    decks: {
      key: () => ["decks"],
      remove: { mutationOptions: (options: unknown) => options },
      updatePronunciationSpeed: {
        mutationOptions: (options: unknown) => options,
      },
    },
    notes: {
      key: () => ["notes"],
      get: {
        queryOptions: ({ input }: { input: { noteId: string } }) => ({
          queryKey: ["notes", "detail", input.noteId],
        }),
      },
      save: { mutationOptions: (options: unknown) => options },
      update: { mutationOptions: (options: unknown) => options },
      delete: { mutationOptions: (options: unknown) => options },
    },
  },
  getDraftsQueryKey: () => ["drafts"],
}));

import { useRemoveDeck, useUpdatePronunciationSpeed } from "@/api/decks";
import { useDeleteNote, useSaveNote, useUpdateNote } from "@/api/notes";

describe("native mutation cache invalidation", () => {
  beforeEach(() => {
    mockInvalidateQueries.mockClear();
    mockCancelQueries.mockClear();
    mockRemoveQueries.mockClear();
    mockSetQueryData.mockClear();
    mockUseMutation.mockClear();
  });

  it("invalidates draft queries after deck removal", async () => {
    await renderHook(() => useRemoveDeck());

    await (mockUseMutation.mock.calls[0][0] as {
      onSuccess: () => Promise<void>;
    }).onSuccess();

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["drafts"],
    });
  });

  it("invalidates every projection of a changed deck speed", async () => {
    await renderHook(() => useUpdatePronunciationSpeed());

    await (mockUseMutation.mock.calls[0][0] as {
      onSuccess: () => Promise<void>;
    }).onSuccess();

    expect(mockInvalidateQueries.mock.calls).toEqual([
      [{ queryKey: ["decks"] }],
      [{ queryKey: ["cards"] }],
      [{ queryKey: ["notes"] }],
    ]);
  });

  it("invalidates draft queries after saving a note", async () => {
    await renderHook(() => useSaveNote());

    await (mockUseMutation.mock.calls[0][0] as {
      onSuccess: () => Promise<void>;
    }).onSuccess();

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["drafts"],
    });
  });

  it("invalidates saved note queries after updating a note", async () => {
    await renderHook(() => useUpdateNote());

    const result = {
      note: { id: "note-1" },
      cards: [],
      imageGenerating: false,
      createdIds: [],
    };
    const input = {
      noteId: "note-1",
      expectedRevision: 4,
      creates: [],
      updates: [],
      deleteCardIds: [],
      resetCardIds: [],
    };
    await (mockUseMutation.mock.calls[0][0] as {
      onSuccess: (result: unknown, input: unknown) => Promise<void>;
    }).onSuccess(result, input);

    expect(mockSetQueryData).toHaveBeenCalledWith(
      ["notes", "detail", "note-1"],
      result,
    );
    expect(mockSetQueryData.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvalidateQueries.mock.invocationCallOrder[0],
    );
    expect(mockInvalidateQueries.mock.calls).toEqual([
      [{ queryKey: ["notes"] }],
      [{ queryKey: ["cards"] }],
      [{ queryKey: ["decks"] }],
    ]);
  });

  it("invalidates saved note queries without drafts after deleting a note", async () => {
    await renderHook(() => useDeleteNote());

    expect(mockUseMutation.mock.calls[0][0]).toMatchObject({ retry: false });

    await (mockUseMutation.mock.calls[0][0] as {
      onSuccess: (result: unknown, input: unknown) => Promise<void>;
    }).onSuccess(undefined, { noteId: "note-1", expectedRevision: 4 });

    expect(mockCancelQueries).toHaveBeenCalledWith({
      queryKey: ["notes", "detail", "note-1"],
      exact: true,
    });
    expect(mockRemoveQueries).toHaveBeenCalledWith({
      queryKey: ["notes", "detail", "note-1"],
      exact: true,
    });
    expect(mockCancelQueries.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoveQueries.mock.invocationCallOrder[0],
    );
    expect(mockRemoveQueries.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvalidateQueries.mock.invocationCallOrder[0],
    );

    expect(mockInvalidateQueries.mock.calls).toEqual([
      [{ queryKey: ["notes"] }],
      [{ queryKey: ["cards"] }],
      [{ queryKey: ["decks"] }],
    ]);
  });
});
