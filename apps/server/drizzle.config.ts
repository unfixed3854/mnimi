import { defineConfig } from "drizzle-kit";
import { databaseUrl, ensureDatabaseDir } from "./db/url.ts";

// drizzle-kit opens the database directly rather than through db/index.ts, so
// it needs the parent directory created here too. Without this, `bun run
// db:migrate` fails SQLITE_CANTOPEN on a clean checkout.
ensureDatabaseDir();

// drizzle-kit runs these paths from the server package, where this config is
// invoked by the package-local db:* scripts. The import above is an ESM
// specifier, so that one stays relative to this file.
export default defineConfig({
  dialect: "sqlite",
  schema: "./db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
});
