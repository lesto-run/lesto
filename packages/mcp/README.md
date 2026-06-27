# @lesto/mcp

Expose a running Lesto app to AI agents as **governed** [MCP](https://modelcontextprotocol.io)
tools — over stdio for a local agent, or over remote HTTP behind OAuth for an agent on the
other side of the internet. An agent in Claude, Cursor, an editor, or your own
`@modelcontextprotocol/sdk` client can inspect your routes, read and write content, generate
UI, and drive real requests through the live app — across **one** audited choke point, with
read-only as the floor and writes behind an explicit grant.

This is the load-bearing half of "agent-native": the agent surface is a first-class, *audited*
part of the framework, not a token you hand a model and hope. Every capability is an
*operation*; the CLI, the UI, and this MCP server are three front-ends over the same operations.
An agent can't do anything you couldn't do from the command line — same operations, a different
caller.

```ts
import { buildTools, dispatch } from "@lesto/mcp";

const tools = buildTools({ app, routes, audit, mode: "operator" });

await dispatch({ app, routes, audit, mode: "operator" }, tools, "list_routes", {});
```

## The tools

`buildTools(context)` assembles the tool set from your app; `dispatch(context, tools, name, input)`
finds one by name, audits the call, and runs it. Nine operations today, each carrying a static
`destructive` flag — and a destructive tool refuses outside `operator` mode:

| Tool | Kind | |
| ---- | ---- | --- |
| `list_routes` | read | Every route the running app answers, in resolution order. |
| `handle_request` | **destructive** | Dispatch a real `{ method, path, query, headers, body }` through the live app and return its response — same routes, same middleware, same database. |
| `generate_ui` | read | A Lesto UI tree from a natural-language prompt (injected; inert when unwired). |
| `list_content_collections` | read | Each content collection with its entry count. |
| `get_content_entry` | read | One entry by collection + slug. |
| `query_content` | read | A collection's entries, optionally capped by a limit. |
| `create_content_entry` | **destructive** | Author a new content entry. |
| `update_content_entry` | **destructive** | Merge data into an existing entry, replacing its body. |
| `delete_content_entry` | **destructive** | Remove an entry by collection + slug. |

Schema migrations are deliberately **not** on this surface — those stay in code and the CLI.
The content tools depend on `@lesto/content-core` / `@lesto/content-store` as **optional peers**:
the package installs and its generic tools (`list_routes`, `handle_request`, `generate_ui`) run
without them; the six content tools refuse, coded, when the peers aren't wired.

`handle_request` only forwards an allowlist of identity headers — `authorization`, `cookie`,
`content-type`, `accept`, `accept-language` — so an agent can act *as* a user without being able
to spoof the infrastructure headers the runtime trusts (`x-forwarded-for`, `x-request-id`).

## Governed at one choke point

Every tool call goes through `dispatch`, which does two things a hand-rolled "expose an API to
the model" setup does not.

**It defaults closed.** A server has a mode, and the floor is read-only:

```ts
type McpMode = "read-only" | "operator"; // unset → "read-only"
```

A destructive tool refuses outside `operator` with an `McpError` (`MCP_OPERATOR_REQUIRED`). The
safety property that matters: forget to set the mode and the agent gets the *safe* surface. You
opt **in** to letting an agent change things.

**It audits everything.** The audit sink is mandatory — there is **no un-audited path to a
tool**. Every dispatch, success or failure, known tool or typo, writes one record *before* the
result surfaces:

```ts
interface McpAuditRecord {
  tool: string;
  inputHash: string;        // a SHA-256 of the input — never the (possibly sensitive) raw args
  outcome: "ok" | "error";
  durationMs: number;
  actor: string | undefined; // WHO drove it (the resolved principal), or undefined when anonymous
}
```

So you always have the receipts — which tool ran, who ran it, whether it succeeded, how long it
took — and, deliberately, a *hash* of the input rather than the raw arguments, so the audit
trail itself isn't where sensitive data leaks. Point the sink at your logs, a table, anywhere.

## Quickstart — stdio (local agent)

The stdio transport is what a desktop MCP client (Claude Desktop, an editor agent) launches and
speaks to. The CLI serves it against your `lesto.app.ts`:

```sh
lesto mcp              # read-only floor
lesto mcp --operator   # unlock the destructive tools
```

The MCP protocol owns **stdout** (it is the wire), so the startup banner and the audit trail go
to **stderr** — they never corrupt the protocol. Point your client at the command and the tools
appear. To serve it yourself, hand `startMcpServer` a context:

```ts
import { startMcpServer } from "@lesto/mcp";

await startMcpServer({
  app,                 // the booted @lesto/kernel app the tools dispatch into
  routes,              // app.routes() — surfaced by list_routes
  mode: "operator",    // omit for the read-only floor
  audit: (record) => log.info(record),
  contentDb,           // the content store the write tools mutate (optional)
});
```

## Quickstart — remote HTTP (agent over the internet, OAuth-gated)

Remote MCP serves agents over HTTP, so the control plane authenticates a **bearer token**
instead of a launch-time session. `createMcpHttpHandlers` returns plain `@lesto/web` handlers
the **application** mounts on its own chain — never the kernel, so there's no `kernel → mcp`
import cycle:

```ts
import { createBearerAuthenticator, createMcpHttpHandlers } from "@lesto/mcp";

const handlers = createMcpHttpHandlers({
  context: { app, routes, audit },          // connection-constant; mode + principal are per-request
  authenticate: createBearerAuthenticator({
    verifyAccessToken,                        // YOUR injected token validator (see below)
    resource: "https://api.example.com/mcp",  // this RS's identifier — the audience tokens must carry
    rolesOf,                                  // subject → roles (e.g. @lesto/identity's rolesOf)
  }),
  resource: "https://api.example.com/mcp",
  authorizationServers: ["https://issuer.example.com"],
  scopesSupported: ["mcp:read", "mcp:write"],
  writeScope: "mcp:write",                    // the scope that unlocks operator mode
  allowedOrigins: [],                         // browser-origin allowlist (DNS-rebinding guard)
  resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource",
});

app
  .get("/.well-known/oauth-protected-resource", handlers.metadata) // RFC 9728 PRM (GET)
  .post("/mcp", handlers.rpc);                                       // the MCP endpoint (POST)
```

Each request gets a fresh, request-scoped context whose `resolvePrincipal` closes over *that*
request's authenticated session — concurrency-safe, no shared state. The transport drives the
SDK's stateless Streamable-HTTP server (JSON responses, no SSE).

## The OAuth Resource Server governance model

`@lesto/mcp` is the **Resource Server** half of remote MCP. It is **issuer-agnostic**: it does
no JWKS or `jose` verification itself and takes no dependency on any one issuer.

- **Issuer-agnostic via an injected seam.** You supply `verifyAccessToken: (token) =>
  AccessTokenClaims | undefined` — validate the JWT against your issuer's JWKS (offline, from
  cached keys, so authentication makes no network call on the hot path) and hand back
  `{ subject, audience, scopes }`. An external IdP (Auth0/Okta/WorkOS/Entra) or a self-hosted
  issuer (the example uses OpenAuth) is the first issuer; a first-party Lesto Authorization
  Server would land later behind the *same* seam, with no RS change.
