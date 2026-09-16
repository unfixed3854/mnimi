import { act, fireEvent, render, within } from "@testing-library/react-native";

import { PortalHost } from "@rn-primitives/portal";
import { router } from "expo-router";

let mockCreationOverrides: Record<string, unknown> = {};
let mockDecks: Array<{ id: string; name: string; description: string | null }> = [];

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn() },
  Link: ({ children }: { children: unknown }) => children,
}));
jest.mock("@/api/creations", () => ({
  creationMutation: jest.fn(() => Promise.resolve()),
  creationListKey: () => ["creations"],
  creationDetailKey: (id: string) => ["creation", id],
  saveCreationWithCache: jest.fn(),
}));
jest.mock("@/api/decks", () => ({ useDecks: () => ({ data: mockDecks }) }));
jest.mock("@/hooks/use-creation-detail", () => ({
  useCreationDetail: () => ({
    creation: {
      id: "creation-1",
      sourceText: "How volcanoes form",
      status: "generating",
      revision: 1,
      attemptId: "attempt-1",
      deck: { id: "deck-1", name: "Geology", description: null },
      routing: null,
      cards: [],
      attemptCards: [],
      imageStatus: "none",
      draftImageId: null,
      error: null,
      ...mockCreationOverrides,
    },
    isLoading: false,
    error: null,
  }),
}));
jest.mock("@/components/generated-image", () => ({
  GeneratedImage: () => null,
}));
jest.mock("@/features/create/notification-leave-education", () => ({
  NotificationLeaveEducation: () => null,
}));
jest.mock("@/notifications/registration", () => ({
  setVisibleCreationId: jest.fn(),
}));

import { creationMutation, saveCreationWithCache } from "@/api/creations";
import { CreationDetailScreen } from "@/features/create/creation-detail-screen";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

