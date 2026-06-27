# ADR 0040 — Open MCP client registration: CIMD-first, with an RFC 7591 DCR compatibility path

- **Status:** Proposed (design + skeleton). The **concrete mechanism** ADR for the
  open-client-registration gap that ADR 0039 D2 named but left as *posture pending the
  MA-0 spike*, and that ADR 0029 §Discovery+clients only resolved at the policy level
  ("CIMD-preferred with a DCR compatibility path"). This ADR pins the **endpoints**, the
  **client-metadata document shape**, the **registration + validation flow**, how it ties
  to the Resource Server's `aud`/`resource` model (the confused-deputy boundary), and the
  **security posture** for *open* registration (registration spam, software statements,
  `redirect_uri` validation, SSRF on metadata fetch). It introduces **no new crypto**
  (ADR 0029 owns every token/JWKS primitive) and **no new authorization-server decision**
  (ADR 0029 owns the AS scope/sequencing). What is genuinely new here is the *registration
  surface* — the one part of the OAuth flow an *open* MCP client ecosystem forces and that
  pre-registration cannot serve. It is **design-only with a thin, non-functional skeleton**
  (`packages/oauth-server/`): the skeleton encodes the document/types/endpoint shape so the
  contract is legible and testable, but it is **not shippable DCR** — it does no
  persistence, no real `redirect_uri`/issuer validation, no rate limiting, no crypto. The
  build inherits ADR 0029's hard gate (vetted libraries; a dedicated adversarial +
  `security-review`) and ADR 0039 D5's single end-to-end security review.
- **Date:** 2026-06-27
- **Deciders:** tech lead + owner
- **Builds on / touches / amends:** **amends ADR 0029 §Discovery+clients** (replaces the
  posture with the concrete CIMD-first + DCR-compat design) and **realizes ADR 0039 D2**
  (the deferred mechanism decision). Composes ADR 0029 (the AS — `/authorize`, `/token`,
  the registered-client + registered-resource registries, the exact-`redirect_uri` rule,
  RFC 8707 `aud` binding, RFC 8414 metadata), ADR 0028 §Phase 3b (the RS — the
  `VerifyAccessToken` seam, the `aud` no-passthrough guard, RFC 9728 PRM), ADR 0030 (the
  shared `jose` verify helper, reused to verify a signed software statement / CIMD JWT),
  ADR 0013 (the `SqlDatabase` seam for the DCR client store), ADR 0016
  (secure-by-default), `@lesto/ratelimit` (registration throttling), `@lesto/csrf`
  (`originCheck` reuse). New skeleton package `packages/oauth-server/` (the home ADR 0029
  reserved as `@lesto/oauth-server`).

## Context

Lesto's Resource Server (ADR 0028 §Phase 3b) is **issuer-agnostic**: it validates a
bearer token offline against a configured issuer's JWKS via the injected
`VerifyAccessToken(token) → { subject, audience, scopes }` seam (`packages/mcp/src/http.ts`),
guards the audience (no passthrough — the confused-deputy defense), and intersects scope
ceiling with the live policy floor. It registers no clients and issues no tokens. The
**Authorization Server** that *would* issue them is ADR 0029 — committed but unbuilt, and
its first cut chose **pre-registration** for clients (know each `client_id` +
`redirect_uri` ahead of time).

That is the gap. A real MCP client — Claude Desktop, Cursor, VS Code, ChatGPT, the MCP
Inspector — arrives **unknown**. It cannot be pre-registered: the site owner has never
heard of it, and the client has never heard of this server. The MCP authorization spec
(2025-11-25) resolves this two ways, and ADR 0039 already chose between them at the policy
level:

1. **Client ID Metadata Documents (CIMD)** — the spec's *preferred, forward* direction.
   The client's `client_id` **is an HTTPS URL** that dereferences to a JSON metadata
   document the client publishes and hosts. There is **no registration write endpoint and
   no server-side client store**: the AS fetches the document at authorize time, validates
   it, and treats it as the (cacheable, immutable-per-URL) client record. This is the
   structurally safer mechanism — registration spam has nowhere to land, and there is no
   attacker-writable client table.
