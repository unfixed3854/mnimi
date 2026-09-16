import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { pushSQLiteSchema } from "drizzle-kit/api";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "./schema.ts";

/**
 * A genuinely fresh database per test, with the schema pushed straight from
 * the Drizzle definitions — no migration files needed, so schema tests never
 * go stale against an unregenerated migration.
 *
 * A unique temp file, not an in-memory database, and both in-memory forms were
 * measured before settling here:
 *
 *   - `:memory:` gives every connection its own private database. Opening a
 *     transaction hands @libsql/client's only connection to that transaction
 *     and nulls its own, so the next query lazily opens a second connection —
 *     a brand-new empty database. Every query after the first transaction
 *     fails "no such table".
 *   - `file::memory:?cache=shared` fixes that, but shared-cache databases are
 *     keyed by name, so every call here would return the SAME database and
 *     tests would collide on unique constraints like user.email.
 *   - A distinct name via `mode=memory` would solve both, but @libsql/client
 *     rejects the `mode` query parameter.
 *
 * A temp file has none of these problems: isolated per call, and it survives
 * the transaction connection-swap because both connections open the same path.
 *
 * Callers must call `close()` — it drops the connection and removes the file.
 */
export async function createTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "mnimi-test-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle({ client, schema });
  // drizzle-kit bundles its own drizzle-orm declarations, whose private type
  // members differ from the runtime client package even though the API is
  // compatible. Keep that boundary local to this test helper.
  const { statementsToExecute } = await pushSQLiteSchema(
    schema,
    db as unknown as Parameters<typeof pushSQLiteSchema>[1],
  );
  // apply() commits every DDL statement separately. With parallel test files,
  // those repeated disk syncs can push fresh database setup past hook timeouts.
  // Build the same schema in one transaction, with one commit per database.
  await client.batch(statementsToExecute, "write");

  const close = () => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { db, client, close };
}
