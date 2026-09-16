# Self-hosting mnimi

mnimi is designed for a private, personal deployment. The web app and Android
client share one API and account system. The API uses SQLite and must run as a
single replica with durable storage.

For local development, see the [development guide](development.md).

## Deploy the web app

Build the single-page app with the public HTTPS API URL compiled into it:

```bash
EXPO_PUBLIC_API_URL=https://api.example.com bun run web:build
```

Serve `apps/mobile/dist` over HTTPS and configure the host to fall back to
`index.html` for app routes such as `/decks/<id>` and `/notes/<id>`. Rebuild
when the API URL changes.

Set the API's `CORS_ORIGIN` to the app's exact HTTPS origin and
`BETTER_AUTH_URL` to the API's public HTTPS URL. Host the app and API on the
same site—for example, `app.example.com` and `api.example.com`—or reverse-proxy
the API under the app's origin. Unrelated frontend and API domains are not
supported by the SameSite=Lax cookie policy. Expo's
[web publishing guide](https://docs.expo.dev/guides/publishing-websites/) has
host-specific single-page app examples.

### Browser security model

Browser sessions use server-set, host-only HttpOnly cookies with SameSite=Lax
and Secure on HTTPS and in production. Local HTTP development is the exception.
Browser requests include cookies, never an Authorization bearer, and auth
responses do not expose session tokens in headers or JSON.

The API checks browser mutation origins in addition to CORS. Only a non-secret
change marker is stored in localStorage to notify other tabs to refresh their
session and clear cached account data; any legacy stored bearer is removed.
Auth operations are serialized across tabs using Web Locks, which requires a
current browser on HTTPS or localhost. A failed web sign-out remains signed in
so it can be retried because JavaScript cannot clear an HttpOnly cookie. See
Better Auth's [cookie documentation](https://better-auth.com/docs/concepts/cookies).

Private images and audio are fetched with the platform's credentials and shown
through temporary blob URLs on web. Those URLs are revoked when released.

## Deploy the API

The API image includes the Bun server and checked-in Drizzle migrations, but no
secrets or runtime data. SQLite, generated images, generated audio, and Codex
credentials all share durable storage mounted at `/data`. Running more than one
API replica against that volume is unsupported.

Build the image from the repository root:

```bash
podman build -t mnimi-api -f Containerfile .
```

Create a host-only environment file such as `mnimi-api.env`. Do not add it to
the image or source control:

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

Include optional ElevenLabs and model-selection variables from
[`apps/server/.env.example`](../apps/server/.env.example) when needed.
`OPENROUTER_API_KEY` and `IMAGE_MODEL` apply only to OpenRouter.
`CORS_ORIGIN` is a comma-separated allowlist for browser clients; the native app
uses bearer authentication without an Origin header.

## Choose an AI provider

Select one complete provider bundle with `AI_PROVIDER`. OpenRouter is the
default. Switching providers requires a restart and never enables automatic
fallback.

### Private Codex option

The Codex app-server integration is experimental and intended only for the
operator's private instance. Never give other people access to an instance
backed by the operator's Codex subscription. It requires an eligible ChatGPT
plan, though availability is not guaranteed by every plan.

Codex mode requires Linux with `/proc/self/fd` available for secure workspace
file access; use the supplied Linux container on other hosts. Generation is
refused if the required file primitives are unavailable.

Use this provider block instead of the OpenRouter values:

```dotenv
AI_PROVIDER=codex
CLASSIFY_MODEL=gpt-5.6-luna
CLASSIFY_EFFORT=low
GENERATE_MODEL=gpt-5.6-sol
GENERATE_EFFORT=high
CODEX_HOME=/data/codex
REGISTRATION_ENABLED=false
```

The Luna/low pair handles classification and routing; Sol/high handles
generation and adjustments. `IMAGE_MODEL` is ignored because Codex uses its
service-selected image model. At startup, the server refreshes authentication
and verifies the ChatGPT account type, both models and effort levels, and image
capability before accepting requests.

If Codex reaches a usage limit, that operation fails. It does not fall back to
OpenRouter or create an OpenRouter charge.

Authenticate in an operator-controlled terminal. Keep the device-login URL and
code in that terminal; do not paste them into the service or expose them to
users:

```bash
podman run --rm -it \
  --env-file mnimi-api.env \
  --volume mnimi-data:/data \
  mnimi-api bun run codex:login
```

Run this once for a new persistent volume and again when authentication needs
refreshing. `/data/codex/auth.json` is a password-equivalent secret. Treat the
entire data volume and its backups as password-equivalent too.

## Migrate and start

Apply database migrations as a release step before replacing the API container:

```bash
podman run --rm \
  --env-file mnimi-api.env \
  --volume mnimi-data:/data \
  mnimi-api bun run db:migrate
```

Start one API replica with the same persistent volume:

```bash
podman run --detach --replace --name mnimi-api \
  --env-file mnimi-api.env \
  --publish 8788:8788 \
  --volume mnimi-data:/data \
  mnimi-api
```

Put an HTTPS-capable reverse proxy or load balancer in front of port 8788. Use
its public hostname in the production mobile build's `EXPO_PUBLIC_API_URL`, for
example `https://api.example.com`.

The app intentionally has no unauthenticated health endpoint. Configure a TCP
health check on port 8788 or provide an authenticated application check outside
this container setup.

After deployment, you can perform a live provider smoke test: create one text
draft, request one image, and confirm that both settle. In Codex mode this
consumes the operator's Codex allowance.