2. **Dynamic Client Registration (RFC 7591)** — the *installed-base* mechanism. The client
   `POST`s a metadata document to a registration endpoint; the AS validates it, persists a
   record, and returns a freshly-minted `client_id` (and optional `client_secret`). It is
   **retained for backward compatibility / de-emphasized** by the current spec — **not**
   formally deprecated (ADR 0029's original "deprecated" wording was already corrected by
   ADR 0039). Most MCP clients shipping *today* still use DCR, so omitting it strands the
   present-day ecosystem.

ADR 0039 D2 decided **"CIMD-preferred with a DCR (RFC 7591) compatibility path"** and
amended ADR 0029 to make the open mechanism in-scope — but explicitly left the *concrete*
design (endpoints, document shape, validation flow) **pending the MA-0 spike**. ADR 0029's
adversarial panel reviewed an AS **without** either mechanism. So the concrete open-registration
surface — *the program's single most dangerous new attack class after token passthrough* —
has been **designed by no one**. This ADR designs it.

### Why this is its own ADR (and not more prose in 0029/0039)

- **0039 is a sequencing ADR** and explicitly defers the mechanism ("default posture
  pending MA-0"). It owns *that the open mechanism is in-scope*, not *what it is*.
- **0029 is the AS-build ADR.** Its §Discovery+clients is a one-line bullet; the open
  registration surface needs endpoints, a document schema, a fetch/validate flow, and a
  threat model of its own. Folding all of that into 0029 would bury the *highest-risk new
  surface* under the (already large) token/JWKS narrative.
- The registration design must be **legible as a unit** for ADR 0039 D5's single
  end-to-end security review (registration → authorize → consent → `aud` binding → RS
  validation). Giving it one home makes that review reviewable.

### Alternatives considered

- **CIMD-only (drop DCR).** Cleanest security posture (no write endpoint, no client
  store, no registration spam). Rejected for the *first* cut because the present-day
  installed base (most shipping MCP clients) speaks DCR; CIMD-only strands them. Kept as
  the **stated end-state** — DCR is the compatibility bridge, CIMD is where the ecosystem
  is going, and the design must let DCR be *disabled by config* without touching CIMD.
- **DCR-only (skip CIMD).** Matches today's clients but builds on the de-emphasized
  mechanism and forgoes the structurally-safer one. Rejected: it would have us build the
  *riskier* surface and skip the one the spec is steering toward.
- **Pre-registration only (ADR 0029's original first cut).** Correct for a *closed* first
  client; cannot serve the open ecosystem at all (ADR 0039 D2). Retained as a **third,
  always-available** mechanism for owners who have a fixed, known client — it is the most
  locked-down option and costs nothing to keep.
- **Delegate registration to an external IdP.** In the external-IdP milestone (ADR 0039,
  shipped first), the IdP *already owns* registration — Lesto's RS just validates the
  resulting tokens. This ADR's mechanism is what the **in-house AS** (ADR 0029) needs so
  Lesto can be the "zero external service" battery. Both are committed; this designs the
  in-house leg.

## Decision

Add open MCP client registration to the first-party AS (`@lesto/oauth-server`, ADR 0029's
reserved package) as **three mechanisms behind one client-resolution seam**, ordered by
safety, all feeding ADR 0029's existing `/authorize` exactly the same validated client
shape:

> **CIMD-first** (preferred, no write endpoint) → **DCR (RFC 7591)** as a config-gated
> compatibility path for today's clients → **pre-registration** as the locked-down option
> for a known client.

The AS resolves a client to a single internal `RegisteredClient` shape **before**
`/authorize` does anything, regardless of which mechanism produced it. `/authorize`,
consent, the exact-`redirect_uri` rule, and RFC 8707 `aud` binding (ADR 0029) are
**unchanged** — they consume the resolved client and never learn how it was registered.

### D1 — The client-resolution seam (one shape, three sources)

A single internal type — the **`RegisteredClient`** — is what `/authorize` consumes. Every
mechanism produces it; nothing downstream branches on the source:

```ts
interface RegisteredClient {
  clientId: string;                       // the URL (CIMD) or the minted opaque id (DCR/pre-reg)
  redirectUris: readonly string[];        // EXACT-match allow-list; never a prefix
  source: "cimd" | "dcr" | "preregistered";
  clientName?: string;                    // display-only; shown on consent, never trusted for routing
  // Future, behind the same seam: tokenEndpointAuthMethod, scope ceiling, software-id, …
}
```

`resolveClient(clientId) → RegisteredClient | undefined` is the **only** path
`/authorize` uses to learn about a client. It dispatches by shape:

- `client_id` is an **`https://` URL** → **CIMD**: fetch + validate the metadata document
  (D2), derive `RegisteredClient` from it. No store read.
- otherwise → look up a **persisted record** (a DCR-minted id or a pre-registered id) in
  the client store. No fetch.

This is the seam that keeps ADR 0029's `/authorize` ignorant of registration — exactly as
ADR 0028 keeps the RS ignorant of the issuer behind `VerifyAccessToken`.

### D2 — CIMD (the preferred path): endpoints, document, flow

**Endpoints.** *None new on the AS.* CIMD's whole point is that the **client** hosts its
metadata; the AS only **dereferences** a URL it is handed as `client_id`. The AS advertises
support via its RFC 8414 metadata (D5).

**The client-metadata document (what the client publishes at its `client_id` URL).** A
JSON document keyed by RFC 7591 §2 field names (CIMD reuses the same registry), the subset
MCP needs:

```jsonc
{
  "client_id": "https://claude.ai/.well-known/oauth-client",   // MUST byte-equal the URL it was fetched from
  "client_name": "Claude",                                      // display-only (consent screen)
  "client_uri": "https://claude.ai",
  "logo_uri": "https://claude.ai/logo.png",                     // rendered sandboxed / not at all (anti-phishing)
  "redirect_uris": ["https://claude.ai/oauth/callback"],        // EXACT match at /authorize
  "token_endpoint_auth_method": "none",                         // public client; PKCE S256 is the proof (ADR 0029)
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "mcp:read"                                            // the MAX scope the client may request (a ceiling)
}
```

**The CIMD validation flow (at `/authorize`, before any consent):**

1. `client_id` MUST be `https:` (never `http:`), MUST have no fragment, and its host MUST
   resolve to a **public** address — the **SSRF guard** (D6): reject loopback, RFC 1918,
   link-local, and any literal-IP host. The fetch is the only place the AS makes an
   outbound request on an attacker-influenced URL, so it is the SSRF chokepoint.
2. Fetch the document over TLS with a **hard timeout, a small max body size, and capped
   redirects that re-run the SSRF guard on every hop** (no redirect to a private address).
3. The document's `client_id` MUST **byte-equal** the fetched URL (binds the document to
   its identity; defeats a hosted-doc that claims someone else's id).
4. Validate the shape (Zod, per ADR 0005 — validation at the boundary): `redirect_uris`
   present + non-empty + each an absolute `https:` URL (or an allow-listed loopback for a
   native client, exact-matched), `response_types` ⊆ `["code"]`, `grant_types` ⊆
   `["authorization_code","refresh_token"]`. Reject anything requesting the implicit grant.
5. Derive `RegisteredClient`. **Cache** by URL with a bounded TTL + an ETag/`Cache-Control`
   honor (CIMD docs are meant to be stable per URL); a **negative cache** for fetch
   failures so a bad/unreachable `client_id` cannot be used as a fetch-amplification lever.

CIMD has **no registration spam surface** (no write endpoint) and **no attacker-writable
store** — its only new risk is the metadata fetch, fully contained by the SSRF guard (D6).

### D3 — DCR (RFC 7591): the endpoint, the flow, the store

**Endpoint.** `POST /register` (Content-Type `application/json`). Config-gated —
**off by default**; the owner opts in (`mcpAuth: { dynamicRegistration: true }`) precisely
because it is the riskier surface. When off, `/register` returns RFC 7591
`{ "error": "access_denied" }` and the AS metadata omits `registration_endpoint`.

**Request body** = the **same metadata document** as D2 (minus `client_id`, which the AS
mints). **Response** (RFC 7591 §3.2.1): `client_id` (a minted opaque id, *not* a URL),
optionally `client_secret` (only if a confidential client is ever supported — the MCP
default is a **public** client, `token_endpoint_auth_method: "none"`, so usually omitted),
`client_id_issued_at`, and the registered metadata echoed back.

**Validation flow (at `POST /register`):**

1. **Rate-limit hard** per source IP **and** globally (`@lesto/ratelimit` `keyFor`) — the
   anti-spam control, since this is the only attacker-writable surface (D6).
2. Validate the body with the **same** Zod schema as CIMD (one schema, two callers): exact
   `redirect_uris` (absolute `https:`, no wildcard, no fragment), `response_types ⊆
   {code}`, `grant_types ⊆ {authorization_code, refresh_token}`, public-client auth method.
3. **Optionally require a signed software statement** (RFC 7591 §2.3) — a JWT, verified
   with ADR 0030's shared `jose` helper against a configured trust anchor. When a trust
   anchor is configured, **unsigned registrations are refused**: this turns open DCR into
   *attested* DCR (only clients vouched-for by a trusted authority register), the strongest
   anti-abuse lever short of disabling DCR. The trust anchor is config; default is none
   (fully open, rate-limited).
4. Mint an opaque `client_id`, persist a `RegisteredClient` (`source: "dcr"`) over the
   `SqlDatabase` seam (ADR 0013) — the **only** persisted registration entity; CIMD and
   pre-registration write nothing here.
5. **No `redirect_uri` is ever dereferenced at registration** (an SSRF trap RFC 7591
   implementations routinely fall into) — `redirect_uris` are *stored verbatim* and only
   ever **exact-matched** at `/authorize`, never fetched.

**Client store** (`SqlDatabase`, edge-safe per ADR 0013): `client_id` (PK), `redirect_uris`
(JSON, exact-match set), `client_name`, `created_at`, optional `software_id`/`software_statement_jti`
(replay-guard the statement). Records are immutable after mint for the first cut (no
`PUT/DELETE /register/:id` — RFC 7592 management is a non-goal).

### D4 — How it ties to the RS `aud`/`resource` model (the confused-deputy boundary)

Registration governs **who may ask for a token**; the **`aud`/`resource` allow-list**
(ADR 0029 RFC 8707, ADR 0028 RS guard) governs **what a token may be spent on**. They are
**orthogonal and both required**, and this ADR keeps them so:

- A registered client (by any mechanism) may request a token, but the AS mints `aud`
  **only** for a **registered resource** — the MCP server's canonical URI
  (`https://app.example.com/mcp`), auto-registered by the `lesto add mcp-auth` scaffold
  (ADR 0039 D4). **Registering a client never registers a resource.** A freshly DCR'd or
  CIMD client cannot coerce the AS into minting a token audienced at an arbitrary URL —
  that is the confused-deputy defense ADR 0029 already owns, and open registration does
  **not** widen it.
- The RS (ADR 0028) still validates `aud ∋ this resource` with **no passthrough**,
  independent of how the client registered. Open registration changes the *front door*
  (who gets in), never the *audience guard* (where the token is valid).
- The minted `client_id` (DCR) or `client_id` URL (CIMD) is **not** the `aud`. Conflating
  the two is the classic confused-deputy bug; this ADR states the separation explicitly so
  the skeleton's types keep `clientId` and `resource`/`audience` distinct.

### D5 — Discovery (AS metadata advertises what is supported)

The AS's RFC 8414 metadata (`/.well-known/oauth-authorization-server`, ADR 0029) gains:

- `registration_endpoint`: present iff DCR is enabled (D3); omitted otherwise.
- a CIMD support signal per the MCP spec's discovery field (the AS advertises that an
  `https`-URL `client_id` is accepted, so a CIMD-capable client skips `/register`).
- `code_challenge_methods_supported: ["S256"]` (carried from ADR 0029 — PKCE is how a
  public, dynamically-registered client proves itself without a secret).

The RS's RFC 9728 PRM (`.well-known/oauth-protected-resource`, already shipped in
`packages/mcp/src/http.ts`) is **unchanged** — it points the client at the AS; the AS's
metadata is where registration is advertised. The discovery chain is: client reads PRM →
finds the AS → reads AS metadata → registers (CIMD/DCR/none) → `/authorize`.

