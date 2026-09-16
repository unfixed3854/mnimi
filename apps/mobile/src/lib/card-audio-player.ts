import { createAudioPlayer } from "expo-audio";

export type CardAudioPlayer = {
  play: () => void | Promise<void>;
  setPlaybackRate: (rate: number) => void;
  pause: () => void;
  remove: () => void;
  onPlayingChange: (
    listener: (playing: boolean, didJustFinish: boolean) => void,
  ) => { remove: () => void };
};

export function createCardAudioPlayer(uri: string): CardAudioPlayer {
  const player = createAudioPlayer(uri);
  return {
    play: () => player.play(),
    setPlaybackRate: (rate) => player.setPlaybackRate(rate, "high"),
    pause: () => player.pause(),
    remove: () => player.remove(),
    onPlayingChange: (listener) => player.addListener(
      "playbackStatusUpdate",
      (status) => listener(status.playing, status.didJustFinish),
    ),
  };
}
