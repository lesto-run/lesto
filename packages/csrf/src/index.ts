/**
 * @keel/csrf — stateless double-submit CSRF tokens.
 *
 *   const token = generateToken(sessionId, secret); // hand to the client (cookie + form field)
 *   verifyToken(token, sessionId, secret);           // true iff the signature checks out for this session
 *
 * No server-side state: the HMAC signature is the proof. `verifyToken` is total —
 * it returns a boolean for every input and never throws.
 */

export { generateToken, verifyToken } from "./token";

export { csrf, defaultExtractToken } from "./middleware";
export type { CsrfOptions } from "./middleware";

// The token-free companion: an Origin / Fetch-Metadata check that needs no
// client plumbing — the cheap, zero-config CSRF default for cookie-authed apps.
export { originCheck } from "./origin";
export type { OriginCheckOptions } from "./origin";
