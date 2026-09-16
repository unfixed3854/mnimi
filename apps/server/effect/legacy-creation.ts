import { Effect, Fiber } from "effect";
import { eq } from "drizzle-orm";
import { parsePartialJSON } from "@tanstack/ai";
import { buildSystemPrompt } from "../ai/rule-packs.ts";
import { classificationSchema, generatedNoteSchemaFor } from "../ai/schemas.ts";
import type { GeneratedCard, GeneratedNote } from "../ai/schemas.ts";
import { projectCompleteCards } from "../ai/complete-cards.ts";
import { decks, drafts } from "../db/schema.ts";
import type { Draft } from "../db/schema.ts";
import type { Db } from "../db/index.ts";
import { withWriteLock } from "../db/write-lock.ts";
import type { DraftEvent } from "../ai/jobs.ts";
import type { EffectPull, ModelPrompts } from "./ai-generation.ts";
import type { BackgroundProviderService } from "./background-provider.ts";
import { DatabaseFailure } from "./errors.ts";
import { makeLegacyJobs, type LegacyJobDependencies } from "./legacy-jobs.ts";

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

export type LegacyCreationInput = Readonly<{
  draft: Draft;
  nativeLanguage: string;
  publish: (event: DraftEvent) => Effect.Effect<void, unknown>;
  isAborted?: () => boolean;
  /** Keeps the legacy in-memory watch snapshot aligned with persisted work. */
  updateSnapshot?: (draft: Draft) => Effect.Effect<void, unknown>;
  /** Refreshes independently progressing image state before merging text changes. */
  currentSnapshot?: () => Draft;
  /** Compatibility hook for explicit-dependency callers without MediaStore. */
  startImage?: (draft: Draft, prompt: string) => Effect.Effect<void, unknown>;
  /** Invalidates an image attempt when generated cards need a validation retry. */
  retryImage?: () => Effect.Effect<void, unknown>;
}>;

export type LegacyCreationWorkflowService = ReturnType<typeof makeLegacyJobs> & Readonly<{
  run(input: LegacyCreationInput): Effect.Effect<void, unknown>;
}>;

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

function generatedMessage(
  input: Pick<LegacyCreationInput, "draft" | "nativeLanguage">,
  deck: { name: string; description: string | null },
  feedback: string | null,
): string {
  return [
    `Create flashcards for: ${input.draft.sourceText}`,
    `The learner's native language is ${input.nativeLanguage}.`,
    `Deck: ${deck.name}`,
    deck.description ? `Deck description: ${deck.description}` : "",
    `Learning goal: ${input.draft.sourceText}`,
    `Choose the smallest useful set of one to six cards that covers the essential applicable features within the learner's requested scope.`,
    `Write the learner-facing side in their native language where that makes sense.`,
    `Include a concise generationSummary that tells the learner what the card set covers.`,
    `If a picture would help anchor this in memory, supply an imagePrompt describing the thing itself, with no text in the image. If a picture would not help, set imagePrompt to null.`,
    feedback ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function databaseEffect<A>(
  operation: string,
  work: () => Promise<A>,
): Effect.Effect<A, DatabaseFailure> {
  return Effect.tryPromise({
    try: work,
    catch: (cause) => new DatabaseFailure({ operation, cause }),
  });
}

type Parsed<T> = { readonly valid: true; readonly value: T } |
  { readonly valid: false; readonly issues: unknown };

function parseResult<T>(value: unknown, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } } }): Parsed<T> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { valid: true, value: parsed.data }
    : { valid: false, issues: parsed.error.issues };
}

function classifyWithRetry(
  provider: BackgroundProviderService,
  text: string,
): Effect.Effect<ReturnType<typeof classificationSchema.parse>, unknown> {
  const attempt = (feedback: string | null) => provider.classify({
    system: CLASSIFY_PROMPT,
    user: feedback ? `${text}\n\n${feedback}` : text,
  }).pipe(
    Effect.map((value) => parseResult(value, classificationSchema)),
    Effect.catchAll((failure) => {
      const issues = structuredOutputValidationIssues(failure.cause);
      return issues === null
        ? Effect.fail(failure)
        : Effect.succeed({ valid: false as const, issues });
    }),
  );
  return Effect.flatMap(attempt(null), (first) => {
    return first.valid
      ? Effect.succeed(first.value)
      : Effect.flatMap(attempt(validationFeedback(first.issues)), (second) => {
        return second.valid
          ? Effect.succeed(second.value)
          : Effect.fail(new Error(
            `Model output failed validation twice: ${JSON.stringify(second.issues)}`,
          ));
      });
  });
}