- **Audience / confused-deputy guard.** The token's `aud` must name **this** resource. A token a
  user granted to some other service is refused — no passthrough — so a token minted elsewhere
  can never be replayed here. (A blank `resource` is rejected at construction:
  `MCP_RESOURCE_REQUIRED`, because it would make the guard vacuous.)
- **Scope ceiling.** A token carrying the write scope unlocks `operator` mode, so the destructive
  tools become reachable; any narrower token gets the read-only floor. A scope-short write is
  refused at the HTTP layer with a `403 insufficient_scope` (RFC 6750 §3.1) *before* dispatch —
  not as a JSON-RPC error inside a `200`.
- **Origin / DNS-rebinding guard.** A present `Origin` must be on the allowlist (a browser always
  sends one); an absent `Origin` is a non-browser client (the agent's own HTTP call, curl) and
  carries no rebinding risk, so it is allowed.
- **Audit.** The bearer's subject is bound to a principal and recorded on every dispatch, so the
  trail names *who* drove each call.
- **RFC 9728 Protected Resource Metadata.** `handlers.metadata` serves the document a client
  reads from `.well-known/oauth-protected-resource` to discover where to get a token; an
  unauthenticated request gets a `401` whose `WWW-Authenticate` points at it.

### The role gate the design provides

The full RS authorization decision is the **intersection** of two checks — the design's complete
shape, exposed as `authorizeBearer`:

```ts
authorizeBearer({ scopes, requiredScope, roles, policy, permission })
// permitted iff  scopes.includes(requiredScope)  &&  policy.allows(roles, permission)
```

- the **scope ceiling** — the token's granted scopes must cover what the action requires
  (a `mcp:read` token can never reach a write, however privileged the subject); and
- the **role policy floor** — the subject's roles must be granted the permission by your live
  `@lesto/authz` policy (a write-scoped token still bounded by who the subject *is*).

Either alone is insufficient: a broadly-scoped token is still bounded by the subject's roles, and
a privileged subject is still bounded by the token's scope.

**What is enforced on the dispatch path today:** the **scope ceiling + the per-tool role policy
floor + the audience guard + the origin guard + the mandatory audit**. The remote RS wires
`authorizeBearer` as an **opt-in** floor — pass a `policy` (your `@lesto/authz` policy) and a
`toolPermissions` map (tool → permission) to `createMcpHttpHandlers`, and a destructive tool
becomes reachable only by a subject whose roles the policy grants the permission, *even within
`operator` mode*; the floor runs after the scope ceiling, so a scope-short call is refused first.
Omit `policy`/`toolPermissions` and the scope ceiling is the sole gate (the back-compatible
default). (The stdio control plane gates on the scope-derived mode only — the role floor is a
remote-RS feature.)

## Errors carry codes

Every refusal is an `McpError` with a stable `McpErrorCode` — branch on the code, never the
message:

`MCP_UNKNOWN_TOOL` · `MCP_OPERATOR_REQUIRED` · `MCP_GENERATE_UNAVAILABLE` ·
`MCP_CONTENT_PACKAGES_MISSING` · `MCP_CONTENT_STORE_UNAVAILABLE` · `MCP_RESOURCE_REQUIRED`.

## A complete, runnable example

[`examples/mcp-auth-openauth`](../../examples/mcp-auth-openauth) is the whole story end-to-end: a
real self-hosted [OpenAuth](https://openauth.js.org) issuer (its own Worker, with a
Durable-Object key store) mints signed JWTs, a Lesto MCP Resource Server validates them **purely
via the issuer's JWKS** with the `@lesto/mcp` governance unchanged, and a real
`@modelcontextprotocol/sdk` agent runs the PKCE dance and drives the **live MLB Stats API**
through the OAuth-gated `handle_request`. One `governance.ts` (`createBearerAuthenticator` →
`createMcpHttpHandlers`) runs **byte-identical** on Node and on a Cloudflare Worker — the
governance is the battery, the issuer is config, the transport is a swap.

```sh
bun run examples/mcp-auth-openauth/agent.ts   # scripted: operator writes, viewer 403s, anon 401s
```

## See also

- [Agent control plane](https://lesto.run/batteries/mcp) — the battery reference.
- [Build an authenticated MCP server](https://lesto.run/guides/authenticated-mcp) — the
  end-to-end guide grounded in the example above.
- [MCP governance: the Resource Server model](https://lesto.run/batteries/mcp-governance) — scopes
  vs roles, audience binding, and the audit trail.
