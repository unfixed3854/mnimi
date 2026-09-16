import { Cause, Context, Effect, Layer, Option, Runtime } from "effect";
import { parsePartialJSON } from "@tanstack/ai";
import type { z } from "zod";
import { buildSystemPrompt } from "../ai/rule-packs.ts";
import { classificationSchema, generatedNoteSchemaFor } from "../ai/schemas.ts";
import type {
  Classification,
  GeneratedCard,
  GeneratedNote,
  PartialCard,
} from "../ai/schemas.ts";
import { projectCompleteCards } from "../ai/complete-cards.ts";

export type GenerationInput = {
  text: string;
  nativeLanguage: string;
  aiInstructions?: string;
  deck: { id: string; name: string; description: string | null };
  learningGoal: string;
};

export type ModelPrompts = { system: string; user: string };

export type ModelCalls = {
  classify(prompts: ModelPrompts): Promise<unknown>;
  generate(prompts: ModelPrompts): AsyncGenerator<string, unknown>;
};

/**
 * A pull-based async iterator whose individual operations are Effects. This
 * keeps a lazy async generator behind the Effect boundary: its next step (and
 * optional early cleanup) is not run until the returned Effect is executed.
 */
export type EffectPull<Yield, Return = unknown, Error = unknown> = Readonly<{
  next(value?: unknown): Effect.Effect<IteratorResult<Yield, Return>, Error>;
  return?(value?: unknown): Effect.Effect<IteratorResult<Yield, Return>, Error>;
}>;

export function makeEffectPull<Yield, Return, Error = unknown>(
  source: AsyncIterator<Yield, Return>,
  mapError: (cause: unknown) => Error = (cause) => cause as Error,
): EffectPull<Yield, Return, Error> {
  const next = (value?: unknown) => Effect.tryPromise({
    try: () => source.next(value),
    catch: mapError,
  });

  const cleanup = source.return === undefined
    ? undefined
    : (value?: unknown) => Effect.tryPromise({
      try: () => source.return!(value as Return),
      catch: mapError,
    });

  return cleanup === undefined ? { next } : { next, return: cleanup };
}

export type GenerationEvent =
  | { type: "classified"; classification: Classification }
  | { type: "image-prompt"; prompt: string | null }
  | { type: "cards"; cards: GeneratedCard[] }
  | { type: "retry" }
  | { type: "done"; classification: Classification; generation: GeneratedNote };

export type StreamProgress = { type: "partial"; raw: string } | { type: "retry" };

export type AiGenerationService = Readonly<{
  parseWithRetry<T>(
    schema: z.ZodType<T>,
    attempt: (feedback: string | null) => Promise<unknown>,
  ): Effect.Effect<T, unknown>;
  streamWithRetry<T>(
    schema: z.ZodType<T>,
    attempt: (feedback: string | null) => AsyncGenerator<string, unknown>,
  ): Effect.Effect<EffectPull<StreamProgress, T>, unknown>;
  generateNote(
    input: GenerationInput,
    models: ModelCalls,
  ): Effect.Effect<EffectPull<GenerationEvent, void>, unknown>;
  projectCards(parsed: unknown): PartialCard[];
}>;

export class AiGeneration extends Context.Tag("@mnimi/server/AiGeneration")<
  AiGeneration,
  AiGenerationService
>() {}

function validationFeedback(issues: unknown): string {
  return (
    `Your previous response failed validation with these errors:\n` +
    JSON.stringify(issues, null, 2) +
    `\nReturn corrected JSON matching the schema exactly.`
  );
}

function structuredOutputValidationIssues(error: unknown): unknown | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "structured-output-validation-failed"
  ) {
    return null;
  }

  const cause = "cause" in error ? error.cause : null;
  if (typeof cause === "object" && cause !== null && "issues" in cause) {
    return cause.issues;
  }
  return [{ message: error instanceof Error ? error.message : "Invalid output" }];
}

async function validatedAttempt<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null) => Promise<unknown>,
  feedback: string | null,
): Promise<{ success: true; data: T } | { success: false; issues: unknown }> {
  try {
    const result = schema.safeParse(await attempt(feedback));
    return result.success
      ? { success: true, data: result.data }
      : { success: false, issues: result.error.issues };
  } catch (error) {
    const issues = structuredOutputValidationIssues(error);
    if (issues === null) throw error;
    return { success: false, issues };
  }
}

