import { mkdirSync } from "node:fs";
import { resolveDatabaseUrl } from "../runtime-paths.ts";

/** The SQLite URL every entry point opens. */
export const databaseUrl = resolveDatabaseUrl(
  process.env.DATABASE_URL ?? "file:./data/mnimi.db",
);

/**
 * Guarantees the database's parent directory exists.
 *
 * Shared by the runtime client and `drizzle.config.ts`, because both open the
 * same file and SQLite will not create a missing parent — it fails with
 * SQLITE_CANTOPEN. Without this on the drizzle-kit side, `bun run db:migrate`
 * fails on a clean checkout before anything else can run.
 *
 * Synchronous so a config file can call it without top-level await.
 */
export function ensureDatabaseDir(url = databaseUrl): void {
  if (!url.startsWith("file:")) return;
  const path = url.slice("file:".length);
  const separator = path.lastIndexOf("/");
  // No separator, or one at index 0, means there is no directory component to
  // create — a bare filename, or a path already at the root.
  if (separator <= 0) return;
  mkdirSync(path.slice(0, separator), { recursive: true });
}
