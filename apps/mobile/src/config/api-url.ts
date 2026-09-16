declare const __DEV__: boolean;

type ApiUrlOptions = {
  apiUrl?: string;
  development?: boolean;
};

function isPrivateLanHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^(?:fc|fd)[0-9a-f:]*$/i.test(host)) return true;

  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }

  const [first, second] = octets;
  return first === 10 ||
    first === 192 && second === 168 ||
    first === 172 && second >= 16 && second <= 31;
}

/**
 * Validates the native app's API origin. Release builds never send bearer
 * credentials over cleartext; development may target an Android-reachable
 * private address such as a LAN server or the emulator's 10.0.2.2 alias.
 */
export function getApiUrl(options: ApiUrlOptions = {}): string {
  const apiUrl = options.apiUrl ?? process.env.EXPO_PUBLIC_API_URL;
  const development = options.development ?? __DEV__;

  if (!apiUrl) throw new Error("EXPO_PUBLIC_API_URL must be set");

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("EXPO_PUBLIC_API_URL must be a valid URL");
  }

  if (parsed.protocol === "https:") {
    // HTTPS is valid in both development and production.
  } else if (
    parsed.protocol === "http:" && development &&
    isPrivateLanHost(parsed.hostname)
  ) {
    // Cleartext is constrained to development-only private/LAN origins.
  } else if (!development) {
    throw new Error("EXPO_PUBLIC_API_URL must use HTTPS outside development");
  } else {
    throw new Error(
      "EXPO_PUBLIC_API_URL may use HTTP only for private LAN hosts in development",
    );
  }

  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("EXPO_PUBLIC_API_URL must be an origin");
  }

  return parsed.origin;
}
