import { clearToken, getToken, setToken } from "@/auth/token-store";

export const usesCookieSession = false;
export const sessionCredentials = "omit" as const;
export const getSessionVersion = getToken;
export const clearSessionCredentials = clearToken;

export function applySessionHeaders(headers: Headers, token: string | null): void {
  if (token) headers.set("authorization", `Bearer ${token}`);
  else headers.delete("authorization");
}

export async function persistSession(response: Response): Promise<void> {
  const token = response.headers.get("set-auth-token");
  if (token) await setToken(token);
}

export function publishSessionChange(): void {}

export function withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

/** Native sessions do not share credentials with other browser tabs. */
export function onExternalSessionChanged(_onChange: () => void): () => void {
  return () => {};
}
