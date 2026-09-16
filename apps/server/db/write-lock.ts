/**
 * Serialises write transactions across the whole process.
 *
 * `@libsql/client` hands its only connection to an open transaction and nulls
 * its own, so the next query lazily opens a SECOND connection — and
 * `PRAGMA busy_timeout` does not survive onto that new connection, because a
 * pragma is per-connection state and only the initial one was configured. A
 * second concurrent writer therefore fails immediately with `SQLITE_BUSY`
 * (measured: 0 ms, not the 5000 ms the pragma suggests).
 *
 * Setting `timeout` on the client is not a fix either. It does propagate to
 * lazily-opened connections, but the driver implements the wait as a busy-wait
 * that blocks the event loop — so the transaction holding the lock can never
 * reach its `commit()`, and the waiter burns the full timeout and fails anyway.
 *
 * This is a single-process self-hosted server, so an in-process promise chain
 * is both sufficient and the cheapest thing that actually works: writers queue
 * instead of colliding. Wrap every `db.transaction(...)` in it — and any write
 * likely to be issued alongside one, since a plain single-statement write on
 * that second connection loses the same race in ~1 ms.
 *
 * It is not a global guarantee: better-auth writes through `drizzleAdapter`,
 * which application code cannot route through here. Those are single
 * statements, so they hold the lock for microseconds rather than a
 * transaction's several round trips — which is where the contention was.
 *
 * Note the chain is deliberately kept alive across failures — a rejected job
 * must not poison the queue for everything behind it.
 */
export type WriteLock = Readonly<{
  withWriteLock<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

export function createWriteLock(): WriteLock {
  let tail: Promise<unknown> = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  return {
    withWriteLock<T>(work: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new Error("database write lock is closing"));
      const result = tail.then(work);
      tail = result.catch(() => {});
      return result;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      const capturedTail = tail;
      closePromise = capturedTail.then(() => undefined);
      return closePromise;
    },
  };
}

// Direct calls from tests retain a private fallback. Live request work enters
// `withWriteLockContext` from the scoped Database service, so it never relies
// on an installed process-wide lock binding.
const fallback = createWriteLock();
const currentLock = new AsyncLocalStorage<WriteLock>();

export function withWriteLockContext<A>(lock: WriteLock, work: () => Promise<A>): Promise<A> {
  return currentLock.run(lock, work);
}

export function withWriteLock<T>(work: () => Promise<T>): Promise<T> {
  return (currentLock.getStore() ?? fallback).withWriteLock(work);
}
import { AsyncLocalStorage } from "node:async_hooks";
