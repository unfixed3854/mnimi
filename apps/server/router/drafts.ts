import * as z from "zod";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { Effect } from "effect";
import {
  assertOwnsDeck,
  authed,
  notFound,
  requireAiDependency,
  runDetachedWorkflow,
  runRouter,
  runWorkflow,
  runWorkflowStream,
} from "./base.ts";
import type { AuthedContext } from "./base.ts";
import { decks, drafts, user } from "../db/schema.ts";
import type { Draft } from "../db/schema.ts";
import { withWriteLock } from "../db/write-lock.ts";
import {
  claimDraftImage,
  removeDraftImage,
  removeImage,
  writeDraftImage,
} from "../images.ts";
import {
  abortJob,
  reconcileDraft,
  startGenerationJob,
  startImageJob,
  subscribe,
} from "../ai/jobs.ts";
import type { JobDeps } from "../ai/jobs.ts";
import {
  BASIC_CARD_NEEDS_BACK,
  cardHasAnAnswer,
  clozeMarkupIsWellFormed,
  IMAGE_CUE_NEEDS_HINT,
  IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
  imageCueHasFallback,
  imageCuesMatchContext,
  MALFORMED_CLOZE,
} from "../ai/card-rules.ts";
import {
  legacyStatus,
  toCreationDetail,
  toCreationSummary,
} from "../creations/contracts.ts";
import type { CreationSummary } from "../creations/contracts.ts";
import {
  cancelCreationImage,
  retryCreationImage,
} from "../creations/image-scheduler.ts";
import type { CreationEventsService } from "../effect/creation-events.ts";
import { Application } from "../effect/application.ts";
import { Conflict, DatabaseFailure, InfrastructureFailure, NotFound, Validation } from "../effect/errors.ts";
import { toOrpcError } from "../effect/transport.ts";
import { saveCreation } from "./creation-save.ts";

/** Every seam a job needs, resolved from the context so a test can replace
 *  any of them and nothing ever reaches a model or the disk. */
function jobDeps(context: AuthedContext): JobDeps {
  return {
    db: context.db,
    modelCalls: requireAiDependency(context.modelCalls),
    generateImageBytes: requireAiDependency(context.generateImageBytes),
    writeDraftImage: context.writeDraftImage ?? writeDraftImage,
    claimDraftImage: context.claimDraftImage ?? claimDraftImage,
    removeImage: context.removeImage ?? removeImage,
    removeDraftImage: context.removeDraftImage ?? removeDraftImage,
  };
}

/** Reads this user's draft by id, or reports it missing. Ownership is checked
 *  here and nowhere else, so no procedure can forget it. */
async function ownDraft(
  context: AuthedContext,
  draftId: string,
): Promise<Draft> {
  const [draft] = await context.db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, context.userId)))
    .limit(1);
  if (!draft) throw notFound("Draft not found");
  return draft;
}

function ownDraftEffect(
  db: AuthedContext["db"],
  userId: string,
  draftId: string,
): Effect.Effect<Draft, RouterDatabaseError> {
  return Effect.flatMap(
    databaseEffect("drafts.find", () => db.select().from(drafts).where(and(
      eq(drafts.id, draftId),
      eq(drafts.userId, userId),
    )).limit(1)),
    ([draft]) => draft
      ? Effect.succeed(draft)
      : Effect.fail(new NotFound({
        message: "Draft not found",
      })),
  );
}

