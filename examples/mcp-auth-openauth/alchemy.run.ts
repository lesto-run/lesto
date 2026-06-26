/**
 * Deploy this example to Cloudflare with Alchemy (alchemy.run) — TypeScript IaC, no
 * `wrangler.toml`. Run it to deploy:
 *
 *   bunx alchemy login            # one-time: Alchemy needs its OWN CF creds (not wrangler's)
 *   bun alchemy.run.ts            # deploy   → prints the live issuer URL
 *   bun alchemy.run.ts --destroy  # tear down
 *
 * PHASE 4a (this file): the OpenAuth issuer Worker + its KV namespace — a clean Hono+KV
 * deploy that gives a live `/.well-known/oauth-authorization-server` + JWKS + token endpoint.
 * The Lesto MCP Resource Server Worker (4b) follows once it's wired off node:http/sqlite onto
 * Lesto's edge adapter + a Workers store (see the task board).
 */

import alchemy from "alchemy";
import { KVNamespace, Worker } from "alchemy/cloudflare";

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

console.log("OpenAuth issuer:", issuer.url);
console.log("  discovery:", `${issuer.url}/.well-known/oauth-authorization-server`);
console.log("  jwks:     ", `${issuer.url}/.well-known/jwks.json`);

await app.finalize();
