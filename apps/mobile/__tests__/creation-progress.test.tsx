import { render } from "@testing-library/react-native";

jest.mock("@/components/generated-image", () => ({
  GeneratedImage: ({ alt, className }: { alt: string; className?: string }) =>
    require("react").createElement(
      require("react-native").View,
      { accessibilityLabel: alt, className },
    ),
}));

import { CreationProgress } from "@/features/create/creation-progress";

const detail: any = {
  id: "creation-1",
  sourceText: "German homes",
  status: "generating",
  attemptId: "attempt-1",
  cards: [],
  attemptCards: [{
    key: "card-1",
    aspect: "meaning",
    front: "Das {{c1::Haus::building}} ist groß.",
    back: "The house is large.",
    imageCue: true,
  }],
  imageStatus: "generating",
  draftImageId: null,
  error: null,
};

describe("CreationProgress", () => {
  it("shows an indeterminate activity before the first card and keeps it during arrivals", async () => {
    const view = await render(<CreationProgress creation={{
      ...detail,
      attemptCards: [],
      imageStatus: "none",
    }} />);
    expect(view.getByRole("progressbar", { name: /Writing cards/ })).toBeTruthy();
    expect(view.queryByText(/card created so far/)).toBeNull();

    await view.rerender(<CreationProgress creation={detail} />);
    expect(view.getByRole("progressbar", { name: /Writing cards/ })).toBeTruthy();
    expect(view.getByText("1 card created so far")).toBeTruthy();
    expect(view.getByText("The house is large.", { exact: false })).toBeTruthy();
  });

  it.each([
    ["queued", "Waiting to start"],
    ["routing", "Understanding your request"],
  ])("represents %s without claiming cards are being written", async (status, label) => {
    const view = await render(<CreationProgress creation={{
      ...detail, status, attemptCards: [], imageStatus: "none",
    }} />);
    expect(view.getByRole("progressbar", { name: new RegExp(label) })).toBeTruthy();
    expect(view.queryByText("Writing cards")).toBeNull();
  });

  it("keeps only image activity after cards finish and clears activity when it finishes", async () => {
    const ready = { ...detail, status: "ready", cards: detail.attemptCards, attemptCards: [] };
    const view = await render(<CreationProgress creation={ready} />);
    expect(view.getByRole("progressbar", { name: /Creating a picture/ })).toBeTruthy();
    expect(view.queryByText("Writing cards")).toBeNull();

    await view.rerender(<CreationProgress creation={{ ...ready, imageStatus: "failed" }} />);
    expect(view.queryByRole("progressbar")).toBeNull();
    expect(view.getByText("The house is large.", { exact: false })).toBeTruthy();
  });

  it("announces only truthful stages and renders only complete cards", async () => {
    const view = await render(<CreationProgress creation={detail} />);
    expect(view.getByText("Creating a picture")).toBeTruthy();
    expect(view.getByText("Writing cards")).toBeTruthy();
    expect(view.getByText("[building]", { exact: false })).toBeTruthy();
    const output = JSON.stringify(view.toJSON());
    expect(output).not.toMatch(/%|countdown|seconds|Generating card|\{\{c1::/i);
  });

  it("animates and announces only complete cards that arrive after hydration", async () => {
    const view = await render(<CreationProgress creation={detail} />);
    expect(view.getByTestId("creation-card-arrival-card-1").props
      .accessibilityLiveRegion).toBe("none");

    await view.rerender(<CreationProgress creation={{
      ...detail,
      attemptCards: [...detail.attemptCards, {
        key: "card-2",
        aspect: "translation",
        front: "What does Haus mean?",
        back: "House",
        imageCue: false,
      }],
      imageStatus: "ready",
      draftImageId: "image-1",
    }} />);

    expect(view.getByTestId("creation-card-arrival-card-1").props
      .accessibilityLiveRegion).toBe("none");
    expect(view.getByTestId("creation-card-arrival-card-2").props
      .accessibilityLiveRegion).toBe("polite");
    expect(view.getByTestId("creation-image-arrival").props
      .accessibilityLiveRegion).toBe("polite");
  });

  it("uses the shared note image layout and keeps cards usable after image failure", async () => {
    const ready = await render(<CreationProgress creation={{
      ...detail,
      status: "ready",
      cards: detail.attemptCards,
      attemptCards: [],
      imageStatus: "ready",
      draftImageId: "image-1",
    }} />);
    expect(ready.getByLabelText("German homes illustration").props.className)
      .toBeUndefined();
    expect(ready.getByTestId("creation-image-arrival").props
      .accessibilityLiveRegion).toBe("none");

    const failed = await render(<CreationProgress creation={{
      ...detail,
      status: "ready",
      cards: detail.attemptCards,
      attemptCards: [],
      imageStatus: "failed",
    }} onRetryImage={jest.fn()} />);
    expect(failed.getByRole("button", { name: "Try picture again" })).toBeTruthy();
    expect(failed.getByText("The house is large.", { exact: false })).toBeTruthy();
  });
});