const draftCardSchema = z.object({
  aspect: z.string().min(1),
  front: z.string(),
  back: z.string().nullable(),
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

const creationCardSchema = z.object({
  key: z.string().min(1),
  aspect: z.string().min(1),
  front: z.string().min(1),
  back: z.string().nullable(),
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

const GROUP_PRIORITY = {
  needsChoice: 0,
  ready: 1,
  creating: 2,
  queued: 3,
  failed: 4,
} as const;

type RouterDatabaseError =
  | Conflict
  | DatabaseFailure
  | InfrastructureFailure
  | NotFound
  | Validation;

const databaseEffect = <A>(operation: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => cause instanceof Conflict ||
        cause instanceof NotFound ||
        cause instanceof Validation ||
        cause instanceof InfrastructureFailure
      ? cause
      : new DatabaseFailure({ operation, cause }),
  });

function creationInbox(
  db: AuthedContext["db"],
  userId: string,
): Effect.Effect<CreationSummary[], RouterDatabaseError> {
  return databaseEffect("drafts.list", () => db.select({
    creation: drafts,
    deckName: decks.name,
  }).from(drafts).leftJoin(decks, eq(drafts.deckId, decks.id)).where(and(
    eq(drafts.userId, userId),
    ne(drafts.status, "removed"),
  )).orderBy(desc(drafts.updatedAt), desc(drafts.id))).pipe(Effect.map((rows) => rows
    .map(({ creation, deckName }) => toCreationSummary(creation, deckName))
    .filter((summary): summary is CreationSummary => summary !== null)
    .sort((left, right) =>
      GROUP_PRIORITY[left.group] - GROUP_PRIORITY[right.group] ||
      right.updatedAt.getTime() - left.updatedAt.getTime() ||
      right.id.localeCompare(left.id)
    )));
}

function creationDetailEffect(
  db: AuthedContext["db"],
  userId: string,
  creationId: string,
) {
  return Effect.flatMap(ownDraftEffect(db, userId, creationId), (creation) => {
    const deckIds = [
      creation.deckId,
      ...(creation.routing?.kind === "ambiguous"
        ? creation.routing.candidates.map((candidate) => candidate.deckId)
        : []),
    ].filter((deckId): deckId is string => deckId !== null);
    if (deckIds.length === 0) return Effect.succeed(toCreationDetail(creation, null));
    return Effect.map(
      databaseEffect("drafts.get-detail-decks", () => db.select({
        id: decks.id,
        name: decks.name,
        description: decks.description,
      }).from(decks).where(and(
        eq(decks.userId, userId),
        inArray(decks.id, deckIds),
      ))),
      (detailDecks) => toCreationDetail(
        creation,
        creation.deckId
          ? detailDecks.find((deck) => deck.id === creation.deckId) ?? null
          : null,
        new Map(detailDecks.map((deck) => [deck.id, deck.name])),
      ),
    );
  });
}

function creationEvents(context: AuthedContext): CreationEventsService {
  const events = context.workflows?.events ?? context.events;
  if (!events) {
    throw new InfrastructureFailure({
      operation: "router.creation-events",
      message: "Creation event service is not configured",
    });
  }
  return events;
}

function publishCreationChangeEffect(
  context: AuthedContext,
  creationId: string,
  attemptId: string | null = null,
): Effect.Effect<void, RouterDatabaseError, Application> {
  return Effect.gen(function* () {
    const { database } = yield* Application;
    const [creation] = yield* databaseEffect("drafts.publish-change", () =>
      database.db.select().from(drafts).where(and(
        eq(drafts.id, creationId),
        eq(drafts.userId, context.userId),
      )).limit(1));
    if (creation) {
      yield* creationEvents(context).publish(
        creation,
        attemptId ?? creation.activeAttemptId,
      );
    } else {
      yield* creationEvents(context).publishInbox(
        context.userId,
        creationId,
        attemptId,
      );
    }
  });
}

async function publishCreationChange(
  context: AuthedContext,
  creationId: string,
  attemptId: string | null = null,
): Promise<void> {
  await runRouter(
    context,
    publishCreationChangeEffect(context, creationId, attemptId),
  );
}

function kickText(context: AuthedContext): void {
  if (context.workflows) {
    void runDetachedWorkflow(context, context.workflows.kickText(context.userId)).catch(
      (error) => console.error("creation scheduler failed", error),
    );
    return;
  }
}

function revisionConflict(): never {
  throw new Conflict({
    message: "This creation changed. Refresh and try again.",
  });
}

const list = authed.input(z.object({})).handler(({ context }) =>
  runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    return yield* creationInbox(database.db, context.userId);
  })));

const get = authed
  .input(z.object({ creationId: z.uuidv7() }))
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    return yield* creationDetailEffect(
      database.db,
      context.userId,
      input.creationId,
    );
  })));

const save = authed.input(z.object({
  creationId: z.uuidv7(),
  expectedRevision: z.int().min(0),
  saveRequestId: z.string().trim().min(1).max(200),
})).handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
  const result = yield* saveCreation(context, input);
  yield* publishCreationChangeEffect(context, input.creationId);
  return result;
})));

const submit = authed.input(z.object({
  clientRequestId: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(2_000),
})).handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
  const { database } = yield* Application;
  const creation = yield* database.withWriteLock(
    "drafts.submit",
    databaseEffect("drafts.submit", async () => {
      const [existing] = await database.db.select().from(drafts).where(and(
        eq(drafts.userId, context.userId),
        eq(drafts.clientRequestId, input.clientRequestId),
      )).limit(1);
      if (existing) return existing;
      const [inserted] = await database.db.insert(drafts).values({
        userId: context.userId,
        clientRequestId: input.clientRequestId,
        sourceText: input.text,
        status: "queued",
        operation: "route_generate",
      }).returning();
      return inserted;
    }),
  );
  yield* Effect.sync(() => kickText(context));
  yield* publishCreationChangeEffect(context, creation.id);
  return {
    creationId: creation.id,
    clientRequestId: creation.clientRequestId,
    status: creation.status,
  };
})));

