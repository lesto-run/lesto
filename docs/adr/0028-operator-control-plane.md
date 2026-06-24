# ADR 0028 — Operator control plane (governed, attributable, impersonation-aware admin)

- **Status:** Accepted. **Phase 1** (the dual-principal request model + per-verb authz
  gating in `@lesto/admin`, actor-only audit) is the committed build-now. **Phase 2**
  (impersonation overlay) is designed here and gated on Phase 1. **Phase 3a** (MCP
  governance over the *existing stdio* transport) is designed here and gated on Phase 1
  + a real roles store. **Phase 3b** (remote MCP — Streamable-HTTP + OAuth Resource
  Server) is **committed**, gated on the `userId → roles` store **+ a configured
  external IdP as its first token issuer** — it is **not** blocked on building the
  first-party AS (**ADR 0029**), which lands later as the battery that removes the
  external-IdP dependency. Role-aware *field* projection (incl. PII data-masking), the
  operator console UI, and a durable audit store remain deferred (Phase 1.5+). Revised twice
  2026-06-20 — a grounded single pass, then a 3-lens adversarial panel — each of which
  cut scope; the remote surface was then re-committed with the AS made an explicit,
  separately-ADR'd prerequisite. See *Reviews*.
- **Date:** 2026-06-20
- **Deciders:** tech lead + owner
- **Builds on / touches:** ADR 0003 (auth strategy), ADR 0005 (validation at the
  boundary), ADR 0016 (secure-by-default kernel), ADR 0020 (auth factors), ADR 0021
  (app-builder AI primitives — related agent context; `@lesto/mcp` has no dedicated
  ADR). Composes `@lesto/authz` (`definePolicy` / `Policy.allows`), `@lesto/identity` +
  `@lesto/auth` (`Session.userId`), `@lesto/admin` (`createAdmin`, the `onMutation`
  seam), and `@lesto/mcp` (`buildTools` / `dispatch`, the `McpAuditSink`).

## Context

`@lesto/admin` today is an honest but small thing: a typed CRUD substrate over a
`@lesto/db` table — `list/get/create/update/destroy` with Zod-validated input
(`packages/admin/src/admin.ts:211`), a **static** column allow-list projection
(`admin.ts:184-195`), and a post-write `onMutation` audit hook whose `AuditEvent`
already separates an `actor` from the row it changed (`admin.ts:67-82`). Critically,
that `actor` is typed `unknown` and **caller-supplied** — the layer's own docstring
says it "attributes, it does not authenticate" (`admin.ts:88-90`), and the live demo
passes `c.query("role")` as the actor (`examples/estate/src/lab.tsx:337-340`).

We are **not** trying to be the WordPress REST API. Content authoring belongs in the
`content-*` packages. What an admin actually needs — and what both a CMS owner and a
SaaS owner need *identically* — is the **operations plane around** their data: who may
operate on it, the ability to act on a customer's behalf for support, and a
trustworthy record of who did what. The hard problems are **permissions, user
impersonation, and authentication** — not CRUD. This ADR re-scopes `@lesto/admin` to
that mission: an **application-agnostic operator control plane**.

The raw materials exist and are good but are not bound together, and the request has
no notion of *who is really acting*:

- **Authz is unbound from operations.** `@lesto/authz` is solid — `definePolicy` with
  roles, wildcard grants, cycle-safe inheritance, deny-by-default; an imperative
  `Policy.allows(roles, permission)` primitive (`packages/authz/src/policy.ts:77`) and
  a `can()` route middleware over it. But `@lesto/admin` calls *none* of it.
- **Roles are demo-grade, and nothing maps a user to them.** The guard reads roles
  from a `"roles"` context var (`guard.ts:59-63`) that *something upstream* must set;
  today only estate's demo sets it, off a query string (`lab.tsx:59-61`). There is
  **no** `userId → roles` mapping in `@lesto/identity`/`@lesto/auth` (`User` has no
  roles column — `packages/identity/src/user.ts:43-51`, `guard.ts:13-16`).
- **Impersonation does not exist — the last attempt was torn out as a hole.** estate's
  old `?as=<id>` swap was *removed* for being unsafe; the tests assert the absence
  (`examples/estate/test/security.test.ts:5-6,89`). Naive "become this user" is a
  privilege-escalation bug, not a feature.
