import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { PortalHost } from "@rn-primitives/portal";

const mockRemoveDeck = jest.fn();
const mockUpdatePronunciationSpeed = jest.fn();
const mockUseDeck = jest.fn();
let mockDueCount = 0;
let mockRemovalEvents: string[] = [];
let mockNotes: Array<{ id: string; deckId: string; sourceText: string }> = [];
jest.mock("@/api/decks", () => ({
  useDeck: (deckId: string) => mockUseDeck(deckId),
  useRemoveDeck: (onSuccess?: () => void | Promise<void>) => ({
    mutateAsync: async (variables: { deckId: string }) => {
      await mockRemoveDeck(variables);
      await onSuccess?.();
      mockRemovalEvents.push("mutation-complete");
    },
    isPending: false,
  }),
  useUpdatePronunciationSpeed: () => ({
    mutateAsync: mockUpdatePronunciationSpeed,
    isPending: false,
  }),
}));
jest.mock(
  "@/api/notes",
  () => ({
    useNotes: () => ({ data: mockNotes, isLoading: false, isError: false }),
  }),
);
jest.mock(
  "@/api/cards",
  () => ({ useDueCount: () => ({ data: mockDueCount }) }),
);
jest.mock(
  "expo-router",
  () => ({
    Link: ({ children, href, asChild }: {
      children: any;
      href: unknown;
      asChild?: boolean;
    }) => {
      const react = require("react");
      const createElement = react["createElement"];
      const { Text } = require("react-native");

      return asChild
        ? react.cloneElement(children, { href })
        : createElement(Text, undefined, children);
    },
    router: {
      replace: jest.fn(() => mockRemovalEvents.push("navigation-dispatched")),
      push: jest.fn(),
    },
  }),
);
import { DeckDetailScreen } from "@/features/decks/deck-detail-screen";

