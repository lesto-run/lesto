# ADR 0029 — Lesto as a first-party OAuth 2.1 Authorization Server

- **Status:** Proposed. A batteries-included **"Lesto apps can be an OAuth provider"**
  battery (the Authorization-*Server* role — issuing tokens others consume), à la
  Laravel Passport. The owner chose to **build** it first-party rather than delegate to
  an external IdP. The general goal is that a Lesto app can issue its own audience-bound
  tokens. **It does NOT block remote MCP (ADR 0028 Phase 3b):** that surface ships first
  against a **configured external IdP** (the RS only validates tokens via an injected
  seam), and this AS lands **later** as the battery that *removes* the external-IdP
  dependency for owners who have none. It also ships **after** ADR 0030 (the OAuth
  *client* / social-login battery, the broader gap). This ADR scopes the build. It is the **largest and most security-sensitive** subsystem in the
  effort. Two hard gates apply: **(1)** all crypto and protocol primitives use **vetted
  libraries** (`jose` for JOSE/JWT/JWKS; a maintained OAuth2 substrate or a `jose`-only
  minimal flow) — **never hand-rolled** — and **(2)** a **Phase 0 runtime/crypto spike
  must pass before any flow code is written** (asymmetric signing + JWKS on a real
  Cloudflare Worker *and* Node are unproven in this codebase). The build must also clear
  a dedicated adversarial review and a `security-review`. Revised 2026-06-20 after a
  3-lens adversarial panel — see *Reviews*. **Amended 2026-07-02** — the agent-native MCP
  wedge ships a *real* OAuth issuer via **OpenAuth** on a Cloudflare Worker as its
  **interim** Authorization Server (`L-0706ea00`), and whether this from-scratch
  first-party AS is still worth building vs. wrapping/recommending OpenAuth is **re-opened
  as an open question**; see *Amendment (2026-07-02)* below.
- **Date:** 2026-06-20
- **Deciders:** tech lead + owner
- **Builds on / touches:** ADR 0030 (OAuth *client* / social sign-in — ships first;
  shares the `jose`-based JWT-verify helper), ADR 0028 (operator control plane — the
  first consumer), ADR 0002 (Cloudflare edge runtime), ADR 0003 (auth strategy), ADR
  0013 (durable stores —
  the `SqlDatabase` seam for persistence), ADR 0016 (secure-by-default kernel), ADR
  0020 (auth factors). Composes `@lesto/identity` + `@lesto/auth` (resource-owner
  session it reads — `currentUser`/`readSessionToken`), `@lesto/csrf` (consent CSRF +
  `originCheck`), `@lesto/ratelimit` (endpoint throttling), `@lesto/web` (app-layer
  mount).

## Context

ADR 0028's remote MCP surface (Phase 3b) is an OAuth 2.1 **Resource Server**: it
validates an audience-bound bearer token per request, maps the token's subject to a
`userId`, resolves roles, and authorizes via `policy.allows`. That presupposes an
**Authorization Server** issuing those tokens. Today Lesto has none:
`packages/auth/src/index.ts:17` states OAuth is "a future adapter, out of scope here,"
and the only credentials minted are opaque session tokens (`auth/sessions.ts:48-58`)
and HMAC reset/verify tokens — none are OAuth access tokens.

Crucially (confirmed by the panel against the repo): there is **no JWT/JOSE code, no
asymmetric crypto, and no key store anywhere** — every primitive is symmetric HMAC/digest
over `node:crypto` (`auth/signed-sessions.ts:24`, `auth/password.ts`, `csrf/token.ts`)
or Web Crypto HMAC on the edge (`storage/sigv4.ts:174-182`). The edge has **no KV/DO
binding** (only D1/Hyperdrive SQL and R2 blobs — `cloudflare/src/{d1,hyperdrive,assets}.ts`),
and **D1 has no interactive transactions** (`cloudflare/src/d1.ts:18,76-78`). So the
token core is greenfield, security-critical crypto on an unproven-for-this runtime —
hence the Phase 0 gate.

Lesto *does* own the hard half: **resource-owner authentication** (`@lesto/identity` +
`@lesto/auth`, with password + TOTP, ADR 0020). The AS is a layer **on top of**
identity — what's new is the OAuth *protocol* (clients, consent, scoped + audience-bound
token issuance, discovery).

### Alternatives considered