const watchInbox = authed.input(z.object({})).handler(({ context }) =>
  runWorkflowStream(
    context,
    creationEvents(context).subscribeInbox(context.userId),
    async (event) => {
      const inbox = await runRouter(context, Effect.gen(function* () {
        const { database } = yield* Application;
        return yield* creationInbox(database.db, context.userId);
      }));
      return {
        type: "snapshot" as const,
        creations: inbox,
        changedCreationId: event.changedCreationId,
        attemptId: event.attemptId,
      };
    },
  ));

const current = authed.handler(({ context }) => runRouter(context, Effect.gen(function* () {
  const { database } = yield* Application;
  const [draft] = yield* databaseEffect("drafts.current", () => database.db
    .select()
    .from(drafts)
    .where(and(
      eq(drafts.userId, context.userId),
      ne(drafts.status, "needs_choice"),
      ne(drafts.status, "removed"),
    ))
    .orderBy(asc(drafts.createdAt), asc(drafts.id))
    .limit(1));
  if (!draft) return null;
  const status = legacyStatus(draft.status);
  return status ? { ...draft, status } : null;
})));

const start = authed
  .input(
    z.object({
      deckId: z.uuidv7(),
      text: z.string().min(1).max(200),
  }),
  )
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database } = yield* Application;
    const [deck] = yield* databaseEffect("drafts.start.find-deck", () => database.db
      .select({ id: decks.id })
      .from(decks)
      .where(and(eq(decks.id, input.deckId), eq(decks.userId, context.userId)))
      .limit(1));
    if (!deck) return yield* Effect.fail(new NotFound({ message: "Deck not found" }));
    // Keep dependency failure ahead of the insert: a missing provider must
    // never leave a draft that no worker can complete.
    const deps = context.workflows ? undefined : jobDeps(context);
    // The generation prompt needs it and the client must not be able to
    // choose it, so it comes from the row rather than from the input.
    const [owner] = yield* databaseEffect("drafts.start.find-user", () => database.db
      .select({ nativeLanguage: user.nativeLanguage })
      .from(user)
      .where(eq(user.id, context.userId))
      .limit(1));

    // Check-then-insert inside ONE locked section, so two concurrent starts
    // serialise here rather than racing to the unique index. The index is
    // still the real guarantee; this is what turns a violation into a clean
    // CONFLICT instead of a driver error string.
    const draft = yield* database.withWriteLock(
      "drafts.start",
      databaseEffect("drafts.start", async () => {
      const [existing] = await database.db
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(
          eq(drafts.userId, context.userId),
          ne(drafts.status, "needs_choice"),
          ne(drafts.status, "removed"),
        ))
        .limit(1);
      if (existing) {
        throw new Conflict({
          message: "You already have a draft in progress",
        });
      }

      const [inserted] = await database.db
        .insert(drafts)
        .values({
          userId: context.userId,
          deckId: input.deckId,
          sourceText: input.text,
          status: "generating",
          operation: "generate",
          learningGoal: input.text,
        })
        .returning();
      return inserted;
      }),
    );

    // Deliberately not awaited: the job outliving this request is the whole
    // feature. Its own `catch` records the failure on the row, so there is
    // nothing here that could be lost by letting it run.
    yield* Effect.sync(() => {
      if (context.workflows) {
        void runDetachedWorkflow(
          context,
          context.workflows.legacy.startGeneration(
            draft,
            owner?.nativeLanguage ?? "en",
          ),
        ).catch((error) => console.error("draft generation failed", error));
      } else {
        void startGenerationJob(
          deps!,
          draft,
          owner?.nativeLanguage ?? "en",
        );
      }
    });

    return { draftId: draft.id };
  })));