describe("CreationDetailScreen", () => {
  beforeEach(() => {
    mockCreationOverrides = {};
    mockDecks = [];
    jest.mocked(router.replace).mockClear();
    jest.mocked(creationMutation).mockReset().mockResolvedValue(undefined);
    jest.mocked(saveCreationWithCache).mockReset();
  });

  it("resolves a proposed new deck into an existing owned deck", async () => {
    mockDecks = [{ id: "deck-existing", name: "German", description: null }];
    mockCreationOverrides = {
      status: "needs_choice",
      deck: null,
      routing: {
        kind: "newDeck",
        proposedName: "German phrases",
        proposedDescription: "Vocabulary and expressions",
        learningGoal: "Produce useful German expressions.",
      },
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <CreationDetailScreen creationId="creation-1" />
        <PortalHost />
      </QueryClientProvider>,
    );

    await fireEvent.press(view.getByRole("button", {
      name: "Choose an existing deck",
    }));
    await fireEvent.press(view.getByRole("button", { name: "German" }));

    expect(creationMutation).toHaveBeenCalledWith("resolveDeck", {
      creationId: "creation-1",
      expectedRevision: 1,
      deckId: "deck-existing",
    });
    queryClient.clear();
  });

  it("closes a pending-choice picker when another client resolves the creation", async () => {
    mockDecks = [{ id: "deck-existing", name: "German", description: null }];
    mockCreationOverrides = {
      status: "needs_choice",
      deck: null,
      routing: {
        kind: "newDeck",
        proposedName: "German phrases",
        proposedDescription: "Vocabulary and expressions",
        learningGoal: "Produce useful German expressions.",
      },
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const screen = () => (
      <QueryClientProvider client={queryClient}>
        <CreationDetailScreen creationId="creation-1" />
        <PortalHost />
      </QueryClientProvider>
    );
    const view = await render(screen());
    await fireEvent.press(view.getByRole("button", {
      name: "Choose an existing deck",
    }));
    expect(view.getByRole("button", { name: "German" })).toBeTruthy();

    mockCreationOverrides = {
      status: "generating",
      routing: null,
    };
    await view.rerender(screen());

    expect(view.queryByRole("button", { name: "German" })).toBeNull();
    expect(creationMutation).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("confirms before discarding a request that needs a deck choice", async () => {
    mockCreationOverrides = {
      status: "needs_choice",
      deck: null,
      routing: {
        kind: "newDeck",
        proposedName: "German phrases",
        proposedDescription: "Vocabulary and expressions",
        learningGoal: "Produce useful German expressions.",
      },
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <CreationDetailScreen creationId="creation-1" />
        <PortalHost />
      </QueryClientProvider>,
    );

    await fireEvent.press(view.getByRole("button", { name: "Discard request" }));
    expect(view.getByText("Discard request?")).toBeTruthy();
    expect(creationMutation).not.toHaveBeenCalled();
    await fireEvent.press(
      view.getAllByRole("button", { name: "Discard request" }).at(-1)!,
    );

    expect(creationMutation).toHaveBeenCalledWith("discard", {
      creationId: "creation-1",
      expectedRevision: 1,
    });
    queryClient.clear();
  });

  it.each([
    ["ready", "Discard creation", "Discard creation?", "Discard", "discard"],
    ["failed", "Discard creation", "Discard creation?", "Discard", "discard"],
    ["queued", "Remove from queue", "Remove from queue?", "Remove", "cancel"],
    ["generating", "Cancel creation", "Cancel creation?", "Cancel creation", "cancel"],
  ])("confirms removal of %s creations", async (status, trigger, title, label, mutation) => {
    mockCreationOverrides = { status, ...(status === "ready" ? {
      cards: [{ key: "card-1", front: "Question", back: "Answer", aspect: "meaning", imageCue: false }],
    } : {}) };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <CreationDetailScreen creationId="creation-1" />
        <PortalHost />
      </QueryClientProvider>,
    );
    async function openRemoval() {
      if (status === "ready") {
        await fireEvent.press(view.getByRole("button", { name: "More creation actions" }));
      }
      await fireEvent.press(view.getByRole("button", { name: trigger }));
    }
    await openRemoval();
    expect(view.getByText(title)).toBeTruthy();
    expect(creationMutation).not.toHaveBeenCalled();
    await fireEvent.press(view.getByRole("button", { name: "Keep" }));
    expect(view.queryByText(title)).toBeNull();
    expect(creationMutation).not.toHaveBeenCalled();

    await openRemoval();
    jest.mocked(creationMutation).mockRejectedValueOnce(new Error("Removal failed"));
    await fireEvent.press(view.getAllByRole("button", { name: label }).at(-1)!);
    expect(view.getByText("Removal failed")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();

    await openRemoval();
    await fireEvent.press(view.getAllByRole("button", { name: label }).at(-1)!);
    expect(creationMutation).toHaveBeenLastCalledWith(mutation, {
      creationId: "creation-1", expectedRevision: 1,
    });
    expect(router.replace).toHaveBeenCalledWith({
      pathname: "/add",
      params: status === "queued" ? { removedCreationId: "creation-1" } : {},
    });
    queryClient.clear();
  });

  it("keeps save outside the scroll content and preserves retry identity after a save failure", async () => {
    mockCreationOverrides = {
      status: "ready",
      cards: [{ key: "card-1", front: "Question", back: "Answer", aspect: "meaning", imageCue: false }],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <CreationDetailScreen creationId="creation-1" />
      </QueryClientProvider>,
    );
    const footer = within(view.getByTestId("screen-footer"));
    expect(within(view.getByTestId("screen-scroll-content")).queryByRole("button", { name: "Save to Geology" })).toBeNull();
    expect(view.getByText("Geology · 1 card")).toBeTruthy();
    jest.mocked(saveCreationWithCache).mockRejectedValueOnce(new Error("Save failed. Try again."));
    await fireEvent.press(footer.getByRole("button", { name: "Save to Geology" }));
    expect(footer.getByRole("alert")).toHaveTextContent("Save failed. Try again.");
    expect(router.replace).not.toHaveBeenCalled();
    jest.mocked(saveCreationWithCache).mockResolvedValueOnce({ noteId: "note-1", deckId: "deck-1", sourceText: "How volcanoes form" });
    await fireEvent.press(footer.getByRole("button", { name: "Save to Geology" }));
    const calls = jest.mocked(saveCreationWithCache).mock.calls;
    expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
    expect(router.replace).toHaveBeenCalledWith({ pathname: "/add", params: { savedNoteId: "note-1", savedDeckName: "Geology" } });
    queryClient.clear();
  });

  it("disables save and overflow changes while a replacement is running", async () => {
    mockCreationOverrides = {
      status: "adjusting", activity: "adjusting",
      cards: [{ key: "card-1", front: "Question", back: "Answer", aspect: "meaning", imageCue: false }],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <CreationDetailScreen creationId="creation-1" />
      </QueryClientProvider>,
    );
    expect(within(view.getByTestId("screen-footer")).getByRole("button", { name: "Save to Geology" })).toBeDisabled();
    expect(view.getByRole("button", { name: "More creation actions" })).toBeDisabled();
    expect(view.getByText("Question")).toBeTruthy();
    queryClient.clear();
  });

  it.each(["We couldn't choose a deck. Try again.", null, "   ", "Creation was interrupted. Try again."])(
    "explains a zero-card failure with error %s and shows retry failures",
    async (error) => {
      mockCreationOverrides = { status: "failed", error, errorStage: "routing" };
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity } },
      });
      const view = await render(
        <QueryClientProvider client={queryClient}>
          <CreationDetailScreen creationId="creation-1" />
        </QueryClientProvider>,
      );
      expect(view.getByRole("alert")).toHaveTextContent(
        error?.startsWith("Creation was interrupted")
          ? /Creation was interrupted\. Try again\./
          : /Your request is saved\. Try again to continue\./,
      );
      expect(view.queryByText("You can leave — we'll keep creating.")).toBeNull();
      jest.mocked(creationMutation).mockRejectedValueOnce(new Error("You're offline. Reconnect and try again."));
      await act(async () => {
        fireEvent.press(view.getByRole("button", { name: "Try again" }));
      });
      expect(view.getByText("You're offline. Reconnect and try again.")).toBeTruthy();
      await act(async () => {
        fireEvent.press(view.getByRole("button", { name: "Try again" }));
      });
      expect(view.queryByText("You're offline. Reconnect and try again.")).toBeNull();
      queryClient.clear();
    },
  );
  it("uses stable content context and says leaving is safe", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <CreationDetailScreen creationId="creation-1" />
      </QueryClientProvider>,
    );
    expect(view.getByRole("header", { name: "How volcanoes form" })).toBeTruthy();
    expect(view.getByText("Geology")).toBeTruthy();
    expect(view.getByText("You can leave — we'll keep creating.")).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).not.toMatch(/provider|confidence|attemptId/i);
    queryClient.clear();
  });
});
