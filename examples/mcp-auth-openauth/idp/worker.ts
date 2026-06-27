/**
 * The Cloudflare Worker entry for the OpenAuth issuer (Phase 4 deploy).
 *
 * The same `buildIssuer` as local/tests, but over a Durable-Object-backed store instead of
 * `MemoryStorage` — so OpenAuth's ES256 signing keys live in ONE strongly-consistent place and
 * every isolate serves the same JWKS. This is the fix for the KV key-storm (L-35a55b2e): KV's
 * eventually-consistent `list` let cold isolates each think "no key" and mint their own, so the
 * JWKS diverged and live verification 401'd. See `idp/key-store.ts`.
 *
 * The issuer is memoized per isolate (warm key cache); its storage closure resolves the DO stub
 * fresh on each call, off the isolate-constant `OPENAUTH_DO` binding.
 */

import type { DurableObjectNamespace, ExecutionContext } from "@cloudflare/workers-types";

import { buildIssuer } from "./issuer";
import { OpenAuthKeyStore, durableObjectStorage } from "./key-store";

// workerd resolves the Durable Object class from the entrypoint module's exports.
export { OpenAuthKeyStore };

interface Env {
  /** The Durable Object namespace OpenAuth's signing keys + auth state live in (alchemy.run.ts). */
  OPENAUTH_DO: DurableObjectNamespace;
}

let issuerApp: ReturnType<typeof buildIssuer> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    issuerApp ??= buildIssuer(
      durableObjectStorage(() => {
        // One deterministic instance ("openauth-keys") → every isolate shares the same store.
        // `env.OPENAUTH_DO` is isolate-constant, so closing over the first request's `env` is safe.
        const ns = env.OPENAUTH_DO;

        return ns.get(ns.idFromName("openauth-keys"));
      }),
    );

    return issuerApp.fetch(request, env, ctx);
  },
};
