/**
 * @keel/csrf — stateless double-submit CSRF tokens.
 *
 *   const { token, cookie } = csrfToken(sessionId, secret); // mint + companion cookie
 *   // set `cookie` as a Set-Cookie; surface `token` to the page to resubmit
 *   verifyToken(token, sessionId, secret);                  // true iff the signature checks out
 *
 * It is a genuine *double-submit* battery: {@link csrfToken} mints the token AND
 * the companion cookie that carries it (the two channels of the pair), {@link csrf}
 * verifies the resubmitted token, and {@link generateToken}/{@link verifyToken} are
 * the underlying primitive. No server-side state: the HMAC signature is the proof.
 * `verifyToken` is total — it returns a boolean for every input and never throws.
 */

export { generateToken, verifyToken } from "./token";

// The issuance half of the double-submit pair: mint a token AND set its
// companion cookie, so the "double-submit" name is true end to end.
export { CSRF_COOKIE, csrfToken } from "./issue";
export type { CsrfTokenOptions, IssuedCsrfToken } from "./issue";

export { CSRF_DENIED_KIND, csrf, defaultExtractToken } from "./middleware";
export type { CsrfOptions } from "./middleware";

export { CsrfError, KeelError } from "./errors";
export type { CsrfErrorCode } from "./errors";

// The token-free companion: an Origin / Fetch-Metadata check that needs no
// client plumbing — the cheap, zero-config CSRF default for cookie-authed apps.
export { ORIGIN_DENIED_KIND, ORIGIN_STRICT_DENIED_KIND, originCheck } from "./origin";
export type { OriginCheckOptions } from "./origin";
