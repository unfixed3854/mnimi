import { z } from "zod";
import type { CreationCard } from "../creations/contracts.ts";
import {
  BASIC_CARD_NEEDS_BACK,
  cardHasAnAnswer,
  clozeMarkupIsWellFormed,
  IMAGE_CUE_NEEDS_HINT,
  IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
  imageCueHasFallback,
  imageCuesMatchContext,
  MALFORMED_CLOZE,
} from "./card-rules.ts";
import { parseWithRetry } from "./generate.ts";
import type { ModelPrompts } from "./generate-note.ts";
import type { Classification } from "./schemas.ts";
import { buildSystemPrompt } from "./rule-packs.ts";

const adjustedCardSchema = z.object({
  key: z.string().min(1).nullable().optional(),
  aspect: z.string().min(1),
  front: z.string().min(1),
  back: z.string().nullish().transform((value) => value || null),
  imageCue: z.boolean(),
})
  .refine(clozeMarkupIsWellFormed, {
    message: MALFORMED_CLOZE,
    path: ["front"],
  })
  .refine(imageCueHasFallback, {
    message: IMAGE_CUE_NEEDS_HINT,
    path: ["front"],
  })
  .refine(cardHasAnAnswer, {
    message: BASIC_CARD_NEEDS_BACK,
    path: ["back"],
  });

export const adjustedCardsOutputSchema = z.object({
  generationSummary: z.string().min(1).max(280).describe(
    "A concise learner-facing summary of what changed in this card set.",
  ),
  cards: z.array(adjustedCardSchema).min(1).max(6),
});

export type CreationAdjustmentInput = {
  request: string;
  nativeLanguage: string;
  aiInstructions?: string;
  deck: { id: string; name: string; description: string | null };
  learningGoal: string;
  classification: Classification;
  imagePrompt: string | null;
  cards: CreationCard[];
  instruction: string;
};

const SYSTEM_PROMPT = `
Adjust an existing reviewed flashcard set according to the learner's instruction.

Return a concise generationSummary and cards only. The summary should tell the
learner what changed in the card set. Do not change the deck or image intent.
Keep an existing card's key when it remains in the set, and use null for the
key of each new card. Never invent or reuse a key. Return the smallest useful
complete set of one to six cards. Preserve valid image cues unless the learner
asks to change the cards in a way that makes them unnecessary.

Apply the shared card-writing and language coverage rules to the adjusted set.
The learner's explicit adjustment instruction takes precedence over default
coverage: do not re-add forms or cards they asked to remove. Use the current
imagePrompt only to decide image cues; do not generate or return an imagePrompt.
`.trim();

export function buildCreationAdjustmentRequest(
  input: CreationAdjustmentInput,
) {
  const aiInstructions = input.aiInstructions?.trim();
  const knownKeys = new Set(input.cards.map((card) => card.key));
  const schema = adjustedCardsOutputSchema.superRefine((output, context) => {
    const supplied = output.cards
      .map((card) => card.key)
      .filter((key): key is string => key != null);
    if (new Set(supplied).size !== supplied.length) {
      context.addIssue({ code: "custom", message: "Card key is duplicated" });
    }
    for (const key of supplied) {
      if (!knownKeys.has(key)) {
        context.addIssue({ code: "custom", message: "Card key is not current" });
      }
    }
    if (!imageCuesMatchContext(
      output.cards,
      input.classification.domain,
      input.imagePrompt,
    )) {
      context.addIssue({
        code: "custom",
        message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
        path: ["cards"],
      });
    }
  });
  const baseUser = [
    `Original request: ${input.request}`,
    `Learner's native language: ${input.nativeLanguage}`,
    `Deck: ${input.deck.name}`,
    input.deck.description ? `Deck description: ${input.deck.description}` : "",
    `Learning goal: ${input.learningGoal}`,
    `Current imagePrompt: ${JSON.stringify(input.imagePrompt)}`,
    `Current cards: ${JSON.stringify(input.cards)}`,
    `Learner instruction: ${input.instruction}`,
    aiInstructions ? `Learner's standing AI instructions:\n${aiInstructions}` : "",
  ].filter(Boolean).join("\n");
  return { schema, prompts: (feedback: string | null): ModelPrompts => ({
      system: `${buildSystemPrompt(input.classification)}\n\n${SYSTEM_PROMPT}`,
      user: [baseUser, feedback].filter(Boolean).join("\n\n"),
    }) };
}

export async function adjustCreationCards(
  input: CreationAdjustmentInput,
  call: (prompts: ModelPrompts) => Promise<unknown>,
  nextKey: () => string,
): Promise<{ generationSummary: string; cards: CreationCard[] }> {
  const request = buildCreationAdjustmentRequest(input);
  const adjusted = await parseWithRetry(request.schema, (feedback) => call(request.prompts(feedback)));

  return {
    generationSummary: adjusted.generationSummary,
    cards: adjusted.cards.map((card) => ({
      ...card,
      key: card.key ?? nextKey(),
    })),
  };
}
