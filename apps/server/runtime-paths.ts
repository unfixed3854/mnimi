import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function resolveRuntimePath(value: string): string {
  return isAbsolute(value) ? value : resolve(repositoryRoot, value);
}

export function resolveDatabaseUrl(value: string): string {
  if (!value.startsWith("file:") || value === "file::memory:") return value;
  const path = value.slice("file:".length);
  return isAbsolute(path) ? value : `file:${resolveRuntimePath(path)}`;
}
