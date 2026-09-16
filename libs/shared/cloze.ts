/**
 * Anki-compatible cloze markup, shared by the server (which validates it and
 * derives `cards.card_type` from it) and the browser (which renders it).
 *
 * Pure logic with zero dependencies on purpose: this module is type-checked by
 * `bun run shared:check`, where no DOM or React types
 * exist, so a UI import fails CI as a type error rather than as a review note.
 */

/** One deletion, split into the parts a renderer needs. */
export type ClozeSegments = {
  before: string;
  answer: string;
  hint: string | null;
  after: string;
};

/** `.*?` rather than `[^}]*` so an answer may contain a lone `}`; the lazy
 *  quantifier stops at the first `}}`. There is deliberately no escape
 *  mechanism — a sentence containing a literal `::` or `}}` is unsupported,
 *  and `parseCloze` rejects it rather than mis-parsing it. */
const DELETION = /\{\{c\d+::(.*?)\}\}/g;

/** Cheap test for "the author was trying to write a deletion". Callers pair
 *  this with `parseCloze` to tell malformed markup apart from plain text:
 *  markup present but unparseable is an error, markup absent is a basic card. */
export function hasClozeMarkup(text: string): boolean {
  return text.includes("{{");
}

/**
 * Strict parse. Returns segments for exactly one well-formed deletion, or
 * `null` for anything else — no markup, malformed markup, two deletions, or an
 * empty answer. `null` is not an error by itself; it means "not a cloze card".
 */
export function parseCloze(text: string): ClozeSegments | null {
  const matches = [...text.matchAll(DELETION)];
  if (matches.length !== 1) return null;

  const [match] = matches;
  if (match[1].includes("{{") || match[1].includes("}}")) return null;
  const parts = match[1].split("::");
  if (parts.length > 2) return null;

  const answer = parts[0];
  if (answer.trim() === "") return null;

  const hint = parts[1]?.trim() ? parts[1] : null;
  const start = match.index ?? 0;
  const before = text.slice(0, start);
  const after = text.slice(start + match[0].length);
  if (
    before.includes("{{") || before.includes("}}") ||
    after.includes("{{") || after.includes("}}")
  ) return null;

  return {
    before,
    answer,
    hint,
    after,
  };
}

export function revealCloze(text: string): string | null {
  const segments = parseCloze(text);
  return segments
    ? `${segments.before}${segments.answer}${segments.after}`
    : null;
}

/**
 * Lenient companion for text still streaming from the model. Drops a trailing
 * deletion that has been opened but not yet closed, so a half-arrived
 * `Ich mag {{c1::Ban` renders as `Ich mag ` instead of flashing brace noise
 * across the streaming list on every delta.
 */
export function stripPartialCloze(text: string): string {
  const open = text.lastIndexOf("{{");
  if (open === -1) return text;
  if (text.includes("}}", open)) return text;
  return text.slice(0, open);
}
