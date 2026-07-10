---
title: MCP governance
description: The governance model behind Lesto's MCP control plane — the Resource Server, scopes versus roles, the audience (confused-deputy) guard, and the mandatory audit trail.
section: Batteries
order: 25
---

# MCP governance

Handing an AI agent a way to drive your app is handing it a credential. The
question this page answers is the one that follows: *what stops it from doing
something it shouldn't?* Lesto's answer is that the agent surface is governed at a
single choke point, the same way every other operation is — and when that surface
is exposed remotely over HTTP, it sits behind a standards OAuth **Resource
Server**.

This is the conceptual model. For the tool set and the stdio transport, see
[Agent control plane](/batteries/mcp); for a step-by-step build, see
[Build an authenticated MCP server](/guides/authenticated-mcp).

## Two checks, in tension

A complete authorization decision for an agent has two independent checks, and
both must hold. They answer different questions:

- **Scope** — *what was this token granted?* A scope is a property of the
  **token**: the issuer minted it for `mcp:read`, or for `mcp:read mcp:write`. It
  bounds the credential regardless of who holds it. A read-scoped token can never
  reach a write, however privileged its bearer.
- **Roles** — *who is this subject, and what may they do?* A role is a property of
  the **principal**: the subject `alice@example.com` is an `operator` or a
  `viewer`, and your `@lesto/authz` policy maps roles to permissions. It bounds the
  subject regardless of the credential.

Neither subsumes the other. A broadly-scoped token in the hands of a low-privilege
subject should still be bounded by that subject's roles; a high-privilege subject
presenting a read-only token should still be bounded by that token. So the full
decision is their **intersection** — permitted only when *both* the scope ceiling
and the role floor allow it. `@lesto/mcp` expresses exactly that:

```ts
authorizeBearer({ scopes, requiredScope, roles, policy, permission })
// permitted iff  scopes.includes(requiredScope)  &&  policy.allows(roles, permission)
```

The ceiling is checked first, so a scope-insufficient call never consults the
policy.

> **What is wired today.** Every gate on this page is enforced on the dispatch
> path: the scope ceiling, the audience and origin guards, the mandatory audit,
> and the per-tool role floor (opt-in for the framework tools, declaration-owned
> for domain tools — see below).

## The scope ceiling, expressed as a mode

Lesto's stdio control plane has always had a two-value mode — `read-only` (the
floor) and `operator` (unlocks the destructive tools). The remote RS does not
invent a second mechanism; it **derives** that mode from the token's scopes:

```ts
mcpModeForScopes(scopes, { writeScope: "mcp:write" })
// has the write scope → "operator";  otherwise → "read-only"
```

A token carrying the write scope unlocks `operator`, so the destructive tools
(`handle_request`, the content writes) become reachable; any narrower token gets
the read-only floor. The scope vocabulary belongs to your deployment — the write
scope's name is injected, not baked in. The effect is that the *same* gate guards
both transports: a forgotten configuration fails closed to read-only either way.

A scope-short write is refused at the **HTTP layer** with a `403 insufficient_scope`
(RFC 6750 §3.1) *before* it reaches dispatch — not surfaced as a JSON-RPC error
inside a `200`. The same refusal is enforced in depth by `dispatch`'s own
operator gate, so a call that slips the HTTP-layer peek is still refused — just as
a coded error rather than a clean `403`.

## The role floor, per tool

The floor half of the intersection is wired per tool, at two levels.

**Framework tools** are mapped by the deployment. Hand `createMcpHttpHandlers` a
compiled `policy` plus a `toolPermissions` map:

```ts
createMcpHttpHandlers({
  // …
  policy,
  toolPermissions: { create_content_entry: "content:write" },
});
```

A mapped tool is refused with a `403` *before dispatch* unless the subject's roles
hold its permission — even in `operator` mode, so "any write-scoped bearer can
drive any write" is closed. A tool absent from the map carries no floor (the scope
ceiling governs it), and a map entry naming no built tool is refused at
construction (`MCP_UNKNOWN_TOOL_FLOOR`) — a typo can never ship its intended
target floorless.

**Domain tools** own their floor in their own declaration —
`requires: { permission, scope? }` on `defineDomainTool` (see the
[control plane](/batteries/mcp)). That floor is enforced inside `dispatch` itself
(`MCP_FORBIDDEN`), so it holds on **every** transport — the remote RS *and* the
stdio server, which has no HTTP gate in front of it.

Registration fails closed, by rule:

- A **destructive tool with no floor** refuses to register
  (`MCP_DOMAIN_TOOL_UNGOVERNED`) — shipping an ungoverned write takes a loud,
  greppable `ungoverned: true`.
- A **governed tool on a context with no `policy`** refuses
  (`MCP_DOMAIN_TOOL_POLICY_REQUIRED`) — nothing could adjudicate its permission.
- A **non-destructive governed tool must name its `scope` explicitly**
  (`MCP_DOMAIN_TOOL_SCOPE_REQUIRED`) — a destructive tool's scope defaults to the
  write scope, but defaulting a *read* to the write scope would wrongly demand
  write.
- A **name collision** with a framework tool or another domain tool refuses
  (`MCP_DOMAIN_TOOL_NAME_CONFLICT`).
- A **destructive domain tool on a server with no principal resolver is absent**
  — never present-and-open, since its write could not be attributed.

