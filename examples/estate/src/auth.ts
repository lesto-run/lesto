/**
 * CSRF wiring for the `/mls` zone's form posts.
 *
 * Session lifecycle (mint / verify / revoke) and the cookie attribute contract
 * (`__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`) now live in
 * `@keel/identity` — see {@link ./identity} for the service composition. This
 * file holds only the CSRF token helpers, which are policy of the *forms*
 * estate renders, not of the identity battery underneath.
 *
 * The token is the double-submit one from `@keel/csrf`: a stateless HMAC
 * bound to a session id (or the literal `anon` for the signed-out sign-in
 * form). The signed-out form has nothing real to bind to, so it binds to a
 * fixed anon id — the signature still proves the token was minted by this
 * origin (an attacker's page cannot forge the HMAC without the secret).
 */

import { generateToken, verifyToken } from "@keel/csrf";

/**
 * The HMAC secret backing CSRF token signatures.
 *
 * Read from `KEEL_CSRF_SECRET` so a real deployment supplies its own. The
 * demo fallback keeps the example runnable out of the box; it is NOT a
 * secret and a production deploy MUST set the env var. The signature is
 * only as strong as this value.
 */
const CSRF_SECRET = process.env["KEEL_CSRF_SECRET"] ?? "estate-demo-csrf-secret";

// The id a CSRF token is bound to when there is no session yet (sign-in).
const ANON_BINDING = "anon";

/** The hidden form field and the POST body key that carry the CSRF token. */
export const CSRF_FIELD = "_csrf";

/** Mint a CSRF token bound to a session token (authenticated flows: sign-out). */
export function csrfTokenForSession(sessionToken: string): string {
  return generateToken(sessionToken, CSRF_SECRET);
}

/** Mint a CSRF token for the signed-out sign-in form. */
export function csrfTokenForAnon(): string {
  return generateToken(ANON_BINDING, CSRF_SECRET);
}

/** Verify a CSRF token minted by {@link csrfTokenForSession}. */
export function verifyCsrfForSession(token: string, sessionToken: string): boolean {
  return verifyToken(token, sessionToken, CSRF_SECRET);
}

/** Verify a CSRF token minted by {@link csrfTokenForAnon}. */
export function verifyCsrfForAnon(token: string): boolean {
  return verifyToken(token, ANON_BINDING, CSRF_SECRET);
}
