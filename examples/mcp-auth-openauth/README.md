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
idp/   — a REAL OpenAuth issuer (its own Hono app)
           /.well-known/oauth-authorization-server  (discovery)
           /.well-known/jwks.json                    (ES256 signing keys)
           /authorize → /token                       (PKCE)
           worker.ts  the Cloudflare Worker entry (CloudflareStorage over KV)
mcp/   — the Lesto MCP Resource Server
           verify.ts     adapts OpenAuth's token → the RS's {subject, audience, scopes}
           governance.ts the @lesto/mcp battery wiring, UNCHANGED — the MLB scout's console + RS
           mlb.ts        a tiny client for the live MLB Stats API (statsapi.mlb.com, no key)
           app.ts        substrate A: Node (`@lesto/runtime` serve + sqlite)
           worker.ts     substrate B: Cloudflare Worker (`@lesto/cloudflare` toFetchHandler)
agent.ts — a real @modelcontextprotocol/sdk agent that scouts live MLB through the gated server
```

**One governance, two transports.** `governance.ts` (`buildGovernedApi`) is the whole wedge in
one place; `app.ts` boots it on the Node kernel and `worker.ts` runs the *same* app on a
Cloudflare Worker. The `@lesto/mcp` battery and the OpenAuth verifier are byte-identical across
both — only the substrate (and, on the edge, the JWKS *transport*) differs. That's the thesis:
the governance is the battery, the issuer is config, the transport is a swap.

## What it proves (10 assertions; tokens from the **real PKCE dance**, `idp/dance.ts`)

The same five claims are proven on **both** substrates — `test/integration.test.ts` over the Node
server (live HTTP) and `test/edge.test.ts` through the actual `@lesto/cloudflare` `toFetchHandler`
the Worker ships (in-process, no workerd):

- the RS advertises the OpenAuth issuer in its RFC 9728 metadata;
- **no token → 401**;
- a valid token minted for **another OpenAuth client → 401** (the confused-deputy guard,
  against a real issuer);
- an **operator** (`mcp:read mcp:write`) drives the scout's console (a `POST /scouting` write)
  through the MCP tools;
- a **viewer** (`mcp:read`) is refused the destructive tool — `403 insufficient_scope`, the
  ceiling sourced from the OpenAuth token's `properties.scopes`.

```
bun --filter '@lesto/example-mcp-auth-openauth' test
```

## The agent: scouting live MLB through the gated server

`agent.ts` is a fully self-contained, runnable demo — it boots the issuer + RS in-process, runs
a real PKCE dance, and connects the actual `@modelcontextprotocol/sdk` `Client` (the library
Claude/Cursor/Inspector use) over the OAuth-gated transport. The server's `handle_request` tool
reaches a scout's console backed by the **live MLB Stats API**.

```
bun run examples/mcp-auth-openauth/agent.ts            # scripted (no key)
ANTHROPIC_API_KEY=sk-... bun run …/agent.ts            # + Claude scouts autonomously
```

It shows an **operator** agent investigate live data across several tool calls — AL standings,
search a player, pull their season line — then write a prospect to the scouting board; a
**viewer** refused that write (403); an **anonymous** agent refused the connection (401). With an
API key, **Claude** is handed the same five tools and scouts autonomously, deciding which MLB
queries to run and whom to add to the board. The governance is the same on every call.

## Deploy (live, on Cloudflare via [Alchemy](https://alchemy.run))

Two Workers — the OpenAuth issuer and the Lesto RS — defined as TypeScript IaC in
`alchemy.run.ts` (no `wrangler.toml`). Alchemy resolves the issuer Worker's url and passes it to
the RS, so the RS trusts the issuer's JWKS with nothing hardcoded:

```
bunx alchemy login            # one-time: Alchemy needs its OWN CF creds (not wrangler's)
bun run deploy                # → prints the live issuer + RS URLs
bun run destroy               # tear down
```

> **CF gotcha — same-account Worker→Worker.** A `workers.dev → workers.dev` subrequest on the
> same account is refused (CF error 1042), so the RS reaches the issuer's JWKS through a **service
> binding** (`ISSUER` in `alchemy.run.ts`), not the public url. Against a real external IdP (a
> different origin) the binding is absent and the RS fetches the JWKS over the public internet —
> the verifier's optional `fetchJwks` seam handles both, the battery unchanged.
>
> **Known rough edge (key persistence).** OpenAuth's signing keys are not reliably persisting to
> KV on this deploy, so the JWKS can diverge across isolates and live verification is flaky. A
> post-deploy warmup primes the keys (fixes the cold-start 503), but the robust fix is
> Durable-Object-backed key storage (strongly consistent) — tracked as a follow-up. The
> in-process `agent.ts` demo (MemoryStorage, one key) is the reliable, runnable path today.

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