type StreamResult =
  | { readonly complete: true; readonly generation: GeneratedNote }
  | { readonly complete: false; readonly aborted: true }
  | { readonly complete: false; readonly aborted: false; readonly issues: unknown };

type LegacyEventPublisher = (event: DraftEvent) => Effect.Effect<void, unknown>;

function consumeGenerationAttempt(
  pull: EffectPull<string, unknown, unknown>,
  schema: ReturnType<typeof generatedNoteSchemaFor>,
  input: Pick<LegacyCreationInput, "isAborted">,
  publish: LegacyEventPublisher,
): Effect.Effect<StreamResult, unknown> {
  return Effect.suspend(() => {
    let raw = "";
    let lastSnapshot = "[]";
    let promptEmitted = false;
    let completed = false;

    const consume = (): Effect.Effect<StreamResult, unknown> => Effect.flatMap(
      pull.next(),
      (step) => {
        if (input.isAborted?.() === true) {
          return Effect.succeed({ complete: false, aborted: true });
        }
        if (step.done) {
          completed = true;
          const parsed = parseResult(step.value, schema);
          if (!parsed.valid) {
            return Effect.succeed({ complete: false, aborted: false, issues: parsed.issues });
          }
          const cards = projectCompleteCards(parsed.value, true);
          const snapshot = JSON.stringify(cards);
          const publishCards = snapshot === lastSnapshot
            ? Effect.void
            : publish({ type: "cards", cards });
          return Effect.as(publishCards, { complete: true, generation: parsed.value });
        }

        raw += step.value;
        const partial = parsePartialJSON(raw) as
          | { imagePrompt?: unknown; cards?: unknown }
          | undefined;
        const effects: Effect.Effect<void, unknown>[] = [];
        if (!promptEmitted && partial && "cards" in partial) {
          promptEmitted = true;
          const prompt = typeof partial.imagePrompt === "string" && partial.imagePrompt
            ? partial.imagePrompt
            : null;
          effects.push(publish({ type: "image-prompt", prompt }));
        }
        const cards = projectCompleteCards(partial, false);
        const snapshot = JSON.stringify(cards);
        if (snapshot !== lastSnapshot) {
          lastSnapshot = snapshot;
          effects.push(publish({ type: "cards", cards }));
        }
        return Effect.zipRight(Effect.all(effects), consume());
      },
    );

    const cleanup = () => Effect.suspend(() =>
      !completed && pull.return !== undefined
        ? pull.return(undefined).pipe(Effect.asVoid)
        : Effect.void
    );
    return Effect.matchEffect(consume(), {
      onFailure: (error) => Effect.zipRight(
        Effect.catchAll(cleanup(), () => Effect.void),
        Effect.fail(error),
      ),
      onSuccess: (result) => Effect.as(cleanup(), result),
    });
  });
}

function generateWithRetry(
  provider: BackgroundProviderService,
  prompts: ModelPrompts,
  input: LegacyCreationInput,
  schema: ReturnType<typeof generatedNoteSchemaFor>,
  publish: LegacyEventPublisher,
): Effect.Effect<GeneratedNote | null, unknown> {
  const attempt = (feedback: string | null) => Effect.flatMap(
    provider.generate({
      ...prompts,
      user: feedback ? `${prompts.user}\n\n${feedback}` : prompts.user,
    }),
    (pull) => consumeGenerationAttempt(pull, schema, input, publish),
  );
  return Effect.flatMap(attempt(null), (first) => {
    if (first.complete) return Effect.succeed(first.generation);
    if (first.aborted) return Effect.succeed(null);
    return Effect.zipRight(
      publish({ type: "retry" }),
      Effect.flatMap(attempt(validationFeedback(first.issues)), (second) =>
        second.complete
          ? Effect.succeed(second.generation)
          : second.aborted
          ? Effect.succeed(null)
          : Effect.fail(new Error(
            `Model output failed validation twice: ${JSON.stringify(second.issues)}`,
          )),
      ),
    );
  });
}

