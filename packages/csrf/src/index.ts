/**
 * @keel/csrf — stateless double-submit CSRF tokens.
 *
 *   const token = generateToken(secret);   // hand to the client (cookie + form field)
 *   verifyToken(token, secret);            // true iff the signature checks out
 *
 * No server-side state: the HMAC signature is the proof. `verifyToken` is total —
 * it returns a boolean for every input and never throws.
 */

export { generateToken, verifyToken } from "./token";
