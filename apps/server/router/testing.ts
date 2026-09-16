import { createTestDb } from "../db/testing.ts";
import { createAuth } from "../auth.ts";
import { and, desc, eq, ne } from "drizzle-orm";
import { makeCreationEvents } from "../effect/creation-events.ts";
import { drafts } from "../db/schema.ts";
import type { AppContext } from "./base.ts";

export async function createTestServer() {
  const { db, client, close } = await createTestDb();
  const events = makeCreationEvents({
    readDetail: async (userId, creationId) => {
      const [creation] = await db.select().from(drafts).where(and(
        eq(drafts.id, creationId),
        eq(drafts.userId, userId),
      )).limit(1);
      return creation ?? null;
    },
    readInbox: (userId) => db.select().from(drafts).where(and(
      eq(drafts.userId, userId),
      ne(drafts.status, "removed"),
    )).orderBy(desc(drafts.updatedAt), desc(drafts.id)),
  });
  const auth = createAuth(db, {
    secret: "test-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    registrationEnabled: true,
  });

  /** Signs a new user up and returns the context an authed call needs. */
  async function signIn(email: string): Promise<
    { userId: string; context: AppContext }
  > {
    const { response, headers } = await auth.api.signUpEmail({
      body: { email, password: "correct-horse", name: email.split("@")[0] },
      returnHeaders: true,
    });
    return {
      userId: response.user.id,
      context: {
        db,
        auth,
        events,
        devtoolsEnabled: true,
        reqHeaders: new Headers({
          authorization: `Bearer ${headers.get("set-auth-token")}`,
        }),
      },
    };
  }

  return { db, client, auth, events, signIn, close };
}

/**
 * Wraps a Drizzle instance so a delete from `table` throws — whether that
 * delete happens directly on the handle passed in, or inside a
 * `db.transaction(...)` callback (including nested transactions).
 *
 * Used to prove rollback when an earlier write in the same transaction has
 * already succeeded.
 */
export function failingDeleteFrom<T extends object>(
  db: T,
  table: unknown,
  message = "simulated delete failure",
): T {
  function wrap<U extends object>(target: U): U {
    return new Proxy(target, {
      get(innerTarget, prop, receiver) {
        if (prop === "delete") {
          return (arg: unknown) => {
            if (arg === table) throw new Error(message);
            return (innerTarget as { delete: (a: unknown) => unknown })
              .delete(arg);
          };
        }
        if (prop === "transaction") {
          return (callback: (tx: unknown) => unknown, ...rest: unknown[]) =>
            (innerTarget as { transaction: (...a: unknown[]) => unknown })
              .transaction(
                (tx: object) => callback(wrap(tx)),
                ...rest,
              );
        }
        return Reflect.get(innerTarget, prop, receiver);
      },
    });
  }

  return wrap(db);
}

/**
 * Wraps a Drizzle instance so an insert into `table` throws — whether that
 * insert happens directly on the handle passed in, or inside a
 * `db.transaction(...)` callback (including nested transactions).
 *
 * This is the ONLY way to prove a transaction actually rolls back. The
 * obvious approach — passing invalid data so the second insert violates NOT
 * NULL — does not work: oRPC validates input against the procedure's zod
 * schema BEFORE the handler runs, so the call fails with BAD_REQUEST and the
 * transaction is never opened. A test written that way passes whether or not
 * the transaction exists at all, which makes it worse than no test.
 *
 * Intercepting only inside `transaction` is not enough either: against an
 * implementation that dropped its transaction wrapper, the proxy would never
 * fire at all, and the test would fail on "expected a rejection" rather than
 * on the orphaned row it exists to catch. So `insert` is intercepted at
 * every level this wrapper can see — the handle itself and any transaction
 * (or nested transaction) opened from it.
 */
export function failingInsertInto<T extends object>(
  db: T,
  table: unknown,
  message = "simulated insert failure",
): T {
  function wrap<U extends object>(target: U): U {
    return new Proxy(target, {
      get(innerTarget, prop, receiver) {
        if (prop === "insert") {
          return (arg: unknown) => {
            if (arg === table) throw new Error(message);
            return (innerTarget as { insert: (a: unknown) => unknown })
              .insert(arg);
          };
        }
        if (prop === "transaction") {
          return (callback: (tx: unknown) => unknown, ...rest: unknown[]) =>
            (innerTarget as { transaction: (...a: unknown[]) => unknown })
              .transaction(
                (tx: object) => callback(wrap(tx)),
                ...rest,
              );
        }
        return Reflect.get(innerTarget, prop, receiver);
      },
    });
  }

  return wrap(db);
}

/**
 * Wraps a Drizzle instance so the FIRST `update` on `table` throws; every
 * call after that goes through untouched.
 *
 * Used to prove that a write failure happening AFTER some other action
 * already succeeded (e.g. `attachImage` claiming a draft image, then failing
 * to persist `imagePath`) surfaces as its own error rather than being
 * absorbed by a later, unrelated write to the same table — which is exactly
 * what a `try` wrapped too widely around both would do.
 */
export function failingUpdateOn<T extends object>(
  db: T,
  table: unknown,
  message = "simulated update failure",
): T {
  let thrown = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "update") {
        return (arg: unknown) => {
          if (arg === table && !thrown) {
            thrown = true;
            throw new Error(message);
          }
          return (target as { update: (a: unknown) => unknown }).update(arg);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Wraps a Drizzle instance so an `update` on `table` throws when `matches`
 * accepts the values it is being handed — matching on the payload rather than
 * on call order.
 *
 * {@link failingUpdateOn} cannot reach every write. It fails the FIRST update
 * on a table, and some branches are never first: the image stage's own
 * `imageStatus: "ready"` write is always preceded by a `patch` to the same
 * table, so the only fault injector available could not reach the catch that
 * stops a row wedging at `generating` forever. This one names the write it
 * wants by what that write says.
 *
 * The throw is raised from inside `.set()` rather than from `update()`, so
 * the values are there to inspect; everything else on the builder is passed
 * through to the real one, bound to the real one, because Drizzle's builders
 * carry private fields that a proxied `this` cannot reach.
 */
export function failingUpdateSet<T extends object>(
  db: T,
  table: unknown,
  matches: (values: Record<string, unknown>) => boolean,
  message = "simulated update failure",
): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "update") {
        return (arg: unknown) => {
          const builder = (target as { update: (a: unknown) => object })
            .update(arg);
          if (arg !== table) return builder;

          return new Proxy(builder, {
            get(innerTarget, innerProp) {
              const value = Reflect.get(innerTarget, innerProp, innerTarget);
              if (innerProp === "set") {
                return (values: Record<string, unknown>) => {
                  if (matches(values)) throw new Error(message);
                  return (value as (v: unknown) => unknown).call(
                    innerTarget,
                    values,
                  );
                };
              }
              return typeof value === "function"
                ? value.bind(innerTarget)
                : value;
            },
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
