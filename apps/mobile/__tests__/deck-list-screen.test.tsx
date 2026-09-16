import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

const mockMutateAsync = jest.fn();
let mockDecks: Array<{ id: string; name: string }> = [];
jest.mock("@/api/decks", () => ({
  useDecks: () => ({ data: mockDecks, isLoading: false, isError: false }),
  useCreateDeck: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
    isError: false,
  }),
}));
jest.mock("expo-router", () => ({
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
}));
import { DeckListScreen } from "@/features/decks/deck-list-screen";

describe("DeckListScreen", () => {
  beforeEach(() => {
    mockDecks = [];
    mockMutateAsync.mockReset();
  });

  it("replaces the first-deck invitation with the creation form", async () => {
    const view = await render(<DeckListScreen />);
    expect(view.queryByLabelText("New deck name")).toBeNull();
    expect(view.getByText("A little curiosity goes a long way")).toBeTruthy();

    await fireEvent.press(view.getByRole("button", { name: "New deck" }));
    expect(view.getByLabelText("New deck name")).toBeTruthy();
    expect(view.queryByText("A little curiosity goes a long way")).toBeNull();

    await fireEvent.press(view.getByRole("button", { name: "Cancel" }));
    expect(view.getByText("A little curiosity goes a long way")).toBeTruthy();
    expect(view.getAllByRole("button", { name: "New deck" })).toHaveLength(1);
  });

  it("clears and closes deck creation when cancelled", async () => {
    const view = await render(<DeckListScreen />);
    await fireEvent.press(view.getByRole("button", { name: "New deck" }));
    await fireEvent.changeText(view.getByLabelText("New deck name"), "Polish");
    await fireEvent.press(view.getByRole("button", { name: "Cancel" }));

    expect(view.queryByLabelText("New deck name")).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "New deck" }));
    expect(view.getByLabelText("New deck name").props.value).toBe("");
  });

  it("renders each deck as a full destination row", async () => {
    mockDecks = [{ id: "deck-1", name: "German" }];
    const view = await render(<DeckListScreen />);

    expect(view.queryByText("Your decks")).toBeTruthy();
    expect(view.queryByText("1")).toBeNull();
    expect(view.getByRole("link", { name: "German" }).props.className)
      .toContain("min-h-[56px]");
    expect(view.getByTestId("deck-list")).toBeTruthy();
  });

  it("does not discard a name when creating the deck fails", async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error("No connection"));
    const view = await render(<DeckListScreen />);
    await fireEvent.press(view.getByRole("button", { name: "New deck" }));
    await fireEvent.changeText(view.getByLabelText("New deck name"), "Polish");
    await fireEvent.press(view.getByRole("button", { name: "Create deck" }));
    await waitFor(() => expect(view.getByText("No connection")).toBeTruthy());
    expect(view.getByDisplayValue("Polish")).toBeTruthy();
  });

  it("keeps creation open when Cancel races a pending request that rejects", async () => {
    let rejectCreate!: (cause: Error) => void;
    mockMutateAsync.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectCreate = reject;
        }),
    );
    const view = await render(<DeckListScreen />);

    await fireEvent.press(view.getByRole("button", { name: "New deck" }));
    await fireEvent.changeText(view.getByLabelText("New deck name"), "Polish");
    await fireEvent.press(view.getByRole("button", { name: "Create deck" }));
    await fireEvent.press(view.getByRole("button", { name: "Cancel" }));

    expect(view.getByLabelText("New deck name")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Cancel" }).props.accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: true }));

    await act(async () => {
      rejectCreate(new Error("No connection"));
    });
    await waitFor(() => expect(view.getByText("No connection")).toBeTruthy());

    await fireEvent.press(view.getByRole("button", { name: "Cancel" }));
    await fireEvent.press(view.getByRole("button", { name: "New deck" }));
    expect(view.queryByText("No connection")).toBeNull();
  });

  it("does not let Cancel precede a pending create that later succeeds", async () => {
    let resolveCreate!: () => void;
    mockMutateAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const view = await render(<DeckListScreen />);

    await fireEvent.press(view.getByRole("button", { name: "New deck" }));
    await fireEvent.changeText(view.getByLabelText("New deck name"), "Polish");
    await fireEvent.press(view.getByRole("button", { name: "Create deck" }));
    await fireEvent.press(view.getByRole("button", { name: "Cancel" }));

    expect(view.getByLabelText("New deck name")).toBeTruthy();

    await act(async () => {
      resolveCreate();
    });
    await waitFor(() =>
      expect(view.queryByLabelText("New deck name")).toBeNull()
    );
  });
});
