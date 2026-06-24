# ADR 0039 — Authenticated MCP servers as a batteries-included default (external-IdP milestone first; in-house AS committed)

- **Status:** Proposed. An **integration / sequencing** ADR over three existing plans —
  ADR 0028 (the MCP **Resource Server** + Streamable-HTTP transport, OCP-8/9), ADR 0029
  (the first-party OAuth **Authorization Server**), ADR 0030 (OAuth *client* / social
  sign-in + the shared `jose` verify helper) — plus `@lesto/identity` (the user store).
  Most of what an authenticated production MCP server needs is **already scoped** in
  those ADRs (RFC 8707 audience binding, JWKS, RFC 8414 discovery, the injected
  `verifyAccessToken` seam). This ADR does **not** re-decide any of that. It makes **one
  genuine decision** — *the delivery ordering of the two issuer paths, both committed* —
  and owns the **three connective pieces** the decoupled plans leave to "the integrator":
  the default RS wiring, the open-ecosystem client-registration correction (an **amendment
  to ADR 0029**), and the `lesto add mcp-auth` scaffold. It also names the **single
  end-to-end security review** that currently falls between three owners.
  It introduces **no new crypto**. This ADR has itself been through a 2-lens
  (red-team + chief-architect) panel — see *Reviews* — and the build still inherits ADR
  0029's hard gate (vetted libs + a dedicated adversarial + `security-review`).
- **Date:** 2026-06-24 (revised same day after the panel)
- **Deciders:** tech lead + owner
- **Builds on / touches / amends:** **amends ADR 0029 §Discovery+clients** (client
  registration for the MCP consumer) and **ADR 0028 §Phase 3b** (records the default
  wiring). Composes ADR 0028 (RS + transport — the `verifyAccessToken` seam, PRM), ADR
  0029 (AS — keys/JWKS/discovery/`aud`), ADR 0030 (shared `jose` helper), ADR 0016
  (secure-by-default wiring), `@lesto/identity`. Touches `@lesto/mcp` /
  `@lesto/mcp-http` (the RS package, where the default validator lives) and
  `@lesto/cli` / `create-lesto` (where the scaffold codegen lives). **No new package.**

## Context

The three legs of an authenticated *production* (HTTP-transport) MCP server exist as
plans, but they are engineered to stay apart and nobody owns the join:

- ADR 0028 §Phase 3b validates tokens through an **injected `verifyAccessToken(token) →
  { subject, audience, scopes }` seam** and ships **external-IdP-first** (Auth0/Okta/
  WorkOS/Entra), *not* blocked on building the AS — by design, "only which
  implementation is wired" differs (0028:229).
- ADR 0029 lands the in-house AS **later**, framed as a general "Lesto-as-OAuth-provider"
  battery (à la Laravel Passport). Its own review recorded that **two of three
  adversarial lenses found it had no consumer** and argued for deferral (0029:224-228).
- `@lesto/identity` already is the user store.

So the "out-of-the-box authenticated MCP server" win is reachable **without** the
in-house AS — and the panel made that the spine of this ADR. Three concrete connective
gaps remain, and one decision must be made:

