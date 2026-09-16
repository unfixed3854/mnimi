/** Browser scripts cannot opt out of Origin/Fetch Metadata/Cookie headers. */
export function isBrowserRequest(request: Request): boolean {
  return ["origin", "sec-fetch-mode", "cookie"].some((name) => request.headers.has(name));
}

/** Keep Better Auth's bearer compatibility from exposing HttpOnly credentials. */
export async function cookieOnlyResponse(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.delete("set-auth-token");
  headers.delete("access-control-expose-headers");
  headers.set("cache-control", "no-store");
  let body: BodyInit | null = response.body;
  if (headers.get("content-type")?.includes("application/json")) {
    // Sign-in/up return a top-level token; get/list-session return nested ones.
    body = JSON.stringify(await response.json(), (key, value) => key === "token" ? undefined : value);
    headers.delete("content-length");
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