### D6 — Security posture (the review gate enforces it)

The open registration surface adds exactly three new attack classes; each has a stated
control, all inside ADR 0039 D5's single end-to-end review:

- **Registration spam (DCR only).** Mitigated by: DCR **off by default**; hard
  per-IP + global rate limits; **optional signed software statement** turning open DCR into
  attested DCR; immutable records; CIMD (the preferred path) has **no** write endpoint, so
  spam has nowhere to land.
- **`redirect_uri` abuse (open-redirect / token exfiltration).** Mitigated by: **exact**
  `redirect_uri` match at `/authorize` (no prefix/substring/wildcard — ADR 0029); absolute
  `https:` only (or an exact-matched loopback for native clients); **never dereferenced**
  at registration; PKCE `S256` so an intercepted `code` is useless without the verifier.
  The consent screen shows the **resolved, server-known** client name + origin + `resource`
  — **never** an attacker-supplied display string (the anti-phishing control, ADR 0039 D1).
- **SSRF / fetch abuse (CIMD + software-statement fetch).** Mitigated by: `https`-only,
  no-fragment `client_id`; a **public-address guard** (reject loopback/RFC 1918/link-local/
  literal-IP) re-checked on **every redirect hop**; hard timeout + max body size + capped
  redirects; positive **and negative** caching so a bad URL is not a fetch-amplification
  lever. The CIMD fetch and the software-statement-JWKS fetch are the *only* outbound
  requests on attacker-influenced URLs and both pass this one guard.

