/**
 * The OpenAuth issuer — a REAL, self-hosted Authorization Server (Hono app) that mints
 * signed JWT access tokens and publishes a JWKS. This is the wedge's interim real issuer
 * (ADR 0039): a batteries-included standards OAuth server, not a from-scratch build.
 *
 * `buildIssuer()` returns a Hono app you serve on Node/Bun (local) or export from a Worker
 * (deploy). It serves `/.well-known/oauth-authorization-server` (discovery) + JWKS, and the
 * `/authorize` → `/token` (PKCE) flow. The access token it signs is ES256 and carries
 * `{ sub, aud: <clientID>, iss, exp, properties }` — so the grant's MCP scopes ride in the
 * subject `properties` (OpenAuth has no OAuth `scope` claim); the RS reads them back via the
 * `VerifyAccessToken` seam (../mcp/verify.ts).
 *
 * For a hermetic demo + CI, four providers below auto-issue a FIXED identity with no login UI:
 *   - `sre`         — an SRE: `mcp:read mcp:write`, role `sre` (the full-control operator);
 *   - `oncall`      — an on-call responder: `mcp:read mcp:write`, role `oncall`;
 *   - `viewer`      — read-only: `mcp:read`, role `viewer` (refused writes by the scope CEILING);
 *   - `stakeholder` — an OVER-SCOPED exec: `mcp:read mcp:write` (broad token) but role
 *                     `stakeholder`, which the role FLOOR does not grant `console:operate` — so a
 *                     write is refused by ROLE despite the scope (the OCP-7 floor in action).
 * The role is selected by the client via `?provider=`. The real `/authorize → code → /token`
 * PKCE dance still runs end to end; only the human login step is stubbed. A production
 * deployment swaps these for OpenAuth's real providers (password, code, GitHub/Google, …).
 */

import { issuer } from "@openauthjs/openauth";
import { MemoryStorage } from "@openauthjs/openauth/storage/memory";
import type { Provider } from "@openauthjs/openauth/provider/provider";
import type { StorageAdapter } from "@openauthjs/openauth/storage/storage";

import { subjects } from "./subjects";

/** What a demo provider hands the issuer's `success` callback. */
interface DemoGrant {
  userID: string;
  scopes: string[];
  role: string;
}

/**
 * A no-UI provider that immediately authenticates a FIXED identity — the hermetic stand-in
 * for a real login. The full PKCE flow still runs (authorize → code → token); only the
 * interactive credential step is short-circuited.
 *
 * ⚠️ DEMO ONLY — this issues a token to ANYONE who hits `/authorize?provider=…` with NO
 * credential check. NEVER copy this into production. Unlike OpenAuth's real providers
 * (`password`, `code`, `github`, …) it skips all state/credential validation. A real
 * deployment deletes these providers and configures OpenAuth's real ones.
 */
function fixedDemoProvider(grant: DemoGrant): Provider<DemoGrant> {
  return {
    type: "demo",
    init(routes, ctx) {
      routes.get("/authorize", async (c) => ctx.forward(c, await ctx.success(c, grant)));
    },
  };
}

/**
 * Build the issuer over an injected {@link StorageAdapter} — so the same app runs on Node/Bun
 * with `MemoryStorage` (local + tests, below) and on a Worker with a Durable-Object-backed store
 * (`durableObjectStorage`, ./key-store.ts). OpenAuth persists its ES256 signing keys IN storage
 * (keys.js), so on a Worker the store MUST be strongly consistent across isolates — an in-memory
 * store (or eventually-consistent KV) regenerates them per isolate and the JWKS churns, breaking
 * in-flight tokens (the key-storm, L-35a55b2e).
 */
export function buildIssuer(storage: StorageAdapter): ReturnType<typeof issuer> {
  return issuer({
    subjects,
    storage,
    providers: {
      sre: fixedDemoProvider({
        userID: "sre@ops.example.com",
        scopes: ["mcp:read", "mcp:write"],
        role: "sre",
      }),
      oncall: fixedDemoProvider({
        userID: "oncall@ops.example.com",
        scopes: ["mcp:read", "mcp:write"],
        role: "oncall",
      }),
      viewer: fixedDemoProvider({
        userID: "viewer@ops.example.com",
        scopes: ["mcp:read"],
        role: "viewer",
      }),
      // Over-scoped on purpose: a broad `mcp:write` token whose ROLE the floor still bounds.
      stakeholder: fixedDemoProvider({
        userID: "stakeholder@ops.example.com",
        scopes: ["mcp:read", "mcp:write"],
        role: "stakeholder",
      }),
    },
    // Map the provider's grant onto the subject the token will carry.
    async success(ctx, value) {
      return ctx.subject("user", {
        userID: value.userID,
        scopes: value.scopes,
        role: value.role,
      });
    },
  });
}

/** The local/test issuer (in-memory). The Worker deploy uses {@link buildIssuer} with DO storage. */
export const issuerApp = buildIssuer(MemoryStorage());
