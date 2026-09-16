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

import { act, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import { createElement } from "react";

const mockFileRemove = jest.fn();
const mockFileWrite = jest.fn();
const mockPlayerRemove = jest.fn();
const mockPlayerPause = jest.fn();
const mockPlayerPlay = jest.fn();
const mockSetPlaybackRate = jest.fn();
const mockCreateAudioPlayer = jest.fn(() => ({
  addListener: jest.fn((event, listener) => {
    if (event === "playbackStatusUpdate") playbackStatusListener = listener;
    return { remove: mockPlaybackSubscriptionRemove };
  }),
  play: mockPlayerPlay,
  pause: mockPlayerPause,
  remove: mockPlayerRemove,
  setPlaybackRate: mockSetPlaybackRate,
}));
const mockPlaybackSubscriptionRemove = jest.fn();
let playbackStatusListener: ((status: {
  didJustFinish: boolean;
  playing: boolean;
}) => void) | null =
  null;
const mockSessionAwareFetch = jest.fn(async () =>
  new Response(new Uint8Array([1, 2, 3]))
);
const mockFile = jest.fn().mockImplementation(() => ({
  uri: "file:///cache/card.mp3",
  write: mockFileWrite,
  delete: mockFileRemove,
}));

jest.mock("expo-file-system", () => ({
  File: mockFile,
  Paths: { cache: "file:///cache" },
}));
jest.mock("expo-audio", () => ({
  createAudioPlayer: mockCreateAudioPlayer,
}));
jest.mock(
  "@/auth/token-store",
  () => ({ getToken: jest.fn(async () => "bearer-token") }),
);
jest.mock(
  "@/config/api-url",
  () => ({ getApiUrl: () => "https://api.test" }),
);
jest.mock("@/api/session-rejection", () => ({
  sessionAwareFetch: mockSessionAwareFetch,
}));

const { useCardAudio } = require(
  "@/hooks/use-card-audio",
) as typeof import("@/hooks/use-card-audio");

let latestAudio: ReturnType<typeof useCardAudio> | null = null;
function AudioHarness({ cardId }: { cardId: string }) {
  const audio = useCardAudio(cardId);
  latestAudio = audio;
  return createElement(Text, null, audio.status);
}

describe("useCardAudio", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    latestAudio = null;
    playbackStatusListener = null;
    mockSuppressEffects = false;
  });

  it("reports when native playback finishes", async () => {
    await render(createElement(AudioHarness, { cardId: "card-1" }));

    await act(async () => {
      await latestAudio!.play();
    });
    expect(latestAudio?.status).toBe("playing");

    await act(() =>
      playbackStatusListener?.({ didJustFinish: true, playing: false })
    );

    expect(latestAudio?.status).toBe("finished");
  });

  it("does not overwrite completion when a short clip finishes during play", async () => {
    mockPlayerPlay.mockImplementationOnce(() => {
      playbackStatusListener?.({ didJustFinish: true, playing: false });
    });
    await render(createElement(AudioHarness, { cardId: "card-1" }));

    await act(async () => {
      await latestAudio!.play();
    });

    expect(latestAudio?.status).toBe("finished");
  });

  it("sets pitch-corrected playback to the requested rate", async () => {
    await render(createElement(AudioHarness, { cardId: "card-1" }));

    await act(async () => {
      await latestAudio!.play(0.75);
    });

    expect(mockSetPlaybackRate).toHaveBeenCalledWith(0.75, "high");
    expect(mockSetPlaybackRate.mock.invocationCallOrder[0]).toBeLessThan(
      mockPlayerPlay.mock.invocationCallOrder[0],
    );
  });

  it("makes rejected playback retryable and releases its resources", async () => {
    mockPlayerPlay.mockRejectedValueOnce(new Error("Autoplay blocked"));
    await render(createElement(AudioHarness, { cardId: "card-1" }));

    await act(async () => {
      await latestAudio!.play();
    });
    expect(latestAudio?.status).toBe("error");
    expect(latestAudio?.error).toContain("Try again");
    expect(mockPlayerRemove).toHaveBeenCalledTimes(1);
    expect(mockFileRemove).toHaveBeenCalledTimes(1);

    await act(async () => {
      await latestAudio!.play();
    });
    expect(latestAudio?.status).toBe("playing");
    expect(latestAudio?.error).toBeNull();
  });

  it("does not start a stale download after playback is stopped", async () => {
    let completeFetch: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      completeFetch = resolve;
    });
    mockSessionAwareFetch.mockImplementationOnce(() => pendingFetch);
    await render(createElement(AudioHarness, { cardId: "card-1" }));

    let play: Promise<void>;
    await act(() => {
      play = latestAudio!.play();
    });
    await act(() => latestAudio!.stop());

    await act(async () => {
      completeFetch!(new Response(new Uint8Array([1, 2, 3])));
      await play!;
    });

    expect(mockPlayerPlay).not.toHaveBeenCalled();
    expect(latestAudio?.status).toBe("idle");
  });

  it("does not create old-card playback after a card render before effects run", async () => {
    let completeFetch: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      completeFetch = resolve;
    });
    mockSessionAwareFetch.mockImplementationOnce(() => pendingFetch);
    mockSuppressEffects = true;
    const view = await render(createElement(AudioHarness, { cardId: "card-a" }));

    let play: Promise<void>;
    await act(() => {
      play = latestAudio!.play();
    });
    try {
      await view.rerender(createElement(AudioHarness, { cardId: "card-b" }));
      await act(async () => {
        completeFetch!(new Response(new Uint8Array([1, 2, 3])));
        await play!;
      });

      expect(mockFile).not.toHaveBeenCalled();
      expect(mockCreateAudioPlayer).not.toHaveBeenCalled();
      expect(mockPlayerPlay).not.toHaveBeenCalled();
    } finally {
      mockSuppressEffects = false;
    }
  });

  it("releases its player and temporary file when its card changes", async () => {
    const view = await render(
      createElement(AudioHarness, { cardId: "card-1" }),
    );

    await act(async () => {
      await latestAudio!.play();
    });
    expect(latestAudio?.error).toBeNull();
    await waitFor(() =>
      expect(mockSessionAwareFetch).toHaveBeenCalledWith(
        "https://api.test/audio/cards/card-1",
      )
    );
    await view.rerender(createElement(AudioHarness, { cardId: "card-2" }));

    expect(mockPlayerPause).toHaveBeenCalled();
    expect(mockPlayerRemove).toHaveBeenCalled();
    expect(mockPlaybackSubscriptionRemove).toHaveBeenCalled();
    expect(mockFileRemove).toHaveBeenCalled();
  });

  it("releases its player and temporary file when it unmounts", async () => {
    const view = await render(
      createElement(AudioHarness, { cardId: "card-1" }),
    );

    await act(async () => {
      await latestAudio!.play();
    });
    await waitFor(() => expect(mockPlayerPlay).toHaveBeenCalled());
    await view.unmount();

    expect(mockPlayerPause).toHaveBeenCalled();
    expect(mockPlayerRemove).toHaveBeenCalled();
    expect(mockPlaybackSubscriptionRemove).toHaveBeenCalled();
    expect(mockFileRemove).toHaveBeenCalled();
  });
});
