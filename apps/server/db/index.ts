import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.ts";
import { databaseUrl, ensureDatabaseDir } from "./url.ts";

// SQLite will not create a missing parent directory — it fails with
// SQLITE_CANTOPEN — and a fresh clone has no data/. Shared with
// drizzle.config.ts, which opens the same file without going through here.
ensureDatabaseDir();

const client = createClient({ url: databaseUrl });

// WAL is what these three buy: readers proceed while a write transaction is
// open, instead of blocking on it.
//
// busy_timeout does NOT cover concurrent writers, whatever it looks like here.
// A pragma is per-connection state, and @libsql/client hands its only
// connection to an open transaction and lazily opens an unconfigured second
// one for everything else — so the contended writer runs on a connection whose
// busy_timeout is 0 and fails with SQLITE_BUSY immediately. The pragma still
// helps the one connection it applies to, which is why it stays.
//
// What actually prevents overlapping writers is `withWriteLock` in
// ./write-lock.ts, which serialises writes in-process. See that file for why
// the obvious alternative (a client-level `timeout`) is worse.
await client.execute("PRAGMA journal_mode = WAL");
await client.execute("PRAGMA busy_timeout = 5000");
await client.execute("PRAGMA foreign_keys = ON");

export const db = drizzle({ client, schema });

export type Db = typeof db;