Cross-cutting (carried from ADR 0029): generic, non-enumerable errors (don't reveal whether
a `client_id` exists); TLS required; tokens/codes/verifiers redacted from logs and the
`onDenied`/trace path. **The whole chain — registration → authorize → consent → `aud`
binding → RS validation → cross-audience refusal — is reviewed as one unit by ADR 0039
D5's single adversarial + `security-review`, owned by ADR 0029's gate.** This ADR's
skeleton is explicitly *pre-review*: it must not be wired to a live `/authorize`.

### Sequencing (slots into ADR 0029's phases, gated by 0039)

This is **ADR 0029 Phase 3** ("Discovery + the chosen client-registration mechanism") made
concrete, and it inherits every upstream gate:

0. ADR 0029 **Phase 0 crypto spike** must pass; the AS chain (`OC-1→OC-2→AS-0→…`) and the
   `AS-0 ← OC-2` social-provider coupling (ADR 0039) stand. **Nothing here is buildable
   before the AS token core exists** — this is the registration *front door* of an AS that
   does not yet mint tokens.
1. **CIMD resolver** (D2) — pure fetch + validate + cache; no store, no write endpoint. The
   safest mechanism ships first.
2. **DCR endpoint + client store** (D3) — config-gated, rate-limited, optional software
   statement; the persisted leg.
