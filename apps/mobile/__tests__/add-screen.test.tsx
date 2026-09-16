import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

let mockParams: Record<string, string> = {};
const mockCreationMutation = jest.fn((_name: string, _input: unknown) =>
  Promise.resolve({ status: "queued" })
);

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: unknown }) => children,
  useLocalSearchParams: () => mockParams,
}));

jest.mock("@/api/creations", () => ({
  creationMutation: (name: string, input: unknown) =>
    mockCreationMutation(name, input),
}));

const mockSubmit = jest.fn();
let mockCreations: any[] = [];

jest.mock("@/hooks/use-creation-outbox", () => ({
  useCreationOutbox: () => {
    const React = require("react");
    const [composer, setComposer] = React.useState("");
    const [validationError, setValidationError] = React.useState(null);
    return {
      ready: true,
      composer,
      setComposer,
      validationError,
      creations: mockCreations,
      actionableCount: mockCreations.filter((item) =>
        ["needsChoice", "ready", "failed"].includes(item.group)
      ).length,
      isLoading: false,
      listError: null,
      items: [],
      retry: jest.fn(),
      submit: async () => {
        const text = composer.trim();
        if (!text) {
          setValidationError("Describe what you want to learn.");
          return false;
        }
        if (text.length > 2_000) {
          setValidationError("Keep your request to 2,000 characters.");
          return false;
        }
        mockSubmit(text);
        setComposer("");
        setValidationError(null);
        return true;
      },
    };
  },
}));

jest.mock("@/components/draft-indicator", () => ({
  DraftIndicator: ({ count }: { count?: number }) => count
    ? require("react").createElement(
      require("react-native").Text,
      null,
      `${count} need attention`,
    )
    : null,
}));

import { AddScreen } from "@/features/add/add-screen";

const creation = (group: string, id: string) => ({
  id,
  clientRequestId: `request-${id}`,
  sourceText: `${id} source`,
  deckName: id === "queued" ? null : "Biology",
  group,
  stateLabel: group === "ready" ? "Ready to review" : group,
  thumbnailId: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});

describe("Create screen", () => {
  beforeEach(() => {
    mockCreations = [];
    mockParams = {};
    mockSubmit.mockClear();
    mockCreationMutation.mockClear();
  });

  it("starts with the learning prompt and an accessible composer", async () => {
    const view = await render(<AddScreen />);

    expect(view.getByRole("header", { name: "What do you want to learn?" })).toBeTruthy();
    expect(view.getByLabelText("What do you want to learn?")).toBeTruthy();
    for (const absent of ["Deck", "Number of cards", "Image", "Domain", "Language"]) {
      expect(view.queryByLabelText(absent)).toBeNull();
    }
  });

  it("keeps invalid text, shows a nearby error, and reveals the count at 1,800", async () => {
    const view = await render(<AddScreen />);
    const input = view.getByLabelText("What do you want to learn?");
    await act(async () => fireEvent.changeText(input, "x".repeat(1_800)));
    expect(view.getByText("1,800 / 2,000")).toBeTruthy();
    await act(async () => fireEvent.changeText(input, "x".repeat(2_001)));
    await act(async () =>
      fireEvent.press(view.getByRole("button", { name: "Create cards" }))
    );
    await waitFor(() =>
      expect(view.getByRole("alert")).toHaveTextContent(/2,000 characters/)
    );
    expect(input.props.value).toHaveLength(2_001);
  });

  it("clears each accepted request so three rapid ideas remain independent", async () => {
    const view = await render(<AddScreen />);
    const input = view.getByLabelText("What do you want to learn?");
    for (const text of ["one", "two", "three"]) {
      await act(async () => fireEvent.changeText(input, text));
      await act(async () =>
        fireEvent.press(view.getByRole("button", { name: "Create cards" }))
      );
      await waitFor(() =>
        expect(view.getByLabelText("What do you want to learn?").props.value)
          .toBe("")
      );
    }
    expect(mockSubmit.mock.calls.map(([text]) => text)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("orders non-empty inbox groups by learner action and shows human copy", async () => {
    mockCreations = [
      creation("failed", "failed"),
      creation("queued", "queued"),
      creation("creating", "creating"),
      creation("ready", "ready"),
      creation("needsChoice", "choice"),
    ];
    const view = await render(<AddScreen />);
    const serialized = JSON.stringify(view.toJSON());
    const headings = [
      "Needs your choice",
      "Ready to review",
      "Creating",
      "Queued",
      "Needs attention",
    ];
    for (let index = 1; index < headings.length; index++) {
      expect(view.getByText(headings[index - 1])).toBeTruthy();
      expect(view.getByText(headings[index])).toBeTruthy();
      expect(serialized.indexOf(headings[index - 1]))
        .toBeLessThan(serialized.indexOf(headings[index]));
    }
    expect(view.getByText("Biology · Ready to review")).toBeTruthy();
    expect(serialized).not.toMatch(/provider|confidence|attemptId/i);
  });

  it("shows save confirmation and a brief queued-removal Undo", async () => {
    mockParams = {
      savedNoteId: "note-1",
      savedDeckName: "Latin",
      removedCreationId: "creation-1",
    };
    const view = await render(<AddScreen />);
    expect(view.getByText("Saved to Latin")).toBeTruthy();
    expect(view.getByText("View note")).toBeTruthy();
    expect(view.getByText("Removed from queue")).toBeTruthy();
    await act(async () =>
      fireEvent.press(view.getByRole("button", { name: "Undo" }))
    );
    expect(mockCreationMutation).toHaveBeenCalledWith("restore", {
      creationId: "creation-1",
    });
  });
});
