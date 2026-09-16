<p align="center">
  <img src="docs/assets/readme-hero.png" alt="mnimi — Make it stick. Cream and lavender flashcards on a deep purple background." width="960" />
</p>

<h1 align="center">Turn everyday discoveries into lasting knowledge.</h1>

<p align="center">
  AI-assisted flashcards for Android and the web.<br />
  Capture what you want to learn, shape it into cards, and build a review habit.
</p>

<p align="center">
  <a href="#why-mnimi">Explore features</a> ·
  <a href="#setup">Get started</a> ·
  <a href="#run-in-a-browser">Run in a browser</a> ·
  <a href="#host-the-api">Self-host</a>
</p>

## Why mnimi?

A new word, a useful idea, a topic you keep meaning to learn. Give mnimi a starting
point and turn it into a set of focused flashcards you can make your own.

- **Spend more time learning.** Generate cards from a short request, then edit
  them yourself or ask AI to simplify, add examples, or change the focus.
- **Recall the missing piece.** Fill-in-the-blank (cloze) cards keep each question
  focused, with images and pronunciation cues to help it stick.
- **Know what to review next.** FSRS spaced repetition schedules your next review
  based on how well you remember each card.
- **Pick up where you left off.** Generation continues on the server when you
  leave the screen. Come back to saved progress and retry when something fails.
- **Learn on your phone or in your browser.** Use the same decks and review flow
  on Android and the web, backed by your own server.

## From curiosity to recall

1. **Capture.** Describe what you want to learn: Spanish travel phrases, how
   volcanoes form, or a concept you want to remember.
2. **Generate.** Let mnimi draft the cards, check the results, and refine the
   wording or adjust the set with AI.
3. **Review.** Recall the hidden answer, reveal it, and rate how well you knew it.
   mnimi schedules the next review.

