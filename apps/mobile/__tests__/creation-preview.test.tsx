import { fireEvent, render } from "@testing-library/react-native";

let mockImageStatus = "ready";

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: unknown }) => children,
}));
jest.mock("@/components/generated-image", () => ({
  GeneratedImage: ({ alt, className, onStatusChange }: { alt: string; className?: string; onStatusChange?: (status: string) => void }) => {
    const status = mockImageStatus;
    require("react").useEffect(() => onStatusChange?.(status), [onStatusChange, status]);
    return status === "error" ? null : require("react").createElement(
      require("react-native").View,
      { accessibilityLabel: alt, className },
    );
  },
}));

import { CreationPreview } from "@/features/create/creation-preview";

const creation: any = {
  id: "creation-1",
  sourceText: "German homes",
  revision: 2,
  deck: { id: "deck-1", name: "German", description: null },
  cards: [
    {
      key: "basic",
      aspect: "meaning",
      front: "What does Haus mean?",
      back: "House",
      imageCue: false,
    },
    {
      key: "cloze",
      aspect: "usage",
      front: "Das ist ein {{c1::Haus::building}}.",
      back: "That is a house.",
      imageCue: true,
    },
  ],
  generationSummary: "Practise the meaning and usage of Haus.",
  imageStatus: "ready",
  draftImageId: "image-1",
};

describe("CreationPreview", () => {
  beforeEach(() => { mockImageStatus = "ready"; });

  it("shows the generation summary before the cards", async () => {
    const view = await render(
      <CreationPreview creation={creation} onAddCard={jest.fn()} />,
    );

    const output = JSON.stringify(view.toJSON());
    expect(view.getByText("Generation summary")).toBeTruthy();
    expect(view.getByText("Practise the meaning and usage of Haus."))
      .toBeTruthy();
    expect(output.indexOf("Practise the meaning and usage of Haus."))
      .toBeLessThan(output.indexOf("What does Haus mean?"));
  });

  it("hides picture cues when generated media cannot be displayed", async () => {
    mockImageStatus = "error";
    const view = await render(<CreationPreview creation={creation} onAddCard={jest.fn()} />);
    expect(view.queryByLabelText("Picture cue")).toBeNull();
    expect(view.getByText("What does Haus mean?")).toBeTruthy();
  });

  it("shows readable prompts and answers with a cue only when the picture is available", async () => {
    const view = await render(
      <CreationPreview
        creation={creation}
        onAddCard={jest.fn()}
      />,
    );
    const output = JSON.stringify(view.toJSON());
    expect(output.indexOf("German homes illustration"))
      .toBeLessThan(output.indexOf("What does Haus mean?"));
    expect(view.getByLabelText("German homes illustration").props.className)
      .toBeUndefined();
    expect(view.getByText("[building]", { exact: false })).toBeTruthy();
    expect(view.getByText("That is a house.", { exact: false })).toBeTruthy();
    expect(view.getByLabelText("Picture cue")).toBeTruthy();
    expect(output).not.toMatch(/TextInput/);
    expect(output).not.toMatch(/\{\{c1::/);

    await view.rerender(
      <CreationPreview
        creation={{ ...creation, imageStatus: "failed", errorStage: "image", error: "Image failed" }}
        onAddCard={jest.fn()}
        onRetryImage={jest.fn()}
      />,
    );
    expect(view.queryByLabelText("Picture cue")).toBeNull();
    expect(view.queryByText("Image failed")).toBeNull();
    expect(view.getByText("Picture unavailable")).toBeTruthy();
    expect(view.getByText("That is a house.", { exact: false })).toBeTruthy();
  });

  it("retries a picture without hiding cards or swallowing other failures", async () => {
    const retry = jest.fn();
    const view = await render(
      <CreationPreview
        creation={{ ...creation, imageStatus: "failed", errorStage: "cards", error: "Cards could not be updated" }}
        onAddCard={jest.fn()}
        onRetryImage={retry}
      />,
    );
    expect(view.getByRole("alert")).toHaveTextContent("Cards could not be updated");
    await fireEvent.press(view.getByRole("button", { name: "Try picture again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(view.getByText("What does Haus mean?")).toBeTruthy();
  });

  it("keeps cards visible during replacement and exposes durable Undo", async () => {
    const cancel = jest.fn();
    const undo = jest.fn();
    const view = await render(
      <CreationPreview
        creation={{ ...creation, activity: "adjusting", undoAvailable: false }}
        onAddCard={jest.fn()}
        onAdjust={jest.fn()}
        onCancelReplacement={cancel}
      />,
    );
    expect(view.getByText("What does Haus mean?")).toBeTruthy();
    expect(view.getByText("Adjusting cards")).toBeTruthy();
    expect(view.getByRole("button", { name: "Adjust with AI" })).toBeDisabled();
    expect(view.getByRole("button", { name: "Add card" })).toBeDisabled();
    await fireEvent.press(view.getByRole("button", { name: "Cancel replacement" }));
    expect(cancel).toHaveBeenCalledTimes(1);

    await view.rerender(
      <CreationPreview
        creation={{ ...creation, activity: null, undoAvailable: true }}
        onAddCard={jest.fn()}
        onUndo={undo}
      />,
    );
    expect(view.getByText("Cards adjusted")).toBeTruthy();
    expect(view.getByRole("button", { name: "Undo" })).toBeTruthy();
    await fireEvent.press(view.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
