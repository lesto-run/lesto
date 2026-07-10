---
title: Build an authenticated MCP server
description: Expose a Lesto app to AI agents over remote HTTP behind OAuth — validate a bearer token via any issuer's JWKS, gate writes on scope, and audit every call. Grounded in the mcp-auth-openauth example.
section: Guides
order: 3
---

# Build an authenticated MCP server

A local agent reaches a Lesto app over stdio (`lesto mcp`). An agent on the other
side of the internet — Claude with a remote connector, your own
`@modelcontextprotocol/sdk` client — reaches it over **HTTP**, and HTTP needs
authentication: a request carries a **bearer token**, not a launch-time session.

`@lesto/mcp` is the **Resource Server** for that case. It validates the token,
binds its subject to a principal, gates writes on the token's scope, and audits
every call — over the same governed choke point the stdio path uses. This guide
builds one end-to-end, grounded in the runnable
[`examples/mcp-auth-openauth`](https://github.com/lesto-run/lesto/tree/main/examples/mcp-auth-openauth)
example: a real self-hosted [OpenAuth](https://openauth.js.org) issuer, a Lesto
RS that validates its tokens *purely via JWKS*, and a real MCP agent that scouts
live MLB data through the gated server.

For the conceptual model behind the checks below — scopes versus roles, the
audience guard, the audit trail — see
[MCP governance](/batteries/mcp-governance). For the battery as a whole (the tool
set, the stdio transport), see [Agent control plane](/batteries/mcp).

Don't want to write the wiring by hand? `lesto add mcp-auth` scaffolds this
guide's exact shape into your app — `app/mcp/config.ts` (the holes you fill:
issuer, resource, scopes), `app/mcp/verify.ts` (the issuer adapter), and
`app/mcp/governance.ts` (the battery wiring) — plus the one-line mount. The
steps below explain what that scaffold builds.

## The shape: one issuer, one Resource Server

OAuth splits the work in two. An **Authorization Server** (the issuer) logs the
user in and mints a signed token. A **Resource Server** validates that token and
serves the protected thing. `@lesto/mcp` is *only* the Resource Server — and it
is **issuer-agnostic**: it does no JWKS or `jose` verification itself and takes no
dependency on any one issuer. You point it at an issuer's public keys through a
single injected seam, and the same RS works against Auth0, Okta, WorkOS, a
self-hosted OpenAuth, or a first-party server later — a config swap, never a
battery change.

```
issuer  (Authorization Server)        Lesto app  (Resource Server)
  /.well-known/oauth-authorization-server     /.well-known/oauth-protected-resource
  /.well-known/jwks.json                      POST /mcp        ← the MCP endpoint
  /authorize → /token  (PKCE)                 validates the bearer via the issuer's JWKS
```

## Step 1 — adapt your issuer's token to the RS contract

The one piece of issuer-specific code is a `verifyAccessToken`: validate the JWT
and hand back the three claims the RS reads. It MUST return the **already-split**
scope tokens (not the raw space-delimited `scope` string), and it validates
**offline** against cached keys, so authentication makes no network call on the
hot path:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AccessTokenClaims, VerifyAccessToken } from "@lesto/mcp";

export function createVerifier(issuer: string, jwksUrl: URL): VerifyAccessToken {
  const keys = createRemoteJWKSet(jwksUrl);

  return async (token): Promise<AccessTokenClaims | undefined> => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        algorithms: ["ES256"], // pin the signing algorithm — never trust the header's alg
      });

      return {
        subject: String(payload.sub),
        audience: payload.aud ?? [],       // who the token was minted FOR
        scopes: scopesFrom(payload),       // the GRANTED scopes, already split into tokens
      };
    } catch {
      return undefined;                    // malformed / forged / expired / wrong-issuer → a 401
    }
  };
}
```

A bad token is `undefined`, never a throw — the RS maps that to a `401`. The
example's
[`mcp/verify.ts`](https://github.com/lesto-run/lesto/blob/main/examples/mcp-auth-openauth/mcp/verify.ts)
is exactly this shape, adapting OpenAuth's token (whose scopes ride in
`properties.scopes`, since OpenAuth has no OAuth `scope` claim) onto the contract.

> **Where do scopes live?** RFC 6749 puts them in a space-delimited `scope`
> claim; split it. Some issuers (OpenAuth among them) carry them elsewhere — read
> them from wherever your issuer stamps them, and return the split array. The
> ceiling is an exact-membership check, so a single un-split
> `["mcp:read mcp:write"]` element would match nothing and deny everything.

## Step 2 — build the authenticator

`createBearerAuthenticator` composes your verifier with the **audience guard** and
the **subject → roles** seam. It validates the token, enforces that the token's
audience names *this* resource, then binds the subject to a principal:

```ts
import { createBearerAuthenticator } from "@lesto/mcp";

