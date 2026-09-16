import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { DatabaseFailure, Forbidden, NotFound, Validation } from "./errors.ts";
import { RequestContext } from "./request-context.ts";
import { makeAppRuntime } from "./runtime.ts";
import { runTransport, toOrpcError } from "./transport.ts";

const request = (requestId: string) => ({
  headers: new Headers(),
  requestId,
  signal: new AbortController().signal,
});

describe("Effect transport", () => {
  it("supplies the request context for exactly the current invocation", async () => {
    const runtime = makeAppRuntime(Layer.empty);
    try {
      await expect(runTransport(
        runtime,
        request("request-a"),
        Effect.map(RequestContext, ({ requestId }) => requestId),
      )).resolves.toBe("request-a");
      await expect(runTransport(
        runtime,
        request("request-b"),
        Effect.map(RequestContext, ({ requestId }) => requestId),
      )).resolves.toBe("request-b");
    } finally {
      await runtime.dispose();
    }
  });

  it("maps a missing resource to the existing oRPC error", () => {
    const error = toOrpcError(new NotFound({ message: "Deck not found" }));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Deck not found");
  });

  it("maps forbidden and validation domain failures without exposing router errors", () => {
    const forbidden = toOrpcError(new Forbidden({ message: "Devtools are disabled" }));
    const invalid = toOrpcError(new Validation({
      message: "Invalid operation",
      issues: [],
      data: { field: "back" },
    }));

    expect(forbidden).toMatchObject({
      code: "FORBIDDEN",
      message: "Devtools are disabled",
    });
    expect(invalid).toMatchObject({
      code: "BAD_REQUEST",
      message: "Invalid operation",
      data: { field: "back" },
    });
  });

  it("does not log an expected database failure as a transport defect", async () => {
    const runtime = makeAppRuntime(Layer.empty);
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runTransport(
        runtime,
        request("database-failure"),
        Effect.fail(new DatabaseFailure({ operation: "decks.list" })),
      )).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(report).not.toHaveBeenCalled();
    } finally {
      report.mockRestore();
      await runtime.dispose();
    }
  });
});
