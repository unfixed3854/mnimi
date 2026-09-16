const mockWatch = jest.fn();
const mockInitial = {
  id: "creation-1",
  revision: 2,
  attemptId: "attempt-new",
  sourceText: "Volcanoes",
  status: "generating",
  cards: [],
};

jest.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    require("react").useEffect(effect, [effect]);
  },
}));
jest.mock("@/api/creations", () => {
  const { useQuery } = require("@tanstack/react-query");
  return {
    creationDetailKey: (id: string) => ["creation", id],
    useCreation: (id: string) => useQuery({
      queryKey: ["creation", id],
      queryFn: async () => mockInitial,
      staleTime: Infinity,
    }),
    watchCreationDetail: (...args: unknown[]) => mockWatch(...args),
  };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { useCreationDetail } from "@/hooks/use-creation-detail";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

describe("useCreationDetail", () => {
  afterEach(async () => cleanup());

  it("hydrates persisted detail, rejects stale events, and owns one focused watch", async () => {
    const staleEventHandled = gate();
    const nextSnapshot = gate();
    mockWatch.mockImplementation(async function* (_id: string, signal: AbortSignal) {
      yield { type: "snapshot", attemptId: "attempt-old", creation: {
        ...mockInitial,
        revision: 1,
        attemptId: "attempt-old",
        cards: [{ key: "old" }],
      } };
      staleEventHandled.resolve();
      await nextSnapshot.promise;
      yield { type: "snapshot", attemptId: "attempt-new", creation: {
        ...mockInitial,
        revision: 3,
        cards: [{ key: "complete" }],
      } };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    queryClient.setQueryData(["creation", "creation-1"], mockInitial);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = await renderHook(() => useCreationDetail("creation-1"), {
      wrapper,
    });

    await staleEventHandled.promise;
    expect(queryClient.getQueryData(["creation", "creation-1"]))
      .toEqual(mockInitial);
    expect(hook.result.current.creation?.revision).toBe(2);
    await act(async () => nextSnapshot.resolve());
    await waitFor(() => expect(hook.result.current.creation?.revision).toBe(3));
    expect(hook.result.current.creation?.cards).toEqual([{ key: "complete" }]);
    expect(mockWatch).toHaveBeenCalledTimes(1);
    await hook.unmount();
    queryClient.clear();
  });
});
