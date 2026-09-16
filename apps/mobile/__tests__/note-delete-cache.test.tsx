import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";

const mockDelete = jest.fn(async (input: {
  noteId: string;
  expectedRevision: number;
}) => ({ id: input.noteId, deckId: "deck-1" }));

jest.mock("@/api/orpc", () => ({
  orpc: {
    cards: { key: () => ["cards"] },
    decks: { key: () => ["decks"] },
    notes: {
      key: () => ["notes"],
      get: {
        queryOptions: ({ input }: { input: { noteId: string } }) => ({
          queryKey: ["notes", "detail", input.noteId],
        }),
      },
      delete: {
        mutationOptions: (options: object) => ({
          mutationFn: mockDelete,
          ...options,
        }),
      },
    },
  },
}));

import { useDeleteNote } from "@/api/notes";

describe("useDeleteNote detail cache", () => {
  it("removes only the successfully deleted note's exact detail", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { gcTime: Infinity, retry: false },
        queries: { gcTime: Infinity, retry: false },
      },
    });
    const deletedKey = ["notes", "detail", "note-1"];
    const retainedKey = ["notes", "detail", "note-2"];
    queryClient.setQueryData(deletedKey, { note: { id: "note-1" } });
    queryClient.setQueryData(retainedKey, { note: { id: "note-2" } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = await renderHook(() => useDeleteNote(), { wrapper });

    await act(async () => {
      await hook.result.current.mutateAsync({
        noteId: "note-1",
        expectedRevision: 4,
      });
    });

    expect(queryClient.getQueryData(deletedKey)).toBeUndefined();
    expect(queryClient.getQueryData(retainedKey)).toEqual({
      note: { id: "note-2" },
    });
    await hook.unmount();
    queryClient.clear();
  });
});
