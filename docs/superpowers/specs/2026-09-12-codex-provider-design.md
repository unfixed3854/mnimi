# Codex Subscription Provider Design

## Goal

Add a selectable Codex provider for mnimi's text and image generation while
preserving the existing OpenRouter provider. Codex mode uses the operator's own
ChatGPT-backed Codex login on a private, personal self-hosted instance. It must
not require an OpenRouter key, make an OpenRouter request, or silently switch to
metered OpenAI API authentication.

This is an architectural change because provider selection affects server
startup, every model-call path, image generation, credentials, container
construction, and deployment documentation.

## Scope and constraints

In scope:

- Select the complete AI provider with `AI_PROVIDER=openrouter|codex`.
- Keep `openrouter` as the default for backward compatibility.
- Reuse the existing role-based model and effort variables for both providers.
- Authenticate Codex through an operator-run device-code command.
- Run one long-lived, pinned Codex app-server child per Bun server process.
- Use Codex for text and built-in image generation in Codex mode.
- Isolate model-run commands from the application, database, and credentials.
- Preserve the existing application behavior and OpenRouter implementation.
- Cover provider selection, protocol handling, security boundaries, and
  deployment with tests and documentation.

Out of scope:

- A browser or mobile sign-in flow for Codex.
- Per-mnimi-user Codex accounts or credentials.
- Automatic fallback between providers.
- Multiple API replicas sharing a Codex process or SQLite volume.
- An unpinned or automatically upgraded Codex runtime.
- Supporting Codex mode as a public or multi-user hosted service.

## Official-product assumptions

The design relies on the official Codex CLI and app-server surface rather than
undocumented OAuth or upstream endpoints.

- Codex app-server is a bidirectional JSON-RPC interface with a JSONL stdio
  transport, request IDs, streamed turn/item events, structured output, account
  inspection, model discovery, and generated version-specific schemas.
- Device-code authentication is available for headless environments through
  `codex login --device-auth`. The resulting auth cache is a password-equivalent
  secret.
- Built-in Codex image generation is invoked explicitly with `$imagegen`, uses
  the service's image model, and consumes the account's Codex allowance.
- GPT-5.6 Luna and Sol have the model IDs `gpt-5.6-luna` and
  `gpt-5.6-sol`. Access remains subject to the operator's ChatGPT plan and
  workspace settings.
- The app-server command is experimental and is not supported for production
  workloads. This design accepts that trade-off only for the requested private,
  personal deployment, pins the runtime, and isolates protocol-specific code.

