# Operator control plane — implementation plan

Derived from **ADR 0028** (operator control plane) and **ADR 0029** (Lesto as a
first-party OAuth 2.1 Authorization Server). Covers **Phase 1** (the principal model +
per-verb authz gating in `@lesto/admin`, actor-only audit), the **roles store** (an
explicit Phase-3 prerequisite), **Phase 3a** (MCP governance over the *existing stdio*
transport), and **Phase 3b** (remote MCP — Streamable-HTTP + OAuth Resource Server),
which is **committed** but gated on the **OAuth Authorization Server built under ADR
0029** (its own phased plan) + the roles store. **Phase 2** (impersonation) is deferred
and only sketched under *Deferred* — see ADR 0028.

Packages: `@lesto/authz` (principal type + policy), `@lesto/admin` (gating + audit),
`@lesto/auth`/`@lesto/identity` (`Session` source + the roles store), `@lesto/mcp`
(the MCP client surface), `examples/estate` (the dogfood / QA gate).

**The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on
touched packages; `bun run ws:typecheck` + the serial coverage gate green; coded
errors; truthful doc comments; one conventional commit on `main`. Layering invariants,
grep-asserted: `@lesto/admin` gains **no** `@lesto/web` import (type-only authz);
`@lesto/mcp` gains **no `kernel → mcp` edge** and no new runtime `@lesto/auth` dep
(inject `verifySession` instead).

## Phase 1 — principal model + per-verb authz gating

1. **Principal resolver in `@lesto/authz`** — `[keystone]`
   Files: `packages/authz/src/principal.ts` (new), `index.ts`.
   `Principal` (Phase 1 shape: `{ actor: string; actorRoles: readonly string[] }` —
   `subject`/`subjectRoles` are added in Phase 2, not now) +
   `createPrincipalResolver({ verifySession, rolesOf })`, a `@lesto/web` middleware
   (authz already type-imports `@lesto/web`, `guard.ts:19`) that verifies the session
   (injected `verifySession`, so authz keeps no `@lesto/auth` dep), resolves
   `actor = session.userId` (a **`string`** — `auth/types.ts:15`), computes
   `actorRoles = rolesOf(actor)`, sets the existing `"roles"` context var (so every
   `can()` guard keeps working, `guard.ts:59-63`), and exposes the resolved roles for
   admin to consume. No second context var.
   Acceptance: unauthenticated → empty roles → deny-by-default holds; `rolesOf`
   injected; `userId` typed `string` end-to-end; existing guard tests unchanged; 100%.

2. **Per-`(resource, action)` gating in `@lesto/admin`** — `[the binding]`
   Files: `packages/admin/src/admin.ts`, `errors.ts`, `index.ts`, `package.json`
   (add **type-only** `@lesto/authz`).
   - `AdminResource` gains `permissions?: { read?; create?; update?; destroy? }`.
   - `createAdmin(db, resources, options)` takes a **required** `options.policy`
     (private `0.0.0` pkg — break it now); `{ ungoverned: true }` is the only, loud,
     greppable opt-out. **No silent "no policy → open" path.**
   - `MutationContext` extends `{ actor }` → `{ actor, actorRoles }`; in governed mode
     the resolver is the **sole** source of `actor` and admin **refuses an
     unattributed governed write** (no caller-supplied actor honored).
   - Each verb calls `policy.allows(actorRoles, requiredPermission)` (`policy.ts:77`,
     **not** the web-coupled `ensure(c,…)`) before touching the db; a verb with no
     declared permission is **denied**; refusal throws coded `ADMIN_FORBIDDEN` with
     `{ resource, action, permission }`. `list`/`get` → `read`.
   Acceptance: governed mode gates every verb and refuses unattributed writes;
   `{ ungoverned: true }` preserves legacy behavior under a loud flag; `@lesto/admin`
   imports no `@lesto/web` (grep-asserted); 100% on governed + ungoverned branches.

3. **Audit carries the resolved actor** — `[attribution]`
   Files: `packages/admin/src/admin.ts`.
   `AuditEvent` stays `{ action, actor, resource, id, patch }` for Phase 1 (the
   `subject` field is a Phase-2 add — optional, zero-migration). `audit()`
   (`admin.ts:229-243`) reports the resolver-sourced `actor`. Note in the doc comment
   that the seam makes attribution trustworthy-at-source, **not** tamper-evident
   (durable store deferred).
   Acceptance: `onMutation` receives the resolved actor for all three verbs; an
   unattributed governed write never reaches `onMutation` (it was refused in Inc 2).

