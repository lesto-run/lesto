/**
 * Mint a real access token for testing the MCP server — the fiddly part of poking an OAuth-gated
 * server by hand.
 *
 *   bun run token.ts            # an operator token (read + write)
 *   bun run token.ts viewer     # a viewer token (read only — writes get 403)
 *   ISSUER=http://localhost:8787 bun run token.ts operator   # against a local issuer
 *
 * It runs the genuine PKCE dance against the demo issuer (../idp/dance.ts) and prints the bearer,
 * so you can paste it into the MCP Inspector, a `curl -H "authorization: Bearer …"`, or any client
 * that takes a manual token. Defaults to the hosted demo issuer; override with `ISSUER`.
 */

import { getAccessToken } from "./idp/dance";

const ISSUER =
  process.env.ISSUER ?? "https://lesto-mcp-auth-openauth-ryan-issuer.ryan-dimascio.workers.dev";

const provider = process.argv[2] ?? "operator";
if (provider !== "operator" && provider !== "viewer") {
  console.error(`unknown provider "${provider}" — use "operator" or "viewer"`);
  process.exit(1);
}

console.log(await getAccessToken(ISSUER, provider));
