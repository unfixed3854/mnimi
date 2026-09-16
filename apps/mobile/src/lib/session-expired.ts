/**
 * Raised when the server refused our bearer token — an opaque better-auth
 * session token, not a JWT, so it is the server's session record that is gone
 * rather than a signature that failed. Either way the session is dead and the
 * route guard is already on its way to /login. Callers should treat it as "no
 * longer this screen's problem" rather than as a failure to report.
 *
 * Its own module, with no imports, so a consumer can recognise it without
 * pulling in the auth client — which is why `watch-draft.ts` can check for
 * it while staying trivially testable.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super("Your session expired");
    this.name = "SessionExpiredError";
  }
}
