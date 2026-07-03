/**
 * Deploy this example to Cloudflare with Alchemy (alchemy.run) — TypeScript IaC, no
 * `wrangler.toml`. Run it to deploy:
 *
 *   bunx alchemy login            # one-time: Alchemy needs its OWN CF creds (not wrangler's)
 *   bun alchemy.run.ts            # deploy   → prints the live issuer URL
 *   bun alchemy.run.ts --destroy  # tear down
 *
 * PHASE 4a: the OpenAuth issuer Worker + its KV namespace — a clean Hono+KV deploy that gives
 * a live `/.well-known/oauth-authorization-server` + JWKS + token endpoint.
 *
 * PHASE 4b: the Lesto MCP Resource Server Worker — the SAME governed app as the Node path
 * (mcp/governance.ts), run on the edge via `@lesto/cloudflare` (no kernel, no sqlite). Alchemy
 * resolves the issuer Worker's url and passes it to the RS as `OPENAUTH_ISSUER`, so the RS
 * trusts the issuer's JWKS with nothing hardcoded across the two Workers.
 */

import alchemy from "alchemy";
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";

import { CLIENT_ID, getAccessToken } from "./idp/dance";

// Shared deploy state in a Cloudflare-Durable-Object-backed SQLite store (ADR 0044 D5), so CI and a
// teammate's machine adopt + tear down the SAME resources instead of orphaning them. A DO-backed
// store (not R2/KV) because deploy state is correctness-bearing read-modify-write, and
// eventually-consistent CF storage is unviable for it (the c782e4e / L-35a55b2e key-storm lesson).
// The store encrypts its secrets under `ALCHEMY_STATE_TOKEN`, which MUST be the SAME value across
// every adopting environment (ADR D4) or a second machine can read the state but not decrypt it.
const app = await alchemy("lesto-mcp-auth-openauth", {
  stateStore: (scope) => new CloudflareStateStore(scope),
});

// OpenAuth's ES256 signing keys + auth state live in a single Durable Object (the `OpenAuthKeyStore`
// class exported from idp/worker.ts) — strongly consistent across isolates, so the JWKS never
// diverges. This replaces the KV namespace, whose eventual consistency caused the key-storm
// (L-35a55b2e). Alchemy hosts the DO in this worker and generates its migration.
const issuer = await Worker("openauth-issuer", {
  name: `${app.name}-${app.stage}-issuer`,
  entrypoint: "idp/worker.ts",
  bindings: {
    OPENAUTH_DO: DurableObjectNamespace("openauth-store", {
      className: "OpenAuthKeyStore",
      sqlite: true,
    }),
  },
  url: true,
  compatibilityDate: "2025-04-01",
  compatibilityFlags: ["nodejs_compat"],
});

// `url: true` guarantees a workers.dev url; narrow the optional type so it can be a binding.
const issuerUrl = issuer.url;
if (issuerUrl === undefined) throw new Error("issuer Worker has no url (expected `url: true`)");

// PHASE 4b — the Lesto MCP Resource Server, the same governed app on the edge. It trusts the
// issuer above (its url, resolved by Alchemy, becomes the `OPENAUTH_ISSUER` binding) and
// audiences tokens to `CLIENT_ID` (= the RS's `resource`, forced by OpenAuth's token shape).
// `nodejs_compat` covers the one `node:crypto` call in the MCP tool path.
//
// `ISSUER` is a SERVICE BINDING to the issuer Worker: the RS fetches the issuer's JWKS through
// it, because a same-account `workers.dev → workers.dev` subrequest is refused (CF error 1042).
// Against a real external IdP this binding wouldn't exist and the RS would fetch JWKS over the
// public internet — the verifier handles both (see mcp/worker.ts).
const rs = await Worker("mcp-rs", {
  name: `${app.name}-${app.stage}-rs`,
  entrypoint: "mcp/worker.ts",
  bindings: { OPENAUTH_ISSUER: issuerUrl, MCP_CLIENT_ID: CLIENT_ID, ISSUER: issuer },
  url: true,
  compatibilityDate: "2025-04-01",
  compatibilityFlags: ["nodejs_compat"],
});

console.log("OpenAuth issuer:", issuerUrl);
console.log("  discovery:", `${issuerUrl}/.well-known/oauth-authorization-server`);
console.log("  jwks:     ", `${issuerUrl}/.well-known/jwks.json`);
console.log("MCP RS:     ", rs.url);
console.log("  metadata: ", `${rs.url}/.well-known/oauth-protected-resource`);
console.log("  mcp:      ", `${rs.url}/mcp`);

await app.finalize();

// Cold-start warmup: OpenAuth generates its ES256 signing + RSA-OAEP encryption keys LAZILY on
// first use, and the keygen CPU can 503 the very first `/authorize` on a cold isolate. One
// SEQUENTIAL dance forces BOTH keys to be generated + persisted (into the Durable Object) ONCE,
// before any real traffic, so later requests read the existing key instead of regenerating.
// (Cross-isolate divergence is already prevented by the DO's strong consistency — this is purely
// a latency prime.) Best-effort: a slow warmup shouldn't fail the deploy.
try {
  await getAccessToken(issuerUrl, "viewer");
  console.log("warmup:      keys seeded (cold-start primed)");
} catch (error) {
  console.warn("warmup:      skipped —", (error as Error).message);
}
