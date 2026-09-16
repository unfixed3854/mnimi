import { getApiUrl } from "@/config/api-url.ts";

const rawApiUrl = process.argv[2] ?? "";

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function isLoopbackOrWildcard(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "[::]" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.");
}

try {
  const apiUrl = getApiUrl({ apiUrl: rawApiUrl, development: true });
  const parsed = new URL(apiUrl);

  if (isLoopbackOrWildcard(parsed.hostname)) {
    throw new Error(
      `EXPO_PUBLIC_API_URL must use the development machine's LAN host, not ${parsed.hostname}.`,
    );
  }

  if (parsed.protocol === "http:" && !isPrivateIpv4(parsed.hostname)) {
    throw new Error(
      "EXPO_PUBLIC_API_URL may use HTTP only with a private LAN IPv4 host (including Android emulator host 10.0.2.2).",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 64;
}
