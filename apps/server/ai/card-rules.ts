import { hasClozeMarkup, parseCloze } from "@mnimi/shared";

/**
 * What "a well-formed card" means, defined once.
 *
 * Two schemas enforce these rules on the same shape from opposite directions —
 * `generatedCardSchema` on what the model returns, `saveNoteInput` on what the
 * client sends — and the messages are user-visible in one case and fed back to
 * the model as correction feedback in the other. Writing them twice would let
 * the two drift into disagreeing about what is legal.
 */
export type CardShape = { front: string; back: string | null };
export type ImageCueCardShape = CardShape & { imageCue: boolean };

export const MALFORMED_CLOZE =
  "Malformed cloze deletion. Write exactly one {{c1::answer}} or " +
  "{{c1::answer::hint}} per card, with a non-empty answer.";

export const BASIC_CARD_NEEDS_BACK =
  "A card with no cloze deletion needs a back.";
export const IMAGE_CUE_NEEDS_HINT =
  "An image-cued card requires one cloze with a native-language fallback hint.";

export const IMAGE_CUE_NEEDS_LANGUAGE_IMAGE =
  "Image cues require a language note with a non-empty image prompt.";

/** Markup that was started must be finished. Text with no braces at all is a
 *  basic card and passes trivially. */
export function clozeMarkupIsWellFormed(card: CardShape): boolean {
  return !hasClozeMarkup(card.front) || parseCloze(card.front) !== null;
}

/** A cloze card's answer is inside its front; a basic card's is its back. A
 *  card with neither has no answer at all. */
export function cardHasAnAnswer(card: CardShape): boolean {
  return parseCloze(card.front) !== null || Boolean(card.back?.trim());
}

export function imageCueHasFallback(card: ImageCueCardShape): boolean {
  if (!card.imageCue) return true;
  return parseCloze(card.front)?.hint != null;
}

export function imageCuesMatchContext(
  cards: ImageCueCardShape[],
  domain: string,
  imagePrompt: string | null,
): boolean {
  return !cards.some((card) => card.imageCue) ||
    (domain === "language" && imagePrompt !== null);
}
