import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { PronunciationSpeed } from "@/api/decks";
import { useCardAudio } from "@/hooks/use-card-audio";
import { useGenerateCardAudio } from "@/api/review";
import { nativeColors } from "@/theme/native-colors";
import { PrimaryButton } from "@/components/primary-button";

const playbackRateBySpeed: Record<PronunciationSpeed, number> = {
  slow: 0.75,
  normal: 1,
  fast: 1.25,
};

const slowerPlaybackRateBySpeed: Record<PronunciationSpeed, number> = {
  slow: 0.5,
  normal: 0.75,
  fast: 1,
};

export function PronunciationControl(
  { card, autoplay }: {
    card: {
      id: string;
      audioEligible: boolean;
      hasAudio: boolean;
      audioStatus: string | null;
      pronunciationSpeed: PronunciationSpeed;
    };
    autoplay: boolean;
  },
) {
  const audio = useCardAudio(card.audioEligible ? card.id : null);
  const generate = useGenerateCardAudio();
  const autoplayed = useRef<string | null>(null);
  const playbackGeneration = useRef(0);
  const currentCardId = useRef(card.id);
  const currentCardAudioEligible = useRef(card.audioEligible);
  const mounted = useRef(true);
  currentCardId.current = card.id;
  currentCardAudioEligible.current = card.audioEligible;
  const [generationError, setGenerationError] = useState<string | null>(null);
  async function play(
    playbackRate = playbackRateBySpeed[card.pronunciationSpeed],
  ) {
    const request = ++playbackGeneration.current;
    setGenerationError(null);
    const isCurrentRequest = () =>
      mounted.current &&
      request === playbackGeneration.current &&
      currentCardId.current === card.id &&
      currentCardAudioEligible.current;
    try {
      if (!card.hasAudio || card.audioStatus !== "ready") {
        await generate.mutateAsync({ cardId: card.id });
      }
    } catch {
      if (isCurrentRequest()) {
        setGenerationError("Pronunciation isn't available. Try again.");
      }
      return;
    }
    if (!isCurrentRequest()) return;
    await audio.play(playbackRate);
  }
  useEffect(() => {
    playbackGeneration.current += 1;
    setGenerationError(null);
  }, [card.id]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      playbackGeneration.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!autoplay || !card.audioEligible || autoplayed.current === card.id) {
      return;
    }
    autoplayed.current = card.id;
    void play();
    // Autoplay is tied to a stable card identity; status refreshes must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, card.audioEligible, card.id]);
  if (!card.audioEligible) return null;
  const waiting = audio.status === "loading" || generate.isPending;
  const error = generationError ?? audio.error;
  const playing = audio.status === "playing";
  const showReplayActions = audio.status === "finished" && !error;
  const label = waiting
    ? "Loading…"
    : playing
    ? "Stop pronunciation"
    : error || card.audioStatus === "failed"
    ? "Retry"
    : card.audioStatus === "pending" || card.audioStatus === "generating"
    ? "Generating…"
    : "Play pronunciation";
  return (
    <View className="gap-xs">
      {showReplayActions
        ? (
          <View
            className="flex-row overflow-hidden rounded-md border border-border bg-surface"
            testID="pronunciation-replay-actions"
          >
            <PrimaryButton
              className="flex-1 rounded-none"
              icon={
                <Ionicons
                  accessibilityElementsHidden
                  color={nativeColors.foreground}
                  importantForAccessibility="no-hide-descendants"
                  name="play"
                  size={20}
                />
              }
              variant="ghost"
              onPress={play}
            >
              Play again
            </PrimaryButton>
            <PrimaryButton
              accessibilityLabel="Replay slower"
              className="rounded-none border-l border-border"
              variant="ghost"
              onPress={() => play(
                slowerPlaybackRateBySpeed[card.pronunciationSpeed],
              )}
            >
              Slower
            </PrimaryButton>
          </View>
        )
        : (
          <PrimaryButton
            disabled={waiting}
            icon={
              label === "Play pronunciation" || playing
                ? (
                  <Ionicons
                    accessibilityElementsHidden
                    color={nativeColors.foreground}
                    importantForAccessibility="no-hide-descendants"
                    name={playing ? "stop" : "play"}
                    size={20}
                  />
                )
                : undefined
            }
            variant="outline"
            onPress={playing ? audio.stop : play}
          >
            {label}
          </PrimaryButton>
        )}
      {error
        ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {error}
          </Text>
        )
        : null}
    </View>
  );
}
