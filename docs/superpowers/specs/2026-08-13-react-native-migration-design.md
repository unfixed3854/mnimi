# React Native Migration

## Goal

Replace the Tauri/Vite React client with an Android-first Expo application.
Rename `apps/app` to `apps/mobile`, retain all user-facing learning workflows,
and continue using the existing Deno server and shared domain code. The first
release supports Android only and uses an Expo development build during local
development.

The migration is feature-for-feature except for browser-only developer tools.
TanStack's React DOM devtools will not ship in the native client. The existing
mnimi debug capabilities backed by the server's `debug` router remain available
through a development-only in-app tools screen.

## Architecture

`apps/mobile` is an Expo application using Expo Router for navigation. It owns
native screens for authentication, deck lists and details, notes, add/edit
flows, review, settings, and development tools. Each screen uses React Native
primitives and platform-appropriate interactions rather than preserving the
web DOM or CSS implementation.

`apps/server` remains the Deno/Hono/oRPC backend and `libs/shared` remains the
framework-neutral shared package. The server's API contracts, database,
scheduling rules, generation jobs, and media endpoints are unchanged except
for client-origin configuration required by a native app.

Portable client behavior is moved or recreated behind native-friendly
boundaries:

- oRPC client setup, query keys, mutation invalidation, FSRS calculation,
  draft polling, and API-error classification keep their existing semantics.
- Session tokens move from browser `localStorage` to `expo-secure-store`.
- Card audio uses Expo's native audio API, with a lifecycle-safe playback
  interface.
- Images use native image components and the existing authenticated media
  endpoints.
- React Query integrates Android app foreground/background and network state
  through `AppState` and NetInfo, so reconnect and focus refetching work as
  they do in the web client.

The resulting top-level layout is:

```text
apps/
  mobile/    # @mnimi/mobile: Expo Router Android client
  server/    # @mnimi/server: Deno API, database, migrations
libs/
  shared/    # @mnimi/shared: framework-neutral utilities
```

## API and Environment

The mobile application reads `EXPO_PUBLIC_API_URL`. Local LAN development uses
the development workstation's reachable private IP address, not Android's
`localhost`. The Deno server must bind so an Android device can reach it and
must accept the native application's requests without relying on a browser
origin.

Development may use HTTP on the local network with Android network-security
configuration scoped to development builds. Production API URLs must use HTTPS.
The root environment-file convention remains the source of server secrets;
the mobile app exposes only the public API URL through Expo's public variable
mechanism.

## Tooling and Migration Boundaries

Remove the browser/desktop implementation once equivalent native behavior is
in place:

- Vite, the TanStack Router Vite plugin, React DOM, web Tailwind UI, and web
  route generation are replaced by Expo and Expo Router.
- Tauri configuration, Rust sources, Tauri plugins, and Tauri-specific build
  and development scripts are removed.
- Root Deno tasks are retargeted for the renamed `apps/mobile` workspace and
  remain the project's only supported command interface. No npm, npx, yarn, or
  pnpm command is introduced.

The Android development workflow creates and runs an Expo development build;
it does not promise Expo Go compatibility. Android-native permissions and
configuration needed for network access and audio are checked into the Expo
app configuration.

## Error Handling

Unauthenticated or expired requests clear the secure token and route to sign
in, preserving the current session-expiry behavior. Network failures retain
clear retry/error states rather than silently treating a failed API call as an
empty result. Audio, image, and generation failures remain locally visible and
do not corrupt draft or card state. The dev-only tools screen is unavailable
from production builds.

## Testing and Verification

Keep the Deno API and shared-unit suite intact. Replace browser-specific
component tests with native component and navigation tests that cover the
native storage, request, error, and rendering boundaries. Verify the portable
client logic without coupling it to platform-specific views.

Before completion, demonstrate:

- Root Deno checks and the API/shared tests pass.
- The Expo project typechecks and produces an Android development build.
- An Android device on the LAN can sign in and call the Deno API.
- A smoke flow covers sign-in, deck creation/removal, note/card creation and
  editing, review grading, image display, and audio playback.
- The production configuration rejects a non-HTTPS API endpoint or otherwise
  cannot accidentally permit development-only cleartext traffic.

## Non-Goals

- iOS or web support in this migration.
- Maintaining the Tauri desktop build or a WebView wrapper.
- Replacing the Deno server, oRPC API, database, or shared scheduling domain.
- Shipping TanStack's browser devtools inside the Android application.
