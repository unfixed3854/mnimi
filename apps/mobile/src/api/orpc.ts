import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { getApiUrl } from "@/config/api-url";
import { sessionAwareFetch } from "@/api/session-rejection";

const link = new RPCLink({
  url: `${getApiUrl()}/rpc`,
  fetch: (request, init) => sessionAwareFetch(request, init),
});

// Server source is Bun-specific and cannot be included in Expo's TypeScript
// program. Native hooks declare their public result types at their boundary.
export const client = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client) as any;

/** Shared by mutations until the native draft hook is introduced. */
export function getDraftsQueryKey(): readonly unknown[] {
  return orpc.drafts.key();
}
