/**
 * The companion-cookie serializer for the double-submit pair.
 *
 * One place owns the cookie attributes so they cannot drift between issuance
 * call sites. The double-submit companion is unlike a session cookie in one
 * deliberate way: it is **NOT `HttpOnly`**. The mechanism requires the page to
 * read the value back and resubmit it on a second channel (a header / form
 * field); an `HttpOnly` cookie the page cannot read would break that. It is safe
 * to expose because the token is not a credential — it authorizes nothing on its
 * own and is bound to the session by HMAC, so a value read on one origin is
 * useless against another session.
 *
 * The attributes that DO matter:
 *   - `SameSite=Strict` — the cookie is for our own same-origin forms; it never
 *     needs to ride a cross-site navigation, so the strictest setting fits and
 *     adds defense in depth.
 *   - `Secure` — never sent over plain HTTP.
 *   - `Path=/` — available to every route that might mint a guarded request.
 */

/**
 * Serialize a `Set-Cookie` value for the double-submit companion cookie.
 *
 * `SameSite=Strict; Secure; Path=/` and — by design — no `HttpOnly`, because the
 * page must read the value back to resubmit it (see the module doc).
 */
export function companionCookie(name: string, value: string): string {
  return `${name}=${value}; Path=/; Secure; SameSite=Strict`;
}
