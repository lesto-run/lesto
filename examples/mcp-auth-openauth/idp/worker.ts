/**
 * The Cloudflare Worker entry for the OpenAuth issuer (Phase 4 deploy).
 *
 * The same `buildIssuer` as local/tests, but over `CloudflareStorage(KV)` instead of
 * `MemoryStorage` — so the ES256 signing keys persist in KV across isolates (a fresh
 * isolate reloads them rather than minting new ones, keeping the JWKS stable). The KV
 * binding is provisioned + wired by `alchemy.run.ts`.
 *
 * The issuer is built lazily and memoized per isolate: bindings are isolate-constant, so
 * one app instance serves every request and keeps OpenAuth's in-memory key cache warm.
 */

import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";

import { buildIssuer } from "./issuer";

interface Env {
  /** The KV namespace OpenAuth stores signing keys + auth state in (bound in alchemy.run.ts). */
  OPENAUTH_KV: KVNamespace;
}

let issuerApp: ReturnType<typeof buildIssuer> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    issuerApp ??= buildIssuer(CloudflareStorage({ namespace: env.OPENAUTH_KV }));

    return issuerApp.fetch(request, env, ctx);
  },
};
