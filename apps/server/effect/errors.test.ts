import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import {
  Conflict,
  DatabaseFailure,
  DependencyUnavailable,
  InfrastructureFailure,
  Interrupted,
  MediaFailure,
  NotFound,
  ProviderFailure,
  Unauthorized,
  Validation,
  type ExpectedError,
} from "./errors.ts";

describe("Effect expected errors", () => {
  it("keeps every expected failure uniquely tagged", () => {
    const errors: ExpectedError[] = [
      new Unauthorized({}),
      new NotFound({ message: "Deck not found" }),
      new Conflict({ message: "Creation changed" }),
      new Validation({
        issues: [{ path: ["name"], message: "Name is required" }],
      }),
      new DependencyUnavailable({
        dependency: "AI provider",
        message: "AI provider is not configured",
      }),
      new DatabaseFailure({ operation: "decks.list" }),
      new ProviderFailure({
        provider: "openrouter",
        operation: "classify",
        message: "Classification failed",
      }),
      new MediaFailure({
        operation: "image.read",
        message: "Image read failed",
      }),
      new Interrupted({ operation: "creation.generate" }),
      new InfrastructureFailure({
        operation: "server.start",
        message: "Server startup failed",
      }),
    ];

    expect(new Set(errors.map((error) => error._tag)).size)
      .toBe(errors.length);
  });

  it("is directly yieldable as a typed Effect failure", async () => {
    const yielded = Effect.gen(function* () {
      yield* new Unauthorized({ message: "Sign in required" });
    });

    await expect(Effect.runPromise(Effect.flip(yielded))).resolves
      .toMatchObject({
        _tag: "Unauthorized",
        message: "Sign in required",
      });
  });

  it("narrows a selected tag without swallowing other failures", async () => {
    const catchNotFound = (
      effect: Effect.Effect<unknown, NotFound | Conflict>,
    ) => effect.pipe(
      Effect.catchTag("NotFound", (error) => Effect.succeed(error.message)),
    );

    const handled = catchNotFound(
      Effect.fail(new NotFound({ message: "Deck not found" })),
    );

    await expect(Effect.runPromise(handled)).resolves.toBe("Deck not found");
    const unhandled = await Effect.runPromiseExit(
      catchNotFound(
        Effect.fail(new Conflict({ message: "Creation changed" })),
      ),
    );
    expect(Exit.isFailure(unhandled)).toBe(true);
    if (Exit.isFailure(unhandled)) {
      expect(unhandled.cause).toMatchObject({
        _tag: "Fail",
        error: {
          _tag: "Conflict",
          message: "Creation changed",
        },
      });
    }
  });
});