4. **Dogfood + QA gate: wire it through estate** — `[per gallery-as-QA-gate]`
   Files: `examples/estate/src/lab.tsx` + estate admin wiring.
   Replace the demo `c.set("roles", c.query("role")…)` (`lab.tsx:59-61`) and the
   `actorOf` query-string actor (`lab.tsx:337-340`) with `createPrincipalResolver` over
   estate's `Sessions` + an estate-local `rolesOf`; declare per-verb permissions on an
   estate admin resource. **Delete** the `?role=` toggle (do not fence it) — the
   session path fully demonstrates deny-by-default; keeping a parallel toggle is the
   two-models rot Inc 5 also avoids.
   Acceptance: estate's lab shows session-sourced roles governing a real admin op (read
   allowed, destroy denied with `ADMIN_FORBIDDEN`); the governed path is the one
   exercised; estate builds/deploys (the QA gate); no `?role=` knob remains.

## Phase-3 prerequisite — the roles store

5. **`userId → roles` store** — `[hard prerequisite for Phase 3; not "app scope"]`
   Files: `packages/identity/src/*` (a `user_roles` join table + `rolesOf`
   implementation) or a dedicated small module; estate switches its local `rolesOf`
   onto it.
   ADR 0028 ships only the `rolesOf` *seam* in Phase 1; a real store is required before
   MCP authz means anything for a non-interactive agent (no `?role=` knob). Keyed by the
   canonical `string` user id (single coercion boundary, per Inc 1).
   Acceptance: roles persist and resolve per user; `rolesOf` reads the store; estate's
   resolver uses it; deny-by-default for a user with no roles; 100%.

## Phase 3a — MCP governance over the existing stdio transport

Reuses the `Principal` type + `policy.allows` (NOT Phase 1's web middleware — MCP has
no `Context`). Pure handlers, tested directly like the rest of `@lesto/mcp`.

6. **Per-request principal + actor in audit (lands BEFORE write tools)** — `[order-critical]`
   Files: `packages/mcp/src/tools.ts` (+ `package.json`: add type-only `@lesto/authz`;
   **inject** `verifySession` rather than depend on `@lesto/auth`).
   Add an MCP principal resolver (caller → `actor` via injected `verifySession` →
   `rolesOf` → roles), threaded into `LestoMcpContext`; extend `McpAuditRecord`
   (`tools.ts:35`) with `{ actor }`.
   Acceptance: every dispatch records the actor; unauthenticated → empty roles →
   deny-by-default; no `@lesto/auth` runtime dep on `@lesto/mcp` (grep-asserted); 100%.

7. **Admin tool set + one policy gate + regate `handle_request`** — `[reuses Inc 2, 6]`
   Files: `packages/mcp/src/tools.ts`, `errors.ts`, `index.ts`, `package.json` (add
   `@lesto/admin`); `packages/cli/src/mcp.ts`.
   - Expose an **explicitly allow-listed** set of admin resources as
     `list/get/create/update/destroy_<resource>` tools calling the Inc-2 governed verbs
     with the principal in `MutationContext`. Mutating tools **fail-closed**: refuse to
     register without a principal resolver (Inc 6).
   - Replace `requireOperator` (`tools.ts:188`) with `requirePermission` over
     `policy.allows`; **retire** `McpMode`/the `mode` flag — map the one CLI consumer's
     `--operator` (`cli/src/mcp.ts:82`) onto a built-in two-role policy (`operator`→`*`,
     default→`:read`). One authorization model.
   - **Regate `handle_request`** (`tools.ts:199-215, 287-328`): bring it under
     `requirePermission` with a dedicated high-privilege permission and strip
     `authorization`/`cookie` forwarding when a governed principal is present — it is
     today an unaudited token-passthrough / impersonation primitive.
   Acceptance: each admin/handle_request tool gated by its permission; mutating tools
   unreachable until a resolver is wired (asserted); resources opt-in (no
   auto-exposure); single authz model (no `McpMode` left); 100%.

## Phase 3b — remote MCP (committed; gated on the roles store + an external IdP, NOT on ADR 0029)

Remote MCP ships against a **configured external IdP** (Auth0/Okta/WorkOS/Entra/…) as
its first token issuer — the RS only *validates* tokens via an injected
`verifyAccessToken` seam, so it is **not** blocked on building the first-party AS. The
**ADR 0029 AS** (preceded by **ADR 0030**, the OAuth client/social-login battery, which
also establishes the shared `jose`-verify helper) lands **later** as the battery that
*removes* the external-IdP dependency — wiring a different `verifyAccessToken`
implementation behind the same seam, no RS change. So Phase 3b needs only: the roles
store (Inc 5), a configured IdP, and Inc 6's principal path.