describe("DeckDetailScreen", () => {
  beforeEach(() => {
    mockDueCount = 0;
    mockRemovalEvents = [];
    mockNotes = [];
    mockRemoveDeck.mockReset();
    mockUpdatePronunciationSpeed.mockReset();
    mockUseDeck.mockReturnValue({
      data: {
        id: "deck-1",
        name: "German",
        pronunciationSpeed: "normal",
      },
      isLoading: false,
      isError: false,
    });
    const router = require("expo-router").router as {
      replace: jest.Mock;
      push: jest.Mock;
    };
    router.replace.mockClear();
    router.push.mockClear();
  });

  it("opens the composer from an empty deck", async () => {
    const router = require("expo-router").router as { push: jest.Mock };
    const view = await render(<DeckDetailScreen deckId="deck-1" />);

    await fireEvent.press(view.getByRole("button", { name: "Create a note" }));

    expect(router.push).toHaveBeenCalledWith("/add");
  });

  it("opens this deck's review queue when cards are due", async () => {
    const router = require("expo-router").router as { push: jest.Mock };
    mockDueCount = 3;

    const view = await render(
      <>
        <DeckDetailScreen deckId="deck-1" />
        <PortalHost />
      </>,
    );
    await fireEvent.press(view.getByRole("button", { name: "Review 3 due" }));

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/review/[deckId]",
      params: { deckId: "deck-1" },
    });
  });

  it("updates this deck's pronunciation speed", async () => {
    const view = await render(
      <>
        <DeckDetailScreen deckId="deck-1" />
        <PortalHost />
      </>,
    );

    await fireEvent.press(view.getByRole("button", { name: "More deck actions" }));
    await fireEvent.press(
      view.getByRole("button", { name: "Pronunciation speed: Normal" }),
    );
    await fireEvent.press(view.getByRole("button", { name: "Slow" }));

    await waitFor(() =>
      expect(mockUpdatePronunciationSpeed).toHaveBeenCalledWith({
        deckId: "deck-1",
        pronunciationSpeed: "slow",
      })
    );
  });

  it("keeps the pronunciation speed preference compact", async () => {
    const view = await render(
      <>
        <DeckDetailScreen deckId="deck-1" />
        <PortalHost />
      </>,
    );

    await fireEvent.press(view.getByRole("button", { name: "More deck actions" }));
    expect(
      view.getByRole("button", { name: "Pronunciation speed: Normal" }),
    ).toBeTruthy();
    expect(
      view.queryByText(
        "Used for autoplay and regular pronunciation playback.",
      ),
    ).toBeNull();
  });

  it("renders shared navigation and each note as a destination row", async () => {
    mockNotes = [{ id: "note-1", deckId: "deck-1", sourceText: "Hallo" }];
    mockDueCount = 3;
    const view = await render(<DeckDetailScreen deckId="deck-1" />);

    expect(view.getByText("Notes")).toBeTruthy();
    expect(view.queryByText("1")).toBeNull();
    expect(view.getByRole("button", { name: "Review 3 due" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Back to decks" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Hallo" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Remove deck" })).toBeNull();
    expect(view.getByRole("button", { name: "More deck actions" })).toBeTruthy();
  });

  it("keeps a heading and safe back link while the deck loads", async () => {
    mockUseDeck.mockReturnValue({ data: undefined, isLoading: true });
    const view = await render(<DeckDetailScreen deckId="deck-1" />);

    expect(view.getByRole("header", { name: "Deck" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Back to decks" })).toBeTruthy();
    expect(view.getByLabelText("Loading deck")).toBeTruthy();
  });

  it("keeps a heading and safe back link when loading the deck fails", async () => {
    mockUseDeck.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("No connection"),
    });
    const view = await render(<DeckDetailScreen deckId="deck-1" />);

    expect(view.getByRole("header", { name: "Deck" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Back to decks" })).toBeTruthy();
    expect(view.getByText("No connection")).toBeTruthy();
  });

  it("keeps a heading and safe back link when the deck is missing", async () => {
    mockUseDeck.mockReturnValue({ data: undefined, isLoading: false });
    const view = await render(<DeckDetailScreen deckId="deck-1" />);

    expect(view.getByRole("header", { name: "Deck" })).toBeTruthy();
    expect(view.getByRole("link", { name: "Back to decks" })).toBeTruthy();
    expect(view.getByText("This deck no longer exists.")).toBeTruthy();
  });

  it("requires confirmation before removing a deck", async () => {
    mockDueCount = 0;
    const view = await render(
      <>
        <DeckDetailScreen deckId="deck-1" />
        <PortalHost />
      </>,
    );
    await fireEvent.press(view.getByRole("button", { name: "More deck actions" }));
    await fireEvent.press(view.getByRole("button", { name: "Remove deck" }));
    expect(mockRemoveDeck).not.toHaveBeenCalled();
    await fireEvent.press(view.getByRole("button", { name: "Cancel" }));
    expect(mockRemoveDeck).not.toHaveBeenCalled();
    await fireEvent.press(view.getByRole("button", { name: "More deck actions" }));
    await fireEvent.press(view.getByRole("button", { name: "Remove deck" }));
    await fireEvent.press(view.getByRole("button", { name: "Remove" }));
    expect(mockRemoveDeck).toHaveBeenCalledWith({ deckId: "deck-1" });
  });

  it("dispatches post-delete navigation after the remove mutation completes", async () => {
    const router = require("expo-router").router as { replace: jest.Mock };
    let resolveRemoval!: () => void;
    mockRemoveDeck.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const view = await render(
      <>
        <DeckDetailScreen deckId="deck-1" />
        <PortalHost />
      </>,
    );

    await fireEvent.press(view.getByRole("button", { name: "More deck actions" }));
    await fireEvent.press(view.getByRole("button", { name: "Remove deck" }));
    await fireEvent.press(view.getByRole("button", { name: "Remove" }));

    expect(router.replace).not.toHaveBeenCalled();
    await act(async () => resolveRemoval());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/decks"));
    expect(mockRemovalEvents).toEqual([
      "mutation-complete",
      "navigation-dispatched",
    ]);
  });
});