1. **Open-ecosystem client registration is unsolved for MCP** — and 0029 currently
   resolves it the wrong way for this consumer. 0029's first cut is **pre-registration**
   (0029:131-134), which requires knowing each client's `client_id` + `redirect_uri`
   ahead of time. An arbitrary agent (Claude / Cursor / VS Code / ChatGPT / MCP
   Inspector) arrives **unknown**. The current MCP authorization spec (2025-11-25) makes
   **Client ID Metadata Documents (CIMD)** the preferred mechanism and **retains Dynamic
   Client Registration (RFC 7591) for backward compatibility** (it is *de-emphasized*,
   not formally deprecated — 0029's "deprecated" wording is corrected here). Most MCP
   clients shipping today still use DCR. **Pre-registration alone cannot serve open MCP
   clients** — this is a correction 0029 needs, regardless of who issues the tokens.
2. **The default RS wiring is unowned.** Nobody implements the default `verifyAccessToken`
   (validate a token against a configured issuer's JWKS + the expected `aud`), nor
   auto-registers the MCP server's canonical URI as the only allow-listed `resource`/`aud`
   (the confused-deputy default), nor ships the `lesto add mcp-auth` scaffold.
3. **The end-to-end security review has no owner.** The confused-deputy / audience-binding
   defense spans 0029 (mints `aud` only for registered resources), 0028 (RS validates
   `aud`), and this ADR (wires *which* `aud` is the registered one). DCR adds an
   open-redirect / SSRF-on-`redirect_uri` / registration-spam surface. 0029's panel
   reviewed an AS **without** DCR and **without** the cross-package `aud` wiring — so the
   actual end-to-end attack surface has been reviewed by **no one as a unit**.

## Decision

**Both issuer paths are committed. Ship the external-IdP MCP Resource Server as the first
delivery milestone (it is reachable without any crypto build); the in-house Authorization
Server (ADR 0029) is committed up front as the headline "zero external service" battery,
not held contingent.**

### The decision: external-IdP milestone first, in-house AS committed (the one genuinely new call)

The headline battery is "one command → an OAuth-protected production MCP server, all
in-house, no external service" — and the owner commits to it up front (à la Laravel
Passport), accepting the in-house AS's greenfield-crypto cost (ADR 0029: the largest,
most security-sensitive subsystem in the effort — zero existing asymmetric crypto/JWKS,
an unproven-for-this runtime, a forever spec/CVE/rotation cost) as the price of the
differentiation.

The **external-IdP path ships first as a delivery milestone**, not as a hedge: it is
reachable via 0028's seam with **no crypto build**, so it gets a real authenticated-MCP
demo into users' hands while the AS's Phase-0 spike and token core are built behind it.
The seam (0028:229) means the in-house issuer is then a config swap with **no RS rework**
— the two paths are the same RS validating different issuers. **MA-0's spike no longer
gates *whether* the AS is built** (it is); it still decides *which* client-registration
mechanism the AS ships (D2) and confirms whether external IdPs can also serve MCP clients.

**The ordering is enforced, not incidental.** "Committed up front" governs *intent and
scope*, never *build order*: the in-house headline proof (MA-5) is **gated by a hard edge
on the external-IdP milestone (MA-6)** — the all-in-house authenticated MCP server is not
shipped or announced until the external-IdP one is already out. The AS *engineering* (the
0029 chain) may proceed in parallel, but the in-house *delivery* always follows external.

