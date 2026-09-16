# Root Environment File for Expo Design

## Goal

Make the Expo development server load `EXPO_PUBLIC_API_URL` from the repository-root `.env`, which remains the project's only environment file.

## Problem

`mobile:start` changes its working directory to `apps/mobile` before invoking Expo. Expo loads environment files relative to its project directory, so it does not see the root `.env`. As a result, `process.env.EXPO_PUBLIC_API_URL` is undefined in the JavaScript bundle even though the root file defines it.

## Design

The root `deno.json` task will pass the root `.env` explicitly to the Expo process while retaining `apps/mobile` as Expo's project directory. `mobile:start` is the sole mobile-development entry point, so `dev` inherits this behavior without a second configuration path.

The repository will not add `apps/mobile/.env` or duplicate the API URL. The root `.env` remains the single source for API, database, and server configuration, consistent with `.env.example` and the README.

## Validation

Add a focused task-level regression test that verifies `mobile:start` supplies the root environment file when it launches Expo. Keep the existing API URL validation tests unchanged; they cover the value after Expo has made it available to the bundle.

## User Experience

After the change, developers can put `EXPO_PUBLIC_API_URL` in root `.env` and run `deno task dev` or `deno task mobile:start` directly. A restarted Expo server picks up changes to the value; an already-built native release continues to use the value embedded at build time.