const authenticate = createBearerAuthenticator({
  verifyAccessToken: createVerifier(issuer, jwksUrl),
  resource: "https://api.example.com/mcp", // this RS's identifier — the audience tokens must carry
  rolesOf,                                  // subject → roles (e.g. @lesto/identity's rolesOf)
});
```

The `resource` is the **confused-deputy guard**: a token whose `aud` does not name
this exact resource is refused — no passthrough — so a token a user granted to
some *other* service can never be replayed against your MCP server. It must be
non-empty (a blank `resource` is rejected at construction with
`MCP_RESOURCE_REQUIRED`, because it would make the guard vacuous) and
byte-identical to the `aud` your issuer mints (the comparison is exact — no
trailing-slash or case normalization).

## Step 3 — mount the handlers on your app

`createMcpHttpHandlers` returns two plain `@lesto/web` handlers. The **application**
mounts them on its own chain — never the kernel, so there's no `kernel → mcp`
import cycle:

```ts
import { createMcpHttpHandlers } from "@lesto/mcp";

const handlers = createMcpHttpHandlers({
  context: { app, routes, audit },          // connection-constant: the app, its routes, the audit sink
  authenticate,                             // from step 2
  resource: "https://api.example.com/mcp",
  authorizationServers: [issuer],           // advertised in the RFC 9728 metadata
  scopesSupported: ["mcp:read", "mcp:write"],
  writeScope: "mcp:write",                  // the scope that unlocks operator mode
  allowedOrigins: [],                       // browser-origin allowlist (DNS-rebinding guard)
  resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource",
});

app
  .get("/.well-known/oauth-protected-resource", handlers.metadata) // RFC 9728 PRM (GET)
  .post("/mcp", handlers.rpc)                                      // the MCP endpoint (POST)
  .get("/mcp", handlers.noStream); // 405 + Allow: POST — "no SSE here", read cleanly by clients
```

`context` carries everything connection-constant; the per-request `mode` and
`resolvePrincipal` are set from each request's token, inside the handler. Each
request gets a fresh, request-scoped context whose principal is *that* request's
authenticated session — concurrency-safe, with no shared state.

The example's
[`mcp/governance.ts`](https://github.com/lesto-run/lesto/blob/main/examples/mcp-auth-openauth/mcp/governance.ts)
is this exact wiring, and it runs **byte-identical** on a Node kernel app
([`mcp/app.ts`](https://github.com/lesto-run/lesto/blob/main/examples/mcp-auth-openauth/mcp/app.ts))
and on a Cloudflare Worker
([`mcp/worker.ts`](https://github.com/lesto-run/lesto/blob/main/examples/mcp-auth-openauth/mcp/worker.ts))
via `@lesto/cloudflare`'s `toFetchHandler`. That's the thesis: the governance is
the battery, the issuer is config, the transport is a swap.

## What the gate does, request by request

Every request to `POST /mcp` runs the same ordered checks before any tool runs:

1. **Origin guard.** A cross-site browser `Origin` not on `allowedOrigins` is
   refused (`403`, no challenge — it isn't an auth problem). A non-browser client
   (the agent's own HTTP call, curl) sends no `Origin` and is allowed.
2. **Bearer authentication.** No token → `401` with a `WWW-Authenticate` pointing
   at the Protected Resource Metadata. A presented-but-invalid token → `401` marked
   `invalid_token`. A token audienced to a *different* resource never
   authenticates.
3. **Scope ceiling.** A token without the write scope runs in read-only mode; a
   `tools/call` to a destructive tool is refused at the HTTP layer with
   `403 insufficient_scope` — *before* dispatch, not as a JSON-RPC error inside a
   `200`.
4. **Audit.** The accepted request dispatches against a context whose principal is
   the token's subject, and every dispatch lands one audit record naming who ran
   what.

## Step 4 — connect an agent

The client is the real `@modelcontextprotocol/sdk` — the same library Claude,
Cursor, and the MCP Inspector use. It presents the bearer on the `Authorization`
header (never a query string, where it would leak into logs) and sends no
`Origin`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
});
const client = new Client({ name: "my-agent", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

// list_routes is a read; an operator (mcp:write) token can also call handle_request.
await client.callTool({ name: "list_routes", arguments: {} });
```

