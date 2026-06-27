/**
 * The Cloudflare Worker entry for the Lesto MCP Resource Server (the edge substrate).
 *
 * The SAME governed app as the Node path (`./governance.ts`), on the edge: no kernel, no sqlite —
 * a pure `@lesto/web` app whose `handle` `@lesto/cloudflare`'s `toFetchHandler` turns into a
 * Worker `fetch(Request) => Response`, running the exact transport-neutral hardening the Node
 * `serve` applies. `node:crypto`'s `createHash` (the MCP tool-input hash in `@lesto/mcp`) runs
 * under `nodejs_compat`; nothing else here is node-only.
 *
 * Three things are wired late instead of hardcoded:
 *   - the issuer URL comes from the `OPENAUTH_ISSUER` binding (alchemy.run.ts points it at the
 *     issuer Worker's own url — no copy-pasted URL, no deploy-order chicken-and-egg);
 *   - the RS's own base URL — needed only for the RFC 9728 `resource_metadata` pointer — is read
 *     from the FIRST request's origin and frozen for the isolate's life (so the app builds lazily
 *     and memoizes per isolate, keeping the verifier's JWKS cache warm). This assumes ONE stable
 *     host; a deployment served under multiple hostnames would want the pointer recomputed per
 *     request. It affects only metadata DISCOVERY, never the audience/scope checks (`resource` is
 *     the client id, not a URL);
 *   - the JWKS fetch rides the `ISSUER` SERVICE BINDING when present. The issuer is another Worker
 *     on the same account, and a `workers.dev → workers.dev` subrequest is refused (CF error
 *     1042) — so the RS reaches the issuer's JWKS through a service binding, not its public url.
 *     Against a real external IdP (a different origin) the binding is absent and the global `fetch`
 *     is used, exactly as a production RS would.
 */

import { toFetchHandler } from "@lesto/cloudflare";
import type { EdgeExecutionContext } from "@lesto/cloudflare";
import type { Fetcher } from "@cloudflare/workers-types";

import { buildGovernedApi, demoRolesOf } from "./governance";

interface Env {
  /** The OpenAuth issuer URL — wired to the issuer Worker's `url` in alchemy.run.ts. */
  OPENAUTH_ISSUER: string;

  /** The OpenAuth client id the RS audiences tokens to (`resource` = this). */
  MCP_CLIENT_ID: string;

  /**
   * Service binding to the issuer Worker — the transport for the JWKS fetch (same-account
   * `workers.dev → workers.dev` is refused, CF 1042). Optional: absent against a real external
   * IdP, where the global `fetch` reaches the JWKS directly.
   */
  ISSUER?: Fetcher;
}

/**
 * Build the governed app for this isolate and adapt it to a Worker fetch handler.
 *
 * Exported so a test can drive the EXACT edge path this Worker ships (the real `toFetchHandler`
 * adapter + governed app + OpenAuth verifier) in-process against a local issuer — no workerd.
 */
export function buildHandler(
  env: Env,
  baseUrl: string,
): (request: Request, ctx?: EdgeExecutionContext) => Promise<Response> {
  // No `app` argument: with no kernel, MCP tool dispatch falls back into this very app
  // (governance.ts self-references its `api`), so there's no booted-app forward-reference to wire.
  const governed = buildGovernedApi({
    issuer: env.OPENAUTH_ISSUER,
    jwksUrl: new URL(`${env.OPENAUTH_ISSUER}/.well-known/jwks.json`),
    clientID: env.MCP_CLIENT_ID,
    baseUrl,
    // Agents and curl send no `Origin`, so they're allowed (a non-browser client carries no
    // DNS-rebinding risk); a browser's cross-site `Origin` is refused. Empty is the safe floor.
    allowedOrigins: [],
    rolesOf: demoRolesOf,
    // Same-account issuer Worker → fetch its JWKS through the service binding (CF 1042 blocks the
    // public-url subrequest). Absent (real external IdP) → governance uses global `fetch`.
    ...(env.ISSUER === undefined
      ? {}
      : { jwksFetch: env.ISSUER.fetch.bind(env.ISSUER) as unknown as typeof fetch }),
  });

  // Arrow keeps `handle`'s `this` binding (the route matcher) intact through the adapter, as the
  // sibling edge worker does.
  return toFetchHandler((method, path, options) => governed.api.handle(method, path, options));
}

let handler: ((request: Request, ctx?: EdgeExecutionContext) => Promise<Response>) | undefined;

export default {
  fetch(request: Request, env: Env, ctx?: EdgeExecutionContext): Promise<Response> {
    handler ??= buildHandler(env, new URL(request.url).origin);

    return handler(request, ctx);
  },
};