const resolveDeck = authed.input(z.object({
  creationId: z.uuidv7(),
  expectedRevision: z.int().min(0),
  deckId: z.uuidv7(),
})).handler(async ({ input, context }) => {
  const result = await withWriteLock(() =>
    context.db.transaction(async (tx) => {
      const [creation] = await tx.select().from(drafts).where(and(
        eq(drafts.id, input.creationId),
        eq(drafts.userId, context.userId),
      )).limit(1);
      if (!creation) throw notFound("Creation not found");
      if (creation.revision !== input.expectedRevision) revisionConflict();
      const routing = creation.routing;
      if (creation.status !== "needs_choice" || !routing ||
        routing.kind === "matched") revisionConflict();
      const candidate = routing.kind === "ambiguous"
        ? routing.candidates.find((option) => option.deckId === input.deckId)
        : undefined;
      const [deck] = await tx.select({ id: decks.id, name: decks.name }).from(decks).where(and(
        eq(decks.id, input.deckId),
        eq(decks.userId, context.userId),
      )).limit(1);
      const now = new Date();
      if (!deck) {
        if (!candidate) throw notFound("Deck not found");
        const [rerouted] = await tx.update(drafts).set({
          deckId: null,
          learningGoal: null,
          routing: null,
          status: "queued",
          operation: "route_generate",
          queuedAt: now,
          revision: creation.revision + 1,
          errorCategory: null,
          errorStage: null,
          error: null,
          updatedAt: now,
        }).where(and(
          eq(drafts.id, creation.id),
          eq(drafts.userId, context.userId),
          eq(drafts.revision, input.expectedRevision),
        )).returning();
        return {
          creationId: rerouted.id,
          status: rerouted.status,
          revision: rerouted.revision,
          rerouting: true as const,
        };
      }
      const [updated] = await tx.update(drafts).set({
        deckId: deck.id,
        learningGoal: routing.kind === "newDeck"
          ? routing.learningGoal
          : candidate?.learningGoal ??
            `Create useful cards for this request in the ${deck.name} deck.`,
        routing: null,
        status: "queued",
        operation: "generate",
        queuedAt: now,
        revision: creation.revision + 1,
        errorCategory: null,
        errorStage: null,
        error: null,
        updatedAt: now,
      }).where(and(
        eq(drafts.id, creation.id),
        eq(drafts.userId, context.userId),
        eq(drafts.revision, input.expectedRevision),
      )).returning();
      return {
        creationId: updated.id,
        status: updated.status,
        revision: updated.revision,
        rerouting: false as const,
      };
    })
  );
  kickText(context);
  await publishCreationChange(context, result.creationId);
  return result;
});

const confirmNewDeck = authed.input(z.object({
  creationId: z.uuidv7(),
  expectedRevision: z.int().min(0),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable(),
})).handler(async ({ input, context }) => {
  const result = await withWriteLock(() =>
    context.db.transaction(async (tx) => {
      const [creation] = await tx.select().from(drafts).where(and(
        eq(drafts.id, input.creationId),
        eq(drafts.userId, context.userId),
      )).limit(1);
      if (!creation) throw notFound("Creation not found");
      if (creation.revision !== input.expectedRevision ||
        creation.status !== "needs_choice" ||
        creation.routing?.kind !== "newDeck") revisionConflict();
      const [deck] = await tx.insert(decks).values({
        userId: context.userId,
        name: input.name,
        description: input.description || null,
      }).returning();
      const now = new Date();
      const [updated] = await tx.update(drafts).set({
        deckId: deck.id,
        learningGoal: creation.routing.learningGoal,
        routing: null,
        status: "queued",
        operation: "generate",
        queuedAt: now,
        revision: creation.revision + 1,
        errorCategory: null,
        errorStage: null,
        error: null,
        updatedAt: now,
      }).where(and(
        eq(drafts.id, creation.id),
        eq(drafts.userId, context.userId),
        eq(drafts.revision, input.expectedRevision),
      )).returning();
      if (!updated) revisionConflict();
      return { creationId: updated.id, deckId: deck.id, status: updated.status };
    })
  );
  kickText(context);
  await publishCreationChange(context, result.creationId);
  return result;
});

const retry = authed.input(z.object({
  creationId: z.uuidv7(),
  stage: z.enum(["routing", "cards"]),
})).handler(async ({ input, context }) => {
  const [updated] = await withWriteLock(async () => {
    const [creation] = await context.db.select().from(drafts).where(and(
      eq(drafts.id, input.creationId),
      eq(drafts.userId, context.userId),
    )).limit(1);
    if (!creation) throw notFound("Creation not found");
    if (creation.status !== "failed" &&
      !(input.stage === "routing" && creation.status === "needs_choice")) {
      revisionConflict();
    }
    const now = new Date();
    const operation = input.stage === "routing"
      ? "route_generate"
      : creation.adjustmentInstruction
      ? "adjust"
      : creation.targetDeckId
      ? "regenerate"
      : "retry";
    return await context.db.update(drafts).set({
      status: "queued",
      operation,
      ...(input.stage === "routing"
        ? { deckId: null, learningGoal: null, routing: null }
        : {}),
      activeAttemptId: null,
      attemptCards: [],
      leaseOwner: null,
      leaseExpiresAt: null,
      queuedAt: now,
      errorCategory: null,
      errorStage: null,
      error: null,
      revision: creation.revision + 1,
      updatedAt: now,
    }).where(and(
      eq(drafts.id, creation.id),
      eq(drafts.userId, context.userId),
      eq(drafts.revision, creation.revision),
    )).returning();
  });
  if (!updated) revisionConflict();
  kickText(context);
  await publishCreationChange(context, updated.id);
  return { creationId: updated.id, status: updated.status };
});

