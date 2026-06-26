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
import { KVNamespace, Worker } from "alchemy/cloudflare";

import { CLIENT_ID, getAccessToken } from "./idp/dance";

const app = await alchemy("lesto-mcp-auth-openauth");

// OpenAuth persists its ES256 signing keys + auth state here, so the JWKS is stable across
// isolates. `adopt` reuses an existing namespace of the same title rather than failing.
const openauthKv = await KVNamespace("openauth-kv", {
  title: `${app.name}-${app.stage}-openauth-kv`,
  adopt: true,
});

const issuer = await Worker("openauth-issuer", {
  name: `${app.name}-${app.stage}-issuer`,
  entrypoint: "idp/worker.ts",
  bindings: { OPENAUTH_KV: openauthKv },
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

// Cold-start warmup (the L-35a55b2e fix): OpenAuth generates its ES256 signing + RSA-OAEP
// encryption keys LAZILY on first use and persists them to KV. On a fresh deploy, concurrent cold
// isolates across colos each generate-and-persist before KV propagates (a "key storm"), and the
// first `/authorize` can 503 under the keygen CPU. One SEQUENTIAL dance here forces BOTH keys to
// be generated + persisted ONCE, before any real traffic — so later cold isolates read the keys
// from KV (cheap) instead of regenerating, and there's no storm. Best-effort: a slow warmup
// shouldn't fail the deploy.
try {
  await getAccessToken(issuerUrl, "viewer");
  console.log("warmup:      keys seeded (cold-start primed)");
} catch (error) {
  console.warn("warmup:      skipped —", (error as Error).message);
}
