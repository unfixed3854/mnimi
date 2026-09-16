import { sessionAwareFetch } from "@/api/session-rejection";
import { clearSessionCredentials, withSessionLock } from "@/auth/session-transport";
import { getApiUrl } from "@/config/api-url";
import { useSyncExternalStore } from "react";

export type Session = {
  user: {
    id: string;
    email: string;
    name: string;
    nativeLanguage: string;
    uiLanguage: string;
    ttsAutoplay: boolean;
    aiInstructions: string;
  };
};

export type SessionState = {
  session: Session | null;
  status: "loading" | "ready" | "error";
};

const SESSION_INITIALIZATION_TIMEOUT_MS = 10_000;

let sessionState: SessionState = { session: null, status: "loading" };
let initialization: Promise<void> | null = null;
let rejected = false;
let sessionEpoch = 0;
const subscribers = new Set<() => void>();

function setSession(next: Session | null): void {
  if (sessionState.session === next) return;
  sessionState = { ...sessionState, session: next };
  subscribers.forEach((subscriber) => subscriber());
}

function setSessionStatus(status: SessionState["status"]): void {
  if (sessionState.status === status) return;
  sessionState = { ...sessionState, status };
  subscribers.forEach((subscriber) => subscriber());
}

/** Updates the synchronous route guard after a successful auth operation. */
export function setCurrentSession(next: Session | null): void {
  rejected = next === null;
  setSession(next);
  setSessionStatus("ready");
}

function asSession(value: unknown): Session | null {
  if (!value || typeof value !== "object" || !("user" in value)) return null;
  return value as Session;
}

export function getSession(): Session | null {
  return sessionState.session;
}

/** Returns both the synchronous route guard session and boot readiness. */
export function getSessionState(): SessionState {
  return sessionState;
}

export function subscribeAuth(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => subscribers.delete(onChange);
}

export function useSession(): Session | null {
  return useSyncExternalStore(subscribeAuth, getSession, getSession);
}

/** Called by auth mutations while they hold the cross-tab cookie-session lock. */
export async function refreshSession(): Promise<Session | null> {
  const epoch = sessionEpoch;
  const response = await sessionAwareFetch(
    `${getApiUrl()}/api/auth/get-session`,
    undefined,
    () => epoch === sessionEpoch,
  );
  if (!response.ok) {
    if (response.status === 401) await clearRejectedSession();
    return null;
  }
  const loaded = asSession(await response.json());
  if (epoch !== sessionEpoch) return null;
  rejected = false;
  setSession(loaded);
  return loaded;
}

/** Resolves the persisted bearer session once while retaining sync guard state. */
export function initializeSession(): Promise<void> {
  initialization ??= loadSession(sessionEpoch);
  return initialization;
}

/** Reconcile a browser tab after another tab signs in or out. */
export function reloadSession(): Promise<void> {
  sessionEpoch += 1;
  rejected = false;
  sessionState = { session: null, status: "loading" };
  subscribers.forEach((subscriber) => subscriber());
  initialization = loadSession(sessionEpoch);
  return initialization;
}

async function fetchSession(epoch: number): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Session initialization timed out"));
    }, SESSION_INITIALIZATION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      sessionAwareFetch(
        `${getApiUrl()}/api/auth/get-session`,
        { signal: controller.signal },
        () => epoch === sessionEpoch,
      ),
      timedOut,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadSession(epoch: number): Promise<void> {
  try {
    await withSessionLock(async () => {
      if (epoch !== sessionEpoch) return;
      const response = await fetchSession(epoch);
      if (epoch !== sessionEpoch) return;
      if (response.status === 401) {
        await clearRejectedSession();
        return;
      }
      if (!response.ok) {
        throw new Error(`Session initialization failed (${response.status})`);
      }
      const loadedSession = asSession(await response.json());
      // A 401 can end the session while this boot-time request is still in
      // flight. Its eventual 200 must not resurrect the rejected bearer.
      if (epoch !== sessionEpoch) return;
      rejected = false;
      setSession(loadedSession);
    });
    if (epoch === sessionEpoch) setSessionStatus("ready");
  } catch {
    if (epoch === sessionEpoch) setSessionStatus("error");
  }
}

/** Drops a bearer session after the server has refused it. */
export async function clearRejectedSession(): Promise<boolean> {
  if (rejected) return false;
  rejected = true;
  sessionEpoch += 1;
  await clearSessionCredentials();
  setSession(null);
  setSessionStatus("ready");
  return true;
}
