---
title: "Agent control plane"
description: "Expose your running app's operations to an agent over MCP — governed: read-only by default, destructive actions gated behind an explicit mode, and every action audited."
section: Batteries
order: 24
---

# Agent control plane

`@lesto/mcp` exposes your running Lesto app's operations to an AI agent as
[MCP](https://modelcontextprotocol.io) tools. An agent in Claude, ChatGPT, or an
editor can inspect your routes, read and write content, generate UI, and drive
real requests through the live app — over one governed choke point. This is the
part of "agent-native" that's load-bearing: the agent surface is a first-class,
*audited* part of the framework, not a token you hand a model and hope.

The design rests on one idea Lesto holds throughout: every capability is an
*operation*, and the CLI, the UI, and this MCP server are three front-ends over
the same operations. An agent can't do anything you couldn't do from the command
line — it's the same operations, a different caller.

## The tools

`buildTools` assembles the tool set from a context — your running app, its routes,
and the mandatory audit sink. `dispatch` invokes one tool by name, and audits it:

```ts
import { buildTools, dispatch } from "@lesto/mcp";

const context = { app, routes: config.app.routes(), audit: (record) => log.info(record) };
const tools = buildTools(context);

await dispatch(context, tools, "list_routes", {});
await dispatch(context, tools, "create_content_entry", { collection: "blog", slug: "hello", data: {/* … */} });
```

Ten framework operations:

- **Inspect** — `list_routes` (every route the app answers), `describe_app` (the
  app's read-only contract — route map, OpenAPI document, collections, declared
  schema — in one payload), `query_content` / `list_content_collections` /
  `get_content_entry` (read the content).
- **Change content** — `create_content_entry`, `update_content_entry`,
  `delete_content_entry`.
- **Generate UI** — `generate_ui` (a Lesto UI tree from a natural-language prompt).
- **Drive the app** — `handle_request` (dispatch a real request through the running
  app and return its response).

Under `lesto dev`, three read-only introspection tools join the set —
`get_dev_diagnostics`, `get_recent_requests`, and `tail_logs`. They are built only
when the dev server injects its live state, so no other server — including the
remote transport below — can ever advertise or reach them. The same read-only
contract is also served as MCP *resources* (`lesto://routes`, `lesto://openapi`,
`lesto://collections`, `lesto://schema`) for clients that read resources instead
of calling tools.

Schema migrations are deliberately **not** on this surface — those stay in code
and the CLI.

### Your own actions, as tools

`handle_request` can drive any route you already have, but an app can also declare
its real actions as first-class tools with `defineDomainTool` — each named, typed
with a Zod input schema, and owning its own per-tool policy floor:

```ts
import { defineDomainTool } from "@lesto/mcp";
import { z } from "zod";

const declareIncident = defineDomainTool({
  name: "declare_incident",
  description: "Declare a new incident against one or more services.",
  input: z.object({ title: z.string(), services: z.array(z.string()).optional() }),
  destructive: true,
  requires: { permission: "incident:declare" },
  handler: (input, { principal }) => declare(input, principal),
});
```

Pass them as `context.domainTools`. Registration fails closed: a destructive tool
with no `requires.permission` refuses to register (unless you write a loud
`ungoverned: true`), and a governed tool on a context with no `policy` refuses too.
Once your surface is covered by domain tools, drop the generic driver with
`omitTools: ["handle_request"]` for least privilege. The full model is on
[MCP governance](/batteries/mcp-governance); `examples/mcp-ops-console` in the
repository is a complete governed console built this way.

## Governed at one choke point

Every tool call goes through `dispatch`, and `dispatch` does two things a
hand-rolled "expose an API to the model" setup does not.

**It defaults closed.** A server has a mode, and the floor is read-only:

```ts
type McpMode = "read-only" | "operator"; // unset → "read-only"
```

A tool that mutates state or drives the live app — the content writes,
`handle_request` — is marked destructive, and a destructive tool **refuses
outside `operator` mode** (a `McpError`). The safety property that matters: forget
to set the mode and the agent gets the *safe* surface. You opt **in** to letting
an agent change things.

**It audits everything.** The audit sink is mandatory — there is **no un-audited
path to a tool**. Every dispatch, success or failure, writes one record before the
result surfaces:

```ts
interface McpAuditRecord {
  tool: string;
  inputHash: string;         // a SHA-256, not the (possibly sensitive) raw arguments
  outcome: "ok" | "error";
  durationMs: number;
  actor: string | undefined; // who drove it, when the caller is authenticated
}
```

So you always have the receipts — which tool ran, who ran it, whether it
succeeded, how long it took — and, deliberately, a *hash* of the input rather than
the raw arguments, so the audit trail itself isn't where sensitive data leaks.
Point the sink at your logs, a table, anywhere.

## Start the server

`lesto mcp` serves the control plane over stdio — the transport a local MCP client
(Claude Desktop, an editor agent) launches and connects to:

```sh
lesto mcp            # read-only
lesto mcp --operator # unlocks the destructive tools
```

It boots your app from `lesto.app.ts`, wires the routes and the content store, and
writes one audit line per dispatch to stderr — stdout belongs to the MCP protocol.
The same server is a library call, `startMcpServer(context)`, taking the same
context `buildTools` does:

```ts
import { startMcpServer } from "@lesto/mcp";

await startMcpServer({ app, routes, mode: "operator", audit: (record) => log.info(record) });
```

Leave `mode` unset for a read-only server. During development you don't need a
second process at all: `lesto dev` hosts the same tool set on a loopback HTTP
transport, gated by an Origin/Host allowlist and a per-session token — that's
where the dev introspection tools live.

## Remote MCP, over OAuth

Stdio is for a *local* agent — the MCP client launches the server as a child
process, so identity is the launch context. An agent reaching your app over the
**internet** needs to authenticate per request, so `@lesto/mcp` is also a standards
OAuth **Resource Server**: `createMcpHttpHandlers` returns plain `@lesto/web`
handlers the application mounts, validating a bearer token on every request.

```ts
import { createBearerAuthenticator, createMcpHttpHandlers } from "@lesto/mcp";

const handlers = createMcpHttpHandlers({
  context: { app, routes, audit },
  authenticate: createBearerAuthenticator({ verifyAccessToken, resource, rolesOf }),
  resource,
  authorizationServers: [issuer],
  scopesSupported: ["mcp:read", "mcp:write"],
  writeScope: "mcp:write",                  // the scope that unlocks operator mode
  allowedOrigins: [],
  resourceMetadataUrl: `${baseUrl}/.well-known/oauth-protected-resource`,
});

app
  .get("/.well-known/oauth-protected-resource", handlers.metadata)
  .post("/mcp", handlers.rpc)
  .get("/mcp", handlers.noStream); // this RS streams no SSE: a clean 405, Allow: POST
```

The RS is **issuer-agnostic**: it does no JWKS work itself, so you inject a
`verifyAccessToken` that validates the token against your issuer's keys (Auth0,
Okta, a self-hosted OpenAuth, …) and hands back `{ subject, audience, scopes }`.
The same read-only/operator gate guards both transports — here the mode is
*derived from the token's scopes*, so a read-scoped token can never reach a write.
The audience guard refuses a token minted for another resource (no replay), the
origin guard blocks browser DNS-rebinding, and the audit names *who* drove each
call. Pass a compiled `policy` plus a `toolPermissions` map and each mapped tool
also gets a per-tool **role floor** — reachable only by a subject whose roles hold
that tool's permission, even with a write-scoped token. For the full model —
scopes versus roles, per-tool floors, audience binding, the audit trail — see
**[MCP governance](/batteries/mcp-governance)**; for an end-to-end build,
**[Build an authenticated MCP server](/guides/authenticated-mcp)**.

