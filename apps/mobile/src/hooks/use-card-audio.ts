import { useCallback, useEffect, useRef, useState } from "react";
import { type CardAudioPlayer, createCardAudioPlayer } from "@/lib/card-audio-player";
import { type MediaResource, createMediaResource } from "@/lib/media-resource";
import { cardAudioMediaPath, fetchAuthenticatedMedia } from "@/api/media";

export type CardAudioStatus =
  | "idle"
  | "loading"
  | "playing"
  | "finished"
  | "error";

/** Owns private downloaded audio and its platform player for one review card. */
export function useCardAudio(cardId: string | null) {
  const player = useRef<CardAudioPlayer | null>(null);
  const media = useRef<MediaResource | null>(null);
  const playbackSubscription = useRef<{ remove: () => void } | null>(null);
  const generation = useRef(0);
  const currentCardId = useRef(cardId);
  currentCardId.current = cardId;
  const [status, setStatus] = useState<CardAudioStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const release = useCallback(() => {
    playbackSubscription.current?.remove();
    playbackSubscription.current = null;
    player.current?.pause();
    player.current?.remove();
    player.current = null;
    media.current?.release();
    media.current = null;
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    release();
    setStatus("idle");
  }, [release]);

  const play = useCallback(async (playbackRate = 1) => {
    if (!cardId) return;
    const request = ++generation.current;
    const isCurrentRequest = () =>
      request === generation.current && currentCardId.current === cardId;
    release();
    setError(null);
    setStatus("loading");
    let downloaded: MediaResource | null = null;
    let nextPlayer: CardAudioPlayer | null = null;
    let transferred = false;
    try {
      const bytes = await fetchAuthenticatedMedia(cardAudioMediaPath(cardId));
      if (!isCurrentRequest()) return;
      downloaded = createMediaResource(bytes, `mnimi-card-${cardId}-${request}.mp3`, "audio/mpeg");
      if (!isCurrentRequest()) return;
      nextPlayer = createCardAudioPlayer(downloaded.uri);
      if (!isCurrentRequest()) return;
      nextPlayer.setPlaybackRate(playbackRate);
      let receivedPlaybackStatus = false;
      const nextSubscription = nextPlayer.onPlayingChange(
        (playing, didJustFinish) => {
          receivedPlaybackStatus = true;
          if (
            isCurrentRequest() && player.current === nextPlayer
          ) {
            setStatus(
              didJustFinish ? "finished" : playing ? "playing" : "idle",
            );
          }
        },
      );
      media.current = downloaded;
      player.current = nextPlayer;
      playbackSubscription.current = nextSubscription;
      transferred = true;
      await nextPlayer.play();
      if (isCurrentRequest() && !receivedPlaybackStatus) setStatus("playing");
    } catch {
      if (isCurrentRequest()) {
        release();
        if (!transferred) nextPlayer?.remove();
        downloaded?.release();
        setError("Pronunciation isn't available. Try again.");
        setStatus("error");
      }
    } finally {
      if (!isCurrentRequest()) {
        if (player.current === nextPlayer) release();
        else if (!transferred) nextPlayer?.remove();
        downloaded?.release();
      }
    }
  }, [cardId, release]);

  useEffect(() => {
    generation.current += 1;
    release();
    setStatus("idle");
    setError(null);
    return () => {
      generation.current += 1;
      release();
    };
  }, [cardId, release]);

  return { play, stop, status, error };
}
