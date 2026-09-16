#!/usr/bin/env bash

set -euo pipefail

usage_error() {
  printf '%s\n' "$1" >&2
  exit 64
}

api_url="${EXPO_PUBLIC_API_URL:-}"
[[ -n "$api_url" ]] || usage_error \
  "EXPO_PUBLIC_API_URL is required (for example, http://192.168.1.20:8788)."

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bun run "$script_dir/validate-api-url.ts" "$api_url" || exit $?

printf 'API URL validated for Android smoke testing: %s\n' "$api_url"

if [[ "${1:-}" == "--check" ]]; then
  exit 0
fi
if [[ $# -gt 0 ]]; then
  usage_error "Unknown argument: $1"
fi

repo_root="$(cd -- "$script_dir/../../.." && pwd)"

printf '%s\n' \
  "Starting the API on all interfaces and the Expo development client." \
  "Keep the Android device on the same trusted Wi-Fi network." \
  "Follow apps/mobile/e2e/android-smoke.md for acceptance checks."
cd "$repo_root"
HOST=0.0.0.0 bun run dev
