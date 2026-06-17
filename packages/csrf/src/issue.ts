/**
 * CSRF token issuance — mint a double-submit token AND its companion cookie.
 *
 * The {@link generateToken} primitive mints the signed token; this is the half
 * that closes the *double-submit* loop. A double-submit defense works because
 * the same token rides on two channels the attacker cannot both control:
 *
 *   1. a cookie the browser attaches automatically (the *companion* cookie), and
 *   2. a value the page reads back and resubmits in a header or form field.
 *
 * A cross-site page can make the browser send the cookie, but the same-origin
 * policy stops it from *reading* the cookie's value — so it cannot put the
 * matching value on channel 2. The server checks the two agree (here, via the
 * HMAC binding {@link verifyToken} already enforces), and the forgery fails.
 *
 * `@keel/csrf` had the token primitive and the verifying middleware but no helper
 * that actually SET the companion cookie — leaving every app to re-derive the
 * cookie attributes, the half a "double-submit" battery exists to provide. This
 * is that helper: mint a token bound to the session and serialize the cookie that
 * carries it, with the attributes the pattern requires.
 *
 * The companion cookie is deliberately **readable by JavaScript** (no `HttpOnly`):
 * the whole mechanism needs the page to read the value back and resubmit it. That
 * is safe — the token is not a credential (it authorizes nothing on its own; it
 * only proves request provenance), and it is bound to the session by HMAC, so a
 * token read on one origin is useless against another session. It carries
 * `SameSite=Strict` (the cookie is for our own forms, never a cross-site
 * navigation), `Secure`, and `Path=/`.
 */

import { companionCookie } from "./cookie";
import { generateToken } from "./token";

/** The default name of the double-submit companion cookie. */
export const CSRF_COOKIE = "csrf_token";

/** What {@link csrfToken} accepts beyond the session id and secret. */
export interface CsrfTokenOptions {
  /**
   * The companion cookie's name. Defaults to {@link CSRF_COOKIE}. Override to
   * namespace it (e.g. per-app) or to match a name the client already reads.
   */
  readonly cookieName?: string;
}

/**
 * A freshly issued CSRF token and the `Set-Cookie` that delivers its companion.
 *
 * `token` is the value handed to the page to resubmit (the `x-csrf-token` header
 * or the `_csrf` form field the {@link csrf} middleware reads); `cookie` is the
 * `Set-Cookie` line that plants the matching companion cookie. Put `cookie` on
 * the response (the multi-`Set-Cookie` list arm lets it ride alongside a session
 * cookie) and surface `token` to the page.
 */
export interface IssuedCsrfToken {
  /** The double-submit token, to be resubmitted on a guarded request. */
  readonly token: string;

  /** The `Set-Cookie` value that plants the companion cookie carrying `token`. */
  readonly cookie: string;
}

/**
 * Mint a double-submit CSRF token bound to `sessionId` and the `Set-Cookie` that
 * delivers its companion cookie.
 *
 * This is the issuance half of `@keel/csrf`: {@link generateToken} signs the
 * token, {@link csrf} verifies it, and this plants the companion cookie that
 * makes the "double-submit" name true. The token and the cookie carry the SAME
 * value — that is the double submit: the page reads it from the cookie and
 * resubmits it on channel 2, and the server's HMAC check confirms they agree.
 *
 * Refuses a weak secret loud (`CSRF_WEAK_SECRET`) — inherited from
 * {@link generateToken}, since a forgeable token defeats the whole pair.
 */
export function csrfToken(
  sessionId: string,
  secret: string,
  options: CsrfTokenOptions = {},
): IssuedCsrfToken {
  // generateToken asserts the secret strength, so a weak secret fails here too.
  const token = generateToken(sessionId, secret);
  const cookieName = options.cookieName ?? CSRF_COOKIE;

  return { token, cookie: companionCookie(cookieName, token) };
}
