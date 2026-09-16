import { Effect } from "effect";
import { parsePartialJSON } from "@tanstack/ai";
import type { z } from "zod";
import { buildCreationRoutingRequest, type DeckRoutingInput } from "../ai/creation-routing.ts";
import { buildCreationAdjustmentRequest, type CreationAdjustmentInput } from "../ai/creation-adjustment.ts";
import type { CreationGenerationEvent } from "../ai/creation-generation.ts";
import { classificationSchema, generatedNoteSchemaFor } from "../ai/schemas.ts";
import { buildSystemPrompt } from "../ai/rule-packs.ts";
import { projectCompleteCards } from "../ai/complete-cards.ts";
import { unwrapDeckRoutingResponse } from "../ai/provider-schemas.ts";
import type { CreationCard } from "../creations/contracts.ts";
import type { GenerationInput } from "./ai-generation.ts";
import type { BackgroundProviderService } from "./background-provider.ts";
import { ProviderFailure } from "./errors.ts";

const CLASSIFY_PROMPT = `
You classify a single thing a learner wants to remember.

Decide whether it is a language-learning item — a word, phrase or grammatical
form in a language the learner is studying — or something else entirely, such
as a person, a scientific concept, a historical event or a quotation.

Set domain to "language" only for language-learning items. Otherwise use a
short lowercase label describing what it is: concept, person, place, event,
phrase, formula.

For language items set language to the target language code and partOfSpeech
to the word class. For everything else leave both null.
`.trim();

const feedbackFor = (issues: unknown) =>
  `Your previous response failed validation with these errors:\n${JSON.stringify(issues, null, 2)}\nReturn corrected JSON matching the schema exactly.`;

export const textProviderFailure = (operation: string, cause: unknown): ProviderFailure =>
  cause instanceof ProviderFailure ? cause : new ProviderFailure({
    provider: "ai", operation, message: cause instanceof Error ? cause.message : String(cause), cause,
  });

function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  return result.success ? { valid: true as const, value: result.data }
    : { valid: false as const, issues: result.error.issues };
}

function parseWithRetry<T>(schema: z.ZodType<T>, call: (feedback: string | null) => Effect.Effect<unknown, ProviderFailure>): Effect.Effect<T, ProviderFailure> {
  const attempt = (feedback: string | null) => call(feedback).pipe(
    Effect.map((value) => parse(schema, value)),
    Effect.catchAll((failure) => {
      const cause = failure.cause;
      if (typeof cause !== "object" || cause === null || !("code" in cause) || cause.code !== "structured-output-validation-failed") return Effect.fail(failure);
      const nested = "cause" in cause ? cause.cause : null;
      const issues = typeof nested === "object" && nested !== null && "issues" in nested
        ? nested.issues : [{ message: cause instanceof Error ? cause.message : "Invalid output" }];
      return Effect.succeed({ valid: false as const, issues });
    }),
  );
  return Effect.gen(function* () {
    const first = yield* attempt(null);
    if (first.valid) return first.value;
    const second = yield* attempt(feedbackFor(first.issues));
    if (second.valid) return second.value;
    return yield* Effect.fail(textProviderFailure("durable-text.validation", new Error(`Model output failed validation twice: ${JSON.stringify(second.issues)}`)));
  });
}

export function routeText(provider: BackgroundProviderService, input: DeckRoutingInput) {
  const request = buildCreationRoutingRequest(input);
  return parseWithRetry(request.schema, (feedback) => provider.route(request.prompts(feedback)).pipe(Effect.map(unwrapDeckRoutingResponse)));
}

export function adjustText(provider: BackgroundProviderService, input: CreationAdjustmentInput, nextKey: () => string) {
  const request = buildCreationAdjustmentRequest(input);
  return parseWithRetry(request.schema, (feedback) => provider.adjust(request.prompts(feedback))).pipe(
    Effect.map((result) => ({
      generationSummary: result.generationSummary,
      cards: result.cards.map((card) => ({ ...card, key: card.key ?? nextKey() })),
    })),
  );
}

