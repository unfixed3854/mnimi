import { getApiUrl } from "@/config/api-url";
import { sessionAwareFetch } from "@/api/session-rejection";

/** Fetches private media as bytes; callers own the platform media resource. */
export async function fetchAuthenticatedMedia(
  path: string,
): Promise<Uint8Array> {
  const response = await sessionAwareFetch(`${getApiUrl()}${path}`);
  if (!response.ok) throw new Error(`Media request failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function imageMediaPath(scope: "notes" | "drafts", id: string): string {
  return `/images/${scope}/${id}`;
}

export function cardAudioMediaPath(cardId: string): string {
  return `/audio/cards/${cardId}`;
}
