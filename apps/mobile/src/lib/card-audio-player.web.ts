import type { CardAudioPlayer } from "@/lib/card-audio-player";

export function createCardAudioPlayer(uri: string): CardAudioPlayer {
  const audio = new Audio(uri);
  return {
    // Preserve the promise so blocked autoplay becomes a retryable UI error.
    play: () => audio.play(),
    setPlaybackRate(rate) {
      audio.playbackRate = rate;
      audio.preservesPitch = true;
    },
    pause: () => audio.pause(),
    remove() {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    },
    onPlayingChange(listener) {
      const playing = () => listener(true, false);
      const stopped = () => listener(false, false);
      const finished = () => listener(false, true);
      audio.addEventListener("playing", playing);
      audio.addEventListener("pause", stopped);
      audio.addEventListener("ended", finished);
      return {
        remove() {
          audio.removeEventListener("playing", playing);
          audio.removeEventListener("pause", stopped);
          audio.removeEventListener("ended", finished);
        },
      };
    },
  };
}