Ready to try it? Follow the [setup guide](#setup) to run mnimi locally, or use the
[API hosting guide](#host-the-api) and [web guide](#run-in-a-browser) to host your
own instance. Live card generation requires either an OpenRouter API key or an
eligible ChatGPT plan for the private Codex option; pronunciation uses an optional
ElevenLabs integration.

## Prerequisites

- [mise](https://mise.jdx.dev/) for the pinned Node, Bun, Java 17, and Android
  SDK toolchain in `mise.toml`
- a browser, or an Android emulator or USB-debuggable Android device
- an OpenRouter API key for live generation, or an eligible ChatGPT plan for the
  private Codex option

## Setup

```bash
mise install
bun install --frozen-lockfile
cp apps/mobile/.env.example apps/mobile/.env
cp apps/server/.env.example apps/server/.env
bun run db:migrate
bun run dev
```

An existing ignored root `.env` is no longer read: split its values between
`apps/mobile/.env` and `apps/server/.env`. Keep `BETTER_AUTH_SECRET`,
the selected provider credentials, database, AI, and text-to-speech settings in
the server file. Set `BETTER_AUTH_SECRET` to at least 32 random characters. Only public
mobile configuration belongs in `apps/mobile/.env`; never put server secrets in
the mobile environment or give them an `EXPO_PUBLIC_` prefix.

To use Codex locally, replace (do not add alongside) the active OpenRouter
`AI_PROVIDER`, `CLASSIFY_MODEL`, `CLASSIFY_EFFORT`, `GENERATE_MODEL`, and
`GENERATE_EFFORT` assignments in `apps/server/.env` with the exact commented
Codex block in [`apps/server/.env.example`](apps/server/.env.example).

Public account creation is disabled by default. Set
`REGISTRATION_ENABLED=true` in `apps/server/.env` to expose signup in the mobile
app and allow the signup API. Any other value disables it. To provision an
account while public registration is disabled, run this from the repository
root and enter the password at the hidden prompts:

```bash
bun run user:create -- --email ada@example.com --name "Ada"
```

## Develop

In `apps/mobile/.env`, set `EXPO_PUBLIC_API_URL` to an API address the emulator
can reach. For an emulator, use `http://10.0.2.2:8788`. For a physical device,
use the development machine's private LAN address and keep both devices on the
same trusted Wi-Fi network:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.20:8788
```

`bun run dev` starts both services. The backend reloads source changes and
restarts automatically when `apps/server/.env` changes (also with
`bun run server:dev`). Invalid configuration stops the command; fix it and
start the command again. The API binds to `HOST` (`0.0.0.0` by
default), so do not expose it on an untrusted network. The canonical commands
are:

```bash
bun run server:dev
bun run mobile:dev
bun run mobile:android
bun run web:dev
bun run web:build
bun run check
bun run test
bun run mobile:build:android
bun run mobile:smoke
```

The native client permits HTTP only in development. A production build rejects
non-HTTPS `EXPO_PUBLIC_API_URL` values at startup.

## Run in a browser

The web app uses the same screens and API as Android. Set
`EXPO_PUBLIC_API_URL=http://localhost:8788` in `apps/mobile/.env`, start the API
with `bun run server:dev`, then run `bun run web:dev` in another terminal and
open `http://localhost:8081`. Use the same hostname for the browser and API:
`localhost` and `127.0.0.1` are different cookie sites. For LAN testing, use
HTTPS and the same LAN hostname/IP for both. The Android emulator's `10.0.2.2`
alias is not a browser loopback address.

The API's default browser allowlist covers `http://localhost:8081` and
`http://127.0.0.1:8081`. If you use a different hostname or port, add its exact
origin to `CORS_ORIGIN` in `apps/server/.env`; the dev server restarts
automatically. This one list controls both CORS and Better Auth's origin checks.

Build a deployable single-page app with:

```bash
EXPO_PUBLIC_API_URL=https://api.example.com bun run web:build
```

Serve `apps/mobile/dist` over HTTPS and configure the static host to fall back
to `index.html` for app routes such as `/decks/<id>` and `/notes/<id>`. The API
URL is compiled into the bundle, so rebuild when it changes. Set the API's
`CORS_ORIGIN` to the hosted app's exact HTTPS origin. Set `BETTER_AUTH_URL` to
the API's public HTTPS URL. Host the app and API on the same site (for example,
`app.example.com` and `api.example.com`), or reverse-proxy the API under the
app's origin. Unrelated frontend/API domains are not supported by the
SameSite=Lax cookie policy. Expo's
[web publishing guide](https://docs.expo.dev/guides/publishing-websites/)
has host-specific single-page app configuration examples.

Browser sessions use server-set, host-only HttpOnly cookies with SameSite=Lax
and Secure on HTTPS/production; local HTTP development is the exception.
Browser requests include cookies, never an Authorization bearer, and auth
responses do not expose session tokens in headers or JSON. The API checks
browser mutation origins in addition to CORS. Only a non-secret change marker
is stored in localStorage to notify other tabs to refresh their session and
clear cached account data; any legacy stored bearer is removed. Auth operations
are serialized across tabs using Web Locks, requiring a current browser on
HTTPS or localhost. A failed web sign-out remains signed in so it can be
retried: JavaScript cannot clear an HttpOnly cookie. See Better Auth's
[cookie documentation](https://better-auth.com/docs/concepts/cookies).

Private images and audio are fetched with the platform's credentials and
displayed through temporary blob URLs on web, which are revoked when released.
Browsers may block pronunciation autoplay;
use the playback/retry button when that happens. Unsaved note edits prompt before
closing or reloading the tab. Browser Back/Forward confirmation uses the
Navigation API available in current browsers; older browsers without this API
still support in-app Cancel and the reload/close warning.

## Host the API

The API ships as a generic OCI image. It includes the Bun server and checked-in
Drizzle migrations, but not secrets or runtime data. SQLite, generated images,
generated audio, and (when selected) Codex credentials all share durable storage
mounted at `/data`; running more than one API replica against that SQLite volume
is unsupported. Use one `/data` volume with one API replica.

Choose one atomic AI provider bundle with `AI_PROVIDER`. The default is
`openrouter`; the Codex app-server integration is experimental and is intended
only for the operator's private personal instance.
Codex mode currently requires Linux with `/proc/self/fd` available for secure
workspace file access; use the supplied Linux container on other hosts. It
refuses generation if the required file primitives are unavailable.
Never give other people access to an instance backed by the operator's Codex
subscription. An eligible ChatGPT plan is required for the Codex option, but
availability is not guaranteed by every ChatGPT plan.

Build the image from the repository root:

```bash
podman build -t mnimi-api -f Containerfile .
```

Create a host-only environment file (for example, `mnimi-api.env`) with at
least these production values. Do not add this file to the image or source
control.

```dotenv
DATABASE_URL=file:/data/mnimi.db
IMAGES_DIR=/data/images
AUDIO_DIR=/data/audio
HOST=0.0.0.0
PORT=8788
BETTER_AUTH_SECRET=replace-with-a-random-secret-of-at-least-32-characters
BETTER_AUTH_URL=https://api.example.com
REGISTRATION_ENABLED=false
# Set this only for browser clients, to their exact HTTPS origin(s).
CORS_ORIGIN=https://app.example.com
AI_PROVIDER=openrouter
# OpenRouter only:
OPENROUTER_API_KEY=sk-or-...
```

Include the optional ElevenLabs and model-selection variables from
[`apps/server/.env.example`](apps/server/.env.example) when those features are
used. `OPENROUTER_API_KEY` and `IMAGE_MODEL` apply only to OpenRouter.
`BETTER_AUTH_URL` must be the public HTTPS API URL; `CORS_ORIGIN` is a
comma-separated allowlist for browser clients, while the native app uses bearer
authentication without an Origin header.

For the experimental private Codex option, use this production environment
instead of the OpenRouter credentials above:

```dotenv
AI_PROVIDER=codex
CLASSIFY_MODEL=gpt-5.6-luna
CLASSIFY_EFFORT=low
GENERATE_MODEL=gpt-5.6-sol
GENERATE_EFFORT=high
CODEX_HOME=/data/codex
REGISTRATION_ENABLED=false
```

The Luna/low pair serves classification and routing; Sol/high serves generation
and adjustments. `IMAGE_MODEL` is ignored in Codex mode: Codex uses its
service-selected built-in image generation model. On startup the server refreshes
authentication and verifies the ChatGPT account type, both configured models and
efforts, and image capability before accepting requests. Switching `AI_PROVIDER`
requires a restart and never enables automatic fallback. If Codex reaches a usage
limit, that operation fails; it does not fall back to OpenRouter or create an
OpenRouter charge.

Authenticate Codex in an operator-controlled terminal. The device-login URL and
code stay in that terminal; do not paste them into the service or expose them to
users. For local development, after `apps/server/.env` selects Codex, run:

```bash
# Local, after apps/server/.env selects Codex
bun run codex:login
```

For the container, run this once for a new persistent volume and again whenever
the authentication needs refreshing:

```bash
# Container, once per persistent volume/auth refresh need
podman run --rm -it \
  --env-file mnimi-api.env \
  --volume mnimi-data:/data \
  mnimi-api bun run codex:login
```

`/data/codex/auth.json` is a password-equivalent secret. Treat the entire data
volume and all of its backups as password-equivalent secrets too; keep them
private and do not add them to the image or source control.

Apply database migrations as a release step before replacing the API container:

```bash
podman run --rm \
  --env-file mnimi-api.env \
  --volume mnimi-data:/data \
  mnimi-api bun run db:migrate
```

Then start one API replica with the same persistent volume:

```bash
podman run --detach --replace --name mnimi-api \
  --env-file mnimi-api.env \
  --publish 8788:8788 \
  --volume mnimi-data:/data \
  mnimi-api
```

Put an HTTPS-capable reverse proxy or load balancer in front of port 8788 and
route it to the API's public hostname. Use that hostname in the production
mobile build's `EXPO_PUBLIC_API_URL`, for example
`https://api.example.com`. The app intentionally has no unauthenticated health
endpoint, so configure the platform's health check as a TCP check on port 8788
or add an authenticated application check outside this container setup.

Optionally perform a live provider smoke test after deployment: start the
service, create one text draft, request one image, and confirm that both settle.
In Codex mode this consumes the operator's Codex allowance.

## Verification

The root verification surface is `bun run check` and `bun run test`; use
`bun run mobile:build:android` for the Android release build. Bun owns
installation, scripts, and the server runtime. Node remains an Expo/test CLI
prerequisite managed by mise.

For browser verification, run `bun run web:test:install` once, then
`bun run web:test`. The Chromium smoke test starts its own API, temporary
database/media storage, and Expo server on ports 18787 and 18081. It exercises
HttpOnly cookie authentication (with no browser bearer), persisted sessions,
cross-tab account changes, deep-link reloads, decks,
preferences, confirmation dialogs, and private media without provider calls.
Use `bun run web:build` to verify the production export as well.

An Android release build is necessary but cannot prove device-only behavior. Run
`bun run mobile:smoke` and complete the physical-device acceptance list in
[`apps/mobile/e2e/android-smoke.md`](apps/mobile/e2e/android-smoke.md). It
covers authentication, decks, notes, drafts, review, media, settings,
development tools, connectivity, and the production HTTPS boundary.

## Development tools

The native development-tools screen exposes SRS reset controls and the
deterministic German seed fixture. It is available only while the app and API
are in development mode. The seed media is stored in the repository, so this
workflow does not require provider credentials.

## Generated drafts and media

Generation is a server-side job persisted as a draft. Navigating away,
backgrounding the app, or temporarily losing the network does not cancel it; the
client reconnects to the persisted snapshot. Cards and images settle
independently, edits autosave, and failures remain retryable.

Pronunciation uses ElevenLabs when `ELEVENLABS_API_KEY` is set. Generated image
and audio files are private server resources fetched with the current bearer
token on Android or the HttpOnly session cookie on web. The mobile client caches
audio only for playback and removes the cache
file when the player is released. On web the equivalent cache is an in-memory blob URL.

## Architecture

| Concern        | Choice                                                 |
| -------------- | ------------------------------------------------------ |
| Client         | Expo SDK 57, React Native 0.86, React Native Web, Expo Router |
| Server state   | TanStack Query with typed oRPC calls                   |
| Authentication | Better Auth; SecureStore bearers on Android, HttpOnly cookies on web |
| Backend        | Hono on Bun, SQLite via Drizzle, oRPC                  |
| AI             | OpenRouter integrations in the server only             |
| Scheduling     | `ts-fsrs` in the shared client                         |

The only client implementation is under `apps/mobile`. Server, database, and
framework-neutral shared code remain under `apps/server` and `libs/shared`.

## Layout

```text
apps/
  mobile/          # Expo Router app, React Native features and Jest tests
  server/          # Hono, Drizzle, oRPC, AI, TTS and backend tests
libs/
  shared/          # framework-neutral cloze parsing
data/              # SQLite database and generated media (gitignored)
```