- **No OAuth, no roles store, no remote transport — today.** `@lesto/auth` states
  OAuth is "a future adapter, out of scope here" (`packages/auth/src/index.ts:17`);
  the only credentials minted are opaque session tokens (`auth/sessions.ts:48-58`) and
  HMAC reset/verify tokens — none are audience-bound OAuth access tokens. `@lesto/mcp`
  serves **stdio only** (`packages/mcp/src/server.ts:56`), via the one consumer that
  starts it, the `lesto mcp` CLI (`packages/cli/src/mcp.ts:99`). These absences are
  why remote MCP is deferred, not committed (Phase 3b).

## The core idea: every request has two principals

A request in the control plane carries a **principal** with two parts:

- **`actor`** — the operator who authenticated. Sourced from the session
  (`Session.userId`, `packages/auth/src/sessions.ts:48-51`), which is a **`string`**
  (`auth/types.ts:15`; identity stringifies an integer `User.id` on the way in,
  `identity.ts:702`). The principal's canonical id type is therefore `string`, with a
  single coercion boundary; `rolesOf` takes a `string`. Never inferred from a query
  string.
- **`subject`** — whose context the request *runs as*. Equal to `actor` normally;
  different only during an explicit, audited impersonation (Phase 2).

| Concern | Resolution from the dual principal |
|---|---|
| **Permissions** | Governance checks use the **actor's** roles — impersonating a customer never grants their powers. |
| **Impersonation** | `subject ≠ actor`. The app experience runs as `subject`; authority stays with `actor`. |
| **Audit** | Records the **resolved** actor (and `subject` once Phase 2 exists), so an impersonated write is attributable to the operator. |

Authz needs **both** role sets and must pick deliberately: *governance* uses the
**actor's** roles; the *impersonated experience* uses the **subject's**. Conflating
them is the classic impersonation vulnerability. The 3-lens panel confirmed this model
is the *minimal* sound abstraction — collapse it and you lose either attribution or
safety. The simplifications below are in *scope and binding*, not in the model.

## Decision

Re-scope `@lesto/admin` to the **operator control plane** binding authz + identity +
audit around operations on any resource, with the dual-principal model as its
keystone. Build in phases; commit only Phase 1 now.

### Phase 1 — build now: the principal model + per-verb authz gating

Two integration points, kept on the right side of the existing layering:

