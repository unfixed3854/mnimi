/**
 * A single-consumer async queue: a producer pushes, one iterator drains.
 *
 * `generate-note.ts` needs nothing like this — it is pulled by a synchronous
 * `.next()` loop, and the 2026-08-07 spec was right to refuse a queue for
 * that. A detached job has no such driver: it runs on its own schedule and
 * subscribers appear and vanish underneath it, so the callback-to-iterator
 * bridge is real here.
 *
 * `canReplace` is how a producer that emits full snapshots avoids an
 * unbounded queue behind a stalled reader. When it returns true the incoming
 * value REPLACES the tail rather than being appended. Dropping the oldest
 * would lose terminal events and blocking the producer would let a slow
 * client slow down generation, so replacing the tail is the only one of the
 * three that is both bounded and lossless in the sense that matters.
 *
 * One iterator per channel. Two would share `wake`, and the second would
 * strand the first.
 */
export type Channel<T> = {
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
  [Symbol.asyncIterator](): AsyncGenerator<T>;
};

export function channel<T>(
  canReplace: (previous: T, next: T) => boolean = () => false,
): Channel<T> {
  const queue: T[] = [];
  let closed = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;

  function signal() {
    const resolve = wake;
    wake = null;
    resolve?.();
  }

  return {
    push(value) {
      if (closed) return;
      const last = queue.length - 1;
      if (last >= 0 && canReplace(queue[last], value)) queue[last] = value;
      else queue.push(value);
      signal();
    },

    close() {
      if (closed) return;
      closed = true;
      signal();
    },

    fail(error) {
      if (closed) return;
      closed = true;
      // Not thrown until the queue is drained: a failure must not swallow
      // events the producer already reported.
      failure = error ?? new Error("channel failed");
      signal();
    },

    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) yield queue.shift() as T;
        if (closed) {
          if (failure !== null) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