async function parseWithRetryImpl<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null) => Promise<unknown>,
): Promise<T> {
  const first = await validatedAttempt(schema, attempt, null);
  if (first.success) return first.data;

  const second = await validatedAttempt(
    schema,
    attempt,
    validationFeedback(first.issues),
  );
  if (second.success) return second.data;

  throw new Error(
    `Model output failed validation twice: ${JSON.stringify(second.issues)}`,
  );
}

async function* streamWithRetryImpl<T>(
  schema: z.ZodType<T>,
  attempt: (feedback: string | null) => AsyncGenerator<string, unknown>,
): AsyncGenerator<StreamProgress, T> {
  async function* run(
    feedback: string | null,
  ): AsyncGenerator<StreamProgress, unknown> {
    let raw = "";
    const deltas = attempt(feedback);
    let completed = false;
    let primaryFailure = false;
    try {
      let step: IteratorResult<string, unknown>;
      try {
        step = await deltas.next();
      } catch (cause) {
        primaryFailure = true;
        throw cause;
      }
      while (!step.done) {
        raw += step.value;
        yield { type: "partial", raw };
        try {
          step = await deltas.next();
        } catch (cause) {
          primaryFailure = true;
          throw cause;
        }
      }
      completed = true;
      return step.value;
    } finally {
      if (!completed && deltas.return !== undefined) {
        try {
          await deltas.return(undefined);
        } catch (cause) {
          if (!primaryFailure) throw cause;
        }
      }
    }
  }

  const first = schema.safeParse(yield* run(null));
  if (first.success) return first.data;

  yield { type: "retry" };

  const second = schema.safeParse(
    yield* run(validationFeedback(first.error.issues)),
  );
  if (second.success) return second.data;

  throw new Error(
    `Model output failed validation twice: ${JSON.stringify(second.error.issues)}`,
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function projectCardsImpl(parsed: unknown): PartialCard[] {
  const cards = (parsed as { cards?: unknown } | undefined)?.cards;
  if (!Array.isArray(cards)) return [];

  return cards.map((card) => ({
    aspect: stringOrNull(card?.aspect),
    front: stringOrNull(card?.front),
    back: stringOrNull(card?.back),
    imageCue: booleanOrNull(card?.imageCue),
  }));
}

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

function generateMessage(input: GenerationInput, feedback: string | null): string {
  const aiInstructions = input.aiInstructions?.trim();
  return [
    `Create flashcards for: ${input.text}`,
    `The learner's native language is ${input.nativeLanguage}.`,
    `Deck: ${input.deck.name}`,
    input.deck.description ? `Deck description: ${input.deck.description}` : "",
    `Learning goal: ${input.learningGoal}`,
    `Choose the smallest useful set of one to six cards that covers the essential applicable features within the learner's requested scope.`,
    `Write the learner-facing side in their native language where that makes sense.`,
    `If a picture would help anchor this in memory, supply an imagePrompt describing the thing itself, with no text in the image. If a picture would not help, set imagePrompt to null.`,
    aiInstructions ? `Learner's standing AI instructions:\n${aiInstructions}` : "",
    feedback ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function generateNoteImpl(
  input: GenerationInput,
  models: ModelCalls,
): AsyncGenerator<GenerationEvent> {
  return (async function* () {
    const classification = await parseWithRetryImpl(
      classificationSchema,
      (feedback) =>
        models.classify({
          system: CLASSIFY_PROMPT,
          user: feedback ? `${input.text}\n\n${feedback}` : input.text,
        }),
    );
    yield { type: "classified", classification };

    const system = buildSystemPrompt(classification);
    const stream = streamWithRetryImpl(
      generatedNoteSchemaFor(classification),
      (feedback) =>
        models.generate({ system, user: generateMessage(input, feedback) }),
    );

    let completed = false;
    try {
      let lastSnapshot = "[]";
      let promptEmitted = false;
      let step = await stream.next();
      while (!step.done) {
        if (step.value.type === "retry") {
          lastSnapshot = "[]";
          promptEmitted = false;
          yield { type: "retry" };
        } else {
          const parsed = parsePartialJSON(step.value.raw) as
            | { imagePrompt?: unknown; cards?: unknown }
            | undefined;

          if (!promptEmitted && parsed && "cards" in parsed) {
            promptEmitted = true;
            const prompt =
              typeof parsed.imagePrompt === "string" && parsed.imagePrompt
                ? parsed.imagePrompt
                : null;
            yield { type: "image-prompt", prompt };
          }

          const cards = projectCompleteCards(parsed, false);
          const snapshot = JSON.stringify(cards);
          if (snapshot !== lastSnapshot) {
            lastSnapshot = snapshot;
            yield { type: "cards", cards };
          }
        }
        step = await stream.next();
      }

      const completedCards = projectCompleteCards(step.value, true);
      const completedSnapshot = JSON.stringify(completedCards);
      if (completedSnapshot !== lastSnapshot) {
        yield { type: "cards", cards: completedCards };
      }
      yield { type: "done", classification, generation: step.value };
      completed = true;
    } finally {
      if (!completed && stream.return !== undefined) {
        await stream.return(undefined as never);
      }
    }
  })();
}

export function makeAiGeneration(): AiGenerationService {
  return {
    parseWithRetry: (schema, attempt) =>
      Effect.tryPromise({
        try: () => parseWithRetryImpl(schema, attempt),
        catch: (cause) => cause,
      }),
    streamWithRetry: (schema, attempt) =>
      Effect.succeed(makeEffectPull(streamWithRetryImpl(schema, attempt))),
    generateNote: (input, models) =>
      Effect.succeed(makeEffectPull(generateNoteImpl(input, models))),
    projectCards: projectCardsImpl,
  };
}

export const AiGenerationLive: Layer.Layer<AiGeneration> = Layer.succeed(
  AiGeneration,
  makeAiGeneration(),
);

export const makeAiGenerationLayer = (): Layer.Layer<AiGeneration> =>
  AiGenerationLive;

export type GenerationPromiseFacade = Readonly<{
  parseWithRetry<T>(
    schema: z.ZodType<T>,
    attempt: (feedback: string | null) => Promise<unknown>,
  ): Promise<T>;
  streamWithRetry<T>(
    schema: z.ZodType<T>,
    attempt: (feedback: string | null) => AsyncGenerator<string, unknown>,
  ): AsyncGenerator<StreamProgress, T>;
  generateNote(input: GenerationInput, models: ModelCalls): AsyncGenerator<GenerationEvent>;
  projectCards(parsed: unknown): PartialCard[];
}>;

export function runGenerationPromise<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> {
  return Effect.runPromise(effect).catch((error: unknown) => {
    if (Runtime.isFiberFailure(error)) {
      const failure = Cause.failureOption(error[Runtime.FiberFailureCauseId]);
      if (Option.isSome(failure)) throw failure.value;
    }
    throw error;
  });
}

type EffectRunner<Error> = <A>(effect: Effect.Effect<A, Error>) => Promise<A>;

export async function* pullToAsyncGenerator<Yield, Return, Error>(
  pull: EffectPull<Yield, Return, Error>,
  run: EffectRunner<Error>,
): AsyncGenerator<Yield, Return> {
  let completed = false;
  let primaryFailure = false;
  try {
    const next = async () => {
      try {
        return await run(pull.next());
      } catch (cause) {
        primaryFailure = true;
        throw cause;
      }
    };
    let step = await next();
    while (!step.done) {
      yield step.value;
      step = await next();
    }
    completed = true;
    return step.value;
  } finally {
    if (!completed && pull.return !== undefined) {
      try {
        await run(pull.return());
      } catch (cause) {
        if (!primaryFailure) throw cause;
      }
    }
  }
}

export function makeGenerationPromiseFacade(
  service: AiGenerationService = makeAiGeneration(),
): GenerationPromiseFacade {
  return {
    parseWithRetry: (schema, attempt) =>
      runGenerationPromise(service.parseWithRetry(schema, attempt)),
    streamWithRetry: (schema, attempt) =>
      (async function* () {
        const pull = await runGenerationPromise(service.streamWithRetry(schema, attempt));
        return yield* pullToAsyncGenerator(pull, runGenerationPromise);
      })(),
    generateNote: (input, models) =>
      (async function* () {
        const pull = await runGenerationPromise(service.generateNote(input, models));
        return yield* pullToAsyncGenerator(pull, runGenerationPromise);
      })(),
    projectCards: service.projectCards,
  };
}
