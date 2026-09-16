const mockStorage = new Map<string, string>();
const mockSubmitCreation = jest.fn();
const mockWatchCreationInbox = jest.fn(async function* (signal: AbortSignal) {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
});
const mockServerCreations: any[] = [];

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockStorage.set(key, value);
    return Promise.resolve();
  }),
}));
jest.mock("@/auth/session-store", () => ({
  useSession: () => ({ user: { id: "user-one" } }),
}));
jest.mock("@/api/creations", () => {
  const { useQuery } = require("@tanstack/react-query");
  return {
    creationListKey: () => ["creations"],
    useCreationList: () => useQuery({
      queryKey: ["creations"],
      queryFn: async () => mockServerCreations,
      staleTime: Infinity,
    }),
    submitCreation: (input: unknown) => mockSubmitCreation(input),
    watchCreationInbox: (signal: AbortSignal) =>
      mockWatchCreationInbox(signal),
    applyCreationInboxSnapshot: (_current: unknown, incoming: unknown) => incoming,
  };
});

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  renderHook,
  waitFor,
} from "@testing-library/react-native";
import type { ReactNode } from "react";
import { creationOutboxKey } from "@/lib/creation-outbox";
import { useCreationOutbox } from "@/hooks/use-creation-outbox";

async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    queryClient,
    hook: await renderHook(() => useCreationOutbox(), { wrapper }),
  };
}

describe("useCreationOutbox", () => {
  beforeEach(() => {
    mockStorage.clear();
    onlineManager.setOnline(true);
    mockServerCreations.length = 0;
    jest.clearAllMocks();
    mockSubmitCreation.mockResolvedValue({
      creationId: "creation-one",
      clientRequestId: "request-one",
      status: "queued",
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("persists enqueue and composer clearing before submit, then keeps a server row", async () => {
    const { hook, queryClient } = await setup();
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(async () => {
      hook.result.current.setComposer("  useful\nrequest  ");
    });
    await act(async () => {
      await hook.result.current.submit();
    });

    expect(mockSubmitCreation).toHaveBeenCalledTimes(1);
    const input = mockSubmitCreation.mock.calls[0][0];
    expect(input.text).toBe("useful\nrequest");
    const firstSubmissionCall = mockSubmitCreation.mock.invocationCallOrder[0];
    expect(jest.mocked(AsyncStorage.setItem).mock.invocationCallOrder.some(
      (order) => order < firstSubmissionCall,
    )).toBe(true);

    await waitFor(() => expect(hook.result.current.items).toHaveLength(0));
    expect(queryClient.getQueryData<any[]>(["creations"]))
      .toEqual([expect.objectContaining({ id: "creation-one" })]);
  });

  it("recovers failed work with the same idempotency key after restart", async () => {
    mockStorage.set(creationOutboxKey("user-one"), JSON.stringify({
      composer: "another draft",
      items: [{
        clientRequestId: "stable-request",
        sourceText: "  remembered text  ",
        createdAt: 1,
        state: "failed",
        error: "offline",
      }],
    }));
    mockSubmitCreation.mockResolvedValue({
      creationId: "creation-two",
      clientRequestId: "stable-request",
      status: "queued",
    });

    const { hook } = await setup();
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await waitFor(() => expect(mockSubmitCreation).toHaveBeenCalled());
    expect(mockSubmitCreation).toHaveBeenCalledWith({
      clientRequestId: "stable-request",
      text: "remembered text",
    });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(0));
    expect(hook.result.current.composer).toBe("another draft");
    expect(mockWatchCreationInbox).toHaveBeenCalledTimes(1);
  });
});
