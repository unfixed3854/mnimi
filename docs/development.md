# Developing mnimi

This guide covers local setup, daily development, and project verification. If
you want to run a private production instance, see the
[self-hosting guide](self-hosting.md).

## Prerequisites

- [mise](https://mise.jdx.dev/) for the pinned Node, Bun, Java 17, and Android
  SDK toolchain in `mise.toml`
- a browser, or an Android emulator or USB-debuggable Android device
- an OpenRouter API key for live generation, or an eligible ChatGPT plan for
  the private Codex option

## Setup

From the repository root:

```bash
mise install
bun install --frozen-lockfile
cp apps/mobile/.env.example apps/mobile/.env
cp apps/server/.env.example apps/server/.env
bun run db:migrate
bun run dev
```

An existing ignored root `.env` is no longer read. Split its values between
`apps/mobile/.env` and `apps/server/.env`.

Keep `BETTER_AUTH_SECRET`, provider credentials, database settings, AI settings,
and text-to-speech settings in the server file. Set `BETTER_AUTH_SECRET` to at
least 32 random characters. Only public mobile configuration belongs in
`apps/mobile/.env`; never put server secrets there or give them an
`EXPO_PUBLIC_` prefix.

### Choose an AI provider

The example server environment uses OpenRouter. To use Codex locally, replace
the active OpenRouter `AI_PROVIDER`, `CLASSIFY_MODEL`, `CLASSIFY_EFFORT`,
`GENERATE_MODEL`, and `GENERATE_EFFORT` assignments with the exact commented
Codex block in [`apps/server/.env.example`](../apps/server/.env.example). Do not
keep both provider bundles active.

After selecting Codex, authenticate it in your terminal:

```bash
bun run codex:login
```

### Create a local account

Public account creation is disabled by default. Set
`REGISTRATION_ENABLED=true` in `apps/server/.env` to expose signup in the app
and API. Any other value disables it.

To create an account while public registration is disabled, run this from the
repository root and enter the password at the hidden prompts:

```bash
bun run user:create -- --email ada@example.com --name "Ada"
```

## Daily development

In `apps/mobile/.env`, set `EXPO_PUBLIC_API_URL` to an API address the client can
reach. Use `http://10.0.2.2:8788` for an Android emulator. For a physical
device, use the development machine's private LAN address and keep both devices
on the same trusted Wi-Fi network:

```dotenv
EXPO_PUBLIC_API_URL=http://192.168.1.20:8788
```

`bun run dev` starts the API and Expo development server. The backend reloads
source changes and restarts automatically when `apps/server/.env` changes.
Invalid configuration stops the command; fix it and start it again. The API
binds to `HOST` (`0.0.0.0` by default), so do not expose it on an untrusted
network.

Useful commands:

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

Set this in `apps/mobile/.env`:

```dotenv
EXPO_PUBLIC_API_URL=http://localhost:8788
```

Start the API with `bun run server:dev`, run `bun run web:dev` in another
terminal, and open `http://localhost:8081`.

Use the same hostname for the browser and API: `localhost` and `127.0.0.1` are
different cookie sites. For LAN testing, use HTTPS and the same LAN hostname or
IP for both. The Android emulator's `10.0.2.2` alias is not a browser loopback
address.

The default browser allowlist covers `http://localhost:8081` and
`http://127.0.0.1:8081`. If you use another hostname or port, add its exact
origin to `CORS_ORIGIN` in `apps/server/.env`. This list controls both CORS and
Better Auth's origin checks.

Browsers may block pronunciation autoplay; use the playback or retry button
when that happens. Unsaved note edits prompt before closing or reloading a tab.
Back and Forward confirmation uses the Navigation API in current browsers;
older browsers still support in-app Cancel and the reload or close warning.

## Verification

Run the root checks and tests:

```bash
bun run check
bun run test
```

For browser verification, install Chromium once and then run the smoke test:

```bash
bun run web:test:install
bun run web:test
bun run web:build
```

The browser smoke test starts its own API, temporary database and media storage,
and Expo server. It covers authentication, persisted sessions, cross-tab
account changes, deep links, decks, preferences, confirmation dialogs, and
private media without calling an AI provider.

An Android release build cannot prove device-only behavior. Run
`bun run mobile:build:android`, then `bun run mobile:smoke` and complete the
[physical-device checklist](../apps/mobile/e2e/android-smoke.md).

## Development tools

The native development-tools screen exposes SRS reset controls and a
deterministic German seed fixture. It is available only while the app and API
are in development mode. Seed media is stored in the repository, so this
workflow does not require provider credentials.

## Runtime behavior

Generation is a server-side job persisted as a draft. Navigating away,
backgrounding the app, or briefly losing the network does not cancel it. Cards
and images settle independently, edits autosave, and failures remain retryable.

Pronunciation uses ElevenLabs when `ELEVENLABS_API_KEY` is set. Generated images
and audio are private resources fetched with the current bearer token on
Android or the HttpOnly session cookie on web. Android caches audio only for
playback and removes the file when the player is released; web uses a temporary
in-memory blob URL.

## Architecture

| Concern | Choice |
| --- | --- |
| Client | Expo SDK 57, React Native 0.86, React Native Web, Expo Router |
| Server state | TanStack Query with typed oRPC calls |
| Authentication | Better Auth; SecureStore bearers on Android, HttpOnly cookies on web |
| Backend | Hono on Bun, SQLite via Drizzle, oRPC |
| AI | OpenRouter or the private Codex integration, selected on the server |
| Scheduling | `ts-fsrs` in the shared client |

The only client implementation is under `apps/mobile`. Server, database, and
framework-neutral shared code remain under `apps/server` and `libs/shared`.

```text
apps/
  mobile/          # Expo Router app, React Native features and Jest tests
  server/          # Hono, Drizzle, oRPC, AI, TTS and backend tests
libs/
  shared/          # framework-neutral cloze parsing
data/              # SQLite database and generated media (gitignored)
```
