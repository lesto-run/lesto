# `@lesto/mcp` — a real self-hosted issuer (OpenAuth) + the Lesto RS

The agent-native wedge with a **real Authorization Server**, not a stand-in: a separate
[OpenAuth](https://openauth.js.org) issuer mints signed JWTs, and a Lesto MCP Resource
Server validates them **purely via the issuer's JWKS** — the `@lesto/mcp` governance
(`createBearerAuthenticator` → `createMcpHttpHandlers`) **completely unchanged**.

Where the sibling [`examples/mcp-server`](../mcp-server) uses a hermetic `idp.ts` stand-in,
this swaps in a genuine standards OAuth server (discovery, JWKS, the PKCE `authorize → token`
flow). It is the wedge's **interim real issuer** (ADR 0039): a batteries-included library on
its own Worker, not a from-scratch crypto build.

> **The one thing that changes is the verifier.** The RS battery is issuer-agnostic — pointing
> it at OpenAuth instead of the stand-in (or at Auth0/Okta tomorrow) is a config swap plus one
> small `VerifyAccessToken` adapter, never a battery change.

## The two pieces

```
idp/   — a REAL OpenAuth issuer (its own Hono server / Worker)
           /.well-known/oauth-authorization-server  (discovery)
           /.well-known/jwks.json                    (ES256 signing keys)
           /authorize → /token                       (PKCE)
mcp/   — the Lesto MCP Resource Server
           verify.ts  adapts OpenAuth's token → the RS's {subject, audience, scopes}
           app.ts     the @lesto/mcp battery, UNCHANGED, pointed at the issuer's JWKS
```

## What it proves (`test/integration.test.ts`, 5 assertions over live HTTP)

Both servers run for real; tokens come from the **real PKCE dance** (`idp/dance.ts`):

- the RS advertises the OpenAuth issuer in its RFC 9728 metadata;
- **no token → 401**;
- a valid token minted for **another OpenAuth client → 401** (the confused-deputy guard,
  against a real issuer);
- an **operator** (`mcp:read mcp:write`) drives a real `POST /deployments` through the MCP tools;
- a **viewer** (`mcp:read`) is refused the destructive tool — `403 insufficient_scope`, the
  ceiling sourced from the OpenAuth token's `properties.scopes`.

```
bun --filter '@lesto/example-mcp-auth-openauth' test
```

## How OpenAuth's token maps to the RS (confirmed against its source, not docs)

OpenAuth's access token is an **ES256** JWT carrying
`{ mode:"access", type:"user", properties:{ userID, scopes }, aud:<clientID>, iss, sub, exp }`.
It has **no OAuth `scope` claim**, and `aud` is the **client id**, not a resource. So
`mcp/verify.ts` adapts it onto the RS contract:

| RS needs   | OpenAuth claim          | Note |
| ---------- | ----------------------- | ---- |
| `subject`  | `properties.userID`     | the principal the RS attributes + audits |
| `scopes`   | `properties.scopes`     | the grant's MCP scopes — set server-side in the issuer's `success` callback |
| `audience` | `aud` (the client id)   | the RS's `resource` is set to the client id (see below) |

It also pins `algorithms: ["ES256"]` and asserts `mode === "access"` (as OpenAuth's own
`client.verify` does), and validates with plain `jose` — **not** OpenAuth's `client.verify` —
because the RS must accept *any* JWKS issuer and take no issuer dependency.

**`resource = clientID` is forced, not a choice.** OpenAuth 0.4.x does not implement RFC 8707
resource indicators, so `aud` is always the client id and the battery's audience guard
(`aud === resource`) requires the RS's `resource` to equal it. A token minted for a *different*
client is still refused. For true per-resource audiences (one client, many resources), use an
issuer that stamps the resource into `aud` — only the verifier changes, not the battery.

## Going to production

1. **Delete the demo providers.** `idp/issuer.ts`'s two `fixedDemoProvider`s issue a token to
   **anyone** with no credential check — a hermetic test convenience, never for production.
   Configure OpenAuth's real providers (`password`, `code`, GitHub/Google, …) instead.
2. **Persist the signing keys.** Swap `MemoryStorage()` for `CloudflareStorage({ namespace })`
   (or Dynamo/etc.) — OpenAuth keeps its ES256 signing keys in storage, so an in-memory store
   regenerates them per process and the JWKS would rotate across Worker isolates.
3. **Wire `rolesOf`** to your identity service (the demo maps an email → role).
4. The agent's OAuth client runs the real dance (discovery → PKCE `authorize` → `token`) and
   presents the bearer; the RS validates via JWKS, gates on scope, and audits.

The issuer is configuration. When a first-party `@lesto` Authorization Server lands (ADR 0029),
you point the verifier at its JWKS and the Resource Server is unchanged.
