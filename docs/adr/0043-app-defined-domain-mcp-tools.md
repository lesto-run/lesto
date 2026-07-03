# ADR 0043 — App-defined domain MCP tools (a per-tool policy floor the app owns, so the tool SET is open)

- **Status:** **Accepted** (2026-07-03, chief-architect governance panel — verdict *ratify with
  amendments*; every cited `file:line` seam spot-checked accurate). It opens the closed part of
  the OCP-7 floor: the *floor* is already per-tool and sound (`packages/mcp/src/http.ts`
  `policyFloorChallenge`, `:607-660`), but the *tool set* is closed
  (`packages/mcp/src/tools.ts` `buildTools`, `:538,768-785`), so every app write collapses onto
  one permission. This ADR lets an app declare its own domain tools, each carrying its own
  floor. It writes **no** production code (nothing under `packages/`/`examples/` changes here)
  and it inherits the fail-closed invariants verbatim from two shipped precedents (ADR 0028's
  `createAdmin` opt-out, ADR 0034 Part B.2's absent-without-a-resolver), so the novel *risk*
  surface is small even though the *capability* surface is large. The panel confirmed the two
  load-bearing calls — app-owns-the-floor is the right ownership, and D5's rejection of a
  route-aware `handle_request` is correct (chiefly D5.2, the router-normalization confused
  deputy) — and required **two blocking amendments, now folded in**: (a) D2 gains a fourth
  fail-closed invariant — a governed domain tool on a server with **no policy configured refuses
  to register** (a `LestoMcpContext.policy` seam names where `dispatch`'s policy comes from), so
  the "no policy → floor off" back-compat rule for framework tools does **not** silently extend
  to domain tools; and (b) the dispatch-floor check and the handler consume the **single**
  `dispatch`-resolved principal (an explicit `dispatch → handler` signature extension), never a
  second `resolvePrincipal()`. Board task `L-6fd79629`.
- **Date:** 2026-07-02
- **Deciders:** tech lead + owner
- **Builds on / touches / delivers:**
  - **Delivers ADR 0028 Phase 3a item 2** — `requirePermission` at *dispatch* (0028:191-193).
    Phase 3a designed one authz gate over `policy.allows`; only the *HTTP* half shipped (the
    OCP-7 floor, `http.ts:607-660`, reached pre-dispatch by `createMcpHttpHandlers`,
    `streamable-http.ts:228,262`). `dispatch` itself (`tools.ts:847-910`) has **no** floor — it
    resolves the principal (`:862`) and audits (`:871-889`) but never checks a permission. This
    ADR is the vehicle that closes that gap for **every** transport (stdio included).
  - **Unblocks ADR 0034 Part B** — `propose_migration` / `apply_migration` were *designed* and
    *deferred* waiting for "exactly this registration + gating surface" (0034 Part B.1/B.2,
    `:215-301`); Part B.2's "absent from `buildTools` without an actor resolver" invariant
    (0034:286-288) is D2 below, generalized.
  - **Feeds ADR 0039** — the `lesto add mcp-auth` scaffold (0039 D1, `:107-121`) gains a
    domain-tools file so a scaffolded production Resource Server ships least-privilege by
    default (D4).
  - **Composes ADR 0005** — a domain tool's input is a Zod schema, validated at the boundary
    (0005 "MCP tool inputs cross the same boundary as HTTP", `:39-41,107`); JSON Schema is
    derived for `tools/list` advertisement.
  - **Composes ADR 0035** — the tool *name* is the agent-legible consent/capability unit a
    client displays; this ADR makes the app's real actions first-class names instead of one
    opaque `handle_request` (0035 "the app's conventions are the single source of agent
    legibility").
  - Touches `@lesto/mcp` only: `LestoMcpContext` (`tools.ts:158`), `LestoTool`
    (`tools.ts:282-298`), `buildTools` (`tools.ts:538`), `dispatch` (`tools.ts:847`), the OCP-7
    floor (`http.ts:571-660`), and its `toolPermissions` → `ToolRequirement` compile
    (`streamable-http.ts:98,234-239`). Composes `@lesto/authz` `Policy.allows` (`policy.ts:77`).
    **No new package, no new transport, no `kernel → mcp` edge.** The acceptance oracle is the
    ops-console's dormant `toolPolicy` fixture (`examples/mcp-ops-console/mcp/governance.ts:75-80`).

## Context

The OCP-7 per-tool floor is genuinely good, and it is genuinely *per-tool*. A deployment hands
`createMcpHttpHandlers` a compiled `Policy` plus a `toolPermissions: Record<string, string>`
map (`streamable-http.ts:89,98`); `createMcpHttpHandlers` compiles it once into a
`Map<toolName, ToolRequirement>` where each mapped tool's required scope IS the deployment
`writeScope` (`streamable-http.ts:234-239`), and `policyFloorChallenge` runs each `tools/call`
through the full intersection — scope ceiling **AND** `policy.allows(actorRoles, permission)` —
returning a `403` naming the missing permission *before* the call reaches `dispatch`
(`http.ts:607-660`). A subject with the write scope but not the role is refused; empty roles
satisfy nothing. This is the right shape.

But the machinery it gates against is a **closed set**. `buildTools(context)` returns a fixed
array — `list_routes`, `handle_request`, `generate_ui`, the six content tools, `describe_app`,
and (only under `lesto dev`) the three dev tools (`tools.ts:768-785`). There is no app-facing
registration path: `LestoTool` (`tools.ts:282-298`) is an internal shape with a `name`, an
`inputSchema`, a `destructive` flag, and a handler — nothing an application can add its own
entries to. So the *only* way an app action reaches an agent today is the single generic
`handle_request` tool (`tools.ts:555-597`): the agent hands it `{ method, path, body }` and it
drives a request back through `context.app.handle` (`:595`). One tool, `destructive: true`,
gated to operator mode (`requireOperator`, `:577,456-464`).

The consequence is that **every write in an app collapses onto one permission.** The
ops-console proves it exactly. Its `opsPolicy` grants `console:operate` to `sre` *and*
`oncall` (`governance.ts:63-66`); its live floor is `toolPermissions: { handle_request:
"console:operate" }` (`governance.ts:274`). So `declare_incident`, `annotate_incident`, and
`gate_deploy` are one indistinguishable capability — the agent calls `handle_request` with a
path, and the floor sees only `handle_request`. The example *already knows* the split it wants:
a dormant `toolPolicy` fixture (`governance.ts:75-80`) records that `oncall` may
`declare_incident`/`annotate_incident` but only `sre` may `gate_deploy` — and its own comment
admits the table "is not consulted on the live path" and that "per-route gating needs
domain-specific MCP tools (one tool per action) instead of the generic `handle_request` — a
follow-up" (`governance.ts:68-73`). The `sre`-vs-`oncall` distinction the console was designed
around is, today, **unenforceable**. This ADR is that follow-up.

The natural-but-wrong reflex — make `handle_request` route-aware, mapping paths to permissions
inside the generic tool — is a fail-open trap (D5). The sound move is to make the app's
*actions* into first-class tools, each named, each typed, each carrying its own floor.

## The core idea: the tool is the capability unit, and the app owns the tools it declares

One named idea: **a domain action is a named tool with a typed input and its own policy floor,
declared by the app and appended to the framework set.** `handle_request` becomes one governed
option among many (and an excludable one), not the sole conduit through which every app write
squeezes and thereby loses its identity.

| Concern | Resolution |
|---|---|
| **Least privilege** | `oncall` holds `incident:declare` but not `deploy:gate`; each is a distinct tool with a distinct permission, so the floor discriminates them — the split the ops-console fixture wanted, now real. |
| **Legibility (ADR 0035)** | The agent (and the human approving it) sees `gate_deploy`, not `handle_request({method,path})`; the consent unit is the real action. |
| **Typed boundary (ADR 0005)** | The tool's input is a Zod schema, validated at dispatch; JSON Schema is derived for `tools/list`. Beats parsing an opaque `{method,path,body}`. |
| **One gate, every transport** | The declared floor compiles into the *same* requirements map the HTTP floor consumes AND is enforced inside `dispatch`, so stdio — which has no floor today — is finally gated. |
| **One surface, three consumers** | App domain tools, ADR 0028's admin tool set, and ADR 0034's migration tools are the *same shape* — this ADR builds the surface all three were waiting for. |

The abstraction is minimal: a domain tool is a `LestoTool` (`tools.ts:282-298`) plus a
`requires` clause. Everything else — dispatch, audit, the floor — already exists; this ADR
opens the *set* and threads the floor through *both* enforcement points.

## Decision

Apps declare domain tools natively; each carries its own per-tool policy floor; `handle_request`
becomes one governed option among many, excludable. Five numbered decisions.

### D1 — The declaration API

`LestoMcpContext` (`tools.ts:158`) gains two fields — the tool list and the **policy seam** the
dispatch floor adjudicates against:

```ts
domainTools?: readonly LestoDomainTool[];
policy?: Policy;   // where dispatch's floor gets its Policy.allows (@lesto/authz, policy.ts:77)
```

**The `policy` seam is load-bearing and is amendment (a).** The dispatch floor (D3) checks
`policy.allows(principal.actorRoles, requires.permission)`; that `policy` must be reachable from
the dispatch context. On the HTTP path it is the same compiled `Policy` the deployment already
hands `createMcpHttpHandlers` (`streamable-http.ts:89`); on stdio it is threaded here. When a
domain tool declares a `requires` floor but **no `policy` is configured on the context**, the
tool **refuses to register** (D2.4) — the framework tools' back-compatible "no policy → floor
off" rule (`http.ts:595-600`) must **not** extend to domain tools, or a governed-on-paper tool
would ship scope-ceiling-only in fact.

`buildTools` (`tools.ts:538`) appends them **after** the framework set and before the
conditional dev tools, preserving the "order is stable" contract its docstring already makes
(`tools.ts:534-536,768-785`) — the same append-at-the-end discipline the dev tools already use
(`:783`). A `LestoDomainTool` is:

```ts
interface LestoDomainTool<I = unknown> {
  name: string;                       // the agent-legible action name (ADR 0035)
  description: string;                // shown in tools/list
  input: ZodSchema<I>;                // validated at DISPATCH (ADR 0005); JSON Schema derived for tools/list
  destructive: boolean;               // surfaced on the LestoTool; gates operator-mode + the default scope
  requires?: {
    scope?: string;                   // defaults to the deployment writeScope for a destructive tool
    permission: string;               // the policy permission the floor checks (Policy.allows)
  };
  handler(input: I, ctx: { principal?: Principal }): Promise<unknown>;
}
```

- **`input` is a Zod schema, not a raw JSON-Schema object.** The framework `LestoTool` carries a
  JSON `inputSchema` (`tools.ts:287`); a domain tool carries the Zod schema and the adapter
  *derives* the JSON Schema for `tools/list` and *parses* the input at dispatch (ADR 0005 —
  "MCP tool inputs cross the same boundary as HTTP … the same machine-readable, codable
  validation result", 0005:39-41). A parse failure is a coded boundary refusal, not a crash.
- **The handler receives the resolved principal**, so a domain write can attribute to and
  reason about the subject (`ctx.principal` is the `{ actor, actorRoles }` `dispatch` already
  resolves, `tools.ts:862`) — the seam the ops-console's `handle_request` currently lacks (it
  hard-codes `actor: "sre@ops.example.com"`, `governance.ts:200,213`). **It is the SAME single
  resolution the dispatch floor checks against — amendment (b).** `dispatch` resolves the
  principal once (`tools.ts:862`); D3's floor check and this handler call both consume *that*
  value via an explicit `dispatch → handler` signature extension (`handler(input, ctx.principal)`).
  A domain-tool wrapper must **never** call `resolvePrincipal()` a second time: a non-memoized
  stdio resolver could return a different principal on the second call, so the tool would be
  *checked-as-A* by the floor but *run-as-B* by the handler.
- **`requires.scope` defaults to the deployment write scope for a destructive tool**, mirroring
  the OCP-7 rule that "each mapped tool's required scope IS the write scope, so the floor
  intersects exactly with the existing ceiling" (`http.ts:576-578`, `streamable-http.ts:237`).
  A non-destructive tool with no `requires` carries no floor and is governed by the scope
  ceiling alone — exactly as an unmapped framework tool is today (`http.ts:598-600,627-628`).

### D2 — Fail-closed registration invariants

Four invariants, each lifted verbatim from an established, shipped precedent — so this ADR
introduces *no new* fail-closed philosophy, only applies the existing ones to a new surface:

1. **A destructive domain tool with no `requires.permission` refuses to register** — unless the
   site declares a loud, greppable opt-out `ungoverned: true`. This is the `createAdmin`
   convention *verbatim*: "a supplied `policy` makes governance mandatory … an explicit
   `{ ungoverned: true }` is the only — loud, greppable — way to opt out. There is no silent
   'no policy → fully open' default" (0028:127-129). A destructive tool that could ship with no
   floor would invert the framework's structural deny-by-default.
2. **A destructive domain tool with no principal resolver is ABSENT from `buildTools` output
   entirely** — not present-and-refusing. This is ADR 0034 Part B.2's invariant generalized:
   "`apply_migration` registers **only** when a real actor resolver … [is] present … otherwise
   fails closed — it is absent from `buildTools` output entirely" (0034:286-288), and ADR 0028
   Phase 3a's ordering rule: "the principal resolver … land[s] **before** any mutating admin
   tool is registered (or mutating tools fail-closed: they refuse to register without a
   resolver)" (0028:211-214). Concretely: when `context.resolvePrincipal` is absent
   (`tools.ts:216`), destructive domain tools do not appear — a build-time gate, the same
   mechanism the dev tools already use for `devState` (`tools.ts:783`), not a runtime check.
3. **Name collisions refuse.** A domain tool whose `name` equals a framework tool's (or another
   domain tool's) throws at build — no silent shadowing. `dispatch` resolves a tool by
   `tools.find(name)` (`tools.ts:891`), so a duplicate name would make dispatch order the
   security boundary; refusing at registration keeps the name a stable capability identifier
   (ADR 0035). The collision check runs against the **full framework name set regardless of
   `omitTools`** — an omitted framework tool's name may not be re-claimed by a domain tool, so a
   later un-omit can never silently re-point a name.
4. **A governed domain tool with no `policy` configured on the context refuses to register**
   (amendment (a)). A domain tool that declares a `requires` floor needs a `Policy` to adjudicate
   it (D1's `policy` seam); if the context supplies none, the tool is not shippable governed —
   it refuses at build, mirroring D2.1's `createAdmin`-verbatim "a supplied `policy` makes
   governance mandatory … no silent 'no policy → fully open' default" (0028:127-129). This closes
   the one fail-open hole of exactly the shape D5 rejects: without it, a `requires.permission`
   would satisfy D2.1 at registration yet nothing would ever adjudicate it (both floor call sites
   skip when no policy is configured — `http.ts:616`, `streamable-http.ts:313-315`). Enforced at
   **both** entry points: `createMcpHttpHandlers` construction and the stdio `buildTools`.

### D3 — Floor composition: one owner per tool's floor

A declared `requires` compiles into the **same** `Map<toolName, ToolRequirement>` that
`policyFloorChallenge` consumes (`http.ts:612,624-625`; the shape `{ scope, permission }`,
`http.ts:571-582`). So a domain tool's floor is enforced by the identical intersection logic
the OCP-7 floor already runs — no second authorization path.

- **The two maps have disjoint ownership.** A deployment's `toolPermissions`
  (`streamable-http.ts:98`) owns the floors for **framework** tools (`handle_request`, the
  content writes). A domain tool's `requires` owns the floor for **that** tool. A deployment
  `toolPermissions` entry that names a **domain** tool is **REFUSED** at handler construction —
  the declaration is the single owner of a domain-tool floor, so the two cannot disagree about
  one tool's permission. (Without this rule a domain tool could have two floors — one from its
  declaration, one from the deployment map — and the enforcement would depend on which map
  `policyFloorChallenge` consulted; making it an error removes the ambiguity.)
- **Enforce in BOTH gates.** Today the floor is HTTP-only: `createMcpHttpHandlers` runs
  `policyFloorChallenge` before dispatch (`streamable-http.ts:223-224,262`), but `dispatch`
  itself (`tools.ts:847-910`) has **no** permission check — it resolves the principal and
  audits, then runs the handler. That means **stdio has no floor at all** — the same landmine
  ADR 0034 Part B.2 flagged (an operator-mode stdio server would run a governed write
  unattributed and ungated, 0034:280-288). This ADR closes it: a domain tool's floor is also
  enforced **inside `dispatch`** —
  `policy.allows(ctx.principal.actorRoles, requires.permission)` before the handler runs,
  refusing a coded `MCP_FORBIDDEN` on denial (the code ADR 0028 Phase 3a / 0034 name). The HTTP
  path keeps its pre-dispatch `403` (a clean challenge the client can step up against); the
  dispatch check is the belt-and-suspenders floor that *also* covers stdio and any future
  transport. **This is the delivery of ADR 0028 Phase 3a item 2** — `requirePermission` at
  dispatch (0028:191-193) — which no shipped code provides.
- **Empty roles satisfy nothing** (`http.ts:604-605`): an attributed-but-unprivileged subject
  is denied, and an *unauthenticated* dispatch (no resolver, or a resolver returning
  `undefined`, `tools.ts:862`) has empty roles → every governed domain tool denies. Deny by
  default, at the dispatch floor, on every transport.

### D4 — `handle_request`'s position: kept, but now excludable

`handle_request` stays exactly as it is — the governed generic escape hatch, `destructive:
true`, floor-gated by a deployment `toolPermissions` entry. It remains the right tool for an
app whose MCP surface is *not* fully enumerated as domain tools. But once an app's surface **is**
covered by domain tools, keeping the generic driver around is gratuitous privilege: it lets an
agent reach *any* route (subject to the one `handle_request` permission), re-collapsing the
per-action floor the domain tools just bought.

So `LestoMcpContext` gains:

```ts
omitTools?: readonly string[];   // e.g. ["handle_request"]
```

`buildTools` filters these from its output. A production Resource Server whose surface is fully
covered by domain tools sets `omitTools: ["handle_request"]` and drops the generic driver — the
least-privilege, recommended production posture. **This is what the ADR 0039 `lesto add
mcp-auth` scaffold generates** (0039 D1 "least-privilege read-only agent role, impersonation
tools never registered", `:114-120`): a scaffolded production MCP server ships domain tools +
no `handle_request`, so an agent can perform exactly the declared actions and nothing else.

### D5 — Rejected alternative: a route-aware floor on `handle_request`

The red-team's natural counter-proposal, steelmanned first: **leave the tool set closed and
make `handle_request` route-aware** — a `Map<pathPattern, permission>` consulted inside the
generic tool, so `POST /deploys` demands `deploy:gate` and `POST /incidents` demands
`incident:declare`, all through the one existing tool. It is appealing: no new declaration API,
the app already has a router, and it reuses `handle_request`'s header-allowlist plumbing
(`tools.ts:466-596`). Recorded and rejected, for three reasons:

1. **Fail-open by omission.** With the tool set closed and the floor keyed on a route→permission
   table, a **newly added route ships reachable under the bare write scope until someone maps
   it.** That inverts deny-by-default: the safe state (a new action is *unreachable* until
   explicitly governed) becomes the unsafe default (reachable until explicitly restricted). The
   domain-tool surface has the opposite failure mode: a destructive tool with no permission
   *refuses to register* (D2.1), so the unmapped state is unreachable, not open.
2. **It duplicates the router inside the governance layer.** A route→permission table must match
   the app router's path-param, trailing-slash, and case normalization **byte-for-byte**, or the
   floor and the dispatch disagree about which permission a request needs — a request the floor
   matches to `deploy:gate` but the router resolves to a *different* handler is a
   confused-deputy waiting to happen. Tool-name-as-capability sidesteps the coupling entirely:
   the name is the key on both sides, with no normalization to keep in sync.
3. **Tool names are the agent-legible consent unit** (ADR 0035): a client displays
   `gate_deploy` and a human approves *that*, not `handle_request` with an argument buried in a
   `path` string. And a typed Zod input (ADR 0005) beats a raw `{method, path, body}` blob at
   the boundary. The route-aware floor keeps the capability opaque; the domain-tool surface
   makes it legible.

The steelman's one real win — "no new API" — is outweighed by inverting the default and
duplicating the router. Domain tools win.

## Strategic framing: one declaration surface, three already-designed consumers

The domain-tool declaration+gating surface this ADR builds is the *same shape* three separate,
already-designed pieces of the roadmap were each waiting on:

- **ADR 0028 Phase 3a item 1 — the admin tool set** ("an *explicitly allow-listed* set of
  resources as `list/get/create/update/destroy_<resource>` tools … Never auto-expose tables",
  0028:189-190). Each admin tool is a domain tool: a name, a typed input, a per-tool floor.
- **ADR 0034 Part B — `propose_migration` / `apply_migration`** (designed, deferred, "waiting
  for exactly this registration + gating surface", 0034:200-301). `apply_migration` is a
  destructive domain tool with `requires.permission = "schema:apply"` and D2's
  absent-without-a-resolver invariant is literally its Part B.2 rule (0034:286-288).
- **App domain tools** — the ops-console's `declare_incident` / `annotate_incident` /
  `gate_deploy` (this ADR's acceptance demo).

All three are the same declaration; building it once serves all three. This ADR is *also* the
vehicle that builds **ADR 0028 Phase 3a item 2** (`requirePermission` at dispatch, 0028:191-193)
— the dispatch-floor half (D3) that no shipped code provides, and that ADR 0034 Part B.2 assumes.
**Superseding note:** 0028 Phase 3a item 2 also proposed *retiring* `requireOperator` / `McpMode`
("one model, one place denials are decided"). This ADR delivers the `requirePermission`-at-dispatch
half but **keeps the operator-mode ceiling** — per OCP-7's intersection posture, denials are
decided by scope ceiling **and** policy floor together. So 0028's retirement clause is *superseded,
not delivered*; do not read 0028's record as fully closed.

## Non-goals

- **Not auto-exposing tables or routes as tools.** Domain tools are *declared*, one by one,
  like the admin tool set's allow-list (0028:189-190). No "mount every route as a tool" DSL.
- **Not row-level authorization.** The floor stays role→permission via `Policy.allows`
  (`policy.ts:77`), per-`(tool)` — the same ceiling ADR 0028 (`:280-281`) and ADR 0034
  (`:329-331`) draw. A domain tool's *handler* may enforce finer rules; the *floor* does not.
- **Not a new transport or package.** Domain tools ride the existing stdio and Streamable-HTTP
  transports; no `kernel → mcp` edge (the wave-wide invariant, 0028:234-238).
- **Not retiring `handle_request`.** It stays as the governed generic escape hatch (D4);
  `omitTools` makes dropping it a *deployment* choice, not a framework removal.
- **No silent fail-open.** A destructive domain tool with no floor refuses to register (D2.1);
  with no resolver it is absent (D2.2); a governed tool with no configured `policy` refuses to
  register (D2.4); a deployment map naming a domain tool is refused (D3); the dispatch floor
  denies unauthenticated and unprivileged subjects (D3).

## Acceptance demo (specified, not built here)

Convert the ops-console's dormant `toolPolicy` fixture (`governance.ts:75-80`) into **real
domain tools** — `declare_incident`, `annotate_incident`, `gate_deploy` — each declared with
its `requires.permission` (`incident:declare`, `incident:annotate`, `deploy:gate`), replacing
the generic `handle_request` path for those writes, and set `omitTools: ["handle_request"]` once
the surface is covered. Prove the **four-identity matrix live**, driven by the existing
`demoRolesOf` (`governance.ts:291-297`) and an `opsPolicy` extended to grant the per-action
permissions:

- **viewer** (no write scope) — refused by the **scope ceiling** (`scopeCeilingChallenge`,
  `http.ts:547`) before the floor is even consulted.
- **stakeholder** (write scope, no operating role — the over-scoped identity `ROLES.stakeholder`
  exists for, `governance.ts:43-45`) — refused by the **floor**, `403 insufficient_scope`, the
  scope ceiling alone would have let them through.
- **oncall** — **can** `declare_incident` / `annotate_incident`, **refused** `gate_deploy` (the
  split that is unenforceable today).
- **sre** — can do all three.

Proven on **BOTH** substrates the example already runs verbatim — the Node kernel (`./app.ts`)
and the Cloudflare Worker (`./worker.ts`) — since `buildGovernedApi` is byte-identical across
them (`governance.ts:1-18`). Each governed call emits a per-tool audit record naming the
**domain action** (`McpAuditRecord.tool` = `gate_deploy`, not `handle_request`, `tools.ts:128-152`),
so the audit finally distinguishes *what* an agent did. A cheap **Part-A extension** (ADR 0034):
`describe_app` and the contract resources list the app's domain tools, so an agent reads the
real action vocabulary as first-class contract.

This matrix — **and specifically the `oncall`-can-declare-but-not-deploy row** — is the
acceptance gate: it is the exact assertion the ops-console's fixture comment says is impossible
under the generic `handle_request` (`governance.ts:68-73`).

## Consequences

- The OCP-7 floor's per-tool discrimination becomes *usable*: an app's real actions are the
  tools, so `oncall` ≠ `sre` at the permission boundary — the ops-console's designed-for split
  is finally enforceable, and the dormant `toolPolicy` fixture (`governance.ts:75-80`) becomes
  live code instead of a documented aspiration.
- **stdio gains a floor for the first time — for *domain* tools.** D3 threads `requirePermission`
  through `dispatch` (`tools.ts:847`), delivering ADR 0028 Phase 3a item 2 (0028:191-193) — the
  gap the HTTP-only floor left open, and the landmine ADR 0034 Part B.2 flagged for
  `apply_migration` (0034:280-288). **Scope honesty:** this covers domain tools (whose `requires`
  rides the context to `dispatch`). Framework destructive tools (`handle_request`, the content
  writes) on stdio remain gated by operator mode alone, because deployment `toolPermissions` is
  HTTP-construction-scoped; threading context-level permissions for *framework* tools to dispatch
  is a follow-up, not this ADR.
- **One surface unblocks three roadmap items** — the admin tool set (0028 Phase 3a item 1), the
  migration tools (0034 Part B), and app domain tools are the same declaration; the scaffold
  (0039 D1) emits a domain-tools file so production Resource Servers ship least-privilege
  (`omitTools: ["handle_request"]`) by default.
- **New risk, honestly small.** The capability surface grows (apps now inject handlers that run
  under governance), but the *fail-closed* invariants (D2) are lifted verbatim from shipped
  precedent (`createAdmin`'s opt-out, 0028:127-129; Part B.2's absent-without-a-resolver,
  0034:286-288), and the floor reuses the exact intersection logic already reviewed for OCP-7
  (`http.ts:607-660`). The genuinely new correctness surface is small: (a) the deriving of JSON
  Schema from Zod + parse-at-dispatch (ADR 0005), (b) the dispatch-floor enforcement path, and
  (c) the disjoint-ownership refusal (D3). Those three are the panel's focus.
- **`handle_request` stops being load-bearing.** It stays for un-enumerated surfaces but is no
  longer the sole conduit; the least-privilege production posture drops it. The header-passthrough
  hole ADR 0028 Phase 3a item 5 worried about (`:204-209`) shrinks accordingly — a scaffolded RS
  need not expose it at all.

## Reviews

**Ratified 2026-07-03** by the chief-architect governance panel (grounded in the cited
`file:line` seams, the same bar ADRs 0028 / 0034 / 0039 / 0042 cleared): **ratify with two
blocking amendments**, both folded into the Status note, D1, D2.4, and D3 above — (a) governed
domain tools fail closed when no `policy` is configured (the `LestoMcpContext.policy` seam), and
(b) the dispatch floor and handler share the single dispatch-resolved principal. The panel
verified the design was "unusually well-grounded" (every citation spot-checked) and confirmed
app-owns-the-floor and the D5 route-aware rejection (chiefly D5.2). Non-blocking follow-ups
(refuse a `toolPermissions` entry naming an unknown tool; the non-destructive-`requires`-without-
`scope` default rule) are tracked on the board. The three claims the panel pressed hardest and
cleared:

- **D3's disjoint-ownership rule is load-bearing** — verify there is no path by which a domain
  tool ends up with two floors (its declaration + a deployment `toolPermissions` entry) that
  could disagree; the refusal must fire at handler construction, before any request.
- **D3's dispatch-floor must not double-refuse or diverge from the HTTP pre-dispatch `403`** —
  the HTTP path already refuses pre-dispatch (`http.ts:607-660`); the dispatch check must be the
  *same* decision (`policy.allows` over the same requirement), so a request that passes the HTTP
  gate never then fails the dispatch gate, and stdio (which has only the dispatch gate) gets the
  identical verdict. A drift between the two is a correctness bug the panel must rule out.
- **D2.2's build-time absence must hold for domain tools exactly as it does for `apply_migration`
  and the dev tools** — a negative test (a destructive domain tool declared, no resolver wired →
  absent from `buildTools`, not present-and-refusing), mirroring 0034:286-288 and the `devState`
  gate (`tools.ts:783`).
