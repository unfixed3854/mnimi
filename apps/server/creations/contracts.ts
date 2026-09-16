import { generatedCardSchema } from "../ai/schemas.ts";
import type {
  DraftCard,
  DraftClassification,
  DraftErrorCategory,
  DraftErrorStage,
  DraftImageStatus,
  DraftRoutingOutcome,
  DraftStatus,
} from "../db/schema.ts";

export type CreationCard = {
  key: string;
  aspect: string;
  front: string;
  back: string | null;
  imageCue: boolean;
};

export type CreationGroup =
  | "needsChoice"
  | "ready"
  | "creating"
  | "queued"
  | "failed";

export type CreationSummary = {
  id: string;
  clientRequestId: string;
  sourceText: string;
  deckName: string | null;
  group: CreationGroup;
  stateLabel: string;
  thumbnailId: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

type ProjectionRow = {
  id: string;
  clientRequestId: string;
  sourceText: string;
  status: DraftStatus;
  operation?: string | null;
  revision: number;
  activeAttemptId: string | null;
  deckId: string | null;
  learningGoal: string | null;
  routing: DraftRoutingOutcome | null;
  classification: DraftClassification | null;
  cards: DraftCard[];
  attemptCards: DraftCard[];
  undoCards: DraftCard[] | null;
  generationSummary: string | null;
  imagePrompt: string | null;
  imageStatus: DraftImageStatus;
  draftImageId: string | null;
  errorCategory: DraftErrorCategory | null;
  errorStage: DraftErrorStage | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreationDetail = {
  id: string;
  clientRequestId: string;
  sourceText: string;
  status: DraftStatus;
  activity: "adjusting" | "regenerating" | null;
  revision: number;
  attemptId: string | null;
  deck: { id: string; name: string; description: string | null } | null;
  learningGoal: string | null;
  routing: CreationRouting | null;
  cards: CreationCard[];
  attemptCards: CreationCard[];
  undoAvailable: boolean;
  generationSummary: string | null;
  imagePrompt: string | null;
  imageCueAllowed: boolean;
  imageStatus: DraftImageStatus;
  draftImageId: string | null;
  errorCategory: DraftErrorCategory | null;
  errorStage: DraftErrorStage | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreationRouting =
  | { kind: "matched"; deckId: string; learningGoal: string }
  | {
    kind: "ambiguous";
    candidates: Array<{
      deckId: string;
      deckName: string;
      learningGoal: string;
    }>;
  }
  | {
    kind: "newDeck";
    proposedName: string;
    proposedDescription: string;
    learningGoal: string;
  };

const SAFE_ERROR_COPY: Record<DraftErrorCategory, string> = {
  interrupted: "Creation was interrupted. Try again.",
  routing_failed: "We couldn't choose a deck. Try again.",
  generation_failed: "We couldn't create these cards. Try again.",
  validation_failed: "These cards need another try.",
  image_failed: "We couldn't create the image. You can retry it.",
};

function creationError(row: ProjectionRow): string | null {
  return (row.errorCategory ? SAFE_ERROR_COPY[row.errorCategory] : null) ??
    (row.status === "failed" ? SAFE_ERROR_COPY.generation_failed : null);
}

export function normalizeStoredCards(
  _creationId: string,
  cards: DraftCard[],
): CreationCard[] {
  const normalized: CreationCard[] = [];
  for (const [index, card] of cards.entries()) {
    const parsed = generatedCardSchema.safeParse(card);
    if (!parsed.success) break;
    normalized.push({
      key: card.key?.trim() || `legacy-${index}`,
      ...parsed.data,
    });
  }
  return normalized;
}

const SUMMARY_STATE: Record<Exclude<DraftStatus, "removed">, {
  group: CreationGroup;
  stateLabel: string;
}> = {
  needs_choice: { group: "needsChoice", stateLabel: "Needs your choice" },
  ready: { group: "ready", stateLabel: "Ready to review" },
  routing: { group: "creating", stateLabel: "Creating" },
  generating: { group: "creating", stateLabel: "Creating" },
  adjusting: { group: "creating", stateLabel: "Creating" },
  regenerating: { group: "creating", stateLabel: "Creating" },
  queued: { group: "queued", stateLabel: "Queued" },
  failed: { group: "failed", stateLabel: "Needs attention" },
};

export function toCreationSummary(
  row: ProjectionRow,
  deckName: string | null,
): CreationSummary | null {
  if (row.status === "removed") return null;
  const state = SUMMARY_STATE[row.status];
  return {
    id: row.id,
    clientRequestId: row.clientRequestId,
    sourceText: row.sourceText,
    deckName,
    ...state,
    stateLabel: row.status === "failed" ? creationError(row)! : state.stateLabel,
    thumbnailId: row.imageStatus === "ready" ? row.draftImageId : null,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCreationDetail(
  row: ProjectionRow,
  deck: { id: string; name: string; description: string | null } | null,
  candidateDeckNames: ReadonlyMap<string, string> = new Map(),
): CreationDetail {
  return {
    id: row.id,
    clientRequestId: row.clientRequestId,
    sourceText: row.sourceText,
    status: row.status,
    activity: row.status === "adjusting" || row.operation === "adjust"
      ? "adjusting"
      : row.status === "regenerating" || row.operation === "regenerate"
      ? "regenerating"
      : null,
    revision: row.revision,
    attemptId: row.activeAttemptId,
    deck,
    learningGoal: row.learningGoal,
    routing: row.routing?.kind === "ambiguous"
      ? {
        kind: "ambiguous",
        candidates: row.routing.candidates.flatMap((candidate) => {
          const deckName = candidateDeckNames.get(candidate.deckId);
          return deckName ? [{ ...candidate, deckName }] : [];
        }),
      }
      : row.routing,
    cards: normalizeStoredCards(row.id, row.cards),
    attemptCards: normalizeStoredCards(row.id, row.attemptCards),
    undoAvailable: row.undoCards !== null,
    generationSummary: row.generationSummary,
    imagePrompt: row.imagePrompt,
    imageCueAllowed: row.classification?.domain === "language" &&
      Boolean(row.imagePrompt),
    imageStatus: row.imageStatus,
    draftImageId: row.draftImageId,
    errorCategory: row.errorCategory,
    errorStage: row.errorStage,
    error: creationError(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function actionableCreationCount(
  summaries: CreationSummary[],
): number {
  return summaries.filter((summary) =>
    summary.group === "needsChoice" || summary.group === "ready" ||
    summary.group === "failed"
  ).length;
}

export function legacyStatus(
  status: DraftStatus,
): "generating" | "ready" | "failed" | null {
  if (status === "ready" || status === "failed") return status;
  if (status === "needs_choice" || status === "removed") return null;
  return "generating";
}
