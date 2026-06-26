/**
 * The OpenAuth issuer — a REAL, self-hosted Authorization Server (Hono app) that mints
 * signed JWT access tokens and publishes a JWKS. This is the wedge's interim real issuer
 * (ADR 0039): a batteries-included standards OAuth server, not a from-scratch build, and
 * not the hermetic `idp.ts` stand-in of the sibling example.
 *
 * `issuer()` returns a Hono app you serve on Node/Bun (local) or export from a Worker
 * (deploy). It serves `/.well-known/oauth-authorization-server` (discovery) + JWKS, and
 * the `/authorize` → `/token` (PKCE) flow. The access token it signs is ES256 and carries
 * `{ sub, aud: <clientID>, iss, exp, properties }` — so the grant's MCP scopes ride in the
 * subject `properties` (OpenAuth has no OAuth `scope` claim); the RS reads them back via
 * the `VerifyAccessToken` seam (../mcp/verify.ts).
 *
 * For a hermetic demo + CI, the two providers below auto-issue a FIXED identity with no
 * login UI — `operator` (read+write) and `viewer` (read-only) — selected by the client via
 * `?provider=`. The real `/authorize → code → /token` PKCE dance still runs end to end; only
 * the human login step is stubbed. A production deployment swaps these for OpenAuth's real
 * providers (password, code, GitHub/Google, …).
 */

import { issuer } from "@openauthjs/openauth";
import { MemoryStorage } from "@openauthjs/openauth/storage/memory";
import type { Provider } from "@openauthjs/openauth/provider/provider";

import { subjects } from "./subjects";

/** What a demo provider hands the issuer's `success` callback. */
interface DemoGrant {
  userID: string;
  scopes: string[];
}

/**
 * A no-UI provider that immediately authenticates a FIXED identity — the hermetic stand-in
 * for a real login. The full PKCE flow still runs (authorize → code → token); only the
 * interactive credential step is short-circuited.
 *
 * ⚠️ DEMO ONLY — this issues a token to ANYONE who hits `/authorize?provider=…` with NO
 * credential check. NEVER copy this into production. Unlike OpenAuth's real providers
 * (`password`, `code`, `github`, …) it skips all state/credential validation. A real
 * deployment deletes these two providers and configures OpenAuth's real ones.
 */
function fixedDemoProvider(grant: DemoGrant): Provider<DemoGrant> {
  return {
    type: "demo",
    init(routes, ctx) {
      routes.get("/authorize", async (c) => ctx.forward(c, await ctx.success(c, grant)));
    },
  };
}

/** OpenAuth's storage seam (a simple KV adapter). `MemoryStorage` + `CloudflareStorage` both return it. */
type Storage = ReturnType<typeof MemoryStorage>;

/**
 * Build the issuer over an injected {@link Storage} — so the same app runs on Node/Bun with
 * `MemoryStorage` (local + tests, below) and on a Worker with `CloudflareStorage({ namespace:
 * env.OPENAUTH_KV })` (../idp/worker.ts). OpenAuth persists its ES256 signing keys IN storage
 * (keys.js), so on a Worker the keys MUST live in KV — an in-memory store would regenerate them
 * per isolate and the JWKS would churn, breaking in-flight tokens.
 */
export function buildIssuer(storage: Storage): ReturnType<typeof issuer> {
  return issuer({
    subjects,
    storage,
    providers: {
      operator: fixedDemoProvider({
        userID: "operator@example.com",
        scopes: ["mcp:read", "mcp:write"],
      }),
      viewer: fixedDemoProvider({ userID: "viewer@example.com", scopes: ["mcp:read"] }),
    },
    // Map the provider's grant onto the subject the token will carry.
    async success(ctx, value) {
      return ctx.subject("user", { userID: value.userID, scopes: value.scopes });
    },
  });
}

/** The local/test issuer (in-memory). The Worker deploy uses {@link buildIssuer} with KV storage. */
export const issuerApp = buildIssuer(MemoryStorage());
