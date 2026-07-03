# `@lesto/mcp` ops console — the app IS the governed MCP surface

The flagship demo of the agent-native wedge: a **real, multi-domain Lesto app** — an SRE ops
console over **services + incidents + deploys** — exposed *as it is* as a governed **remote**
[`@lesto/mcp`](../../packages/mcp) Resource Server, behind a **real self-hosted
[OpenAuth](https://openauth.js.org) issuer**, driven by a real
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol) agent that runs a genuine
**multi-step, multi-tool incident response** across all three domains.

> **The thesis, in one line.** You don't build a separate "agent API." Your app's routes *are* the
> tool surface, and `@lesto/mcp`'s OAuth Resource Server governs WHO may call them — the same
> scope/role machinery for a human's browser and for an autonomous agent. The governance is the
> battery, the issuer is config, the transport is a swap.

It's the more ambitious sibling of [`examples/mcp-auth-openauth`](../mcp-auth-openauth) (a single
live dataset — MLB — behind the same gate). Here the surface is **three linked entities** with a
real cross-entity rule, so the agent's tool calls form a **dependency chain** — later steps observe
the effects of earlier writes — instead of a flat fan-out.

## The domain (three linked entities)

```
services    the things that can break        (name, tier, derived health)
incidents   an outage against ≥1 services     (severity, status, a timeline)
deploys     a release to a service — FROZEN while that service has an open incident
```

The freeze rule lives in the **domain** (`mcp/ops.ts`), not the MCP layer — so the agent's chain is
real cause-and-effect:

```
deploy checkout@2.4.0 → deployed     (no incident)
declare sev1 on checkout             (a write)
deploy checkout@2.4.1 → BLOCKED      (frozen by the incident the agent just opened)
…mitigate → resolve the incident…    (writes)
deploy checkout@2.4.1 → deployed     (cleared — the chain's payoff)
```

## The pieces

```
idp/   — a REAL OpenAuth issuer (its own Hono app)
           /.well-known/oauth-authorization-server  (discovery)
           /.well-known/jwks.json                    (ES256 signing keys)
           /authorize → /token                       (PKCE)
           worker.ts / key-store.ts  the Cloudflare Worker entry (DO-backed key store)
mcp/   — the Lesto MCP Resource Server
           ops.ts        the services/incidents/deploys domain (+ the deploy-freeze rule)
           verify.ts     adapts OpenAuth's token → the RS's {subject, audience, scopes}
           governance.ts the @lesto/mcp battery wiring, UNCHANGED — the ops console + RS
           app.ts        substrate A: Node (`@lesto/runtime` serve + sqlite)
           worker.ts     substrate B: Cloudflare Worker (`@lesto/cloudflare` toFetchHandler)
agent.ts — a real @modelcontextprotocol/sdk agent that runs the incident response through the gate
```

**One governance, two transports.** `governance.ts` (`buildGovernedApi`) is the whole wedge in one
place; `app.ts` boots it on the Node kernel and `worker.ts` runs the *same* app on a Cloudflare
Worker. The `@lesto/mcp` battery and the OpenAuth verifier are byte-identical across both — only the
substrate (and, on the edge, the JWKS *transport*) differs.

## Roles & scopes — the per-action capability split, enforced

The app's real actions are **first-class MCP tools** (ADR 0043): `declare_incident`,
`annotate_incident`, `gate_deploy` (governed writes) and `list_services`, `list_deploys` (reads).
Each write **owns its per-tool policy floor**, and the generic `handle_request` is **omitted** —
least privilege, so an agent reaches exactly the declared actions.

The issuer mints four identities, selected by `?provider=`:

| role          | scopes               | enforced                                                              |
| ------------- | -------------------- | -------------------------------------------------------------------- |
| `sre`         | `mcp:read mcp:write` | full operator — clears the floor on every action, including `gate_deploy` |
| `oncall`      | `mcp:read mcp:write` | MAY `declare_incident` / `annotate_incident`, REFUSED `gate_deploy` (floor) |
| `viewer`      | `mcp:read`           | read only — refused every write by the **scope ceiling**             |
| `stakeholder` | `mcp:read mcp:write` | refused every write by the **role floor** — has the scope, not the role |

**Both halves of the intersection, per action:**
- the **scope ceiling** — `mcp:write` unlocks the destructive tools, so a `viewer` (`mcp:read`) is
  refused every write (`403`) and an anonymous agent can't connect (`401`); and
- the **per-tool role FLOOR** (OCP-7 + ADR 0043) — each governed tool requires its own permission ON
  TOP of `mcp:write`. So the over-scoped **`stakeholder`** — which *holds* `mcp:write` but whose role
  is granted no action permission — is refused **by ROLE**: a `403` whose challenge names the missing
  permission (e.g. `scope="incident:declare"`), not the token's scope.