1. **A request principal (web layer).** A `@lesto/web`/`@lesto/auth` middleware
   resolves the verified session into an **`actor`** and resolves it to a role list via
   an **app-supplied** `rolesOf(userId: string)` — the plane provides the plumbing, not
   a roles datastore (see *the roles gap*). It writes the existing `"roles"` context
   var (the actor's roles), so every existing `can()` route guard keeps working
   **unchanged** (`guard.ts:59-63`), and threads the resolved `{ actor, actorRoles }`
   to admin via a single two-field `"principal"` context var (next) — the `"roles"`
   var carries roles only, so the actor lives nowhere else on the context. Phase 1
   does **not** add a second `subject`/`subjectRoles` context var or a four-field
   `Principal` — `subject === actor` always until Phase 2, so that machinery is
   deferred to the phase that first makes them diverge.

2. **Per-`(resource, action)` gating (admin layer).** `AdminResource` gains an
   optional `permissions?: { read?; create?; update?; destroy? }`. `createAdmin`
   accepts a `Policy` and the **resolved actor roles** through its `MutationContext`
   (extended from `{ actor }` to `{ actor, actorRoles }`). Each verb calls
   **`policy.allows(actorRoles, requiredPermission)`** (`policy.ts:77` — *not* the
   web-coupled `ensure(c, …)`), throwing a coded `ADMIN_FORBIDDEN` on refusal.
   `@lesto/admin` stays web-decoupled: a **type-only** dep on authz's `Policy`, never a
   `@lesto/web` import (grep-asserted).
   - **Fail-closed (corrected from the draft).** A supplied `policy` makes governance
     mandatory: a verb with no declared permission is **denied**. `policy` is
     **required** for `createAdmin` going forward (it is a private `0.0.0` package —
     break it now); an explicit `{ ungoverned: true }` is the only — loud, greppable —
     way to opt out. There is no silent "no policy → fully open" default; that would
     invert the framework's structural deny-by-default and contradict `@lesto/mcp`'s
     own deliberately fail-closed gate (`tools.ts:26-31`).

3. **Audit carries the *resolved, non-forgeable* actor.** In governed mode the
   principal middleware is the **sole** source of `MutationContext.actor`; admin
   **refuses an unattributed governed write** rather than accept a caller-supplied
   actor. `AuditEvent` stays `{ action, actor, resource, id, patch }` for Phase 1 — the
   `subject` field is added in Phase 2, in the same change that first makes
   `subject ≠ actor` real (it is an optional field; existing consumers ignore it, so
   the later migration is near-zero). **Tamper-evidence is not claimed:** the
   `onMutation` seam makes attribution *trustworthy at the source* but not *immutable*
   — durable, tamper-evident retention is the deferred audit-store concern.

**The roles gap (stated, not hidden).** No `userId → roles` store exists today. Phase 1
ships only the *resolution path* (`session → userId → rolesOf → actor roles`), with the
app supplying `rolesOf`. This is fine for Phase 1 (estate supplies a local `rolesOf`),
but it is a **hard prerequisite for Phase 3** — a non-interactive MCP agent has no
`?role=` knob, so remote authz is meaningless without a real store. A persistent
`userId → roles` store is therefore an **explicit increment gating Phase 3**, not
open-ended "app scope."

Scope discipline: Phase 1 is additive, introduces no UI/runtime/web-coupling, and is
100%-testable as pure functions over a `Policy` + a principal.

### Phase 2 — designed here, gated on Phase 1: the impersonation overlay

Impersonation cannot be built safely before Phase 1, because every guardrail checks the
principal and the policy:

- **Permission-gated** — starting impersonation requires `admin.impersonate` (an
  `allows` check against the **actor's** roles).
- **The real guardrail is "read-only while impersonating," not the
  `admin.impersonate` check.** A subject can hold a destructive grant the actor lacks
  (via a `"*"` / `"billing:*"` grant) *without* holding `admin.impersonate`, so that
  check alone does **not** guarantee impersonation grants no new authority — it only
  blocks impersonating other impersonators. The sound invariant — *actor's grants ⊇
  subject's grants for any mutating permission* — requires an authz accessor that does
  not yet exist (`Policy` exposes only `roles`/`permissions`/`allows`, not resolved
  grant sets — `policy.ts:56-78`). Phase 2 therefore **adds `Policy.grantsFor(roles)` +
  `subsumes(actorRoles, subjectRoles)`** (wildcard-aware) and makes the ceiling the
  superset check for mutating permissions. Until that lands, impersonation is
  **read-only**, full stop — and that, not the permission gate, is what makes it safe.
- **Time-boxed & scoped**; **structurally derived** (the session keeps the real actor;
  the overlay is an added effective subject with an unmissable UI banner and one-click
  exit — never a session re-minted as the victim); **fully audited** `{ actor, subject }`.

Architecturally the overlay is an **auth/session-layer** concern (any route runs as the
effective subject while attributing to the actor); the control plane owns the
guardrails and the audit.

### Phase 3a — designed here, gated on Phase 1 + the roles store: MCP governance (stdio)

Admins (and the agents they drive) reach data through an **MCP client**. `@lesto/mcp`
already exists as "the MCP control plane" but with coarser governance: a
construction-time `mode: "read-only" | "operator"` flag (`tools.ts:32,188-193`), **no
caller identity**, and an audit sink that records the *tool*, not *who* (`tools.ts:35-54`).
MCP is **another client of the same governed operations**, not a parallel system.
Phase 3a collapses it onto the principal model **over the stdio transport that already
ships** — no new wire surface:

1. **An admin tool set** — an *explicitly allow-listed* set of resources as
   `list/get/create/update/destroy_<resource>` tools, thin adapters calling the Phase 1
   governed verbs with the principal in `MutationContext`. Never auto-expose tables.
2. **One authz gate.** Replace the binary `requireOperator` (`tools.ts:188`) with
   `requirePermission` over `policy.allows`. **Retire** the `mode` flag and `McpMode`
   rather than keep a second model — its *only* consumer is one CLI line
   (`packages/cli/src/mcp.ts:82`), which maps onto a built-in two-role policy
   (`operator` grants `*`, default grants `:read`). One model, one place denials are
   decided.
3. **A principal over the dispatch.** MCP has no web `Context`, so this is **not** a
   literal reuse of Phase 1's middleware — what is reused is the `Principal` type +
   `policy.allows`. The MCP server resolves the caller (stdio: the local process
   identity / an injected `verifySession`) to an `actor` via the same `rolesOf`, and
   threads it through `LestoMcpContext`.
4. **Audit gains the actor.** Extend `McpAuditRecord` (`tools.ts:35`) with `{ actor }`
   (and `subject` once Phase 2 exists).
5. **Regate `handle_request`.** This existing tool forwards `authorization`/`cookie`
   headers to act *as* a user (`tools.ts:199-215`) — i.e. it is already a
   token-passthrough / impersonation primitive over MCP, in direct tension with this
   plane. Phase 3a must bring it under `requirePermission` with a dedicated
   high-privilege permission (and strip identity-forwarding when a governed principal
   is present), or it is the hole that the rest of the work papers over.

**Ordering within Phase 3a:** the principal resolver + actor-in-audit land **before**
any mutating admin tool is registered (or mutating tools fail-closed: they refuse to
register without a resolver). Registering write tools before attribution exists would
expose unattributed `create/update/destroy` gated only by the legacy coarse mode.

### Phase 3b — committed, gated on the roles store + an external IdP (NOT on ADR 0029): remote MCP (Streamable-HTTP + OAuth)

The remote door is the real SaaS shape and is committed, but the panel showed it is
**not** "a thin transport." Its prerequisites — in order:

- **An OAuth Authorization Server it can validate tokens against — external IdP FIRST.**
  Validating audience-bound bearer tokens (RFC 8707) presupposes something *issuing*
  them; nothing in Lesto does today (`auth/index.ts:17`). The MCP spec allows the AS to
  be a **separate entity**, so the RS's **first** path is to accept tokens from a
  **configured external IdP** (Auth0/Okta/WorkOS/Entra/…) — the app owner brings the IdP
  they already have. This is a thin RS, **not** blocked on building anything. The
  **first-party AS (ADR 0029)** lands **later** as the battery that *removes* the
  external-IdP dependency for owners who have none — it is **not** a prerequisite for
  remote MCP. Because the token-validation contract is an **injected `verifyAccessToken`
  seam** (below), external-IdP-first vs self-hosted-AS is just which implementation is
  wired — the RS code is identical either way.
- **The roles store** (the Phase 3 prerequisite above) — a remote agent's `subject →
  roles` resolution is meaningless without it.
- **No `kernel → mcp` cycle.** `@lesto/mcp` already depends on `@lesto/kernel`
  (`mcp/package.json:19`, `tools.ts:12`). The remote transport must therefore be
  mounted by the **app** (which already sits above both), or live in a small
  `@lesto/mcp-http` adapter package — **never** mounted by `kernel`, which would close
  `kernel → mcp → kernel`.

When built, it follows the MCP authorization spec: server as OAuth 2.1 **Resource
Server**; serve RFC 9728 Protected Resource Metadata; **validate token audience and
reject any non-own token** (the confused-deputy / passthrough defense — exactly the
risk an AI-agent client raises); `Authorization: Bearer` only; `401` invalid/expired;
`403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope=…` on
insufficient permission; `Origin` validation. The token-validation contract is an
**injected `verifyAccessToken(token) → { subject, audience, scopes }` seam** (validating
the JWT against the configured issuer's JWKS + the expected audience) so the Resource
Server logic is thin, testable, and identical whether the issuer is an external IdP
(first path) or the first-party AS (ADR 0029, later).

**Default wiring is specified in ADR 0039** (the batteries capstone): the default
`verifyAccessToken` implementation lives **here, in the RS package (`@lesto/mcp-http`),
config-parameterized by issuer + JWKS URL** (external-IdP `alg` allow-list vs in-house
ES256 — never `none`/HMAC-confusion), the canonical MCP-server URI is auto-registered as
the only allow-listed `resource`/`aud`, and `lesto add mcp-auth` (CLI codegen) scaffolds
the mount + consent/login views. ADR 0039 commits the **external-IdP** path now and makes
the in-house AS contingent; it also owns the **single end-to-end security review** for the
whole MCP-auth flow.

Two honest caveats the panel surfaced:
- **Scopes are *not* equivalent to permissions, but they *are* an enforced ceiling.**
  `policy.allows` resolves wildcard (`"*"`, `"posts:*"`) and inherited grants
  (`policy.ts:88-98`); OAuth scopes are a flat, exact-string set with no
  wildcard/inheritance semantics — so they can't *be* the permission set. The token
  therefore conveys **identity + a coarse scope cap** (not the full permission set).
  The RS decision is the **intersection**: `scope-permits(action) AND
  policy.allows(rolesOf(sub), action)` — the scope is a hard ceiling on what the token
  may do (a `mcp:read` token can never write, regardless of the user's live roles),
  and `policy.allows` is the live floor (revoked roles deny immediately). The
  `403 insufficient_scope` challenge carries the requested permission for display. The
  earlier "scopes ≡ permissions" / "scope is display-only" framings were both wrong and
  are withdrawn: scope is neither the decision nor mere display — it is the cap.
- **MCP step-up authorization** maps to a future sensitive-op step-up, but only once an
  AS exists to step up against.

## Non-goals

- **Not the WordPress REST API.** No auto-mounted CRUD, no query/filter/sort/count DSL.
- **Not content authoring** — `content-*`, not here.
- **No row-level security.** `@lesto/authz` is role→permission only; `allows` has no
  row predicate (`policy.ts:77,88-97`). Admin authz is per-`(resource, action)`.
- **No operator console UI, no `@lesto/admin` web coupling, no change to the
  secure-by-default kernel/CSRF/boundary validation.**
- **No silent fail-open.** Governed mode denies by default; opting out is explicit.

## Deferred — recorded, not scheduled; each gated on a real consumer

- **Role-aware *field* projection** (per-field→permission narrowing) — Phase 1.5.
- **The operator console UI**, a **durable/tamper-evident audit store**, **step-up /
  break-glass approvals**, a **separate operator directory** (this ADR assumes admins
  are app users distinguished by roles; impersonation is user→user).

## Reviews

- **Grounded single pass.** Fixed the authz binding (was `ensure(c,…)`, web-coupled →
  `policy.allows(roles,…)`); cut row-level authz; demoted field projection; pinned the
  impersonation ceiling to an `allows`-based rule; surfaced the roles gap.
- **3-lens adversarial panel (correctness/security, simplicity/scope,
  sequencing/coupling).** All three independently found that the committed remote-OAuth
  Phase 3 rested on two non-existent subsystems (an OAuth AS — `auth/index.ts:17`; a
  `userId → roles` store — `user.ts:43-51`) with **no consumer** (sole MCP caller is
  the stdio `lesto mcp` CLI, `cli/src/mcp.ts:99`). Resulting cuts/fixes: remote MCP's
  hidden prerequisites surfaced — the owner then **re-committed remote** with the OAuth
  AS pulled into **ADR 0029** as an explicit, separately-sequenced prerequisite (not
  smuggled in as "or delegates"); the roles store made an **explicit Phase-3
  prerequisite**; "scopes ≡ permissions" **withdrawn** (token conveys identity);
  "no policy → ungated" changed to **fail-closed/required policy**; audit `actor` made
  the **resolver's sole, non-forgeable output** (not caller `unknown`), with
  tamper-evidence explicitly *not* claimed; the impersonation ceiling corrected to
  "read-only is the real guardrail" + a new `grantsFor`/`subsumes` accessor; the
  `kernel → mcp` **cycle** flagged (app mounts the transport); Phase 1 trimmed to
  actor-only (no premature `subject`/`subjectRoles` var, four-field `Principal`, or
  audit field — the two-field `{ actor, actorRoles }` `"principal"` carrier stays: it
  is the only thread for the actor to admin);
  the `mode` flag **retired** onto one policy gate; the existing `handle_request`
  passthrough hole **brought into scope**; `userId` pinned to `string`. The
  dual-principal *model* and the Phase 1 per-verb binding survived as already-minimal.

## Consequences

- `@lesto/admin`'s mission becomes coherent: an application-agnostic operator control
  plane, not a half-built CMS data API.
- Phase 1 turns already-good-but-unconnected packages into one governed surface, with a
  real session-sourced, non-forgeable actor — additive, fail-closed, web-decoupled,
  100%-testable.
- The dual-principal model makes safe impersonation *possible* (Phase 2) and gives MCP
  one governance story (Phase 3a) — over the transport that already ships.
- Remote MCP is honestly scoped: committed, but with its real prerequisites made
  explicit and sequenced — a first-party OAuth AS (**ADR 0029**) and a roles store —
  rather than a "thin transport" smuggled in. The AS is the largest, most
  security-sensitive piece and must clear its own adversarial + security review.
- Slow iteration upheld for the keystone: only the Phase 1 primitive and its per-verb
  binding land first; the AS and remote surface follow behind ADR 0029.
