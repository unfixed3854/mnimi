import { SessionExpiredError } from "@/lib/session-expired";
import type { DraftEvent } from "@/api/drafts";

export const MAX_RECONNECTS = 3;
const BACKOFF_MS = [500, 1500, 4000];

/** Reopens a transport-only failure; generation failures are watch events. */
export async function runDraftWatch(
  draftId: string,
  open: (draftId: string, signal: AbortSignal) => AsyncIterable<DraftEvent>,
  dispatch: (event: DraftEvent) => void,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0;; attempt++) {
    try {
      for await (const event of open(draftId, signal)) dispatch(event);
      return;
    } catch (error) {
      if (signal.aborted || error instanceof SessionExpiredError) return;
      if (attempt >= MAX_RECONNECTS) {
        dispatch({
          type: "failed",
          message:
            "The connection dropped and could not be restored — reopen this page to try again.",
        });
        return;
      }
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    }
  }
}