The example's
[`agent.ts`](https://github.com/lesto-run/lesto/blob/main/examples/mcp-auth-openauth/agent.ts)
runs the full PKCE dance for an **operator** and a **viewer** token, then drives
the live MLB Stats API through `handle_request`:

```sh
bun run examples/mcp-auth-openauth/agent.ts
```

It proves the three outcomes the gate produces: an **operator** (`mcp:read mcp:write`)
investigates live data across several tool calls and writes a prospect to the
scouting board; a **viewer** (`mcp:read`) is refused that destructive write
(`403 insufficient_scope`); an **anonymous** agent can't even connect (`401`).
With `ANTHROPIC_API_KEY` set, Claude is handed the same tools and scouts
autonomously — under the exact same governance on every call.

## Step 5 — connect an off-the-shelf MCP client

You can drive the running server from the **MCP Inspector** (or any client that
takes a manual bearer) — no code. First mint a token; the example ships a helper:

```sh
bun run examples/mcp-auth-openauth/token.ts operator   # prints a bearer (`viewer` for read-only)
```

Then launch the Inspector and point it at the server:

```sh
npx @modelcontextprotocol/inspector
```

- **Transport:** `Streamable HTTP`
- **URL:** `https://<your-rs>/mcp`
- **Authentication:** paste the token as the **Bearer Token** (or add a header
  `Authorization: Bearer <token>`). Then **Connect** → the `Tools` tab lists
  `handle_request`, `list_routes`, …; call `handle_request` with `{ "method":
  "GET", "path": "/standings", "query": { "league": "AL", "season": "2024" } }`.

Or with `curl` (the server is stateless — no `initialize` handshake required):

```sh
curl -s "$RS/mcp" -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"handle_request",
       "arguments":{"method":"GET","path":"/standings","query":{"league":"AL","season":"2024"}}}}'
```

> **Present the token yourself — don't use the client's "Log in" flow.** The fully
> automatic OAuth flow (Claude Desktop / Cursor "connect and authorize") expects the
> issuer to support **Dynamic Client Registration** so the client can self-register.
> The demo issuer doesn't advertise a `registration_endpoint` yet (that's
> [ADR 0041](https://github.com/lesto-run/lesto/blob/main/docs/adr/0041-open-mcp-client-registration.md)),
> and its demo providers have no login UI — so auto-connect won't complete. Supplying
> a bearer (above) sidesteps that; a refusal carries a JSON body naming the missing
> `scope`/permission, so the client surfaces *why*, not an opaque error.

**Local dev (stdio).** For the loopback dev-loop, `lesto mcp` serves the control
plane over stdio — point a desktop client at it with an `mcpServers` entry:

```json
{ "mcpServers": { "lesto": { "command": "lesto", "args": ["mcp"] } } }
```

## Notes & gotchas

- **The RS is issuer-agnostic — keep it that way.** Do all JWKS/signature work in
  your `verifyAccessToken`; the RS reads only `{ subject, audience, scopes }`.
  Swapping issuers is that adapter plus config, never a battery change.
- **Pin the algorithm.** Pass `algorithms: […]` to `jwtVerify` so a forged token
  can't downgrade the signature check via its own header.
- **`resource` must equal the minted `aud`, exactly.** No normalization is applied;
  a trailing-slash or case mismatch fails the audience guard, and an empty
  `resource` is rejected at construction.
- **The scope is the ceiling; the role floor is opt-in.** The dispatch path
  enforces the scope ceiling, the audience guard, the origin guard, the mandatory
  audit, and — when you pass a `policy` + `toolPermissions` map to
  `createMcpHttpHandlers` — the per-tool **role policy floor** (`authorizeBearer`):
  a destructive tool is then reachable only by a subject whose roles your
  `@lesto/authz` policy grants, even within `operator` mode. Omit them and the
  scope ceiling is the sole gate. See [MCP governance](/batteries/mcp-governance)
  for the full model.
- **Demo issuers issue to anyone.** The example's OpenAuth providers auto-issue a
  fixed identity with no credential check — a hermetic test convenience. For
  production, configure OpenAuth's real providers (or your IdP), persist the
  signing keys, and wire `rolesOf` to your identity service.
