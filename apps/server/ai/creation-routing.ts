import { z } from "zod";
import type { ModelPrompts } from "./generate-note.ts";
import { parseWithRetry } from "./generate.ts";

export type DeckRoutingCandidate = {
  deckId: string;
  learningGoal: string;
};

export type DeckRoutingOutcome =
  | { kind: "matched"; deckId: string; learningGoal: string }
  | { kind: "ambiguous"; candidates: DeckRoutingCandidate[] }
  | {
    kind: "newDeck";
    proposedName: string;
    proposedDescription: string;
    learningGoal: string;
  };

export type DeckRoutingInput = {
  request: string;
  nativeLanguage: string;
  decks: Array<{ id: string; name: string; description: string | null }>;
};

const routingCandidateSchema = z.object({
  deckId: z.string().min(1),
  learningGoal: z.string().trim().min(1).max(300),
});

export const newDeckRoutingOutcomeSchema = z.object({
  kind: z.literal("newDeck"),
  proposedName: z.string().trim().min(1).max(100),
  proposedDescription: z.string().trim().max(500),
  learningGoal: z.string().trim().min(1).max(300),
});

export const deckRoutingOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("matched"),
    deckId: z.string().min(1),
    learningGoal: z.string().trim().min(1).max(300),
  }),
  z.object({
    kind: z.literal("ambiguous"),
    candidates: z.array(routingCandidateSchema).min(2).max(3),
  }).superRefine((outcome, context) => {
    const ids = outcome.candidates.map((candidate) => candidate.deckId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Candidate deck is duplicated" });
    }
  }),
  newDeckRoutingOutcomeSchema,
]);

export function buildCreationRoutingRequest(
  input: DeckRoutingInput,
) {
  const ownedIds = new Set(input.decks.map((deck) => deck.id));
  const schema = deckRoutingOutcomeSchema.superRefine((outcome, context) => {
    if (outcome.kind === "matched" && !ownedIds.has(outcome.deckId)) {
      context.addIssue({ code: "custom", message: "Matched deck is not owned" });
    }
    if (outcome.kind !== "ambiguous") return;
    for (const option of outcome.candidates) {
      if (!ownedIds.has(option.deckId)) {
        context.addIssue({
          code: "custom",
          message: "Candidate deck is not owned",
        });
      }
    }
  });

  const system = `
Route a learner's natural-language request to its best pedagogical deck.

The outcome kind must be exactly "matched", "ambiguous", or "newDeck". Never
invent a synonym for these discriminator values.

The request may combine an instruction with quoted or foreign-language source
material. Interpret what the learner wants to practise; do not assume every
foreign phrase names its target language or every imperative is literal study
content.

Return matched only when one supplied deck is clearly the best context. When
two or three supplied decks would produce meaningfully different learning
angles, return ambiguous rather than making an unsafe guess. When no supplied
deck fits, propose a concise new deck. Never invent an existing deck id.
An existing broad subject deck fits requests about its subtopics; its description
does not need to mention the particular word or topic. Reuse that deck instead
of proposing a duplicate. For "die Paprika", if a supplied "German" deck is the
clear language-learning context, return matched with that deck's id.

New decks should default to broad, reusable subjects that can hold future
requests. For language learning, use the language name alone, such as "German"
or "Latin". Do not narrow the deck to the current word, its topic, part of
speech, or exercise type unless the learner explicitly asks for a specialized
deck. Keep proposedDescription broad as well; put request-specific details in
learningGoal.

For example, "die Paprika" with no suitable owned deck should propose "German"
with a description like "German vocabulary, expressions, and grammar" and a
learning goal about learning this word and its article. Do not propose "German
Food Vocabulary: Vegetables", "German Vocabulary", or "German Nouns" for this
request. Apply the same broad-subject principle outside language learning.
`.trim();
  const catalog = input.decks.map((deck) => ({
    id: deck.id,
    name: deck.name,
    description: deck.description,
  }));
  const baseUser = [
    `Request: ${input.request}`,
    `Native language: ${input.nativeLanguage}`,
    `Owned decks: ${JSON.stringify(catalog)}`,
  ].join("\n");

  return { schema, prompts: (feedback: string | null): ModelPrompts => ({
      system,
      user: [baseUser, feedback].filter(Boolean).join("\n\n"),
    }) };
}

export async function routeCreation(
  input: DeckRoutingInput,
  call: (prompts: ModelPrompts) => Promise<unknown>,
): Promise<DeckRoutingOutcome> {
  const request = buildCreationRoutingRequest(input);
  return await parseWithRetry(request.schema, (feedback) => call(request.prompts(feedback)));
}