const cancel = authed.input(z.object({
  creationId: z.uuidv7(),
  expectedRevision: z.int().min(0),
})).handler(async ({ input, context }) => {
  const now = new Date();
  const undoUntil = new Date(now.getTime() + 10_000);
  const [updated] = await withWriteLock(() =>
    context.db.update(drafts).set({
      status: "removed",
      activeAttemptId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      removedAt: now,
      undoUntil,
      revision: input.expectedRevision + 1,
      updatedAt: now,
    }).where(and(
      eq(drafts.id, input.creationId),
      eq(drafts.userId, context.userId),
      eq(drafts.revision, input.expectedRevision),
      ne(drafts.status, "ready"),
      ne(drafts.status, "removed"),
      isNotNull(drafts.operation),
    )).returning()
  );
  if (!updated) revisionConflict();
  if (updated.imageAttemptId) {
    if (context.workflows) {
      await runWorkflow(context, context.workflows.images.cancel({
        creationId: updated.id,
        userId: context.userId,
        imageAttemptId: updated.imageAttemptId,
      }));
    } else {
      await cancelCreationImage(context.db, {
        creationId: updated.id,
        userId: context.userId,
        imageAttemptId: updated.imageAttemptId,
      }, { removeDraftImage: context.removeDraftImage ?? removeDraftImage });
    }
  }
  kickText(context);
  await publishCreationChange(context, updated.id);
  return { creationId: updated.id, undoUntil };
});

const restore = authed.input(z.object({ creationId: z.uuidv7() }))
  .handler(async ({ input, context }) => {
    const now = new Date();
    const [restored] = await withWriteLock(async () => {
      const [creation] = await context.db.select().from(drafts).where(and(
        eq(drafts.id, input.creationId),
        eq(drafts.userId, context.userId),
      )).limit(1);
      if (!creation) throw notFound("Creation not found");
      if (creation.status !== "removed" || !creation.undoUntil ||
        creation.undoUntil.getTime() < now.getTime()) revisionConflict();
      return await context.db.update(drafts).set({
        status: "queued",
        removedAt: null,
        undoUntil: null,
        errorCategory: null,
        errorStage: null,
        error: null,
        revision: creation.revision + 1,
        updatedAt: now,
      }).where(and(
        eq(drafts.id, creation.id),
        eq(drafts.userId, context.userId),
        eq(drafts.revision, creation.revision),
        eq(drafts.status, "removed"),
      )).returning();
    });
    if (!restored) revisionConflict();
    kickText(context);
    await publishCreationChange(context, restored.id);
    return { creationId: restored.id, status: restored.status };
  });

const adjust = authed.input(z.object({
  creationId: z.uuidv7(),
  expectedRevision: z.int().min(0),
  instruction: z.string().trim().min(1).max(500),
})).handler(async ({ input, context }) => {
  const [updated] = await withWriteLock(async () => {
    const [creation] = await context.db.select().from(drafts).where(and(
      eq(drafts.id, input.creationId),
      eq(drafts.userId, context.userId),
    )).limit(1);
    if (!creation) throw notFound("Creation not found");
    if (creation.revision !== input.expectedRevision ||
      (creation.status !== "ready" && creation.status !== "failed") ||
      creation.cards.length === 0 || !creation.deckId ||
      !creation.learningGoal || !creation.classification) revisionConflict();
    const now = new Date();
    return await context.db.update(drafts).set({
      status: "queued",
      operation: "adjust",
      adjustmentInstruction: input.instruction,
      targetDeckId: null,
      targetLearningGoal: null,
      activeAttemptId: null,
      attemptCards: [],
      leaseOwner: null,
      leaseExpiresAt: null,
      queuedAt: now,
      errorCategory: null,
      errorStage: null,
      error: null,
      revision: creation.revision + 1,
      updatedAt: now,
    }).where(and(
      eq(drafts.id, creation.id),
      eq(drafts.userId, context.userId),
      eq(drafts.revision, input.expectedRevision),
    )).returning();
  });
  if (!updated) revisionConflict();
  kickText(context);
  await publishCreationChange(context, updated.id);
  return {
    creationId: updated.id,
    status: updated.status,
    revision: updated.revision,
  };
});

