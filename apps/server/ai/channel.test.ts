import { describe, expect, it } from "vitest";
import { channel } from "./channel.ts";

/** Drains an iterable into an array. */
async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of source) out.push(value);
  return out;
}

describe("channel", () => {
  it("delivers values pushed before anyone started reading", async () => {
    const ch = channel<number>();
    ch.push(1);
    ch.push(2);
    ch.close();

    expect(await drain(ch)).toEqual([1, 2]);
  });

  it("delivers values pushed while a reader is waiting", async () => {
    const ch = channel<number>();
    const read = drain(ch);

    // A tick, so the reader is genuinely parked on its promise.
    await Promise.resolve();
    ch.push(1);
    ch.push(2);
    ch.close();

    expect(await read).toEqual([1, 2]);
  });

  it("replaces the tail when canReplace says so", async () => {
    const ch = channel<{ type: string; n: number }>(
      (previous, next) => previous.type === "cards" && next.type === "cards",
    );
    ch.push({ type: "cards", n: 1 });
    ch.push({ type: "cards", n: 2 });
    ch.push({ type: "cards", n: 3 });
    ch.close();

    expect(await drain(ch)).toEqual([{ type: "cards", n: 3 }]);
  });

  it("never coalesces across a differing event", async () => {
    const ch = channel<{ type: string; n: number }>(
      (previous, next) => previous.type === "cards" && next.type === "cards",
    );
    ch.push({ type: "cards", n: 1 });
    ch.push({ type: "done", n: 0 });
    ch.push({ type: "cards", n: 2 });
    ch.close();

    expect(await drain(ch)).toEqual([
      { type: "cards", n: 1 },
      { type: "done", n: 0 },
      { type: "cards", n: 2 },
    ]);
  });

  it("yields everything already queued before reporting a failure", async () => {
    const ch = channel<number>();
    ch.push(1);
    ch.fail(new Error("boom"));

    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const value of ch) seen.push(value);
      })(),
    ).rejects.toThrow("boom");
    expect(seen).toEqual([1]);
  });

  it("ignores pushes after close", async () => {
    const ch = channel<number>();
    ch.push(1);
    ch.close();
    ch.push(2);

    expect(await drain(ch)).toEqual([1]);
  });
});
