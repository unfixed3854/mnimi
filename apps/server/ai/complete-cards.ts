import { generatedCardSchema } from "./schemas.ts";
import type { GeneratedCard } from "./schemas.ts";

export function projectCompleteCards(
  parsed: unknown,
  includeLast: boolean,
): GeneratedCard[] {
  const value = parsed as { cards?: unknown } | null | undefined;
  if (!Array.isArray(value?.cards)) return [];

  const candidates = includeLast ? value.cards : value.cards.slice(0, -1);
  const completed: GeneratedCard[] = [];
  for (const candidate of candidates) {
    const result = generatedCardSchema.safeParse(candidate);
    if (!result.success) break;
    completed.push(result.data);
  }
  return completed;
}