- **Delegate to an external IdP** (Auth0/WorkOS/Clerk): least code, but a third-party
  *runtime* hard dependency per deployment; cuts against the batteries-included thesis.
  Rejected by the owner.
- **`better-auth` OAuth-provider plugin** (`auth/index.ts:17`): recorded fallback if the
  first-party build proves too costly.
- **Build first-party (chosen) — but mandate vetted libraries.** The honest ledger
  weighs not just build cost but the **permanent** cost: tracking the OAuth 2.1 / MCP
  authorization spec (which is young and churning — it already moved from dynamic
  registration toward Client ID Metadata Documents), key rotation, CVE monitoring, and
  audits, at a one/two-person cadence. The mandated-library posture (own the *glue*, not
  the crypto) is what keeps that forever-cost bounded — and a library dependency is
  categorically different from a runtime third-party IdP dependency, so it does **not**
  violate the self-contained-stack thesis.

## Decision

Add a first-party OAuth 2.1 Authorization Server (working name `@lesto/oauth-server`),
conformant with the subset of OAuth 2.1 the MCP authorization spec requires, **built on
`jose` (JOSE/JWT/JWKS) and a maintained OAuth2 substrate (or a `jose`-only minimal flow
if no substrate fits Workers cleanly) — never hand-rolled crypto**. It issues
**audience-bound JWT access tokens** validated by any Lesto Resource Server (MCP first)
**offline via a published JWKS**, so the RS never calls the AS on the hot path.

`@lesto/oauth-server` is an **app-tier leaf** depending on `@lesto/web` + `@lesto/identity`
+ `@lesto/csrf` + `@lesto/ratelimit`; it is **mounted by the app** (via `web`'s
`.route()`), never by `@lesto/kernel` (which would close a cycle, the same lesson as
remote MCP). A small **shared types module** (the `verifyAccessToken` claim shape +
the JWKS document type) is depended on by *both* AS and RS, so neither imports the
other's logic.

### Phase 0 — runtime + crypto spike (HARD GATE, before any flow code)

Prove, on a real Cloudflare Worker **and** Node: ES256 keypair generation, JWT sign +
JWKS verify (via `jose`/Web Crypto), and a persisted **signing-key store** with
**rotation** over the `SqlDatabase` seam (works on Node SQLite/PG and edge D1). Prove
**atomic single-use** redemption *without* a transaction (D1 has none) via a conditional
single-statement CAS — the idiom `identity.ts:965` (`markRecoveryCodeUsed`,
`UPDATE … WHERE used_at IS NULL RETURNING …`) and `ratelimit/sql-store.ts:126-134`
(INSERT-conflict-as-signal) already use. If the spike fails, the whole remote-MCP
surface is reconsidered. This gate is the true meeting point with ADR 0028 Phase 3b —
*not* "token mint/verify."

### Scope — what the AS must provide (after Phase 0)

- **Persisted entities** (none exist today; all over the `SqlDatabase` seam, edge-safe):
  **signing keys** (with `kid`, validity windows), **authorization codes** (atomic
  single-use CAS, short TTL, bound to client+PKCE+redirect_uri), **registered clients**
  (id + exact redirect_uris), **consent records** (per `(user, client, scope, resource)`),
  and, if Phase 4 ships, **refresh tokens** (opaque, **hashed at rest** like
  `sql-session-store.ts`).
- **Authorization endpoint** (`/authorize`): authorization-code grant; **PKCE `S256`
  required** (reject `plain` and absent method); **no implicit grant**; **exact
  `redirect_uri` match** against the client registry (no prefix/substring; on validation
  *failure* render the error locally, never redirect it); echo `state` verbatim;
  internal `return`/login params validated as **relative same-origin paths only**
  (open-redirect defense). The resource-owner step **reads** an authenticated
  `@lesto/identity` session via `currentUser(readSessionToken(cookie))` (`identity.ts:355`,
  `identity/cookies.ts`) and, if unauthenticated, redirects to an **injected
  `loginUrl(returnTo)`** seam (identity ships *no* login UI — the app owns it).
- **Token endpoint** (`/token`): code exchange (verify PKCE `code_verifier`); **code
  reuse revokes all tokens derived from it**. Refresh grant (Phase 4) with **rotation +
  reuse detection → revoke the whole token family** (alarm via `onDenied`).
- **Resource indicators (RFC 8707):** honor `resource` on authz + token requests and
  bind the token's `aud` — but **only to a registered resource** (allow-list; never mint
  `aud` for an arbitrary client-supplied URL). This is the confused-deputy defense.
