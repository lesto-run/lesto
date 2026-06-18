/**
 * Origin / Fetch-Metadata CSRF defense — the zero-token half of `@volo/csrf`.
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
 *
 * **Strict mode.** By default `same-site` (a sibling subdomain) is allowed: the
 * baseline trusts the whole registrable domain. An app that wants the tighter
 * posture — only a request from *exactly our origin* is trusted — sets
 * {@link OriginCheckOptions.strict}. Then `Sec-Fetch-Site` must be `same-origin`
 * (not merely `same-site`/`none`), and the `Origin` fallback must equal an
 * allow-listed origin (the allow-list IS the same-origin set in strict mode).
 */

import type { VoloRequest, Middleware } from "@volo/web";

const FORBIDDEN = 403;

/** The methods that mutate state — the ones an origin check guards. */
const DEFAULT_GUARDED_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

/** The one `Sec-Fetch-Site` value that marks a cross-origin initiator — a CSRF vector. */
const CROSS_SITE = "cross-site";

/** The `Sec-Fetch-Site` value strict mode demands: exactly our own origin. */
const SAME_ORIGIN = "same-origin";

/**
 * The coded `kind` an origin-check refusal reports through {@link OriginCheckOptions.onDenied}.
 *
 *   - `origin_cross_site` — the default refusal: a cross-site initiator, an
 *     un-allowlisted `Origin`, or no evidence at all.
 *   - `origin_not_same_origin` — a strict-mode refusal: evidence that the
 *     request is same-*site* (or otherwise not same-origin) when strict mode
 *     requires same-origin.
 *
 * Stable codes so an audit sink branches on the reason, never on prose.
 */
export const ORIGIN_DENIED_KIND = "origin_cross_site";
export const ORIGIN_STRICT_DENIED_KIND = "origin_not_same_origin";

export interface OriginCheckOptions {
  /**
   * The origins a state-changing request may legitimately originate from — the
   * app's own origin(s), e.g. `["https://app.example.com"]`. Used for the
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

  /**
   * Require *same-origin*, not merely same-site. Defaults to `false`.
   *
   * The default trusts the whole registrable domain: a `Sec-Fetch-Site` of
   * `same-site` (a sibling subdomain like `cdn.example.com` posting to
   * `app.example.com`) passes. With `strict: true` only `same-origin` passes,
   * and the `Origin` fallback must equal an allow-listed origin (so the
   * allow-list IS the same-origin set). Choose this when subdomains are not part
   * of the trust boundary — a request from a sibling host you do not fully
   * control should not be able to drive a state change.
   */
  readonly strict?: boolean;

  /**
   * Optional observability hook fired the moment a request is refused — the
   * uniform `onDenied(kind, c)` seam shared across `@volo/csrf`, `@volo/authz`,
   * and `@volo/ratelimit`.
   *
   * `kind` is the coded reason ({@link ORIGIN_DENIED_KIND} or
   * {@link ORIGIN_STRICT_DENIED_KIND}); `c` is the refused {@link VoloRequest}.
   * Purely observational — the `403` is identical whether or not a hook is wired.
   * A returned promise is awaited so an async sink is not dropped mid-write.
   */
  readonly onDenied?: (kind: string, c: VoloRequest) => void | Promise<void>;
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
 * evidence says same-origin (or same-site, unless {@link OriginCheckOptions.strict}
 * is set); everything ambiguous fails closed. It never reads `Content-Type`, so
 * it is immune to the content-type-parsing bypass class.
 */
export function originCheck(options: OriginCheckOptions = {}): Middleware {
  const guarded = options.methods ?? DEFAULT_GUARDED_METHODS;
  const allowed = new Set((options.allowedOrigins ?? []).map((origin) => origin.toLowerCase()));
  const allowNoOrigin = options.allowNoOrigin ?? false;
  const strict = options.strict ?? false;

  return async (request, next) => {
    // A safe method changes no state; no origin evidence is required to proceed.
    if (!guarded.includes(request.method)) {
      return next();
    }

    // Announce a refusal under its coded kind (observation only), then answer.
    const deny = async (kind: string): Promise<ReturnType<typeof forbidden>> => {
      if (options.onDenied !== undefined) {
        await options.onDenied(kind, request);
      }

      return forbidden();
    };

    const secFetchSite = request.headers["sec-fetch-site"];

    if (secFetchSite !== undefined) {
      const value = secFetchSite.toLowerCase();

      // Strict: only the exact same origin is trusted — same-site (a sibling
      // subdomain) is refused, with its own coded reason.
      if (strict) {
        return value === SAME_ORIGIN ? next() : deny(ORIGIN_STRICT_DENIED_KIND);
      }

      // Default: Fetch Metadata is authoritative and needs no allowlist — only a
      // cross-site initiator is a forgery. Case-insensitive, though the spec
      // lowercases it.
      return value === CROSS_SITE ? deny(ORIGIN_DENIED_KIND) : next();
    }

    const origin = request.headers["origin"];

    if (origin !== undefined) {
      // No Fetch Metadata (an older client): verify the Origin against our own
      // configured origins. With no allowlist we cannot vouch for it — fail
      // closed. The allow-list is the same-origin set, so this path is identical
      // in strict and non-strict mode; a non-member is refused either way.
      return allowed.has(origin.toLowerCase()) ? next() : deny(ORIGIN_DENIED_KIND);
    }

    // Neither signal: a non-browser client. Fail closed unless the app opted in.
    return allowNoOrigin ? next() : deny(ORIGIN_DENIED_KIND);
  };
}
