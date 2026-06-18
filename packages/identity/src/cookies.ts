/**
 * Cookie wiring for the identity session.
 *
 * The cookie name carries the `__Host-` prefix, which is browser-enforced: a
 * cookie with this name is only accepted when set with `Secure`, `Path=/`, and
 * no `Domain` — so the cookie cannot be set over plain HTTP or scoped to a
 * subdomain. The serializers honor that contract; readers and writers travel
 * through this module so the contract cannot drift.
 *
 * **Reverse-proxy gotcha.** `__Host-` is enforced *at the browser*, on the
 * scheme the browser observes. Behind a TLS-terminating proxy (Cloudflare,
 * an ALB, nginx) the origin sees plain HTTP — that's fine, the browser still
 * sees HTTPS. What is NOT fine is local dev over `http://localhost`: the
 * browser silently drops a `__Host-` cookie because the response is not
 * `Secure`. If you need a dev-mode escape hatch, rename the cookie
 * (`lesto_session_dev`) and drop `Secure` only in that mode — do not lie
 * about `Secure` on a real deployment.
 */

/** The session cookie name. The `__Host-` prefix is part of the contract. */
export const SESSION_COOKIE = "__Host-lesto_session";

/**
 * Serialize a `Set-Cookie` value for the session.
 *
 * `Secure` + `Path=/` + no `Domain` are mandatory for the `__Host-` prefix the
 * cookie name carries; `HttpOnly` keeps it off `document.cookie`; `SameSite=Lax`
 * is the baseline CSRF control (the double-submit token is the explicit one).
 */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** Serialize a `Set-Cookie` that clears the session — same attributes, expired. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Pull a single cookie's value out of a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;

  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");

    if (key === name) return rest.join("=");
  }

  return undefined;
}

/** Read the session token from a `Cookie` header, if any. */
export function readSessionToken(header: string | undefined): string | undefined {
  return readCookie(header, SESSION_COOKIE);
}
