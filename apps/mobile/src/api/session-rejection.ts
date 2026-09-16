import {
  applySessionHeaders,
  getSessionVersion,
  persistSession,
  sessionCredentials,
} from "@/auth/session-transport";

type SessionRejectionHandler = () => Promise<void> | void;

let handler: SessionRejectionHandler | null = null;
let rejectionInFlight: Promise<void> | null = null;

/** Registers the app-wide rejected-session cleanup and returns its teardown. */
export function onSessionRejected(next: SessionRejectionHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

function isRejectedSession(input: RequestInfo | URL, status: number): boolean {
  if (status !== 401) return false;
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : input.url;
  // A rejected email/password sign-in belongs to that form. Every other 401,
  // including authenticated preference changes, is a refused bearer session.
  return !url.includes("/api/auth/sign-in/email");
}

function rejectSessionOnce(): void {
  if (!handler || rejectionInFlight) return;
  rejectionInFlight = Promise.resolve(handler()).finally(() => {
    rejectionInFlight = null;
  });
}

/**
 * Web requests use HttpOnly cookies; native requests use SecureStore bearers.
 * Reject responses belonging to an account replaced while the request ran.
 */
export async function sessionAwareFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  isSessionCurrent: () => boolean = () => true,
): Promise<Response> {
  const headers = new Headers(
    init?.headers ??
      (typeof input === "string" || input instanceof URL
        ? undefined
        : input.headers),
  );
  const version = await getSessionVersion();
  applySessionHeaders(headers, version);

  // Keep the native cookie jar out of bearer requests. Browsers must send and
  // accept server-owned cookies, including cross-origin, same-site API calls.
  const response = await fetch(input, {
    ...init,
    headers,
    credentials: sessionCredentials,
  });
  // An old tab/request must neither replace a newer login nor refill its cache
  // with data from the previous account.
  if (!isSessionCurrent() || version !== await getSessionVersion()) {
    throw new Error("Your session changed. Please try again.");
  }
  await persistSession(response);
  if (isRejectedSession(input, response.status)) rejectSessionOnce();
  return response;
}
