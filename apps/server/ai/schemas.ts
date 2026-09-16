import { z } from "zod";

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

export const classificationSchema = z.object({
  /**
   * Open vocabulary. 'language' is the only value that changes behaviour;
   * everything else is descriptive and simply selects the base pack.
   */
  domain: z.string().min(1),
  /** BCP-47-ish target language code, null for non-language notes. */
  language: z.string().nullish().transform((v) => v ?? null),
  partOfSpeech: z.string().nullish().transform((v) => v ?? null),
});

export type Classification = z.infer<typeof classificationSchema>;

export const generatedCardSchema = z
  .object({
    aspect: z.string().min(1),
    front: z.string().min(1),
    // Nullable for cloze cards, whose answer is inside `front`. "" is
    // normalised to null here, at the parse boundary, so no downstream site
    // has to decide whether an empty string means "no meaning line".
    back: z.string().nullish().transform((v) => v || null),
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
  .refine(cardHasAnAnswer, { message: BASIC_CARD_NEEDS_BACK, path: ["back"] });

export const generatedNoteSchema = z.object({
  // `imagePrompt` first so the model emits it first: JSON keys arrive in
  // schema order, and the prompt is the input to a generation stage that runs
  // CONCURRENTLY with the cards. Emitting it first buys the whole
  // card-writing duration as image head start, for the ~20 tokens of prompt
  // the model writes before the first card.
  //
  // The 2026-07-30 spec ordered these the other way, correctly, when the
  // image was fired by the client after `done` and nothing could start early.
  //
  // "" is normalised to null here, at the boundary where the model's output
  // is parsed, so every downstream site agrees on what "no image wanted"
  // means. Leaving "" as a distinct legal value made a note with an empty
  // prompt permanently `imageFailed`, with no attempt ever made and no way
  // to clear it.
  imagePrompt: z.string().nullish().transform((v) => v || null),
  generationSummary: z.string().min(1).max(280).describe(
    "A concise learner-facing summary of what this card set covers.",
  ),
  cards: z.array(generatedCardSchema).min(1).max(6),
});

export type GeneratedCard = z.infer<typeof generatedCardSchema>;
export type GeneratedNote = z.infer<typeof generatedNoteSchema>;

export function generatedNoteSchemaFor(classification: Classification) {
  return generatedNoteSchema.refine(
    (note) =>
      imageCuesMatchContext(
        note.cards,
        classification.domain,
        note.imagePrompt,
      ),
    { message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE, path: ["cards"] },
  );
}

/**
 * A card mid-stream. Deliberately not a Zod schema: every field is null until
 * the model reaches it, so there is nothing yet to validate — validation
 * happens once, on the completed `GeneratedCard`. `apps/app/src/lib/api/ai.ts` gets
 * this exact type by re-exporting it from `~server/ai/schemas`, type-only, so
 * the declaration erases at build and no server module reaches the browser
 * bundle.
 */
export type PartialCard = {
  aspect: string | null;
  front: string | null;
  back: string | null;
  imageCue: boolean | null;
};