**The split, now REAL.** Because each action is its own tool with its own floor, the finer
distinction the single generic `handle_request` could never express is enforced: `oncall` **may**
declare and annotate incidents but is **refused** `gate_deploy` — `sre` may do all three. That is the
`oncall`-can-declare-but-not-gate-deploy row, proven live on both substrates
(`mcp/governance.ts`'s `opsPolicy` maps each `PERMISSIONS.*` to the roles that hold it).

## What it proves (CI; tokens from the **real PKCE dance**, `idp/dance.ts`)

The same claims are proven on **both** substrates — `test/integration.test.ts` over the Node server
(live HTTP) and `test/edge.test.ts` through the actual `@lesto/cloudflare` `toFetchHandler` the
Worker ships (in-process, no workerd):

- the RS advertises the OpenAuth issuer in its RFC 9728 metadata;
- **no token → 401**;
- a valid token minted for **another OpenAuth client → 401** (the confused-deputy guard);
- the surface is **domain tools**, not the generic `handle_request` (least privilege, ADR 0043 D4);
- an **SRE** runs the **incident-response chain** through the domain tools — a declared incident
  **freezes** a subsequent `gate_deploy`, and resolving it **clears** the deploy (the cross-domain
  cause-and-effect), and the audit names the **domain action** (`gate_deploy`), not `handle_request`;
- **the four-identity matrix** — the acceptance gate:
  - a **viewer** refused every write by the **scope ceiling** (`403`, `scope="mcp:write"`);
  - an over-scoped **stakeholder** refused by the **role floor** (`403` naming the missing permission);
  - **`oncall` MAY `declare_incident` but is REFUSED `gate_deploy`** — the split that was impossible
    under the generic `handle_request`;
  - **`sre`** clears the floor on every action.

```
bun --filter '@lesto/example-mcp-ops-console' test
```

## The agent: an incident response through the gated server

`agent.ts` is a fully self-contained, runnable demo — it boots the issuer + RS in-process, runs a
real PKCE dance, and connects the actual `@modelcontextprotocol/sdk` `Client` (the library
Claude/Cursor/Inspector use) over the OAuth-gated transport.

```
bun run examples/mcp-ops-console/agent.ts            # scripted (no key needed)
ANTHROPIC_API_KEY=sk-... bun run …/agent.ts          # + Claude runs it autonomously
```

It shows an **SRE** agent run the full chain — survey the fleet, ship a clean deploy, declare a
sev1, watch the next deploy get **frozen** by it, post mitigation, resolve, then watch the deploy
**clear** — a real multi-step, multi-tool task whose later steps depend on the earlier writes; a
**viewer** refused those writes (`403`); an **anonymous** agent refused the connection (`401`). With
an API key, **Claude** is handed the same five tools and runs the incident response autonomously,
deciding the order of operations itself. The governance is the same on every call.

## Deploy (live, on Cloudflare via [Alchemy](https://alchemy.run))

Two Workers — the OpenAuth issuer and the Lesto RS — defined as TypeScript IaC in `alchemy.run.ts`
(no `wrangler.toml`). Alchemy resolves the issuer Worker's url and passes it to the RS, so the RS
trusts the issuer's JWKS with nothing hardcoded:

```
bunx alchemy login            # one-time: Alchemy needs its OWN CF creds (not wrangler's)
bun run deploy                # → prints the live issuer + RS URLs
bun run destroy               # tear down
```

> **CF gotcha — same-account Worker→Worker.** A `workers.dev → workers.dev` subrequest on the same
> account is refused (CF error 1042), so the RS reaches the issuer's JWKS through a **service
> binding** (`ISSUER` in `alchemy.run.ts`), not the public url. Against a real external IdP (a
> different origin) the binding is absent and the RS fetches the JWKS over the public internet — the
> verifier's optional `fetchJwks` seam handles both, the battery unchanged.
>
> **Key storage = a Durable Object (not KV).** OpenAuth scans storage for its signing key and mints
> a new one when the scan is empty (`keys.js`). KV's eventually-consistent `list` makes cold isolates
> each see "no key" and mint their own, so the JWKS diverges and live verification 401s. The fix
> (`idp/key-store.ts`): a single strongly-consistent **Durable Object** every isolate routes storage
> to, so one generated key is the only key any isolate sees. (A post-deploy warmup primes that key to
> avoid a cold-keygen 503 on the first request.)

## How OpenAuth's token maps to the RS

OpenAuth's access token is an **ES256** JWT carrying
`{ mode:"access", type:"user", properties:{ userID, scopes, role }, aud:<clientID>, iss, sub, exp }`.
It has **no OAuth `scope` claim**, and `aud` is the **client id**, not a resource. So `mcp/verify.ts`
adapts it onto the RS contract:

| RS needs   | OpenAuth claim          | Note |
| ---------- | ----------------------- | ---- |
| `subject`  | `properties.userID`     | the principal the RS attributes + audits |
| `scopes`   | `properties.scopes`     | the grant's MCP scopes — set server-side in the issuer's `success` callback |
| `audience` | `aud` (the client id)   | the RS's `resource` is set to the client id |

The principal's `role` also rides in the token, but the RS's source of truth is **`rolesOf`** (the
identity service), not the token — `verify.ts` reads only the few claims the battery requires, and
`rolesOf` maps the subject to the role for the (future) floor.

**`resource = clientID` is forced, not a choice.** OpenAuth 0.4.x does not implement RFC 8707
resource indicators, so `aud` is always the client id and the battery's audience guard
(`aud === resource`) requires the RS's `resource` to equal it. A token minted for a *different*
client is still refused. For true per-resource audiences (one client, many resources), use an issuer
that stamps the resource into `aud` — only the verifier changes, not the battery.

## Going to production

1. **Delete the demo providers.** `idp/issuer.ts`'s four `fixedDemoProvider`s issue a token to
   **anyone** with no credential check — a hermetic test convenience, never for production. Configure
   OpenAuth's real providers (`password`, `code`, GitHub/Google, …) instead.
2. **Persist the signing keys.** The Worker deploy already uses a Durable Object; for another host
   swap `MemoryStorage()` for a strongly-consistent store — OpenAuth keeps its ES256 signing keys in
   storage, so an in-memory store regenerates them per process.
3. **Wire `rolesOf`** to your identity service (the demo maps an email → role).
4. **Declare your own domain tools.** This console's actions are `@lesto/mcp` domain tools
   (`defineDomainTool`, ADR 0043), each with its own `requires.permission`; a production server keeps
   `handle_request` omitted so an agent reaches only the actions you declare.

The issuer is configuration. When a first-party `@lesto` Authorization Server lands (ADR 0029), you
point the verifier at its JWKS and the Resource Server is unchanged.