Ownership is disjoint: `toolPermissions` may not name a domain tool
(`MCP_DOMAIN_TOOL_FLOOR_CONFLICT`) — the declaration is the single owner of that
tool's floor, so the two maps can never disagree. And once domain tools cover the
surface, drop the generic driver with `omitTools: ["handle_request"]`; an omit
naming no known tool is refused too (`MCP_UNKNOWN_OMIT_TOOL`), because a typo'd
omit would silently leave the intended tool exposed.

## Audience binding: the confused-deputy guard

A bearer token is bearer — whoever holds it can present it. The danger is
*replay*: a token a user granted to service A, presented to service B, which
honors it because the signature checks out. That is the confused-deputy problem,
and the defense is the token's **audience** (`aud`) — the resource the issuer
minted it *for*.

The RS is configured with its own `resource` identifier, and a validated token
whose `aud` does not name that exact resource is **refused — no passthrough**:

```ts
createBearerAuthenticator({ verifyAccessToken, resource: "https://api.example.com/mcp", rolesOf });
```

A token minted for some other audience never authenticates here, no matter how
valid its signature. The comparison is exact (per RFC 7519 §4.1.3 — no
trailing-slash, port, or case normalization), so the `resource` must be
byte-identical to the `aud` your issuer stamps. And it must be non-empty: a blank
`resource` would make the guard vacuous (`"" === ""` holds), so it is rejected at
construction with `MCP_RESOURCE_REQUIRED` rather than silently honoring every
token.

## Issuer-agnostic by construction

The RS does **no** token cryptography itself. It takes no dependency on any
issuer, carries no `jose`/JWKS code, and verifies nothing directly. Instead you
inject one seam:

```ts
type VerifyAccessToken = (token: string) => MaybePromise<AccessTokenClaims | undefined>;
//   AccessTokenClaims = { subject, audience, scopes }
```

Your implementation validates the JWT against your issuer's JWKS — **offline**,
from cached keys, so authentication makes no network call on the hot path — and
returns the three claims the RS reads. A bad token is `undefined` (a `401`), never
a throw. Because the verifier is the *only* issuer-specific code, pointing the RS
at a different issuer — Auth0, Okta, WorkOS, a self-hosted OpenAuth, or a
first-party server later — is that adapter plus config, never a battery change.

The seam also hands back the **already-split** scope tokens, not the raw
space-delimited `scope` string. The ceiling is an exact-membership check, so a
single un-split `["mcp:read mcp:write"]` element would match nothing and deny
everything — splitting is the verifier's job.

## Discovery: RFC 9728 Protected Resource Metadata

A client that hits the MCP endpoint without a token needs to know *where to get
one*. The RS serves the standard **Protected Resource Metadata** document at
`.well-known/oauth-protected-resource` — its resource identifier, the issuer(s) it
trusts, and that it accepts a bearer in the `Authorization` header only:

```json
{
  "resource": "https://api.example.com/mcp",
  "authorization_servers": ["https://issuer.example.com"],
  "bearer_methods_supported": ["header"]
}
```

An unauthenticated request gets a `401` whose `WWW-Authenticate` points at this
document (RFC 9728 §5.1), so a spec-compliant client can discover the issuer and
obtain a token without anything hardcoded.

## The origin guard

One more refusal sits *before* the token is even read. A malicious web page in a
victim's browser could otherwise drive a local MCP server via DNS rebinding — so a
request carrying an `Origin` header (browsers always attach one) must have that
origin on the allowlist. An **absent** `Origin` is a non-browser client (the
agent's own HTTP call, curl), which carries no rebinding risk, so it is allowed. A
disallowed origin is a `403` with no challenge — it isn't an authentication
problem, so there's nothing for the client to retry with credentials.

(The guard covers the `Origin` header; Host-header rebinding is a deployment
concern — bind the server to loopback or a trusted host.)

## The audit trail: who did what

Authorization decides *whether* a call runs; the audit records *that* it ran. The
sink is **mandatory** — there is no un-audited path to a tool. Every dispatch,
success or failure, known tool or typo, lands one record *before* the result
surfaces:

```ts
interface McpAuditRecord {
  tool: string;
  inputHash: string;         // a SHA-256 of the input — never the raw arguments
  outcome: "ok" | "error";
  durationMs: number;
  actor: string | undefined; // the resolved principal's subject — WHO drove it
}
```

On the remote path, `actor` is the bearer token's subject, bound to a principal
the moment the token authenticates — so the trail names *who* drove each call, not
just *what* ran. The input is recorded as a **hash**, never the raw arguments, so
the audit trail itself isn't where a session cookie or a content body leaks; if
you need full-fidelity replay, log it deliberately inside your own sink.

## The model in one paragraph

A remote MCP request is governed by, in order: an **origin guard** (no DNS
rebinding), **bearer authentication** through your injected verifier, an
**audience guard** (no replayed tokens), a **scope ceiling** (a read token can't
write), a per-tool **role floor** (a write-scoped bearer still needs the role the
policy grants), and a **mandatory audit** (who ran what). The full authorization
decision is the intersection of the ceiling and the floor, and every gate is
enforced on the dispatch path today. The whole point: the agent gets the *safe*
surface by default, and every escalation is a deliberate, audited,
standards-shaped grant.