const cancelAdjustment = authed.input(z.object({
  creationId: z.uuidv7(),
  expectedRevision: z.int().min(0),
})).handler(async ({ input, context }) => {
  const [updated] = await withWriteLock(async () => {
    const [creation] = await context.db.select().from(drafts).where(and(
      eq(drafts.id, input.creationId),
      eq(drafts.userId, context.userId),
    )).limit(1);
    if (!creation) throw notFound("Creation not found");
    const isReplacement = creation.operation === "adjust" ||
      creation.operation === "regenerate" ||
      creation.adjustmentInstruction !== null || creation.targetDeckId !== null;
    const isReplacementState = creation.status === "queued" ||
      creation.status === "adjusting" || creation.status === "regenerating" ||
      creation.status === "failed";
    if (creation.revision !== input.expectedRevision || !isReplacement ||
      !isReplacementState || creation.cards.length === 0) revisionConflict();
    const now = new Date();
    return await context.db.update(drafts).set({
      status: "ready",
      operation: null,
      activeAttemptId: null,
      attemptCards: [],
      adjustmentInstruction: null,
      targetDeckId: null,
      targetLearningGoal: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCategory: null,
      errorStage: null,
      error: null,
      revision: creation.revision + 1,
      updatedAt: now,
    }).where(and(
      eq(drafts.id, creation.id),
      eq(drafts.userId, context.userId),
      eq(drafts.revision, input.expectedRevision),
      creation.activeAttemptId
        ? eq(drafts.activeAttemptId, creation.activeAttemptId)
        : isNull(drafts.activeAttemptId),
    )).returning();
  });
  if (!updated) revisionConflict();
  kickText(context);
  await publishCreationChange(context, updated.id);
  return {
    creationId: updated.id,
    status: updated.status,
    revision: updated.revision,
  };
});

const undoAdjustment = authed.input(z.object({
  creationId: z.uuidv7(),
  expectedRevision: z.int().min(0),
})).handler(async ({ input, context }) => {
  const [creation] = await context.db.select().from(drafts).where(and(
    eq(drafts.id, input.creationId),
    eq(drafts.userId, context.userId),
  )).limit(1);
  if (!creation) throw notFound("Creation not found");
  if (creation.revision !== input.expectedRevision ||
    creation.status !== "ready" || !creation.undoCards) revisionConflict();
  const [updated] = await withWriteLock(() =>
    context.db.update(drafts).set({
      cards: creation.undoCards!,
      undoCards: null,
      generationSummary: creation.undoGenerationSummary,
      undoGenerationSummary: null,
      revision: creation.revision + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(drafts.id, creation.id),
      eq(drafts.userId, context.userId),
      eq(drafts.revision, input.expectedRevision),
      eq(drafts.status, "ready"),
      isNotNull(drafts.undoCards),
    )).returning()
  );
  if (!updated) revisionConflict();
  await publishCreationChange(context, updated.id);
  return { creationId: updated.id, revision: updated.revision };
});

const changeDeck = authed.input(z.object({
  creationId: z.uuidv7(),
  expectedRevision: z.int().min(0),
  deckId: z.uuidv7(),
})).handler(async ({ input, context }) => {
  const [updated] = await withWriteLock(() =>
    context.db.transaction(async (tx) => {
      const [creation] = await tx.select().from(drafts).where(and(
        eq(drafts.id, input.creationId),
        eq(drafts.userId, context.userId),
      )).limit(1);
      if (!creation) throw notFound("Creation not found");
      if (creation.revision !== input.expectedRevision ||
        (creation.status !== "ready" && creation.status !== "failed") ||
        creation.cards.length === 0 || !creation.deckId) revisionConflict();
      const [target] = await tx.select({
        id: decks.id,
        name: decks.name,
      }).from(decks).where(and(
        eq(decks.id, input.deckId),
        eq(decks.userId, context.userId),
      )).limit(1);
      if (!target) throw notFound("Deck not found");
      if (target.id === creation.deckId) {
        throw new Validation({
          message: "Choose a different deck to regenerate these cards.",
          issues: [],
        });
      }
      const now = new Date();
      return await tx.update(drafts).set({
        status: "queued",
        operation: "regenerate",
        targetDeckId: target.id,
        targetLearningGoal:
          `Create useful cards for this request in the ${target.name} deck.`,
        adjustmentInstruction: null,
        activeAttemptId: null,
        attemptCards: [],
        leaseOwner: null,
        leaseExpiresAt: null,
        queuedAt: now,
        errorCategory: null,
        errorStage: null,
        error: null,
        revision: creation.revision + 1,
        updatedAt: now,
      }).where(and(
        eq(drafts.id, creation.id),
        eq(drafts.userId, context.userId),
        eq(drafts.revision, input.expectedRevision),
      )).returning();
    })
  );
  if (!updated) revisionConflict();
  kickText(context);
  await publishCreationChange(context, updated.id);
  return {
    creationId: updated.id,
    status: updated.status,
    revision: updated.revision,
  };
});

