export type ClozeSegments = {
  before: string;
  answer: string;
  hint: string | null;
  after: string;
};

export type TextRange = { start: number; end: number };

export type EditableCloze = {
  sentence: string;
  answerRange: TextRange | null;
  hint: string;
};

const deletion = /\{\{c\d+::(.*?)\}\}/g;

/** Native copy of the shared pure parser, kept Expo-resolvable without server imports. */
export function parseCloze(text: string): ClozeSegments | null {
  const matches = [...text.matchAll(deletion)];
  if (matches.length !== 1) return null;
  const [match] = matches;
  if (match[1].includes("{{") || match[1].includes("}}")) return null;
  const parts = match[1].split("::");
  if (parts.length > 2 || parts[0].trim() === "") return null;
  const start = match.index ?? 0;
  const before = text.slice(0, start);
  const after = text.slice(start + match[0].length);
  if (
    before.includes("{{") || before.includes("}}") || after.includes("{{") ||
    after.includes("}}")
  ) return null;
  return {
    before,
    answer: parts[0],
    hint: parts[1]?.trim() ? parts[1] : null,
    after,
  };
}

export function parseEditableCloze(front: string): EditableCloze | null {
  const parsed = parseCloze(front);
  if (!parsed) return null;
  return {
    sentence: `${parsed.before}${parsed.answer}${parsed.after}`,
    answerRange: {
      start: parsed.before.length,
      end: parsed.before.length + parsed.answer.length,
    },
    hint: parsed.hint ?? "",
  };
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  ) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(
  left: string,
  right: string,
  prefix: number,
): number {
  let count = 0;
  while (
    count < left.length - prefix &&
    count < right.length - prefix &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

export function updateEditableClozeSentence(
  current: EditableCloze,
  sentence: string,
): EditableCloze {
  const range = current.answerRange;
  if (!range) return { ...current, sentence };
  const prefix = commonPrefixLength(current.sentence, sentence);
  const suffix = commonSuffixLength(current.sentence, sentence, prefix);
  const oldChangeEnd = current.sentence.length - suffix;
  const delta = sentence.length - current.sentence.length;
  if (oldChangeEnd <= range.start) {
    return {
      ...current,
      sentence,
      answerRange: { start: range.start + delta, end: range.end + delta },
    };
  }
  if (prefix >= range.end) return { ...current, sentence };
  return { ...current, sentence, answerRange: null };
}

export function serializeEditableCloze(model: EditableCloze): string | null {
  const range = model.answerRange;
  if (
    !range ||
    range.start < 0 ||
    range.end > model.sentence.length ||
    range.start >= range.end
  ) {
    return null;
  }
  const before = model.sentence.slice(0, range.start);
  const answer = model.sentence.slice(range.start, range.end);
  const after = model.sentence.slice(range.end);
  const hint = model.hint.trim();
  if (
    !answer.trim() ||
    [before, answer, after, hint].some((part) =>
      part.includes("{{") || part.includes("}}") || part.includes("::")
    )
  ) {
    return null;
  }
  return `${before}{{c1::${answer}${hint ? `::${hint}` : ""}}}${after}`;
}
