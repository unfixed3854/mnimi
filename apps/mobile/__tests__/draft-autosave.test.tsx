import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { act } from "react";
import { Pressable, Text } from "react-native";
import type { Draft } from "@/api/drafts";

const mockUpdateDraft = jest.fn(() => Promise.resolve());
const mockCurrentKey = ["drafts", "current"];
const queryClients: QueryClient[] = [];
const mockDraft: Draft = {
  id: "draft-1",
  deckId: "deck-1",
  sourceText: "die Banane",
  status: "ready",
  classification: null,
  cards: [{
    aspect: "meaning",
    front: "server front",
    back: "server back",
    imageCue: false,
  }],
  imagePrompt: null,
  imageStatus: "none",
  draftImageId: null,
  error: null,
  createdAt: new Date(0),
};

jest.mock(
  "@/api/decks",
  () => ({
    useDecks: () => ({ data: [] }),
    useCreateDeck: () => ({ isPending: false, mutateAsync: jest.fn() }),
  }),
);
jest.mock(
  "@/lib/watch-draft",
  () => ({ runDraftWatch: jest.fn(() => Promise.resolve()) }),
);
jest.mock("@/api/orpc", () => {
  const mutationOptions = (options = {}) => ({
    mutationFn: jest.fn(),
    ...options,
  });
  return {
    client: { notes: { save: jest.fn() }, drafts: { update: mockUpdateDraft } },
    orpc: {
      drafts: {
        key: () => ["drafts"],
        current: {
          queryOptions: () => ({
            queryKey: mockCurrentKey,
            queryFn: async () => mockDraft,
          }),
        },
        start: { mutationOptions },
        discard: { mutationOptions },
        retryImage: { mutationOptions },
      },
      notes: { key: () => ["notes"] },
      cards: { key: () => ["cards"] },
    },
  };
});

import { useDraftSession } from "@/hooks/use-draft-session";

function createTestQueryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClients.push(client);
  return client;
}

function Harness() {
  const draft = useDraftSession();
  const front =
    draft.state.status === "ready" || draft.state.status === "failed"
      ? draft.state.cards[0]?.front
      : "";
  return (
    <>
      <Text accessibilityLabel="Draft front">{front}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          draft.dispatch({
            type: "edit-card",
            index: 0,
            patch: { front: "locally edited" },
          })}
      >
        <Text>Edit</Text>
      </Pressable>
    </>
  );
}

describe("draft autosave cleanup", () => {
  beforeEach(() => mockUpdateDraft.mockClear());

  afterEach(() => {
    for (const client of queryClients) client.clear();
    queryClients.length = 0;
  });

  it("flushes an edit to the durable draft before the Add screen unmounts", async () => {
    (require("@/api/orpc").client as {
      drafts: { update: typeof mockUpdateDraft };
    }).drafts = { update: mockUpdateDraft };
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(mockCurrentKey, mockDraft);
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.getByLabelText("Draft front")).toHaveTextContent(
        "server front",
      )
    );

    fireEvent.press(view.getByRole("button", { name: "Edit" }));
    await waitFor(() =>
      expect(view.getByLabelText("Draft front")).toHaveTextContent(
        "locally edited",
      )
    );
    await act(async () => view.unmount());

    expect(mockUpdateDraft).toHaveBeenCalledWith({
      draftId: "draft-1",
      deckId: "deck-1",
      cards: [{
        aspect: "meaning",
        front: "locally edited",
        back: "server back",
        imageCue: false,
      }],
    });
  });
});
