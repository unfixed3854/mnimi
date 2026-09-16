let mockSuppressEffects = false;

jest.mock("react", () => {
  const actualReact = jest.requireActual<typeof import("react")>("react");
  return {
    ...actualReact,
    useEffect: (...args: Parameters<typeof actualReact.useEffect>) =>
      actualReact.useEffect(() => {
        if (mockSuppressEffects) return;
        return args[0]();
      }, args[1]),
  };
});

import { act, fireEvent, render, waitFor } from "@testing-library/react-native";

const mockGenerate = jest.fn();
const mockAudioPlay = jest.fn();
const mockAudioStop = jest.fn();
let mockAudioStatus: "idle" | "playing" | "finished" = "idle";

jest.mock("@expo/vector-icons", () => ({
  Ionicons: ({ name, ...props }: { name: string }) => {
    const react = require("react");
    const createElement = react["createElement"];
    const { Text } = require("react-native");
    return createElement(Text, { ...props, testID: `icon-${name}` });
  },
}));

jest.mock("@/hooks/use-card-audio", () => ({
  useCardAudio: () => ({
    play: mockAudioPlay,
    stop: mockAudioStop,
    status: mockAudioStatus,
    error: null,
  }),
}));
jest.mock("@/api/review", () => ({
  useGenerateCardAudio: () => ({ mutateAsync: mockGenerate, isPending: false }),
}));

const { PronunciationControl } = require(
  "@/components/pronunciation-control",
) as typeof import("@/components/pronunciation-control");

