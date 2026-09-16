import * as z from "zod";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { authed, runRouter } from "./base.ts";
import { notes } from "../db/schema.ts";
import { setNoteImageFailed } from "../images.ts";
import { Application } from "../effect/application.ts";
import { DatabaseFailure, NotFound } from "../effect/errors.ts";

const databaseEffect = <A>(operation: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new DatabaseFailure({ operation, cause }),
  });

const generateImageProcedure = authed
  .input(
    z.object({
      noteId: z.uuidv7(),
      prompt: z.string().min(1).max(1000),
    }),
  )
  .handler(({ input, context }) => runRouter(context, Effect.gen(function* () {
    const { database, media, provider } = yield* Application;
    // Existence and ownership BEFORE spending money. Without this, any
    // authenticated caller could POST random ids in a loop and bill a full
    // image generation for each one before the 404.
    const [note] = yield* databaseEffect("ai.find-note", () => database.db
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(eq(notes.id, input.noteId), eq(notes.userId, context.userId)),
      )
      .limit(1));
    if (!note) return yield* Effect.fail(new NotFound({ message: "Note not found" }));
    let bytes: Uint8Array;
    try {
      bytes = yield* provider.generateImageBytes(input.prompt);
    } catch (error) {
      yield* database.withWriteLock(
        "ai.mark-image-failed",
        databaseEffect("ai.mark-image-failed", () =>
          setNoteImageFailed(database.db, context.userId, input.noteId, true),
        ),
      );
      return yield* Effect.fail(error);
    }
    const imagePath = yield* media.writeImage(
      context.userId,
      input.noteId,
      bytes,
    );

    // Not a transaction, but it still needs the write lock: this is the update
    // `useSaveNote.onSuccess` fires, so it routinely lands while the user is
    // grading a card inside `cards.grade`'s transaction. A plain write on the
    // driver's second connection loses that race in ~1 ms with SQLITE_BUSY,
    // and losing it here means a generated image is silently orphaned on disk
    // with no note pointing at it.
    const [updated] = yield* database.withWriteLock(
      "ai.record-image",
      databaseEffect("ai.record-image", () => database.db
        .update(notes)
        .set({ imagePath })
        .where(
          and(eq(notes.id, input.noteId), eq(notes.userId, context.userId)),
        )
        .returning({ id: notes.id }),
      ),
    );
    if (!updated) {
      yield* media.removeImage(imagePath);
      return { imagePath };
    }

    yield* database.withWriteLock(
      "ai.clear-image-failed",
      databaseEffect("ai.clear-image-failed", () =>
        setNoteImageFailed(database.db, context.userId, input.noteId, false),
      ),
    );

    return { imagePath };
  })));

export const aiRouter = {
  generateImage: generateImageProcedure,
};
