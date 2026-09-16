import { createAuth } from "./auth.ts";
import { db } from "./db/index.ts";

/** The process-wide instance, over the real database. Only `main.ts` needs it;
 *  everything else takes an `Auth` as a parameter so it can be given a test
 *  instance instead. */
export const auth = createAuth(db);
