/**
 * Origin / Fetch-Metadata CSRF defense — the zero-token half of `@keel/csrf`.
 *
 * The signed double-submit token ({@link csrf}) is the strong check, but it costs
 * the app real plumbing: mint a token, thread it into every form and fetch. This
 * is the cheap companion that needs none of that — it decides whether a
 * state-changing request *came from us* by reading two headers the browser sets
 * and the page cannot forge:
 *
 *   - `Sec-Fetch-Site` (Fetch Metadata) — every modern browser tags a request
 *     with its relationship to our origin. Only `cross-site` is a CSRF vector;
 *     `same-origin`/`same-site`/`none` (a typed URL, a bookmark) are ours or
 *     user-initiated. This needs NO configuration — the zero-config default.
 *   - `Origin` — the fallback for an older client without Fetch Metadata, checked
 *     against the app's *explicitly configured* origins. Never against the `Host`
 *     header, which a client forges at will (the hazard half the field's SSR
 *     CVEs turned on).
 *
 * It is deliberately blind to `Content-Type`. The recurring CSRF-bypass CVE
 * family across the ecosystem (SvelteKit CVE-2023-29003/29008, Astro
 * CVE-2024-56140, Hono CVE-2024-43787/48913) all live in content-type parsing —
 * a missing header, a casing difference, a `;`-parameter slips the gate. A check
 * that never reads `Content-Type` cannot have that bug. Header values are
 * compared case-insensitively, and an absent signal is treated as *unsafe*, not
 * safe — the two other lessons from those CVEs.
 *
 * Fail-closed: a guarded request that carries neither signal is refused unless
 * the app opts into {@link OriginCheckOptions.allowNoOrigin}. A cookie-authed
 * browser always sends at least one; a request with neither is a non-browser
 * client (curl, server-to-server, a native app) where CSRF — an ambient-cookie
 * attack — does not apply, so a token-authed API can allow them.
 */

import type { Middleware } from "@keel/web";

const FORBIDDEN = 403;

/** The methods that mutate state — the ones an origin check guards. */
const DEFAULT_GUARDED_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

/** The one `Sec-Fetch-Site` value that marks a cross-origin initiator — a CSRF vector. */
const CROSS_SITE = "cross-site";

export interface OriginCheckOptions {
  /**
   * The origins a state-changing request may legitimately originate from — the
   * app's own origin(s), e.g. `["https://app.example.com"]`. Used ONLY for the
   * `Origin`-header fallback when a client sent no `Sec-Fetch-Site`. Compared
   * case-insensitively. Configure it explicitly; it is never derived from the
   * spoofable `Host` header. Omit it to rely on Fetch Metadata alone (which needs
   * no allowlist) — then an older client lacking `Sec-Fetch-Site` is refused.
   */
  readonly allowedOrigins?: readonly string[];

  /**
   * Which methods to guard. Defaults to the state-changing four
   * (`POST`/`PUT`/`PATCH`/`DELETE`); a safe method never needs the check.
   */
  readonly methods?: readonly string[];

  /**
   * Allow a guarded request that carries NEITHER `Sec-Fetch-Site` NOR `Origin`.
   * Defaults to `false` (fail-closed): a cookie-authed browser always sends one,
   * so a request with neither is a non-browser client. Set `true` for a pure-API
   * deployment that authenticates with tokens (not ambient cookies), where such
   * clients are legitimate and CSRF does not apply.
   */
  readonly allowNoOrigin?: boolean;
}

/** The 403 an origin-check failure answers with — the same shape `csrf` uses. */
function forbidden(): { status: number; headers: Record<string, string>; body: string } {
  return { status: FORBIDDEN, headers: { "content-type": "text/plain" }, body: "Forbidden" };
}

/**
 * A CSRF middleware that verifies a state-changing request came from our own
 * origin, via `Sec-Fetch-Site` (preferred) then `Origin` (fallback).
 *
 * A safe method flows straight through. A guarded one is allowed only when the
 * evidence says same-origin; everything ambiguous fails closed. It never reads
 * `Content-Type`, so it is immune to the content-type-parsing bypass class.
 */
export function originCheck(options: OriginCheckOptions = {}): Middleware {
  const guarded = options.methods ?? DEFAULT_GUARDED_METHODS;
  const allowed = new Set((options.allowedOrigins ?? []).map((origin) => origin.toLowerCase()));
  const allowNoOrigin = options.allowNoOrigin ?? false;

  return async (request, next) => {
    // A safe method changes no state; no origin evidence is required to proceed.
    if (!guarded.includes(request.method)) {
      return next();
    }

    const secFetchSite = request.headers["sec-fetch-site"];

    if (secFetchSite !== undefined) {
      // Fetch Metadata is authoritative and needs no allowlist: only a cross-site
      // initiator is a forgery. Case-insensitive, though the spec lowercases it.
      return secFetchSite.toLowerCase() === CROSS_SITE ? forbidden() : next();
    }

    const origin = request.headers["origin"];

    if (origin !== undefined) {
      // No Fetch Metadata (an older client): verify the Origin against our own
      // configured origins. With no allowlist we cannot vouch for it — fail closed.
      return allowed.has(origin.toLowerCase()) ? next() : forbidden();
    }

    // Neither signal: a non-browser client. Fail closed unless the app opted in.
    return allowNoOrigin ? next() : forbidden();
  };
}
