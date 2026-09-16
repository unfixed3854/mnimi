const mockStorage = new Map<string, string>();
const mockMutation = jest.fn();
const mockCreation: any = {
  id: "creation-1",
  revision: 4,
  imageCueAllowed: false,
  cards: [{
    key: "card-1",
    aspect: "meaning",
    front: "Haus",
    back: "House",
    imageCue: false,
  }, {
    key: "card-2",
    aspect: "plural",
    front: "Häuser",
    back: "Houses",
    imageCue: false,
  }],
};

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    mockStorage.delete(key);
    return Promise.resolve();
  }),
}));
jest.mock("@/auth/session-store", () => ({
  useSession: () => ({ user: { id: "user-1" } }),
}));
jest.mock("@/api/creations", () => ({
  useCreation: () => ({ data: mockCreation, isLoading: false }),
  creationDetailKey: (id: string) => ["creation", id],
  creationMutation: (...args: unknown[]) => mockMutation(...args),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import {
  creationCardRecoveryKey,
  useCreationCardEdit,
} from "@/hooks/use-creation-card-edit";

describe("useCreationCardEdit", () => {
  afterEach(async () => cleanup());

  it("persists every field first, autosaves a complete set, and clears on Done", async () => {
    jest.useFakeTimers();
    mockStorage.clear();
    mockMutation.mockReset().mockResolvedValue({ ok: true, revision: 5 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = await renderHook(
      () => useCreationCardEdit("creation-1", "card-1"),
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    const initialCard = hook.result.current.card;
    if (!initialCard || initialCard.kind !== "basic") {
      throw new Error("expected a basic card");
    }
    await act(async () => {
      hook.result.current.change({
        ...initialCard,
        question: "das Haus",
      });
    });
    expect(mockStorage.has(creationCardRecoveryKey(
      "user-1",
      "creation-1",
      "card-1",
    ))).toBe(true);
    await act(async () => jest.advanceTimersByTime(600));
    await waitFor(() => expect(mockMutation).toHaveBeenCalledWith("update", {
      creationId: "creation-1",
      expectedRevision: 4,
      cards: [
        expect.objectContaining({ key: "card-1", front: "das Haus" }),
        mockCreation.cards[1],
      ],
    }));
    await act(async () => {
      await hook.result.current.done();
    });
    expect(mockStorage.size).toBe(0);
    jest.useRealTimers();
    queryClient.clear();
  });
});