async function* watchLegacyDraft(
  context: AuthedContext,
  draftId: string,
) {
  try {
    const draft = await ownDraft(context, draftId);

    // The lookup is inside `subscribe`, so there is no window between
    // "is there a job?" and "attach to it".
    if (context.workflows) {
      const subscription = await runWorkflow(
        context,
        context.workflows.legacy.openSubscription(draft.id),
      );
      if (subscription) {
        try {
          yield { type: "snapshot" as const, draft: subscription.snapshot };
          yield* subscription.events;
        } finally {
          await runWorkflow(context, subscription.close);
        }
        return;
      }
    } else {
      const live = subscribe(draft.id);
      if (live) {
        yield* live;
        return;
      }
    }

    // No job. Either the generation settled — in which case the row is the
    // whole truth — or the process restarted underneath it.
    yield {
      type: "snapshot" as const,
      draft: await reconcileDraft(context.db, draft),
    };
  } catch (cause) {
    throw toOrpcError(cause);
  }
}

const watch = authed
  .input(z.union([
    z.object({ creationId: z.uuidv7() }),
    z.object({ draftId: z.uuidv7() }),
  ]))
  .handler(({ input, context }) => {
    if ("creationId" in input) {
      return runWorkflowStream(
        context,
        creationEvents(context).subscribeDetail(
          context.userId,
          input.creationId,
        ),
        async (event) => {
          if (!event.creation) throw notFound("Creation not found");
          return {
            type: "snapshot" as const,
            creationId: event.creationId,
            attemptId: event.attemptId,
            revision: event.revision,
            creation: await runRouter(context, Effect.gen(function* () {
              const { database } = yield* Application;
              return yield* creationDetailEffect(
                database.db,
                context.userId,
                event.creationId,
              );
            })),
          };
        },
        () => runRouter(context, Effect.gen(function* () {
          const { database } = yield* Application;
          return yield* ownDraftEffect(database.db, context.userId, input.creationId);
        })),
      );
    }
    return watchLegacyDraft(context, input.draftId);
  });

const update = authed
  .input(
    z.union([
      z.object({
        creationId: z.uuidv7(),
        expectedRevision: z.int().min(0),
        cards: z.array(creationCardSchema).min(1).max(6),
      }),
      z.object({
        draftId: z.uuidv7(),
        deckId: z.uuidv7().optional(),
        cards: z.array(draftCardSchema).optional(),
      }).refine(
        (input) => input.deckId !== undefined || input.cards !== undefined,
        { message: "Provide at least one of deckId or cards to update" },
      ),
    ]),
  )
  .handler(async ({ input, context }) => {
    if ("creationId" in input) {
      const [creation] = await context.db.select().from(drafts).where(and(
        eq(drafts.id, input.creationId),
        eq(drafts.userId, context.userId),
      )).limit(1);
      if (!creation) throw notFound("Creation not found");
      if (creation.revision !== input.expectedRevision ||
        (creation.status !== "ready" && creation.status !== "failed")) {
        revisionConflict();
      }
      if (!imageCuesMatchContext(
        input.cards,
        creation.classification?.domain ?? "concept",
        creation.imagePrompt,
      )) {
        throw new Validation({
          message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
          issues: [],
        });
      }
      const [updated] = await withWriteLock(() =>
        context.db.update(drafts).set({
          cards: input.cards,
          undoCards: null,
          undoGenerationSummary: null,
          adjustmentInstruction: null,
          targetDeckId: null,
          targetLearningGoal: null,
          revision: creation.revision + 1,
          updatedAt: new Date(),
        }).where(and(
          eq(drafts.id, creation.id),
          eq(drafts.userId, context.userId),
          eq(drafts.revision, input.expectedRevision),
        )).returning()
      );
      if (!updated) revisionConflict();
      await publishCreationChange(context, updated.id);
      return { ok: true, revision: updated.revision };
    }
    const draft = await ownDraft(context, input.draftId);
    if (draft.status === "generating") {
      // The job owns `cards` until it is done; a write here would be
      // overwritten by the next snapshot without anyone noticing.
      throw new Conflict({
        message: "This draft is still generating",
      });
    }
    if (input.deckId) {
      await assertOwnsDeck(context.db, context.userId, input.deckId);
    }
    if (
      input.cards &&
      !imageCuesMatchContext(
        input.cards,
        draft.classification?.domain ?? "concept",
        draft.imagePrompt,
      )
    ) {
      throw new Validation({
          message: IMAGE_CUE_NEEDS_LANGUAGE_IMAGE,
          issues: [],
      });
    }

    await withWriteLock(() =>
      context.db
        .update(drafts)
        .set({
          ...(input.deckId ? { deckId: input.deckId } : {}),
          ...(input.cards ? { cards: input.cards } : {}),
        })
        .where(eq(drafts.id, draft.id))
    );

    return { ok: true };
  });