8. **MCP Resource Server — token validation + PRM** — `[external IdP first; AS-agnostic]`
   Files: `packages/mcp/src/tools.ts` (the injected `verifyAccessToken` seam),
   `packages/mcp/src/http.ts` (new) for the `.well-known/oauth-protected-resource` doc.
   Add `verifyAccessToken(token) → { subject, audience, scopes }` — validates the JWT
   against the **configured issuer's JWKS** (an external IdP first; the ADR 0029 AS later,
   same seam) + checks `aud` is this server. The resolved `subject` feeds the Inc-6
   principal path (`subject → rolesOf → policy.allows`). Serve RFC 9728 PRM advertising
   the configured issuer. Reject any non-own-audience token (no passthrough).
   Acceptance: a token minted for another resource is refused; PRM correct; `subject`
   flows into the existing principal/authz path; RS validates offline (no issuer callback
   on the hot path); seam works against an external IdP with zero AS code present;
   100% on the validation logic.

9. **Streamable-HTTP transport — mounted by the app, never kernel** — `[committed]`
   Files: `packages/mcp/src/http.ts`, app-level mount in `examples/estate` (or a small
   `@lesto/mcp-http` adapter package). **No `kernel → mcp` edge** (`@lesto/mcp` already
   depends on `@lesto/kernel` — `mcp/package.json:19`; mounting from kernel would close
   a cycle).
   Bearer in `Authorization` only (never query string); `401` invalid/expired; `403` +
   `WWW-Authenticate: Bearer error="insufficient_scope", scope="<requested permission>"`
   on authz refusal. The RS decision is the **intersection** `scope-permits(action) AND
   policy.allows(rolesOf(sub), action)`: scope is an enforced ceiling (a `mcp:read`
   token can never write), `policy.allows` is the live floor; the challenge `scope` is
   the requested permission for display;
   `Origin` validation (DNS-rebinding).
   Acceptance: spec-shaped 401/403; origin check pinned; transport behind the coverage
   exclusion with all governance decided in Inc 6–8; grep-asserted no `kernel → mcp`
   edge. **Confused-deputy defaults (asserted):** dedicated least-privilege agent role;
   read-only default; impersonation tools never registered on the MCP surface.

## Owned elsewhere (do not duplicate)

- The `Session` lifecycle + session-token hardening → `@lesto/auth` + the
  **auth-security** plan. Increments inject `verifySession`; they don't reimplement it.
- **Admin-denial observability.** The `onDenied(kind, c)` seam lives on *web-coupled*
  middleware (`guard.ts:47`, csrf/ratelimit) and takes a `LestoRequest` — it is
  **unreachable** from `@lesto/admin`, which is web-decoupled and throws
  `ADMIN_FORBIDDEN`. Decision: the **caller** (estate route / the MCP adapter) catches
  `ADMIN_FORBIDDEN` and fires `onDenied`; admin does **not** import a request type.
  (Do not "reuse the seam inside admin" — that would break Inc 2's layering.)

## Deferred (per ADR 0028 — not in this plan)

- **Phase 2 — impersonation overlay**: `admin.impersonate` gate; the real guardrail is
  **read-only-while-impersonating** (the permission check alone is insufficient — a
  subject can hold grants the actor lacks); add `Policy.grantsFor`/`subsumes`
  (wildcard-aware) for the actor ⊇ subject ceiling on mutating perms; time-box/scope;
  structurally-derived session + UI banner; `{ actor, subject }` audit (adds the
  `subject` field then). Gated on Phase 1.
- **The OAuth Authorization Server itself** → **ADR 0029** + its own plan (Phase 0
  crypto spike GATE → token core + key store + JWKS → auth-code/PKCE + client registry →
  discovery → refresh [deferred]). Vetted libraries only (`jose`); hard prerequisite for
  Phase 3b above; the single largest, most security-sensitive piece; gated behind the
  Phase 0 spike + its own adversarial + `security-review`.
- **Role-aware field projection** (Phase 1.5); **operator console UI**;
  **durable/tamper-evident audit store**; **step-up / break-glass**; **row-level
  security** (explicit non-goal — `policy.ts:77,88-97` has no row predicate).