## Notes and gotchas

- **Read-only is the floor, on purpose.** An unconfigured server can never mutate
  — `mode` defaults to `"read-only"` and destructive tools refuse there. Granting
  write access is an explicit `mode: "operator"`, never an accident.
- **The audit sink is required, not optional.** There is no path to a tool that
  skips it; if you don't supply one, you don't get a quietly-unaudited agent. Make
  it durable (a table, your log pipeline) if you want the trail to survive.
- **`inputHash`, not raw args.** The audit record stores a hash of the input so the
  trail doesn't become a place arguments (which may carry sensitive content) leak.
  If you need full-fidelity replay, log it yourself inside the sink, deliberately.
- **`handle_request` runs the real app.** It dispatches an actual request through
  your handlers — same routes, same middleware, same database — so an agent
  driving it exercises production behavior, not a sandbox. It is destructive
  (operator-only) for exactly that reason. Request headers pass through an
  allowlist (`authorization`, `cookie`, `content-type`, `accept`,
  `accept-language`) — identity travels, but an agent can't spoof infrastructure
  headers like `x-forwarded-for`.
- **Branch on `code`, never the message.** Failures are an `McpError` with a stable
  `McpErrorCode` (e.g. a destructive call in read-only mode).
- **There's a separate content MCP.** `@lesto/content-mcp` is a standalone,
  file/Studio-oriented content server (preview); this page is the DB-backed
  control plane `@lesto/mcp` exposes over your running app.

For how these operations compose with the rest of the framework, see
[Why Lesto](/why-lesto) and [Concepts](/concepts).