const discard = authed
  .input(z.union([
    z.object({
      creationId: z.uuidv7(),
      expectedRevision: z.int().min(0),
    }),
    z.object({ draftId: z.uuidv7() }),
  ]))
  .handler(async ({ input, context }) => {
    if ("creationId" in input) {
      const [deleted] = await withWriteLock(() =>
        context.db.delete(drafts).where(and(
          eq(drafts.id, input.creationId),
          eq(drafts.userId, context.userId),
          eq(drafts.revision, input.expectedRevision),
        )).returning()
      );
      if (!deleted) revisionConflict();
      if (deleted.draftImageId) {
        await (context.removeDraftImage ?? removeDraftImage)(
          context.userId,
          deleted.draftImageId,
        );
      }
      await publishCreationChange(context, input.creationId);
      return { ok: true };
    }
    const draft = await ownDraft(context, input.draftId);

    // Abort first: a stage that settles after the row is gone takes the
    // "discarded" branch and deletes its own file, which is what keeps a
    // discard-during-generation from orphaning bytes.
    if (context.workflows) {
      await runWorkflow(context, context.workflows.legacy.abortJob(draft.id));
    } else {
      abortJob(draft.id);
    }

    // The image id comes from the DELETE's own `returning()`, not from the
    // snapshot read above: an image settle landing in the gap between that
    // read and this delete can write `draftImageId` onto the row, and a
    // pre-delete snapshot would still show it null, silently skipping
    // `removeDraftImage` and orphaning the file.
    const [deleted] = await withWriteLock(() =>
      context.db.delete(drafts).where(eq(drafts.id, draft.id)).returning()
    );

    if (deleted?.draftImageId) {
      await (context.removeDraftImage ?? removeDraftImage)(
        context.userId,
        deleted.draftImageId,
      );
    }

    return { ok: true };
  });

const retryImage = authed
  .input(z.union([
    z.object({ creationId: z.uuidv7() }),
    z.object({ draftId: z.uuidv7() }),
  ]))
  .handler(async ({ input, context }) => {
    if ("creationId" in input) {
      await ownDraft(context, input.creationId);
      const imageAttemptId = context.workflows
        ? await runWorkflow(context, context.workflows.images.retry({
          creationId: input.creationId,
          userId: context.userId,
        }))
        : await retryCreationImage(context.db, {
          creationId: input.creationId,
          userId: context.userId,
        }, { removeDraftImage: context.removeDraftImage ?? removeDraftImage });
      await publishCreationChange(context, input.creationId);
      return { ok: true, imageAttemptId };
    }
    const draft = await ownDraft(context, input.draftId);
    if (draft.status === "generating") {
      // The cards job still owns `imagePrompt` until it reaches `done`: a
      // model retry can replace the prompt, and `done`'s safety net can start
      // a stage of its own. Regenerating from the half-settled prompt now
      // would be regenerating from a string the row is about to disagree
      // with, which is the same reason `update` refuses in this window.
      //
      // Note this is NOT a guard against attaching to a live job. Attaching
      // is the supported path — the spec's §4.1 defines a retry as bumping
      // `imageAttempt` on the stage that is running, and `startImageJob`'s
      // attach branch re-arms `imageStatus` precisely so a save can still
      // retarget it. What makes that safe is the claim the attach branch takes
      // on `job.pendingStages` synchronously, in the same block as the lookup
      // that found the job: `drainImageStages` waits on that claim as well as
      // on the stages already pushed, so the job stays registered across the
      // `patch` between the two and cannot be torn down under an attempt that
      // has not started yet.
      throw new Conflict({
        message: "This draft is still generating",
      });
    }
    if (!draft.imagePrompt) {
      throw new Conflict({
        message: "This draft has no picture to generate",
      });
    }

    if (context.workflows) {
      void runDetachedWorkflow(context, context.workflows.legacy.startImage(draft)).catch(
        (error) => console.error("draft image generation failed", error),
      );
    } else {
      void startImageJob(jobDeps(context), draft);
    }
    return { ok: true };
  });

export const draftsRouter = {
  list,
  get,
  submit,
  save,
  watchInbox,
  current,
  start,
  watch,
  resolveDeck,
  confirmNewDeck,
  update,
  retry,
  cancel,
  restore,
  adjust,
  cancelAdjustment,
  undoAdjustment,
  changeDeck,
  discard,
  retryImage,
};
