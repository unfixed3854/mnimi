import type { DraftState } from "@/lib/draft-state";
import type { DraftClassification } from "@/api/drafts";

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** "language" + "de" + "noun" reads as "Language · de · noun". */
function describeClassification(classification: DraftClassification): string {
  const label = [
    classification.domain,
    classification.language,
    classification.partOfSpeech,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Aspects are open-vocabulary model output: `roman_name` reads as "roman name". */
function humanizeAspect(aspect: string): string {
  return aspect.replace(/_/g, " ");
}

/**
 * Every line here is derived from something the server actually reported.
 * Nothing is filler, so the screen never claims progress that did not happen.
 */
export function draftStatusText(state: DraftState): string {
  switch (state.status) {
    case "loading":
    case "none":
      return "";

    case "generating": {
      if (state.retried && state.cards.length === 0) {
        return "That came back malformed — trying once more…";
      }
      if (!state.classification) return "Working out what this is…";

      const current = state.cards[state.cards.length - 1];
      // Name the aspect only once `front` has started arriving, which proves
      // the aspect string itself finished streaming. Otherwise a half-written
      // label leaks out as "Writing the gen card…".
      if (current?.aspect && current.front !== null) {
        return `Writing the ${humanizeAspect(current.aspect)} card…`;
      }
      return `${describeClassification(state.classification)} — writing cards…`;
    }

    case "failed":
      return "Generation failed";

    case "ready":
      return `${state.cards.length} ${
        state.cards.length === 1 ? "card" : "cards"
      } ready`;
  }
}
