import { Data } from "effect";

export type ValidationIssue = {
  readonly path: ReadonlyArray<string | number>;
  readonly code?: string;
  readonly message: string;
};

export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly message?: string;
}> {}

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly message: string;
}> {}

export class Conflict extends Data.TaggedError("Conflict")<{
  readonly message: string;
}> {}

export class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly message: string;
}> {}

export class Validation extends Data.TaggedError("Validation")<{
  readonly issues: ReadonlyArray<ValidationIssue>;
  readonly message?: string;
  readonly data?: unknown;
}> {}

export class DependencyUnavailable
  extends Data.TaggedError("DependencyUnavailable")<{
    readonly dependency: string;
    readonly message: string;
  }> {}

export class DatabaseFailure extends Data.TaggedError("DatabaseFailure")<{
  readonly operation: string;
  readonly cause?: unknown;
}> {}

export class ProviderFailure extends Data.TaggedError("ProviderFailure")<{
  readonly provider: string;
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class MediaFailure extends Data.TaggedError("MediaFailure")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class Interrupted extends Data.TaggedError("Interrupted")<{
  readonly operation: string;
}> {}

export class InfrastructureFailure
  extends Data.TaggedError("InfrastructureFailure")<{
    readonly operation: string;
    readonly message: string;
    readonly cause?: unknown;
  }> {}

export type ExpectedError =
  | Unauthorized
  | NotFound
  | Conflict
  | Forbidden
  | Validation
  | DependencyUnavailable
  | DatabaseFailure
  | ProviderFailure
  | MediaFailure
  | Interrupted
  | InfrastructureFailure;
