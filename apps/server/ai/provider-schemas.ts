import { z } from "zod";
import {
  deckRoutingOutcomeSchema,
  newDeckRoutingOutcomeSchema,
} from "./creation-routing.ts";

const proposedDeckRoutingOutcomeSchema = newDeckRoutingOutcomeSchema.extend({
  kind: z.literal("proposed"),
});

export const deckRoutingResponseSchema = z.object({
  outcome: z.union([
    ...deckRoutingOutcomeSchema.options,
    proposedDeckRoutingOutcomeSchema,
  ]),
});

export function unwrapDeckRoutingResponse(response: unknown): unknown {
  if (!response || typeof response !== "object" || !("outcome" in response)) {
    return response;
  }
  const outcome = (response as { outcome: unknown }).outcome;
  if (!outcome || typeof outcome !== "object") return outcome;
  if ((outcome as { kind?: unknown }).kind !== "proposed") return outcome;
  const { kind: _kind, ...proposal } = outcome as Record<string, unknown>;
  return { kind: "newDeck", ...proposal };
}
