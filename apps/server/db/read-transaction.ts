import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { Db } from "./index.ts";
import * as schema from "./schema.ts";

export type ReadDb = Pick<Db, "select">;

/**
 * Runs related reads in one libSQL read-only snapshot.
 *
 * Drizzle 0.45's libSQL adapter always opens its public `db.transaction()`
 * with the client's default mode, which is `write` in @libsql/client 0.17.
 * Starting the client transaction ourselves is the only public path in these
 * pinned versions that can request the non-blocking `read` mode explicitly.
 */
export async function withReadTransaction<T>(
  db: Db,
  read: (transaction: ReadDb) => Promise<T>,
): Promise<T> {
  const transaction = await db.$client.transaction("read");
  // Drizzle types its constructor to the wider Client interface. Read queries
  // only use execute/batch, both of which the libSQL Transaction implements;
  // the narrow ReadDb callback keeps unsupported client operations out of the
  // transaction-backed handle.
  const transactionDb = drizzle({
    client: transaction as unknown as Client,
    schema,
  });

  try {
    const result = await read(transactionDb);
    await transaction.commit();
    return result;
  } finally {
    // Idempotent after commit, and rolls the read transaction back if the
    // callback or commit failed.
    transaction.close();
  }
}