- **Token format (via `jose`):** ES256 JWT (`iss`, `sub`, `aud`, `scope`, `exp`, `iat`,
  `nbf`, `jti`) with a **`kid`** header. **RS validation contract (mandated, testable):**
  algorithm **allow-list `["ES256"]`** (never trust the header `alg`; ban `none`; forbid
  HMAC algs so a JWKS public key can't be coerced into an HMAC secret); reject if `iss`
  ≠ expected, `aud` ∌ this RS, `exp` ≤ now, or `nbf` > now (bounded skew).
- **JWKS + rotation:** JWKS publishes **all currently-valid public keys** (overlap
  window ≥ max access-token TTL), each with `kid`; tokens carry `kid`. RS caches JWKS
  with a **bounded, rate-limited refetch on unknown `kid`** (and negative-caches unknown
  kids) so random-`kid` tokens can't trigger a refetch-storm DoS.
- **Discovery + clients:** RFC 8414 AS metadata (`/.well-known/oauth-authorization-server`)
  and RFC 9207 `iss` on the authorization response. Client registration via **one**
  mechanism for the first cut — **pre-registration** (or Client ID Metadata Documents);
  dynamic registration (RFC 7591) stays out for a *closed* first client.
  **Amended by ADR 0039 for the MCP Resource-Server consumer:** pre-registration is
  insufficient for the open MCP client ecosystem (arbitrary agents arrive unknown), so
  **CIMD-preferred with a DCR (RFC 7591) compatibility path** is in-scope when this AS
  serves MCP — DCR is *retained for backward compat / de-emphasized* by the current MCP
  spec, **not** formally deprecated. Its open-redirect / SSRF-on-`redirect_uri` /
  registration-spam surface is covered by ADR 0039's single end-to-end security review,
  which this AS's gate owns. **The concrete mechanism — endpoints, the client-metadata
  document shape, the CIMD/DCR/pre-registration resolution flow, the `aud`/`resource`
  separation, and the registration threat model — is designed in ADR 0041 (open MCP client
  registration); this bullet is that design's policy hook, and ADR 0041 is its Phase 3.**
- **Scope is an enforced ceiling, not the decision and not display-only (carried from
  ADR 0028).** Scopes are coarse (e.g. `mcp:admin`). The RS decision is the
  **intersection** `scope-permits(action) AND policy.allows(rolesOf(sub), action)`:
  scope caps what the token may do (a `mcp:read` token never writes, whatever the live
  roles); `policy.allows` is the live floor (revoked roles deny immediately). The AS
  defines what each scope grants.

### Revocation — the deliberate decision (offline JWT cannot be revoked pre-`exp`)

Offline JWKS validation and "revocable access tokens" cannot both hold. The written
decision: **access tokens are not individually revocable before `exp`; their TTL is the
bound** — capped hard (**≤5 min for `mcp:admin`-class scopes**). The blast radius of a
leaked admin token is full `aud`+`scope` access until `exp`, with no per-token kill
switch — *accepted*, mitigated by the short cap, TLS, and `Referrer-Policy: no-referrer`
+ token/`code`/`code_verifier` redaction from logs and the `onDenied`/trace path.
**Mass revocation** is via **signing-key rotation** (rotate the active key ⇒ all live
tokens fail — the nuclear button). An optional RS-side `jti` deny-list (checked from a
fast store) is the recorded escalation if per-token revocation is later required; it
trades pure-offline for a bounded worst case.

### Security posture (the review gate enforces it)

PKCE `S256`-only; no implicit grant; exact redirect match + local error render;
open-redirect allow-list on return params; `state` echo. Consent is **authenticated-only**,
CSRF-bound to the **identity session** (`csrf({ sessionFor })`, `csrf/middleware.ts:47`)
**plus** `originCheck({ strict })` (`csrf/origin.ts:134`); consent recorded per
`(user, client, scope, resource)` and the screen shows the resolved client + `resource`
(audience). Rate-limit `/authorize` + `/token` per `client_id` (`ratelimit` `keyFor`).
JWT alg allow-list + `none`/key-confusion ban; full claim validation. Short access-token
TTL; refresh rotation + reuse-detection. Generic, **non-enumerable** OAuth errors
(don't reveal whether a `client_id`/code exists). TLS required. **The AS is a
session-*reader* and never runs scrypt on the edge** (password verification stays on the
Node tier / behind the existing login).

### Sequencing (all behind ADR 0028 Phase 1 + the roles store)

0. **Runtime/crypto spike** (the hard gate above).
1. **Token core + key store + JWKS** — `jose` ES256 mint/verify, the persisted key
   store + rotation + `kid`, JWKS publication. Pure/testable; no flow yet.
2. **Auth-code + PKCE flow + client pre-registration** — `/authorize` (session read +
   `loginUrl` + consent), `/token`, exact redirect match (needs the client registry,
   so it lands *here*, not later), RFC 8707 audience binding, RFC 9207 `iss`.
3. **Discovery** (RFC 8414) + the chosen client-registration mechanism.
4. **Refresh tokens** (rotation + reuse-detection) — **optional/deferred**; for an
   interactive first client, short access-token TTL + re-auth is acceptable, which drops
   the rotation/replay surface entirely. Build it only if an unattended long-running
   agent needs it.

Only after Phase 0 + the key store does ADR 0028 Phase 3b's RS survive a rotation
(stale JWKS otherwise → mass 401s).

## Non-goals

- **Not a social-login / IdP-federation product.** Acting as an OAuth *client* to
  upstream IdPs remains the separate "future adapter" of `auth/index.ts:17`.
- **No OIDC ID tokens** unless a consumer needs them.
- **No replacement of `@lesto/identity`/`@lesto/auth`.** The AS sits on top.
- **No fine-grained authorization in the token.** Authorization is the RS
  intersection (scope ceiling ∩ live policy).
- **No hand-rolled crypto or protocol primitives.** Vetted libraries only.

## Reviews

3-lens adversarial panel (protocol/token security, build-vs-buy/scope,
integration/sequencing/runtime), grounded in the repo. Resulting changes:

- **Mandated vetted libraries** (`jose` + OAuth substrate) — the panel found the ADR
  had left "from scratch vs library" undecided on a codebase with zero JWT/asymmetric
  crypto, defaulting to the reckless reading.
- **Added the Phase 0 runtime/crypto spike gate** — asymmetric signing + JWKS + a key
  store + transaction-free atomic CAS are all greenfield and unproven on the edge
  (no asymmetric crypto, no KV/DO, D1 has no transactions).
- **Resolved the revocation contradiction in writing** — offline JWT ⇒ access tokens
  not revocable pre-`exp`; TTL cap + key-rotation mass-revoke; blast radius stated.
- **Specified the JWT/PKCE security contract** — `S256`-only; RS alg allow-list; ban
  `none`/HS-RS key confusion; `kid`/rotation/JWKS-cache-with-bounded-refetch.
- **Corrected scope from "display-only" to an enforced ceiling** (RS = scope ∩
  `policy.allows`); this also amended ADR 0028.
- **Made the identity-reuse seams explicit** — `currentUser`/`readSessionToken` works,
  but added the injected `loginUrl` seam (no login UI in identity) and **consent
  records** as a persisted entity; AS never runs scrypt on the edge.
- **Enumerated the persisted entities** (keys, codes, clients, consent, refresh) over
  the `SqlDatabase` seam; pinned `sub = String(<integer User.id>)` today with the RS
  resolving via `rolesOf(string)` only (never re-`Number()` for authz), and flagged the
  integer-PK assumption as the thing that breaks under non-integer ids.
- **App-mounted, never `kernel`** (cycle avoidance) + a **shared types module** for the
  AS↔RS claim/JWKS contract.
- **Trimmed the first cut** — one client-registration mechanism; refresh tokens
  deferred; DCR/OIDC out.
- **Surfaced the sequencing dissent, then reframed:** two lenses argued the AS had *no
  consumer today* and should be deferred until a named remote MCP client exists. The
  owner's resolution was to keep it committed but reframe its justification — it is a
  general **"Lesto-as-OAuth-provider" battery** (à la Laravel Passport), with remote MCP
  as the first consumer rather than the sole one, and it ships **after** the broader
  OAuth-*client* battery (ADR 0030). The zero-consumer concern is thus answered at the
  product level (a framework battery, demanded by the batteries-included thesis), not by
  a single waiting client; recorded so the bet stays explicit.

## Consequences

- Lesto can issue audience-bound tokens, unblocking ADR 0028 Phase 3b and any future
  first-party Resource Server, with a clean offline AS↔RS boundary.
- It is a large, security-critical surface — own ADR, own package, own phased build, a
  Phase 0 spike gate, mandated libraries, and a dedicated adversarial + `security-review`.
  It deliberately follows the demanded value (ADR 0028 Phase 1) and sequences last.
- The first-party choice keeps the auth stack self-contained while the library mandate
  bounds the forever-cost; `better-auth` / external-IdP remain recorded fallbacks.

## Amendment (2026-07-02) — OpenAuth as the wedge's interim real issuer

An ADR-level decision surfaced **2026-06-25**: the agent-native MCP wedge (epic
`L-ac59114b`, capstone ADR 0039) needed a *real* OAuth issuer to prove the
authenticated-production-MCP-server battery end-to-end, and blocking that proof on this
from-scratch `@lesto/oauth-server` — the largest, most security-sensitive, deepest
subsystem in the effort (the Phase 0 crypto spike plus the ~8-deep chain ADR 0039 counts)
— was the wrong trade for the wedge's timeline. The decision: ship a real issuer **via a
proven, batteries-included standards library — OpenAuth on a Cloudflare Worker** (tracked
as `L-0706ea00`), adopted as the **interim Authorization Server**. This **reaffirms and
sharpens** the earlier 2026-06-24 steer to *defer* the from-scratch AS: the deferral now
has a concrete, shipping replacement rather than a gap. It records the pivot on top of the
original Decision above — that decision text is unchanged and still describes the
first-party build *if* it is undertaken.

- **(a) The pivot — wrap/recommend a standards OAuth server NOW.** The wedge no longer
  waits on first-party crypto to demonstrate an authenticated MCP server. OpenAuth (ES256
  JWTs, JWKS discovery, RFC 8414 metadata) runs as a Cloudflare Worker and issues the real
  access tokens the MCP Resource Server validates. The wedge example is
  `examples/mcp-auth-openauth/` (its issuer under `idp/`, the RS adapter at
  `mcp/verify.ts`); OpenAuth's issuer signing keys are persisted in a single Durable
  Object (Cloudflare-KV eventual consistency is unviable for a JWKS). This is the
  recommended path for a site owner who wants an authenticated production MCP server
  *today*: wrap — or simply recommend — a vetted OAuth server rather than hand-roll one.
- **(b) The re-opened question — is a from-scratch `@lesto`-native AS still worth it?**
  ADR 0039 committed the in-house AS "up front" as the headline "zero external service"
  battery. With a proven library now covering the wedge, that commitment is **re-opened as
  an open question**, not cancelled: does a hand-rolled first-party AS earn its
  greenfield-crypto build plus the forever spec/CVE/rotation cost (this ADR's *Context*)
  over **wrapping OpenAuth as a first-party battery**, or simply **recommending it**,
  long-term? The honest ledger of §*Alternatives considered* gains a fourth entry — a
  maintained OAuth-server *library* (OpenAuth). Like the mandated `jose`/OAuth-substrate
  posture, it is a library dependency, not a runtime third-party IdP, so it does **not**
  violate the self-contained-stack thesis. No decision is recorded here; the from-scratch
  build is **an open question, not a commitment**, pending that call.
- **(c) The integration contract (so any future first-party AS is a drop-in).** Whatever
  issues the tokens, the Resource Server depends on **one** contract, behind the **same
  `verify.ts` seam** — `VerifyAccessToken(token) → { subject, audience, scopes }` from
  `@lesto/mcp`, the seam ADR 0028 §Phase 3b and ADR 0039 D3 already specify. The canonical
  shape is: a **JWT access token**, verified **offline via JWKS discovery** (the issuer's
  `jwks_uri`; ES256/RS256 per the issuer's `alg` allow-list — never `none`, never HMAC
  against a JWKS key), with **`aud` = the resource identifier** (the confused-deputy bound)
  and **`scope` claims** (the RS ceiling). OpenAuth is the *interim* fit, not a perfect
  one, and the seam absorbs the gap: OpenAuth 0.4.x ships no RFC 8707 resource indicators
  (its `aud` is the *client id*, so the RS is configured with `resource = <that client
  id>`) and no OAuth `scope` claim (the grant's scopes ride in `properties.scopes`) —
  `mcp/verify.ts` maps both onto the RS contract. A future first-party AS (this ADR's
  `@lesto/oauth-server`, *if* it is built) that stamps the resource into `aud` and emits a
  real `scope` claim is a **cleaner drop-in behind the identical seam — no RS rework**,
  which is the whole reason the RS is kept issuer-agnostic.
