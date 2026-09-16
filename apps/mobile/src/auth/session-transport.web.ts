// This is only an invalidation marker, never a credential or session identifier.
const VERSION_KEY = "mnimi.session-version";
let localVersion = "";

export const usesCookieSession = true;
export const sessionCredentials = "include" as const;

export async function getSessionVersion(): Promise<string> {
  if (typeof window === "undefined") return localVersion;
  try {
    // Discard credentials saved by the pre-cookie web implementation.
    window.localStorage.removeItem("mnimi.bearer");
    return window.localStorage.getItem(VERSION_KEY) ?? "";
  } catch {
    // Cookie authentication still works if browser storage is unavailable.
    return localVersion;
  }
}

export function applySessionHeaders(headers: Headers, _version: string | null): void {
  headers.delete("authorization");
}

// Only Set-Cookie responses may change the browser's HttpOnly credentials.
export async function persistSession(_response: Response): Promise<void> {}
export async function clearSessionCredentials(): Promise<void> {}

export function publishSessionChange(): void {
  localVersion = `${Date.now()}-${Math.random()}`;
  try {
    window.localStorage.setItem(VERSION_KEY, localVersion);
  } catch { /* Cross-tab notifications are best effort when storage is disabled. */ }
}

/** Cover the response cookie write and local session publication in one lock. */
export async function withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) {
    throw new Error("Cookie sign-in requires a current browser using HTTPS or localhost.");
  }
  const version = await getSessionVersion();
  return navigator.locks.request("mnimi.cookie-session", async () => {
    // Do not apply a queued sign-out or preference change to a newer account.
    if (version !== await getSessionVersion()) {
      throw new Error("Your session changed. Please try again.");
    }
    return operation();
  });
}

export function onExternalSessionChanged(onChange: () => void): () => void {
  const changed = (event: StorageEvent) => {
    if (event.key === VERSION_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", changed);
  return () => window.removeEventListener("storage", changed);
}
