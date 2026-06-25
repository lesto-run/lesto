# `@lesto/mcp` — an authenticated remote MCP server

A real, runnable Lesto app that an AI agent reaches over HTTP **only through a
validated OAuth bearer token**. This is the agent-native wedge made concrete: ship
a *production* MCP server whose tools (inspect the app, drive a request) are
governed by the same OAuth your humans already use — discovery, audience binding,
a scope ceiling, and an audit trail, all over the wire.

It is the gallery's per-feature QA gate for the remote-MCP transport (ADR 0028
Phase 3b / ADR 0039): it exercises the battery's real public API
(`createMcpHttpHandlers`, `createBearerAuthenticator`) on both axes a unit test
can't reach — **local DX** (wire it, run it) and **hosted UX** (serve it behind a
real `node:http` server and drive it with `curl` or a real MCP client).

> **No crypto build.** Lesto does **no** token-minting here. The Resource Server
> *validates* a token from a configured **external IdP** (Auth0, Okta, WorkOS,
> Entra) against its JWKS. The first-party Authorization Server (ADR 0029) lands
> later behind the **same** seam — a config swap, not an RS rewrite.

## The two capabilities it proves

- **The scope ceiling.** A `mcp:read` token floors to `read-only` mode: the agent
  can `list_routes`, but the destructive `handle_request` is refused with a `403`
  `insufficient_scope` **before** it reaches the app. An `mcp:read mcp:write` token
  unlocks `operator`, so the same call drives a real `POST /deployments`. A
  read-scoped token can never write, no matter how privileged its subject.
- **The audit trail.** Every dispatch — allowed or refused — records one
  `McpAuditRecord` (the tool, the outcome, and the resolved `actor` the bearer
  named), so an operator can always see which agent ran what. There is no
  un-audited path to a tool.

Plus the guards that make a remote MCP server safe to expose:

| Guard                       | What happens                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Discovery** (RFC 9728)    | `GET /.well-known/oauth-protected-resource` names the issuer + resource a client needs to get a token.   |
| **No token**                | `401` + `WWW-Authenticate: Bearer resource_metadata="…"` pointing the client at discovery.               |
| **Wrong audience**          | A validly-signed token minted for **another** resource is refused (`401`) — the confused-deputy guard.   |
| **Cross-site `Origin`**     | `403` before the token is even read — the DNS-rebinding allowlist.                                        |
| **Scope ceiling**           | A destructive `tools/call` from a `mcp:read` token → `403` `insufficient_scope`.                          |

## What the agent operates

The app's own surface is a miniature deploy API — the "production" state an
operator agent acts on through the MCP control plane:

| Route                | Does                                                            |
| -------------------- | -------------------------------------------------------------- |
| `GET /health`        | Liveness.                                                      |
| `GET /deployments`   | List the deploys recorded so far.                              |
| `POST /deployments`  | Record a deploy — the destructive op an **operator** agent drives via `handle_request`. |

The MCP tools (from `@lesto/mcp`) the agent calls against it:

- `list_routes` — *read-only*. Every route the app answers.
- `handle_request` — *operator-only*. Dispatch a request through the live app
  (a `POST` mutates state), gated to `operator` mode by the `mcp:write` scope.

## Run it

In-process — the whole governed dance, narrated:

```
bun run examples/mcp-server/run.ts
```

Over live HTTP — boots behind a real server and prints copy-paste `curl`s for the
full flow (discovery → 401 → viewer reads → viewer refused → operator deploys):

```
bun run examples/mcp-server/serve.ts        # PORT=3000 by default
```

A **real MCP client** completes the dance — connects the actual
`@modelcontextprotocol/sdk` `Client` (the same library Claude/Cursor/MCP-Inspector
use) over `StreamableHTTPClientTransport` to the live server, with a real bearer:
operator `connect`/`listTools`/`callTool` → a real deploy; viewer refused by the
scope ceiling; anonymous turned away:

```
bun run examples/mcp-server/agent.ts
```

The QA gate — drives the whole flow over a **live** server, two ways: with real
`fetch` + signed JWTs (`test/mcp-server.test.ts`), and through a real MCP **client**
(`test/mcp-client.test.ts`). This is the runtime proof the package's in-process
tests couldn't give:

```
bun --filter '@lesto/example-mcp-server' test
```

## How it's wired (`src/`)

- **`idp.ts`** — a stand-in external IdP you **delete in production**. It generates
  an RS256 keypair, publishes the matching JWKS, and signs access tokens exactly the
  way a real issuer does — so the demo is self-contained (no tenant, no network).
- **`verify.ts`** — the **production** validation seam: a `VerifyAccessToken` that
  checks a JWT's signature/issuer/expiry against a JWKS (`jose`). Pass the demo's
  in-process key set, or a `URL` to your IdP's `jwks_uri` and `jose` fetches +
  caches the keys — verification is offline on the hot path.
- **`app.ts`** — wires `createJwksVerifier` → `createBearerAuthenticator` (which
  adds the audience no-passthrough guard) → `createMcpHttpHandlers`, and mounts the
  two handlers (PRM + `/mcp`) the **app** owns. `@lesto/mcp` does no JWKS/`jose`
  work itself and the kernel never mounts the transport — the app does.

## Going to production

1. **Delete `idp.ts`.** You don't mint tokens — your IdP does.
2. **Point `verify.ts` at your IdP.** Pass `jwks: new URL("https://YOUR_TENANT/.well-known/jwks.json")`
   and set `issuer` to your IdP's issuer identifier. Nothing else changes — the
   verify seam is AS-agnostic.
3. **Register the MCP server as an OAuth resource** in your IdP, with `mcp:read` /
   `mcp:write` scopes, audienced to your `resource` URL.
4. **Wire `rolesOf` to your identity service** (`rolesOf: (actor) => identity.rolesOf(actor)`)
   instead of the demo's hardcoded table. It rides the principal + the audit trail today
   and is the input the OCP-7 per-tool policy floor will read.
5. The agent's own OAuth client obtains the token (it discovered where from the PRM)
   and presents it as `Authorization: Bearer …`. The RS validates, gates, audits.

The seam (ADR 0028 Phase 3b) is the point: the issuer is configuration. When the
first-party Lesto Authorization Server (ADR 0029) ships, you swap the `jwks`/`issuer`
config and the Resource Server is unchanged.
