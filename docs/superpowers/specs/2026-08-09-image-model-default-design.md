# Image Generation Model Default Design

## Goal

Change mnimi's default image-generation model to `black-forest-labs/flux.2-klein-4b` for GitHub issue #31.

## Scope

Update the model identifier in every project configuration/documentation location that currently provides or describes the image model:

- `server/ai/openrouter.ts`: runtime fallback when `IMAGE_MODEL` is unset.
- `.env.example`: recommended development configuration.
- `.env`: the local override requested for this workspace.
- `README.md`: documented default configuration.

The existing environment-variable precedence remains unchanged: a non-empty `IMAGE_MODEL` value wins over the fallback.

## Testing

Extend `server/ai/openrouter.test.ts` with focused tests for `imageModel()`:

1. It returns `black-forest-labs/flux.2-klein-4b` when `IMAGE_MODEL` is unset.
2. It returns an explicitly configured `IMAGE_MODEL` value unchanged.

The tests must clean up `IMAGE_MODEL` before and after execution so they do not affect other tests or the developer environment.

## Alternatives considered

- Centralizing the default in a shared constant was rejected as unnecessary refactoring for a single configuration change.
- A focused replacement keeps the behavior and configuration surface stable while making the new default explicit and tested.

## Verification

Run the focused OpenRouter test and the complete project test task, then inspect the diff and confirm that only the intended model references changed (apart from the design document and test coverage).
