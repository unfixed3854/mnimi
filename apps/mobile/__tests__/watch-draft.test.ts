import { runDraftWatch } from "@/lib/watch-draft";
import type { DraftEvent } from "@/api/drafts";

describe("native draft watch", () => {
  it("reports a failure after the three reconnect attempts are exhausted", async () => {
    const dispatch = jest.fn();
    const failingOpen = jest.fn(() =>
      (async function* (): AsyncGenerator<DraftEvent> {
        throw new Error("offline");
      })()
    );

    await runDraftWatch(
      "draft-1",
      failingOpen,
      dispatch,
      new AbortController().signal,
      async () => {},
    );

    expect(failingOpen).toHaveBeenCalledTimes(4);
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "failed" }),
    );
  });
});