/** Pull and validate the selected provider directly; false publication means the lease fence was lost. */
export function generateText<E>(
  provider: BackgroundProviderService,
  input: GenerationInput,
  nextKey: () => string,
  publish: (event: CreationGenerationEvent) => Effect.Effect<boolean, E>,
): Effect.Effect<void, E | ProviderFailure> {
  return Effect.gen(function* () {
    const aiInstructions = input.aiInstructions?.trim();
    const classification = yield* parseWithRetry(classificationSchema, (feedback) => provider.classify({
      system: CLASSIFY_PROMPT, user: feedback ? `${input.text}\n\n${feedback}` : input.text,
    }));
    if (!(yield* publish({ type: "classified", classification }))) return;
    const schema = generatedNoteSchemaFor(classification);
    let keyedCards: CreationCard[] = [];
    const keyCards = (cards: Array<Omit<CreationCard, "key">>) => {
      let commonPrefix = 0;
      while (commonPrefix < cards.length) {
        const left = cards[commonPrefix], right = keyedCards[commonPrefix];
        if (!right || left.aspect !== right.aspect || left.front !== right.front || left.back !== right.back || left.imageCue !== right.imageCue) break;
        commonPrefix++;
      }
      keyedCards = cards.map((card, index) => ({ key: index < commonPrefix ? keyedCards[index].key : nextKey(), ...card }));
      return keyedCards;
    };
    let feedback: string | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const prompts = {
        system: buildSystemPrompt(classification),
        user: [
          `Create flashcards for: ${input.text}`,
          `The learner's native language is ${input.nativeLanguage}.`,
          `Deck: ${input.deck.name}`,
          input.deck.description ? `Deck description: ${input.deck.description}` : "",
          `Learning goal: ${input.learningGoal}`,
          "Choose the smallest useful set of one to six cards that covers the essential applicable features within the learner's requested scope.",
          "Write the learner-facing side in their native language where that makes sense.",
          "Include a concise generationSummary that tells the learner what the card set covers.",
          "If a picture would help anchor this in memory, supply an imagePrompt describing the thing itself, with no text in the image. If a picture would not help, set imagePrompt to null.",
          aiInstructions ? `Learner's standing AI instructions:\n${aiInstructions}` : "",
          feedback ?? "",
        ].filter(Boolean).join("\n"),
      };
      let completed = false;
      const result = yield* Effect.acquireUseRelease(provider.generate(prompts), (pull) => Effect.gen(function* () {
        let raw = "", lastSnapshot = "[]", promptEmitted = false;
        while (true) {
          const step = yield* pull.next();
          if (step.done) {
            completed = true;
            const parsed = parse(schema, step.value);
            if (!parsed.valid) return { kind: "invalid" as const, issues: parsed.issues };
            const cards = projectCompleteCards(parsed.value, true);
            if (JSON.stringify(cards) !== lastSnapshot && !(yield* publish({ type: "cards", cards: keyCards(cards) }))) return { kind: "stale" as const };
            yield* publish({
              type: "done",
              classification,
              imagePrompt: parsed.value.imagePrompt,
              generationSummary: parsed.value.generationSummary,
              cards: keyCards(parsed.value.cards),
            });
            return { kind: "done" as const };
          }
          raw += step.value;
          const partial = parsePartialJSON(raw) as { imagePrompt?: unknown; cards?: unknown } | undefined;
          if (!promptEmitted && partial && "cards" in partial) {
            promptEmitted = true;
            if (!(yield* publish({ type: "image-prompt", prompt: typeof partial.imagePrompt === "string" && partial.imagePrompt ? partial.imagePrompt : null }))) return { kind: "stale" as const };
          }
          const cards = projectCompleteCards(partial, false);
          const snapshot = JSON.stringify(cards);
          if (snapshot !== lastSnapshot) {
            lastSnapshot = snapshot;
            if (!(yield* publish({ type: "cards", cards: keyCards(cards) }))) return { kind: "stale" as const };
          }
        }
      }), (pull) => !completed && pull.return
        ? pull.return().pipe(Effect.catchAll((error) => Effect.sync(() => console.error("creation generation stream cleanup failed", error))), Effect.asVoid)
        : Effect.void);
      if (result.kind !== "invalid") return;
      if (pass === 1) return yield* Effect.fail(textProviderFailure("durable-text.generate", new Error(`Model output failed validation twice: ${JSON.stringify(result.issues)}`)));
      keyedCards = [];
      if (!(yield* publish({ type: "retry" }))) return;
      feedback = feedbackFor(result.issues);
    }
  });
}