describe("PronunciationControl", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockAudioPlay.mockReset();
    mockAudioStop.mockReset();
    mockAudioStatus = "idle";
    mockSuppressEffects = false;
  });

  it("shows the matching action and icon, then stops active playback", async () => {
    const card = {
      id: "card-1",
      audioEligible: true,
      hasAudio: true,
      audioStatus: "ready",
      pronunciationSpeed: "normal" as const,
    };
    const view = await render(
      <PronunciationControl autoplay={false} card={card} />,
    );

    expect(view.getByRole("button", { name: "Play pronunciation" })).toBeTruthy();
    expect(view.getByTestId("icon-play", { includeHiddenElements: true })).toMatchObject({
      props: {
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      },
    });

    mockAudioStatus = "playing";
    await view.rerender(<PronunciationControl autoplay={false} card={card} />);

    const stop = view.getByRole("button", { name: "Stop pronunciation" });
    expect(stop).toBeTruthy();
    expect(view.getByTestId("icon-stop", { includeHiddenElements: true })).toMatchObject({
      props: {
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      },
    });
    await fireEvent.press(stop);

    expect(mockAudioStop).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("replaces the play button with joined replay actions after completion", async () => {
    const card = {
      id: "card-1",
      audioEligible: true,
      hasAudio: true,
      audioStatus: "ready",
      pronunciationSpeed: "normal" as const,
    };
    const view = await render(
      <PronunciationControl autoplay={false} card={card} />,
    );

    expect(view.queryByRole("button", { name: "Play again" })).toBeNull();
    expect(view.queryByRole("button", { name: "Replay slower" })).toBeNull();
    await fireEvent.press(
      view.getByRole("button", { name: "Play pronunciation" }),
    );
    expect(mockAudioPlay).toHaveBeenLastCalledWith(1);

    mockAudioStatus = "finished";
    await view.rerender(<PronunciationControl autoplay={false} card={card} />);
    expect(
      view.queryByRole("button", { name: "Play pronunciation" }),
    ).toBeNull();
    const replayActions = view.getByTestId("pronunciation-replay-actions");
    expect(replayActions.props.className).toEqual(
      expect.stringContaining("flex-row"),
    );
    expect(replayActions.props.className).toEqual(
      expect.stringContaining("overflow-hidden"),
    );

    await fireEvent.press(view.getByRole("button", { name: "Play again" }));
    expect(mockAudioPlay).toHaveBeenLastCalledWith(1);
    await fireEvent.press(view.getByRole("button", { name: "Replay slower" }));

    expect(mockAudioPlay).toHaveBeenLastCalledWith(0.75);
  });

  it.each([
    ["slow", 0.75, 0.5],
    ["fast", 1.25, 1],
  ] as const)(
    "uses %s deck speed with one slower replay step",
    async (pronunciationSpeed, deckRate, replayRate) => {
      const card = {
        id: "card-1",
        audioEligible: true,
        hasAudio: true,
        audioStatus: "ready",
        pronunciationSpeed,
      };
      const view = await render(
        <PronunciationControl autoplay={false} card={card} />,
      );

      await fireEvent.press(
        view.getByRole("button", { name: "Play pronunciation" }),
      );
      expect(mockAudioPlay).toHaveBeenLastCalledWith(deckRate);

      mockAudioStatus = "finished";
      await view.rerender(<PronunciationControl autoplay={false} card={card} />);
      await fireEvent.press(
        view.getByRole("button", { name: "Replay slower" }),
      );
      expect(mockAudioPlay).toHaveBeenLastCalledWith(replayRate);
    },
  );

  it("uses the deck speed for autoplay", async () => {
    await render(
      <PronunciationControl
        autoplay
        card={{
          id: "card-1",
          audioEligible: true,
          hasAudio: true,
          audioStatus: "ready",
          pronunciationSpeed: "fast",
        }}
      />,
    );

    await waitFor(() => expect(mockAudioPlay).toHaveBeenCalledWith(1.25));
  });

  it("shows a retryable error when pronunciation generation fails", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("generation unavailable"));
    const view = await render(
      <PronunciationControl
        autoplay={false}
        card={{
          id: "card-1",
          audioEligible: true,
          hasAudio: false,
          audioStatus: null,
          pronunciationSpeed: "normal",
        }}
      />,
    );

    expect(
      view.getByRole("button", { name: "Play pronunciation" }).props.className,
    )
      .toContain("bg-surface");
    await fireEvent.press(
      view.getByRole("button", { name: "Play pronunciation" }),
    );

    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("does not play a generation request after its card changes before effects run", async () => {
    let completeGeneration: () => void;
    const pendingGeneration = new Promise<void>((resolve) => {
      completeGeneration = resolve;
    });
    mockGenerate.mockImplementationOnce(() => pendingGeneration);
    const cardA = {
      id: "card-a",
      audioEligible: true,
      hasAudio: false,
      audioStatus: null,
      pronunciationSpeed: "normal" as const,
    };
    const cardB = { ...cardA, id: "card-b" };
    const view = await render(
      <PronunciationControl autoplay={false} card={cardA} />,
    );

    await fireEvent.press(
      view.getByRole("button", { name: "Play pronunciation" }),
    );
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledWith({
      cardId: "card-a",
    }));
    mockSuppressEffects = true;
    try {
      await view.rerender(
        <PronunciationControl autoplay={false} card={cardB} />,
      );
      await act(async () => completeGeneration!());

      expect(mockAudioPlay).not.toHaveBeenCalled();
    } finally {
      mockSuppressEffects = false;
    }
  });

  it("does not play a generation request after the control unmounts", async () => {
    let completeGeneration: () => void;
    const pendingGeneration = new Promise<void>((resolve) => {
      completeGeneration = resolve;
    });
    mockGenerate.mockImplementationOnce(() => pendingGeneration);
    const view = await render(
      <PronunciationControl
        autoplay={false}
        card={{
          id: "card-a",
          audioEligible: true,
          hasAudio: false,
          audioStatus: null,
          pronunciationSpeed: "normal",
        }}
      />,
    );

    await fireEvent.press(
      view.getByRole("button", { name: "Play pronunciation" }),
    );
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledWith({
      cardId: "card-a",
    }));
    await view.unmount();
    await act(async () => completeGeneration!());

    expect(mockAudioPlay).not.toHaveBeenCalled();
  });
});
