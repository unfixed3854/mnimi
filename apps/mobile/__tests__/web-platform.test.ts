/** @jest-environment jsdom */

import { TextDecoder, TextEncoder } from "node:util";

import { createMediaResource } from "@/lib/media-resource.web";
import { createCardAudioPlayer } from "@/lib/card-audio-player.web";

// Expo's test setup installs URL lazily; jsdom omits these browser globals.
Object.assign(globalThis, { TextDecoder, TextEncoder });

describe("browser media ownership", () => {
  it("gives each media owner its own URL and revokes only that URL", () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = jest.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:media-${blobs.length}`;
    });
    URL.revokeObjectURL = jest.fn();

    const first = createMediaResource(new Uint8Array([1, 2]), "same.png", "image/png");
    const second = createMediaResource(new Uint8Array([3]), "same.png", "image/png");
    expect(first.uri).not.toBe(second.uri);
    expect(blobs.map((blob) => [blob.type, blob.size])).toEqual([
      ["image/png", 2], ["image/png", 1],
    ]);
    first.release();
    first.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first.uri);
    second.release();
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith(second.uri);
  });

  it("reports browser playback state and propagates autoplay rejection", async () => {
    const audio = document.createElement("audio");
    jest.spyOn(window, "Audio").mockImplementation(() => audio);
    jest.spyOn(audio, "play").mockRejectedValue(new Error("Autoplay blocked"));
    jest.spyOn(audio, "pause").mockImplementation(() => {});
    jest.spyOn(audio, "load").mockImplementation(() => {});
    const player = createCardAudioPlayer("blob:pronunciation");
    const changed = jest.fn();
    const subscription = player.onPlayingChange(changed);

    player.setPlaybackRate(0.75);
    expect(audio.playbackRate).toBe(0.75);
    expect(audio.preservesPitch).toBe(true);
    await expect(player.play()).rejects.toThrow("Autoplay blocked");
    audio.dispatchEvent(new Event("playing"));
    expect(changed).toHaveBeenLastCalledWith(true, false);
    audio.dispatchEvent(new Event("ended"));
    expect(changed).toHaveBeenLastCalledWith(false, true);
    subscription.remove();
    changed.mockClear();
    audio.dispatchEvent(new Event("playing"));
    expect(changed).not.toHaveBeenCalled();
    player.remove();
    expect(audio.getAttribute("src")).toBeNull();
    jest.restoreAllMocks();
  });
});