References:

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex permissions](https://learn.chatgpt.com/docs/permissions)
- [Codex image generation](https://learn.chatgpt.com/docs/image-generation)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)

## Approaches considered

### Selected: one long-lived app-server over stdio

The Bun server starts one local `codex app-server` child, performs one
initialization handshake, and multiplexes independent ephemeral threads over
the connection. This retains rich streamed events and the image-generation
item needed by mnimi while avoiding a process launch for every model call.

The protocol adapter is deliberately narrow. The rest of mnimi continues to
depend on `CreationModelCalls` and `generateImageBytes`, not app-server message
types. A future protocol or provider change therefore stays behind one seam.

### Rejected: one Codex CLI process per call

This is easier to prototype but repeatedly pays startup and authentication
overhead, complicates concurrency, and provides a weaker interface for
structured streaming and generated-image paths.

### Rejected: direct OAuth tokens or undocumented service endpoints

This would couple mnimi to authentication and transport details that OpenAI
does not document as an application integration. It is less stable and creates
more risk of mishandling credentials.

### Not selected: Codex SDK

The SDK is the official recommendation for ordinary job automation. Mnimi is a
rich local product integration that needs app-server's event stream, account
and model introspection, and image-generation item. The selected app-server
approach better fits those requirements, with its experimental status made
explicit in the deployment documentation.

## 1. Provider boundary

Introduce one provider bundle consumed by server startup:

```ts
type AiProvider = {
  modelCalls: CreationModelCalls;
  generateImageBytes(prompt: string): Promise<Uint8Array>;
  close(): Promise<void>;
};
```

An asynchronous provider factory reads `AI_PROVIDER` and returns exactly one
bundle:

- `openrouter` wraps the existing text calls and image-generation function.
- `codex` initializes the app-server client and exposes adapters implementing
  the same interfaces.
- An unknown value fails before the HTTP server binds.

OpenRouter remains the default when `AI_PROVIDER` is unset. The selector loads
provider implementations dynamically so choosing Codex does not initialize or
call the OpenRouter SDK. Choosing OpenRouter does not start Codex or inspect its
credential directory.

The provider is created before schedulers and `Bun.serve`. Its two capabilities
are injected into:

- the oRPC context used by draft and explicit image-generation procedures;
- the durable creation text scheduler;
- the durable creation image scheduler.

Direct OpenRouter fallbacks are removed from router modules. Tests continue to
inject fake model calls and image generation, but missing production
dependencies fail clearly rather than reaching an implicit provider.

The existing OpenRouter request behavior, model routing, and image endpoint
discovery remain unchanged apart from moving the image-generation function
behind the provider boundary.

## 2. Configuration

`CLASSIFY_MODEL`, `CLASSIFY_EFFORT`, `GENERATE_MODEL`, and
`GENERATE_EFFORT` describe application roles, not a provider. Both providers
consume them:

| Operation | Model and effort |
| --- | --- |
| Classification | `CLASSIFY_MODEL`, `CLASSIFY_EFFORT` |
| Deck routing | `CLASSIFY_MODEL`, `CLASSIFY_EFFORT` |
| Card generation | `GENERATE_MODEL`, `GENERATE_EFFORT` |
| Card adjustment | `GENERATE_MODEL`, `GENERATE_EFFORT` |
| Codex image-agent turn | `GENERATE_MODEL`, `GENERATE_EFFORT` |

Recommended personal Codex configuration:

```dotenv
AI_PROVIDER=codex
CLASSIFY_MODEL=gpt-5.6-luna
CLASSIFY_EFFORT=low
GENERATE_MODEL=gpt-5.6-sol
GENERATE_EFFORT=high
CODEX_HOME=/data/codex
REGISTRATION_ENABLED=false
```

OpenRouter mode continues to accept OpenRouter model identifiers through the
same model variables and additionally uses:

```dotenv
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
IMAGE_MODEL=black-forest-labs/flux.2-klein-4b
```

`IMAGE_MODEL` is OpenRouter-only. Codex's built-in image capability selects the
image model on the service side, so adding a misleading Codex image-model
override is intentionally avoided.

Codex startup queries `model/list` and requires both configured models and
their configured effort levels to be available to the logged-in account. It
does not accept provider fallback or model rerouting as configuration
fallback. An unavailable model or effort is an actionable startup error.

Codex mode is personal-use only. Startup rejects
`REGISTRATION_ENABLED=true` so the operator cannot accidentally expose their
ChatGPT-backed provider to public signups. The README also states that the
operator must not give other people access to an instance using the operator's
Codex subscription.

## 3. Authentication and credential storage

Add a root-level command:

```bash
bun run codex:login
```

The root command delegates to a server-side Bun script. That script:

1. Resolves `CODEX_HOME` with the same helper used by server startup, defaulting
   locally to the repository's ignored `data/codex` directory.
2. Creates the directory with mode `0700`.
3. Invokes the pinned local Codex executable with file credential storage and
   `login --device-auth`.
4. Leaves the device URL and one-time code attached to the operator's terminal.

There is no application endpoint or UI for login, logout, token display, or
credential copying. In a container, the operator runs the same command once in
an interactive disposable container with the production `/data` volume
mounted. The normal service then reuses `/data/codex`.

`auth.json` must never be committed, included in an image layer, returned by an
API, or logged. The login wrapper ensures the auth directory is private; server
startup rejects credentials that are group- or world-accessible instead of
silently continuing.

The Codex child receives the dedicated `CODEX_HOME`, but `OPENAI_API_KEY` is
removed from its environment. After initialization, startup calls
`account/read` with token refresh and requires `account.type` to be `chatgpt`.
An API-key account is rejected. These two checks prevent a stray environment
variable or cached API key from turning subscription mode into metered OpenAI
API usage.

If authentication is missing or cannot refresh, startup fails with an
instruction to run `bun run codex:login`. A later authentication failure fails
the affected operation; it never invokes OpenRouter.

## 4. Container design

The current Alpine stages are incompatible with the official Codex executable,
which is dynamically linked against glibc. Both stages move to the verified
`oven/bun:1.3.13-debian` image.

Add an exact `@openai/codex` `0.154.0` production dependency to the server
workspace. The image uses this workspace dependency rather than a global or
latest-at-build install, so the lockfile and container are reproducible.

The runtime image:

- sets `CODEX_HOME=/data/codex`;
- creates `/data/codex` owned by the unprivileged `bun` user with mode `0700`;
- keeps `/data` as the single required persistent mount for SQLite, media, and
  the Codex auth cache;
- continues running the application as `USER bun`;
- never copies a host auth cache during the build.

Example one-time login:

```bash
podman run --rm -it \
  --env-file mnimi-api.env \
  --volume mnimi-data:/data \
  mnimi-api bun run codex:login
```

The normal migration and server containers mount the same named volume.
Operators must protect that volume and any backups because it contains both
application data and a password-equivalent Codex auth cache.

## 5. App-server client

The Codex-specific implementation has two layers:

1. A transport client owns the child process, JSONL framing, initialization,
   request IDs, pending requests, event subscriptions, and process lifecycle.
2. A provider adapter maps mnimi's existing text/image interfaces onto
   app-server threads and turns.

The client starts `codex app-server` with stdio pipes and sends `initialize`
followed by `initialized`. It identifies itself with a stable mnimi client name
and version. Stdout is parsed one complete line at a time; incomplete chunks
remain buffered. Responses resolve the pending request with the matching ID,
while notifications are dispatched by thread and turn IDs.

One client supports concurrent calls. Each operation owns its subscription and
cannot receive another operation's deltas or completion. Unknown notifications
are ignored unless they are required to complete an active operation. Malformed
JSON, an unexpected protocol response, or child exit rejects every in-flight
request with a typed provider error.

Raw protocol messages are never logged because they contain prompts and model
output. Child stderr is drained so the pipe cannot block, but its content is not
logged; diagnostics record only the exit code and a capped byte count.
Authentication tokens, email addresses, prompts, generated content, and raw
JSON-RPC payloads are excluded.

The client never grants server-initiated command, file, or permission
approvals. Any such request is declined. User-input and MCP elicitation requests
are cancelled rather than left pending, because mnimi has no operator present
inside a generation turn and must not let model input widen its privileges.

When app-server exits, the existing instance is marked dead. A later operation
may start and initialize a new process, but the operation affected by the exit
is not replayed because the server cannot know whether upstream usage or image
generation already occurred. Shutdown terminates the child and rejects pending
requests.

## 6. Startup validation

Codex provider construction is eager and completes before HTTP binding or
scheduler startup. It performs these checks in order:

1. Start and initialize app-server.
2. Read and refresh the account; require ChatGPT-managed authentication.
3. List available models; validate the two configured IDs and effort levels.
4. Read provider capabilities; require image generation.

A failure exits startup with a concise remediation. It does not log account
details or fall back. OpenRouter startup preserves its existing lazy key usage
and does not acquire new Codex requirements.

## 7. Per-operation isolation

Every classify, route, generate, adjust, and image call starts a fresh ephemeral
thread. No thread is resumed or shared between application operations or mnimi
users, and ephemeral threads are not added to Codex's stored thread history.
The newly created workspace lives under the operating system's temporary
directory, never below `/data` or `CODEX_HOME`.

Each operation gets a newly created temporary workspace. The turn uses:

- `approvalPolicy: "never"`;
- workspace-write access only for that temporary root;
- restricted read access limited to platform/runtime essentials;
- command network access disabled;
- no access to the repository, `/data`, the SQLite database, media, or
  `CODEX_HOME`.

The app-server process itself still accesses its auth cache and Codex service
traffic. Sandbox restrictions apply to model-run local commands, so first-party
model and image-generation traffic remains available.

This boundary matters even for a personal deployment: source text and image
prompts are untrusted model input. They must not be able to induce a shell or
tool call that reads credentials or application data.

Temporary workspaces are removed after success, failure, or cancellation. The
path is resolved and checked before cleanup so no event-controlled value can
broaden the deletion target.

## 8. Text data flow

The provider maps each `ModelPrompts` call as follows:

1. Create an ephemeral thread with the operation's model, effort, temporary
   working directory, and `developerInstructions` set from the existing system
   prompt.
2. Convert the existing Zod response schema to JSON Schema and pass it as the
   turn's `outputSchema`.
3. Send the existing user prompt as the turn's text input.
4. Consume events until `turn/completed`.
5. Parse the authoritative completed agent message as JSON and return it as
   `unknown` to the existing Zod validation/retry layer.

Classification, routing, and adjustment are accumulated without exposing
deltas. Generation forwards `item/agentMessage/delta` text unchanged so the
existing partial-JSON projection continues to update cards incrementally. The
completed message, not concatenated deltas, is authoritative for the returned
object.

The existing application-level validation retry remains in charge of malformed
model output. Provider failures throw immediately and do not masquerade as
schema-validation failures or consume a validation retry.

## 9. Image data flow

Codex image generation uses a fresh ephemeral thread configured with
`GENERATE_MODEL` and `GENERATE_EFFORT`. Its prompt retains mnimi's existing
photographic/plain-background/no-text constraints and explicitly invokes
`$imagegen`.

The provider waits for the completed image-generation item supplied by the
pinned app-server protocol. On success it:

1. Requires a non-empty `savedPath`.
2. Resolves the real path and proves it is inside the operation's temporary
   workspace.
3. Requires a regular file no larger than 25 MiB.
4. Reads and returns the bytes through the existing `generateImageBytes`
   interface.
5. Removes the temporary workspace in `finally`.

A missing path, failed image item, out-of-workspace path, unsupported object, or
oversized result is a provider error. The downstream draft/note image storage
and ownership logic remains unchanged.

Codex mode never consults `IMAGE_MODEL` and never calls either OpenRouter image
endpoint.

## 10. Errors and cancellation

The provider normalizes failures into categories useful for logs and tests:

- unauthenticated or token refresh failure;
- unavailable model or unsupported effort;
- usage limit exceeded;
- upstream connection failure;
- structured-output or protocol failure;
- sandbox/permission failure;
- unexpected provider model rerouting;
- image generation or result validation failure;
- child process exit or shutdown.

The application keeps its existing generic user-visible generation failure
messages. Detailed categories are server diagnostics only, without prompt or
credential contents.

The transport supports `turn/interrupt` for orderly provider shutdown and waits
up to five seconds for interrupted completion before terminating the child.
Existing draft cancellation semantics remain unchanged: the job layer prevents
a late result from being written, but this feature does not widen the model-call
interfaces to cancel already accepted upstream work.

If app-server emits `model/rerouted` for a configured operation, the provider
fails that operation. It does not accept an implicit substitute for Luna or Sol.

There is no cross-provider retry. After an ambiguous process or stream failure,
the current operation fails rather than being replayed. A new app-server process
may serve later operations.

## 11. Tests

Normal automated tests remain offline and do not require a Codex login or spend
Codex allowance.

### Provider selection

- Unset `AI_PROVIDER` selects OpenRouter.
- `openrouter` returns the OpenRouter text and image bundle.
- `codex` returns the Codex bundle and never loads or calls OpenRouter.
- Unknown values fail before server startup.
- Codex plus public registration is rejected.

### Transport client

A fake stdio child process covers:

- handshake ordering;
- fragmented and multiple JSONL messages per stream chunk;
- response correlation when concurrent requests complete out of order;
- per-thread and per-turn notification routing;
- automatic refusal of approvals, permission requests, and interactive
  elicitations;
- server request errors and typed turn failures;
- malformed messages, stderr bounding, process exit, and shutdown;
- rejection of all pending requests after a crash;
- reinitialization only for subsequent operations.

### Codex adapters

- Classification and routing select the classify model and effort.
- Generation, adjustment, and image-agent turns select the generate model and
  effort.
- Existing system prompts become developer instructions.
- Existing Zod schemas become turn output schemas.
- Non-streamed calls use the completed message.
- Generation forwards deltas and returns the parsed completed object.
- Provider failures bypass the application validation retry.
- Every operation uses an isolated ephemeral thread and restricted sandbox.

### Image handling

- A valid in-workspace saved image returns its bytes.
- Missing and failed image items are rejected.
- Relative traversal, absolute external paths, symlinks escaping the workspace,
  directories, and oversized files are rejected.
- Temporary files are removed on success and every failure path.

### Startup and authentication

- Missing login, API-key auth, unavailable models, invalid effort, and missing
  image capability fail with actionable errors.
- `OPENAI_API_KEY` is absent from the spawned child's environment.
- OpenRouter mode does not read `CODEX_HOME` or impose Codex validation.

### Protocol contract

An offline test runs the pinned executable's
`codex app-server generate-json-schema` command in a temporary directory and
asserts that the small set of request, event, and item fields consumed by mnimi
still exists. Generated schemas are not checked into the repository. Updating
`@openai/codex` therefore requires a deliberate dependency bump and a passing
contract test.

Existing provider-independent router, draft, creation, concurrency, and media
tests remain unchanged except where production dependencies are now injected.
Existing OpenRouter behavior keeps focused regression coverage.

## 12. Documentation and rollout

Update `apps/server/.env.example` and the README to describe both provider
configurations. The README includes:

- Codex plan/model availability caveats and app-server's experimental status;
- local device login and status/startup validation;
- container build, one-time login, migration, and normal start commands;
- `/data/codex` permissions and backup sensitivity;
- the provider-neutral model variables and OpenRouter-only `IMAGE_MODEL`;
- switching providers by editing `AI_PROVIDER` and restarting;
- usage-limit behavior and the absence of automatic fallback;
- the private, personal-use restriction;
- an optional manual live smoke flow clearly marked as consuming allowance.

Normal CI runs no live Codex requests. Container publication continues building
the same `Containerfile`, which now proves the pinned binary can be installed in
the Debian/glibc image. A deployment is ready when startup validation passes and
one manually requested text generation and image generation succeed through the
application.

## Verification

Run the repository's required quality gates:

```bash
bun run check
bun run test
podman build -t mnimi-api -f Containerfile .
```

The container build may be performed by CI when a local container CLI is not
available. Live verification is separate and opt-in because it uses the
operator's Codex allowance.

## Acceptance criteria

- `AI_PROVIDER` atomically selects OpenRouter or Codex, with OpenRouter as the
  backward-compatible default.
- Codex mode uses `gpt-5.6-luna` for classify-role calls and
  `gpt-5.6-sol` for generate-role calls when configured as recommended.
- `bun run codex:login` performs device authentication into the persistent,
  dedicated `CODEX_HOME`.
- Startup confirms ChatGPT authentication, model/effort access, and image
  capability before accepting requests.
- Codex mode handles all text and image generation without OpenRouter or
  metered OpenAI API fallback.
- Model-run commands cannot read application data or credentials and cannot use
  command network access.
- Concurrent requests remain isolated over one long-lived app-server process.
- OpenRouter functionality remains supported and covered by regression tests.
- Offline tests cover the protocol adapter, failure modes, image paths, and
  configuration, and the full `bun run test` suite passes.
- Deployment documentation covers local and container login, persistence,
  personal-use boundaries, and explicit provider switching.
