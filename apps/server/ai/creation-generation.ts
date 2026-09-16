import { uuidv7 } from "uuidv7";
import { generateNote } from "./generate-note.ts";
import type {
  GenerationInput,
  ModelCalls,
} from "./generate-note.ts";
import type { Classification } from "./schemas.ts";
import type { CreationCard } from "../creations/contracts.ts";

export type CreationGenerationEvent =
  | { type: "classified"; classification: Classification }
  | { type: "image-prompt"; prompt: string | null }
  | { type: "cards"; cards: CreationCard[] }
  | { type: "retry" }
  | {
    type: "done";
    classification: Classification;
    imagePrompt: string | null;
    generationSummary: string;
    cards: CreationCard[];
  };

function sameCard(
  left: Omit<CreationCard, "key">,
  right: CreationCard | undefined,
): boolean {
  return right !== undefined && left.aspect === right.aspect &&
    left.front === right.front && left.back === right.back &&
    left.imageCue === right.imageCue;
}

function keyCards(
  cards: Array<Omit<CreationCard, "key">>,
  previous: CreationCard[],
  nextKey: () => string,
): CreationCard[] {
  let commonPrefix = 0;
  while (
    commonPrefix < cards.length &&
    sameCard(cards[commonPrefix], previous[commonPrefix])
  ) commonPrefix++;

  return cards.map((card, index) => ({
    key: index < commonPrefix ? previous[index].key : nextKey(),
    ...card,
  }));
}

/** Adds stable, server-owned identities to complete-card stream snapshots. */
export async function* streamCreationGeneration(
  input: GenerationInput,
  models: ModelCalls,
  nextKey: () => string = uuidv7,
): AsyncGenerator<CreationGenerationEvent> {
  let keyedCards: CreationCard[] = [];
  for await (const event of generateNote(input, models)) {
    switch (event.type) {
      case "classified":
      case "image-prompt":
        yield event;
        break;
      case "cards":
        keyedCards = keyCards(event.cards, keyedCards, nextKey);
        yield { type: "cards", cards: keyedCards };
        break;
      case "retry":
        keyedCards = [];
        yield event;
        break;
      case "done":
        keyedCards = keyCards(event.generation.cards, keyedCards, nextKey);
        yield {
          type: "done",
          classification: event.classification,
          imagePrompt: event.generation.imagePrompt,
          generationSummary: event.generation.generationSummary,
          cards: keyedCards,
        };
        break;
    }
  }
}
