import { useEffect, useState } from "react";

/** Milliseconds since `startedAt`, ticking once a second while `running`. */
export function useElapsed(startedAt: number | null, running: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0);
      return;
    }

    // Settle on the true value the moment the run stops, rather than freezing
    // on whatever the last tick happened to catch up to a second earlier.
    setElapsed(Date.now() - startedAt);
    if (!running) return;

    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt, running]);

  return elapsed;
}