3. **Wire `resolveClient` into ADR 0029's `/authorize`** (D1) — the seam; pre-registration
   is the trivial third source.
4. **Discovery fields** (D5) + the `lesto add mcp-auth` scaffold (ADR 0039 D1) advertising
   the enabled mechanisms.
5. **ADR 0039 D5 end-to-end security review** — **blocks** the dogfood (it *reviews* the
   flow; the dogfood *exercises* it).

## Non-goals

- **No new crypto, token format, or JWKS** — ADR 0029 owns all of it; the software-statement
  verify reuses ADR 0030's `jose` helper.
- **No new authorization-server decision** — `/authorize`, `/token`, consent, PKCE, the
  exact-`redirect_uri` rule, RFC 8707 `aud` binding are ADR 0029's, consumed unchanged.
- **No RFC 7592 client-configuration management** (`GET/PUT/DELETE /register/:id`) — DCR
  records are immutable for the first cut; rotation is re-registration.
- **No confidential clients / `client_secret` issuance** by default — MCP clients are
  public; PKCE `S256` is the proof. The shape leaves room but the default mints none.
- **No OIDC ID tokens, SCIM, or SAML** (carried from ADR 0029 non-goals).
- **Not shippable from this ADR.** The `packages/oauth-server/` skeleton is a
  non-functional shape: no persistence, no real validation, no rate limiting, no fetch, a
  pending/skipped test. It exists to make the contract legible and to give the real build a
  typed target — not to be wired to anything.

