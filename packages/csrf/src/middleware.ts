/**
 * The CSRF middleware adapter — wires the stateless {@link verifyToken} check
 * into the request pipeline, guarding state-changing requests.
 *
 * OPT-IN, ALWAYS. CSRF enforcement runs only because an app mounted this
 * middleware; nothing turns it on by default. The reason is concrete: a
 * legitimate client (a form, an old integration) that sends no token must keep
 * working until the app has minted and threaded tokens everywhere, so flipping
 * enforcement on is the app's deliberate act, not the framework's.
 *
 * The signature check stays in `verifyToken` (constant-time, session-bound,
 * total). This adapter decides *when* to check — only on the methods that change
 * state — and *what* to check: the presented token against the session the token
 * was bound to, under the app's secret.
 */

import { assertStrongSecret } from "./errors";
import { verifyToken } from "./token";

import type { KeelRequest, Middleware } from "@keel/web";

const FORBIDDEN = 403;

/** The coded `kind` the {@link CsrfOptions.onDenied} seam reports a refusal under. */
export const CSRF_DENIED_KIND = "csrf_token_invalid";

/** The methods that mutate state — the ones a CSRF token must accompany. */
const DEFAULT_GUARDED_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

/** Where the default extractor looks for a token before the form body. */
const TOKEN_HEADER = "x-csrf-token";

/** The form field the default extractor reads a token from. */
const TOKEN_FIELD = "_csrf";

export interface CsrfOptions {
  /** The server-held secret the token signatures are computed under. */
  readonly secret: string;

  /**
   * The session (or anon) id the presented token must be bound to.
   *
   * App-specific by nature — only the app knows where its session lives (a
   * cookie value, a header, an anon id). Required: a double-submit token is
   * meaningless without the identity half of the binding.
   */
  readonly sessionFor: (request: KeelRequest) => string;

  /**
   * The token the client presented, or `undefined` when none was found.
   *
   * Defaults to {@link defaultExtractToken} (the `x-csrf-token` header, then a
   * `_csrf` form field). Override to read a different header or a JSON body.
   */
  readonly extractToken?: (request: KeelRequest) => string | undefined;

  /**
   * Which methods to guard. Defaults to the state-changing four
   * (`POST`/`PUT`/`PATCH`/`DELETE`); a safe method (`GET`/`HEAD`/`OPTIONS`)
   * never needs a token and is always let through.
   */
  readonly methods?: readonly string[];

  /**
   * Optional observability hook fired the moment a request is refused — the
   * uniform `onDenied(kind, c)` seam shared across `@keel/csrf`, `@keel/authz`,
   * and `@keel/ratelimit` (owned by auth-security item 6, consumed by OTLP wiring
   * in operability-dx item 3).
   *
   * `kind` is the coded reason (here always {@link CSRF_DENIED_KIND}); `c` is the
   * refused {@link KeelRequest}. Purely observational: it shapes nothing — the
   * `403` is identical whether or not a hook is wired — so firing is safe on the
   * refusal path. Wire it to a tracer/audit sink. A returned promise is awaited so
   * an async sink is not dropped mid-write.
   */
  readonly onDenied?: (kind: string, c: KeelRequest) => void | Promise<void>;
}

/**
 * Pull the CSRF token from a request: the `x-csrf-token` header first, then a
 * `_csrf` field in a form-urlencoded body.
 *
 * The header is the API/AJAX path; the form field is the classic HTML form
 * path. We read the body field only when the body is the raw urlencoded string
 * the runtime leaves a `application/x-www-form-urlencoded` POST as — never from
 * a parsed JSON object, which would mean reaching into an arbitrary shape.
 * Returns `undefined` when neither carries a token, which the middleware treats
 * as a failed check on a guarded method.
 */
export function defaultExtractToken(request: KeelRequest): string | undefined {
  const header = request.headers[TOKEN_HEADER];

  if (header !== undefined && header.length > 0) {
    return header;
  }

  // The form path: the runtime hands a urlencoded body through as a raw string.
  if (typeof request.body === "string") {
    const field = new URLSearchParams(request.body).get(TOKEN_FIELD);

    if (field !== null && field.length > 0) {
      return field;
    }
  }

  return undefined;
}

/**
 * A CSRF middleware guarding state-changing methods.
 *
 * A safe method (anything not in `methods`) flows straight through — a GET
 * changes nothing, so it needs no token. A guarded method must present a token
 * that {@link verifyToken} accepts for the request's bound session under the
 * secret; anything else — no token, a token for another session, a tampered
 * signature — is a `403 Forbidden`, answered here without reaching a controller.
 *
 * The check is fail-closed: a missing token is as fatal as a forged one, so a
 * guarded request can never slip through unverified.
 */
export function csrf(options: CsrfOptions): Middleware {
  // Refuse a weak secret when the middleware is built, not per request
  // (CSRF_WEAK_SECRET) — a forgeable secret defeats the whole guard.
  assertStrongSecret(options.secret);

  const guarded = options.methods ?? DEFAULT_GUARDED_METHODS;
  const extractToken = options.extractToken ?? defaultExtractToken;

  return async (request, next) => {
    // A safe method changes no state; no token is required to proceed.
    if (!guarded.includes(request.method)) {
      return next();
    }

    const token = extractToken(request);

    // Fail-closed: an absent token is a failed check, never a bypass.
    const ok =
      token !== undefined && verifyToken(token, options.sessionFor(request), options.secret);

    if (!ok) {
      // Announce the refusal before answering — observation only, never a bypass:
      // the `403` is returned regardless of whether (or how) the hook resolves.
      if (options.onDenied !== undefined) {
        await options.onDenied(CSRF_DENIED_KIND, request);
      }

      return { status: FORBIDDEN, headers: { "content-type": "text/plain" }, body: "Forbidden" };
    }

    return next();
  };
}