One hard ordering constraint stands regardless: the AS cannot begin until its **Phase-0
crypto spike passes** (ADR 0029), and that spike is itself gated on one social provider
shipping (`AS-0 ← OC-2`, to share 0030's `jose` helper). So "committed up front" means
*committed in intent and scope now*, sequenced behind the spike — not buildable on day one.

### D1 — `lesto add mcp-auth` scaffold (CLI codegen, not a package)

The scaffold lives in `@lesto/cli` / `create-lesto` (it is codegen, not a runtime
library — no `@lesto/mcp-auth` package). It wires `@lesto/identity` (resource-owner
session) ⨝ a configured issuer ⨝ the MCP RS + Streamable-HTTP transport, **app-mounted,
never kernel** (cycle — 0028:233-236), with secure defaults: short access-token TTL,
exact redirect match, PRM served, least-privilege read-only agent role, impersonation
tools never registered. **It must scaffold the consent screen + the login view + wire
0029's injected `loginUrl(returnTo)` seam** — identity ships *no* auth UI (0029:114-115),
so without these the "one command" app 401s at consent with no page to render. For the
external-IdP path, consent/login are the IdP's; for a future in-house issuer they are the
scaffolded views. The consent screen is the **primary anti-phishing control** for unknown
open clients — it must display the *resolved, server-known* client metadata + origin +
`resource`, never attacker-supplied display strings.

### D2 — Open-ecosystem client registration (amends ADR 0029 §Discovery+clients)

For the **MCP consumer**, pre-registration is **insufficient**; at least one open
mechanism is **required**. This **amends ADR 0029** (whose §Discovery+clients is updated
in place to reference this ADR): the open mechanism is in-scope and inherits the AS's
security gate. Default posture pending MA-0: **CIMD-preferred with a DCR (RFC 7591)
compatibility path** — CIMD is the spec's stated direction and avoids a write endpoint;
DCR is what the installed base runs today. *Whoever* owns registration (external IdP in
the committed increment; the in-house AS if it is later built) must satisfy this. DCR is
a classic open-redirect / SSRF-on-`redirect_uri` / client-spoofing surface — exact
`redirect_uri` match + rate-limited registration are mandatory and in scope for D5.

### D3 — Default RS validator (implementation of 0028's seam — not a new decision)

The default `verifyAccessToken` impl lives **with the RS, in `@lesto/mcp-http`**,
**config-parameterized by issuer + JWKS URL** — because the external-IdP validator and a
future in-house-AS validator are *the same code with different config* (0028:229).
**Per-issuer algorithm allow-list** (the one subtlety): an external IdP typically issues
**RS256**; a future in-house AS issues **ES256** (0029:124). The validator takes the
issuer's published `alg` as an explicit allow-list — **never `none`, never an HMAC alg
against an asymmetric JWKS key** (key-confusion ban). It rejects `iss ≠` configured,
`aud ∌` this server, expired / not-yet-valid, with a bounded, rate-limited JWKS refetch
on unknown `kid` + negative-cache (0029:128-130). This is wiring 0028 already specified;
it is a task, not an architecture decision.

### D4 — Resource-indicator default binding (implementation of 0028+0029's `aud` rule)

The scaffold registers the MCP server's canonical URI (e.g. `https://app.example.com/mcp`)
as the configured issuer's allow-listed `resource`, so tokens are minted with exactly
that `aud` and the RS validates exactly that `aud`. 0029 already forbids minting `aud`
for arbitrary resources (0029:120-121); this wires the default so the confused-deputy
loop is closed out of the box rather than left to the integrator.

### D5 — One end-to-end security review (the owner the seam currently lacks)

A **single** adversarial + `security-review`, owned by **ADR 0029's gate**, covers the
*whole* flow as a unit: registration (CIMD/DCR) → authorize + consent → `aud` binding →
RS validation → cross-audience refusal → origin/redirect checks. It is an explicit task
(MA-7) that **blocks the dogfood (MA-5)** — the dogfood *exercises* the flow; it does not
*review* it. This closes the gap where the program's most dangerous bug class
(confused-deputy / token passthrough — 0028:241) lands on the seam between three owners
and is reviewed by none.

### Sequencing & honest depth (corrected)

The committed external-IdP battery is **not shallow**: MA-6 (the slice) sits behind the
**entire OCP RS leg** — `OCP-1` (the Phase-1 principal keystone) → `OCP-5` (the
`userId→roles` store) → `OCP-6` → `OCP-8` → `OCP-9` — **6 upstream tasks**, none of them
thin. "First" means *first of the two MCP-auth slices*, **not** pick-up-able now.

The in-house capstone is deeper than first stated and the owner commits to it eyes-open:
the GTM proof (MA-5, in-house issuer) has **~17 distinct prerequisite tasks** (the OCP RS
leg + the full AS chain `OC-1→OC-2→AS-0→AS-1→AS-2→AS-3` + the MA wiring) with **~8 on the
longest serial chain** — and the AS chain itself cannot start until **one social provider
ships** (`AS-0 ← OC-2`, to share 0030's `jose` helper). The earlier "~12-task" figure was
wrong both ways; this corrected count is *why the external-IdP milestone ships first* (it
puts a demo in users' hands while this 8-deep chain is built), not a reason to defer the
in-house path.

## Non-goals

- **No new crypto, token format, or JWKS implementation** — ADR 0029 owns all of it.
- **No new package** — validator in `@lesto/mcp-http`, scaffold in `@lesto/cli`/`create-lesto`.
- **Not a general IdP product** beyond what MCP authorization requires (no SCIM/SAML/OIDC
  ID tokens unless a consumer needs them — per 0029 non-goals).
- **Does not re-decide the AS build** — ADR 0029 owns the in-house AS scope/sequencing;
  this ADR commits to it as the headline battery and orders the external-IdP milestone
  ahead of it for delivery.
- **No fine-grained / row-level authz** — the RS decision stays scope-ceiling ∩
  `policy.allows` (0028).

## Reviews

2-lens panel (red-team + chief-architect), grounded in the repo, the three dependency
ADRs, and the live task board. Resulting changes:

- **Sequencing call (chief-arch P1, red-team P1):** the panel argued for making the
  in-house AS *contingent* (0029 itself recorded "no consumer"). **The owner overrode
  this:** the in-house AS is **committed up front** as the headline "zero external
  service" battery, with the panel's risk acknowledged in writing (greenfield-crypto
  cost, ~8-deep chain). The panel's concrete win is kept as *delivery ordering* — the
  external-IdP path ships first as a no-crypto milestone, the in-house AS follows behind
  its Phase-0 spike. MA-0 decides the registration *mechanism*, not *whether* to build.
- **Armed the dead-end guard (red-team P0):** `MA-0 → AS-3` was a `related` edge with no
  scheduling force, so the AS could ship pre-registration-only — the exact dead end this
  ADR exists to prevent. Changed to a **`blocks`** edge, and **amended 0029 in place**
  (rather than leaving the correction only in this ADR's prose).
- **Named one end-to-end security-review owner (chief-arch P0):** the confused-deputy/`aud`
  defense + the DCR surface spanned three owners and was reviewed by none as a unit. Added
  **MA-7**, owned by 0029's gate, blocking the dogfood.
- **Fixed the validator placement + alg footgun (red-team P1, chief-arch P2):** the default
  validator moved into the RS package (`@lesto/mcp-http`), config-parameterized; an
  ES256-only allow-list would have rejected every external-IdP **RS256** token — now
  per-issuer. Dropped the speculative `@lesto/mcp-auth` package.
- **Tasked the missing auth UI (red-team P1):** identity ships no login/consent UI; the
  scaffold (D1) now explicitly owns the consent screen + login view + `loginUrl` wiring,
  with the consent screen as the anti-phishing control for open clients.
- **Corrected the depth numbers (red-team P0) and the MA-6 "do first" framing (both):**
  ~8 serial / ~17 total prerequisites for the in-house proof; MA-6 is "first of two
  slices," gated behind the full OCP RS leg incl. the roles store.
- **Corrected "DCR deprecated" → "retained for backward compat / de-emphasized" (red-team
  P2)** and surfaced the `AS-0 ← OC-2` coupling (the in-house battery cannot exist until
  social sign-in ships a provider).
- **Refuted (chief-arch strongest form):** "delete 0039, it is only amendments." Kept as
  one legible doc because (a) the external-first *sequencing decision* is genuinely new
  and owner-level, (b) the end-to-end security-review owner needs a home, and (c) the
  MCP-auth narrative has standalone GTM legibility — but marked D3/D4 as *implementation*
  of 0028's seam and pushed D2 into 0029 as a real in-place amendment, so the ADRs do not
  silently contradict.

## Consequences

- Delivers the GTM claim — *site owners ship an authenticated production MCP server in one
  command* — first on the **external-IdP** milestone (~6 upstream OCP tasks + the MA
  wiring, **no greenfield crypto**), getting a real demo out while the AS is built.
- Commits the in-house "zero external service" battery up front (à la Laravel Passport),
  **accepting the greenfield-crypto liability** ADR 0029 documents — the largest, most
  security-sensitive subsystem, behind a Phase-0 spike that can fail, with a forever
  spec/CVE/rotation cost. The seam makes the external→in-house transition purely additive
  (no RS rework), so the milestone-first ordering costs nothing.
- Corrects 0029 (open client registration) and records the default wiring in 0028, in
  place, so the three ADRs stay consistent.
- Establishes **one** end-to-end security review for the whole flow — the single most
  important structural fix the panel surfaced.