## Reviews

Self-review against ADR 0029, ADR 0039, ADR 0028, the live RS contract
(`packages/mcp/src/http.ts`: `AccessTokenClaims`/`VerifyAccessToken`/`ProtectedResourceMetadata`),
and the MCP authorization spec (2025-11-25). Resulting positions:

- **Picked the mechanism ADR 0039 deferred** — CIMD-first (no write endpoint, no client
  store, the spec's direction) with DCR as a **config-gated, off-by-default** compatibility
  path for today's installed base, and pre-registration retained as the locked-down third
  option. ADR 0039 D2's posture is now a concrete, ordered design.
- **Kept `/authorize` ignorant of registration** via the `resolveClient` seam (one
  `RegisteredClient` shape, three sources) — mirroring how ADR 0028's `VerifyAccessToken`
  keeps the RS ignorant of the issuer. The downstream OAuth flow is untouched.
- **Separated registration from the `aud`/`resource` allow-list in writing** (D4) — open
  registration changes the *front door*, never the audience guard; a freshly-registered
  client still cannot get a token audienced at an arbitrary URL. The confused-deputy defense
  ADR 0029/0028 own is **not** widened.
- **Named the three new attack classes and their controls** (D6): registration spam (DCR
  off-by-default + rate limit + optional attested-DCR software statement); `redirect_uri`
  abuse (exact match, never dereferenced, PKCE); SSRF on the CIMD/software-statement fetch
  (public-address guard on every redirect hop + timeouts + caches). All inside ADR 0039
  D5's single end-to-end review.
- **Refuted "fold this into 0029/0039."** 0039 is sequencing and explicitly defers the
  mechanism; 0029's one-line clients bullet would bury the highest-risk new surface. A
  standalone, reviewable registration design is the point.
- **Marked it design-only.** The skeleton is non-functional by construction and must not be
  wired to a live `/authorize` before ADR 0039 D5's review — recorded so the bet stays
  explicit and the skeleton is never mistaken for shippable DCR.

## Consequences

- Closes the **biggest interop gap**: a real, unknown MCP client (Claude / Cursor / VS Code
  / ChatGPT / Inspector) can register with a first-party Lesto AS — CIMD if it speaks the
  forward mechanism, DCR if it speaks today's — without the owner pre-knowing it. The
  "zero external service" battery (ADR 0039) becomes reachable for the in-house AS leg.
- Adds an **attacker-writable surface (DCR)** and an **attacker-influenced outbound fetch
  (CIMD)** — the program's most dangerous new classes after token passthrough. Contained by
  off-by-default DCR + rate limits + optional attested-DCR, and a single SSRF guard on every
  fetch, all under ADR 0039 D5's one end-to-end review.
- Makes ADR 0029 §Discovery+clients and ADR 0039 D2 **concrete and consistent** (this ADR is
  referenced from both; 0029 amended in place).
- Ships **no runtime code** — a design ADR plus a non-functional `packages/oauth-server/`
  skeleton that encodes the shape. The remaining work to make it real is the full ADR 0029
  AS build (Phase 0 spike → token core → `/authorize`/`/token`) with this registration leg
  as its Phase 3; nothing here is shippable alone.