export function makeLegacyCreationWorkflow({
  db,
  provider,
  database,
  media,
}: Readonly<{
  db: Db;
  provider: BackgroundProviderService;
  database?: LegacyJobDependencies["database"];
  media?: LegacyJobDependencies["media"];
}>): LegacyCreationWorkflowService {
  const run = (input: LegacyCreationInput): Effect.Effect<void, unknown> => Effect.suspend(() => {
    let current = input.draft;
    const updateSnapshot = input.updateSnapshot ?? (() => Effect.void);
    const aborted = () => input.isAborted?.() === true;
    const persist = (values: Partial<Draft>) => Effect.zipRight(
      database
        ? database.withWriteLock("legacy-creation.persist", databaseEffect("legacy-creation.persist", () =>
          db.update(drafts).set(values).where(eq(drafts.id, current.id))))
        : databaseEffect("legacy-creation.persist", () => withWriteLock(() =>
          db.update(drafts).set(values).where(eq(drafts.id, current.id)))),
      Effect.sync(() => { current = { ...(input.currentSnapshot?.() ?? current), ...values }; }).pipe(
        Effect.zipRight(Effect.suspend(() => updateSnapshot(current))),
      ),
    );
    const remember = (values: Partial<Draft>) => Effect.sync(() => {
      current = { ...(input.currentSnapshot?.() ?? current), ...values };
    }).pipe(Effect.zipRight(Effect.suspend(() => updateSnapshot(current))));
    const publishProgress: LegacyEventPublisher = (event) => {
      switch (event.type) {
        case "image-prompt": {
          const values = {
            imagePrompt: event.prompt,
            imageStatus: event.prompt ? ("generating" as const) : ("none" as const),
          };
          return Effect.zipRight(
            persist(values),
            Effect.zipRight(
              input.publish(event),
              event.prompt
                ? input.startImage?.(current, event.prompt) ?? Effect.void
                : Effect.void,
            ),
          );
        }
        case "cards":
          return Effect.zipRight(remember({ cards: event.cards }), input.publish(event));
        case "retry":
          return Effect.zipRight(
            input.retryImage?.() ?? Effect.void,
            Effect.zipRight(remember({ cards: [] }), input.publish(event)),
          );
        default:
          return input.publish(event);
      }
    };

    const program = Effect.gen(function* () {
      if (aborted()) return;
      const deckId = current.deckId ??
        (yield* Effect.fail(new Error("Draft has no selected deck")));
      const [storedDeck] = yield* databaseEffect("legacy-creation.read-deck", () =>
        db.select({ id: decks.id, name: decks.name, description: decks.description })
          .from(decks)
          .where(eq(decks.id, deckId))
          .limit(1),
      );
      const deck = storedDeck ??
        (yield* Effect.fail(new Error("Draft deck no longer exists")));

      if (aborted()) return;
      const classification = yield* classifyWithRetry(provider, current.sourceText);
      if (aborted()) return;
      yield* persist({ classification });
      yield* input.publish({ type: "classified", classification });

      if (aborted()) return;
      const generation = yield* generateWithRetry(
        provider,
        {
          system: buildSystemPrompt(classification),
          user: generatedMessage(input, deck, null),
        },
        input,
        generatedNoteSchemaFor(classification),
        publishProgress,
      );
      if (generation === null || aborted()) return;

      yield* persist({
        status: "ready",
        classification,
        cards: generation.cards,
        generationSummary: generation.generationSummary,
        imagePrompt: generation.imagePrompt,
      });
      yield* input.publish({ type: "done", classification, generation });
      if (generation.imagePrompt && current.imageStatus === "none") {
        yield* persist({ imageStatus: "generating" });
        yield* input.startImage?.(current, generation.imagePrompt) ?? Effect.void;
      }
    });

    return program.pipe(Effect.catchAll((error) => {
      console.error("draft generation failed", error);
      if (aborted()) return Effect.void;
      const message = "Generation failed";
      return Effect.zipRight(
        persist({ status: "failed", error: message }),
        input.publish({ type: "failed", message }),
      );
    }));
  });

  const jobs = makeLegacyJobs({ database, media, provider, run });
  return { ...jobs, run: (input) => Effect.flatMap(jobs.start(input), Fiber.join) };
}
