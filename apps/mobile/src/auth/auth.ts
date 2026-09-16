import { AuthError } from "@/auth/auth-error";
import { getApiUrl } from "@/config/api-url";
import { sessionAwareFetch } from "@/api/session-rejection";
import {
  clearSessionCredentials,
  getSessionVersion,
  publishSessionChange,
  usesCookieSession,
  withSessionLock,
} from "@/auth/session-transport";
import { refreshSession, setCurrentSession } from "@/auth/session-store";

type SignedOutHandler = () => void | Promise<void>;

let signedOutHandler: SignedOutHandler | null = null;

/** Registers native cleanup that must accompany an intentional sign-out. */
export function onSignedOut(next: SignedOutHandler): () => void {
  signedOutHandler = next;
  return () => {
    if (signedOutHandler === next) signedOutHandler = null;
  };
}

async function authRequest(path: string, body?: object): Promise<Response> {
  return sessionAwareFetch(`${getApiUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function requireSuccess(
  response: Response,
  fallback: string,
): Promise<void> {
  if (response.ok) return;
  let message = fallback;
  try {
    const body = await response.json() as { message?: string };
    message = body.message ?? fallback;
  } catch { /* API errors are not required to contain JSON. */ }
  throw new Error(message);
}

async function authenticate(
  path: string,
  email: string,
  password: string,
): Promise<void> {
  const response = await authRequest(path, {
    email,
    password,
    ...(path.includes("sign-up") ? { name: email.split("@")[0] || email } : {}),
  });
  await requireSuccess(
    response,
    path.includes("sign-up")
      ? "Couldn't create your account."
      : "Couldn't sign you in.",
  );
  publishSessionChange();
  if (!await refreshSession()) {
    const message = path.includes("sign-up")
      ? "Please sign in to continue."
      : "Please try signing in again.";
    const cookieHelp = usesCookieSession
      ? " Check that cookies are allowed for this site."
      : "";
    const developmentHelp = usesCookieSession && __DEV__
      ? ` For local web development, use the same hostname for the app and API (for example, localhost for both). Current API: ${getApiUrl()}. Different sites can block session cookies.`
      : undefined;
    throw new AuthError(
      path.includes("sign-up") ? "Account created, but sign-in failed" : "Couldn't sign you in",
      message + cookieHelp,
      developmentHelp?.trim(),
    );
  }
}

export function signIn(email: string, password: string): Promise<void> {
  return withSessionLock(() => authenticate("/api/auth/sign-in/email", email, password));
}

export function signUp(email: string, password: string): Promise<void> {
  return withSessionLock(() => authenticate("/api/auth/sign-up/email", email, password));
}

export async function getRegistrationEnabled(): Promise<boolean> {
  const response = await fetch(`${getApiUrl()}/api/registration`);
  if (!response.ok) throw new Error("Couldn't check registration availability");

  const body: unknown = await response.json();
  if (
    typeof body !== "object" || body === null ||
    typeof (body as { enabled?: unknown }).enabled !== "boolean"
  ) {
    throw new Error("Invalid registration availability response");
  }
  return (body as { enabled: boolean }).enabled;
}

export function signOut(): Promise<void> {
  return withSessionLock(signOutSession);
}

async function signOutSession(): Promise<void> {
  const version = await getSessionVersion();
  let failure: Error | null = null;
  try {
    await requireSuccess(
      await authRequest("/api/auth/sign-out"),
      "Sign out failed",
    );
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Sign out failed");
  }
  // JavaScript cannot clear an HttpOnly cookie: a failed web sign-out must
  // remain signed in and retryable, rather than only appearing to sign out.
  if (failure && usesCookieSession) throw failure;
  // A delayed sign-out from one tab must not erase another tab's newer login.
  if (version === await getSessionVersion()) {
    await clearSessionCredentials();
    publishSessionChange();
    try {
      await signedOutHandler?.();
    } finally {
      setCurrentSession(null);
    }
  }
  if (failure) throw failure;
}

async function updateUser(patch: object, fallback: string): Promise<void> {
  const response = await authRequest("/api/auth/update-user", patch);
  await requireSuccess(response, fallback);
  await refreshSession();
}

export function updateNativeLanguage(nativeLanguage: string): Promise<void> {
  return withSessionLock(() => updateUser({ nativeLanguage }, "Failed to update language"));
}

export function updateTtsAutoplay(ttsAutoplay: boolean): Promise<void> {
  return withSessionLock(() => updateUser({ ttsAutoplay }, "Failed to update autoplay"));
}

export function updateAiInstructions(aiInstructions: string): Promise<void> {
  return withSessionLock(() => updateUser(
    { aiInstructions },
    "Failed to update AI instructions",
  ));
}
