# MCP client registration reality matrix (MA-0 / L-9a2e839f)

- **Type:** Research spike (pure research — no code, no ADR edits). Feeds ADR 0041
  (open MCP client registration: CIMD-first + DCR-compat) and the chief-architect's
  AS-deferral ruling (this is **trigger T2**).
- **Date:** 2026-07-10 (launch-week). Sources verified against the 2025‑11‑25 MCP
  authorization spec and current client docs/issues; see **Sources**.
- **Question:** for the MCP clients people actually have installed, how does each one
  obtain OAuth client credentials against a *remote, OAuth-protected* MCP server today —
  and what does that force on Lesto's `lesto add mcp-auth` scaffold and on the
  wrap-OpenAuth-vs-build-AS decision?

## Bottom line (read this first)

1. **Which clients need DCR (the matrix's bottom line):** **Claude Code** (the Anthropic
   CLI agent) is **DCR-only with no fallback** — if the authorization server does not
   expose an RFC 7591 `registration_endpoint`, it hard-fails (`does not support dynamic
   client registration`). **Cursor**'s automatic path is DCR-only today (CIMD not
   shipped as of early 2026), though a qualified manual `mcp.json` escape hatch
   exists. Every *other* major client (Claude.ai / Desktop, ChatGPT,
   VS Code, MCP Inspector) **also speaks DCR** but additionally has a CIMD and/or
   manual-`client_id` escape hatch. So **DCR is the interop floor**; the only client that
   *cannot* be served any other way is Claude Code.
2. **Interim OpenAuth issuer, as-is:** connectable by **essentially none of them
   without manual glue**. OpenAuth 0.4.x exposes **no `/register` endpoint** and does
   **not** advertise `client_id_metadata_document_supported`, so a spec-compliant client
   discovers the AS metadata, finds *neither* CIMD nor DCR, and falls through to
   "prompt the user for a client_id." That path only exists on some clients, and even
   then OpenAuth's `aud = client_id` / no‑RFC‑8707 model breaks the audience guard for an
   unknown client. **Claude Code fails outright** (DCR-only, no fallback); **Cursor**'s
   automatic DCR path fails too, leaving only its qualified manual `mcp.json` escape hatch.
3. **Launch recommendation:** ship the scaffold with **DCR enabled at launch** (rate-limited,
   optional attested) **and** the **CIMD resolver**, with pre-registration as the third
   option — DCR is non-negotiable for the installed base, CIMD is the spec's forward path
   already usable by VS Code / ChatGPT / Inspector (and, reportedly, Claude.ai). **The single most important
   client to be connectable with is Claude Code**, because it is (a) the on-brand agent
   client for an "agent-native" framework and (b) the *only* client with **no** non-DCR
   path — it is the forcing function that makes DCR mandatory, not optional, for launch.
4. **T2 verdict:** **TRIGGERED.** The evidence says Lesto must **own the registration
   surface (a DCR `/register` endpoint, plus a CIMD resolver) regardless** of whether it
   wraps OpenAuth or builds a from-scratch AS — OpenAuth provides neither, and the
   installed base requires at least one. Wrapping OpenAuth does **not** buy you out of
   building the front door.

---

## 1. The matrix — how each client gets OAuth client credentials against a remote MCP server (as of 2026-07)

Columns: **DCR** = RFC 7591 dynamic client registration; **CIMD** = Client ID Metadata
Documents (`client_id` is an HTTPS URL); **Manual** = user pastes a pre-registered
`client_id`/secret; **None-yet** = no path.

| Client | DCR (RFC 7591) | CIMD | Manual pre-reg | Default / notes |
| --- | --- | --- | --- | --- |
| **Claude.ai + Claude Desktop** (custom connectors; also Cowork/mobile) | ✅ Yes | ⚠️ Reported (URL `client_id`) — re-verify against current Anthropic docs | ✅ Yes (client_id + optional secret in Settings; also "Anthropic-held credentials" via `mcp-review@anthropic.com`) | Tries CIMD/DCR first; manual added ~Jul 2025. Supports 3/26 **and** 6/18 auth spec. The **broadest** support of any client. |
| **Claude Code** (CLI agent) | ✅ **Only** DCR | ❌ Not yet | ❌ Not yet (open feature request) | **DCR-only, no fallback.** Fails with `Incompatible auth server: does not support dynamic client registration` if the AS lacks `/register`. Static-`client_id` + pre-registration are open GitHub issues (#52638, #38102). **The strictest client.** |
| **Cursor** | ✅ Yes (primary path) | ❌ Not shipped (requested, forum #148096, early 2026) | ~ Via `mcp.json` config; ships **pre-registered** `client_id`s with some big providers (e.g. Slack) | Automatic path is DCR-only; a qualified manual `mcp.json` escape hatch exists. CIMD "on the roadmap," not available. |
| **VS Code** (Copilot / MCP) | ✅ Yes (fallback) | ✅ **Yes — first client to ship CIMD**, stable ~Nov 2025 | ✅ Yes | Publishes its CIMD doc at `https://vscode.dev/oauth/client-metadata.json`. Prefers CIMD, falls back to DCR. |
| **ChatGPT** (Apps SDK / "apps", née connectors; renamed 2025-12-17) | ✅ Yes | ✅ Yes (**prioritized** when AS advertises it) | ✅ Yes ("predefined OAuth clients") | Priority: CIMD → DCR (app-creator can force DCR) → predefined. PKCE **S256 required**; `resource` param required. |
| **MCP Inspector** | ✅ Yes (official Inspector, via the MCP SDK auth) | ✅ In the MCPJam Inspector / OAuth Debugger variant | ✅ Yes (debugger lets you set client info) | A **debugging tool**: the popular MCPJam OAuth Debugger explicitly tests all three (pre-reg, DCR, CIMD). Treat as "supports whatever you point it at." |

### Spec-mandated runtime priority (what a fully-capable client does — 2025‑11‑25 §Client Registration Approaches)

1. Use **pre-registered** client info if it has it.
2. Use **CIMD** if the AS advertises `client_id_metadata_document_supported: true`.
3. Fall back to **DCR** if the AS advertises a `registration_endpoint`.
4. Otherwise **prompt the user** to enter client info.

So the AS's **advertised** capability is what steers a compliant client — a client will not
attempt CIMD against an AS that does not advertise it, and will not attempt DCR against an
AS with no `registration_endpoint`.

### Trajectory: CIMD vs DCR (where this is heading)

- **The spec flipped the default on 2025‑11‑25.** CIMD went to **SHOULD** ("Authorization
  servers and MCP clients **SHOULD** support OAuth Client ID Metadata Documents"); DCR was
  **downgraded SHOULD → MAY** ("**MAY** support ... included for backwards compatibility").
  DCR is **de-emphasized, not deprecated** — exactly the wording ADR 0039/0041 already use.
- **CIMD is the forward direction and it is real, not vaporware:** VS Code shipped it in
  stable (first mover, even ahead of the spec), ChatGPT prioritizes it, Claude.ai reportedly
  supports it, the MCPJam Inspector tests it. It removes the write endpoint, the unbounded client
  table, and the registration-spam surface — the structural win ADR 0041 D2 is built on.
- **But DCR is still the installed-base floor in mid-2026.** Server-side CIMD support lags
  badly: one survey found **only 3 of 78** tested MCP authorization servers supported CIMD
  (Stytch, WorkOS, Authlete). And the two most agent-shaped clients — **Claude Code** and
  **Cursor** — do **not** have CIMD yet. A launch that is CIMD-only strands them.
- **Net:** CIMD is the end-state (ADR 0041's directional bet is **validated**); DCR is the
  bridge you must still ship to connect the clients that exist today.

---

## 2. Implication for the shipped interim OpenAuth issuer (`examples/mcp-auth-openauth`)

**Verified against OpenAuth `master` source, not docs.** OpenAuth 0.4.x's issuer registers
exactly: `GET /authorize`, `POST /token`, `GET /.well-known/oauth-authorization-server`,
`GET /.well-known/jwks.json`, `GET /userinfo`, and per-provider routes. There is **no
`/register` route**, and its `oauth-authorization-server` metadata includes **neither
`registration_endpoint` nor `client_id_metadata_document_supported`**. `client_id` is
**arbitrary** (no client store — the app "makes one up"); the default `allow` accepts a
`redirect_uri` only on **localhost/127.0.0.1 or the issuer's own host**.

Mapped onto the matrix, against the shipped issuer *as-is*:

| Client | Result against OpenAuth interim issuer as-is |
| --- | --- |
| **Claude Code** | ❌ **Hard fail.** DCR-only; no `registration_endpoint` → `does not support dynamic client registration`. No workaround exists on the client. |
| **Cursor** | ❌ Fails the automatic DCR path; would need manual `mcp.json` client config, and then still hits the constraints below. |
| **Claude.ai / Desktop, ChatGPT, VS Code, Inspector** | ⚠️ **Only via manual `client_id` entry.** A compliant client sees no CIMD and no DCR advertised and falls to "prompt for client info." OpenAuth *will* accept an arbitrary pasted `client_id` (no store), so it can limp — **but** see the two blockers below. |

Two OpenAuth-model blockers even on the manual path, both flagged in the example README:

- **`aud = client_id`, no RFC 8707 resource indicators.** The 2025‑11‑25 spec makes the
  `resource` parameter a **MUST** for clients (VS Code, ChatGPT, Claude on 6/18+ all send
  it). OpenAuth ignores it and stamps `aud` = the client id. So the RS's expected audience
  must equal *that specific client_id* — impossible to pre-configure for an **unknown /
  user-chosen** client. The confused-deputy guard (`aud === resource`) cannot be wired
  generically for open clients; the example only works because it forces `resource = clientID`
  for one known client.
- **Default `allow` rejects cross-origin (web) redirect URIs.** OpenAuth's default permits
  only localhost or the issuer's own host. **Claude.ai and ChatGPT redirect to their own
  domains**, which the default `allow` refuses — so even the manual path needs a custom
  `allow` before a web client's callback is accepted.

**Conclusion for §2:** the interim OpenAuth issuer is a genuine *token issuer* for a
**known, hand-wired** client (which is exactly what the wedge demo proves), but it is **not
an interop target** for the open client ecosystem: it can serve **zero** of the six clients
*zero-config*, and the two most agent-native ones (Claude Code, Cursor) cannot connect at
all. It lacks precisely the surface ADR 0041 exists to build — a registration front door.

---

## 3. Recommendation for the `lesto add mcp-auth` scaffold (launch)

**Ship all three mechanisms, with DCR live at launch — do not treat DCR as an optional,
off-by-default afterthought for the scaffold.** Ordering by *connectability importance*:

1. **DCR (`/register`, RFC 7591) — enabled in the scaffold at launch.** This is the only
   mechanism that connects the installed base **zero-config**, and the *only* path for
   **Claude Code** and today's **Cursor**. Keep ADR 0041 D6's controls (hard per-IP +
   global rate limits, immutable records, optional signed software statement → attested
   DCR, redirect_uris stored-verbatim-never-dereferenced, exact match at `/authorize`).
2. **CIMD resolver — shipped alongside, advertised via `client_id_metadata_document_supported`.**
   It is the spec's SHOULD, structurally safest (no write endpoint), and **already works
   today** for VS Code, ChatGPT, and the Inspector (and, reportedly, Claude.ai). Advertising it lets those
   clients skip `/register` entirely — the best outcome per client, per the spec priority.
3. **Pre-registration — always available**, locked-down option for a known/fixed client.

**Single most important client to be connectable with: Claude Code.** Why: it is the
Anthropic flagship *agent* client — the exact "agent-native" user Lesto's wedge and GTM
target ("Batteries-included. Agent-native.") — and it is the **only** client in the matrix
with **no fallback**: no CIMD, no manual `client_id`, DCR-or-nothing. Every other client can
be coaxed onto Lesto some other way; Claude Code cannot. If the launch scaffold does not
expose a working `registration_endpoint`, the single most on-brand client silently cannot
connect. That makes DCR a **launch gate**, not a config toggle.

### Reconciliation with ADR 0041 / 0039

- **ADR 0041's CIMD-first directional bet is confirmed** by the reality — CIMD is the
  spec default and the shipping trajectory. Keep it as the end-state and build the CIMD
  resolver first for the safety reasons ADR 0041 §Sequencing gives.
- **One correction the reality forces:** ADR 0041 D3 has DCR **"off by default; the owner
  opts in."** For the **launch scaffold** that is too weak — the most important agent client
  (Claude Code) is DCR-or-nothing, so a CIMD-only / DCR-off default means the flagship agent
  cannot connect on day one. Recommendation: the scaffold should **default DCR on** (or make
  it a loud, first-class scaffold prompt with "on" as the recommended answer), while keeping
  the *library* default conservative. "CIMD-first" should govern *build order and
  preference*, not gate DCR *out of the launch artifact*.
- This does **not** re-open any ADR decision — it sharpens ADR 0041 D3's *scaffold default*
  and confirms ADR 0039 D2's "CIMD-preferred with a DCR compatibility path" was the right
  call, with the emphasis that the compatibility path is **required at launch**, not later.

---

## 4. Feeds-the-ruling: T2 (does Lesto own the registration surface regardless?)

**Verdict: T2 is TRIGGERED — yes, Lesto owns the registration surface either way.**

The chief-architect's AS-deferral ruling left open "wrap/recommend OpenAuth long-term vs.
build a from-scratch first-party AS" (ADR 0039 amendment 2026‑07‑02 / ADR 0029 amendment).
T2 asks whether the registration surface is unavoidable *regardless of that choice*. The
evidence says it is:

- **The installed base requires a registration surface.** DCR is the interop floor (Claude
  Code has no other path; Cursor none in practice), and CIMD is the SHOULD every compliant
  client checks for. A remote authenticated MCP server with *neither* advertised is
  reachable by no one zero-config.
- **Wrapping OpenAuth does not provide it.** OpenAuth 0.4.x has no `/register`, advertises
  no CIMD, has no client store, and its `aud = client_id` / no‑RFC‑8707 model can't serve an
  unknown client's audience. To make wrapped-OpenAuth connectable, Lesto would have to put
  **its own DCR endpoint + CIMD resolver + resource/`aud` mapping in front of / around**
  OpenAuth — i.e., build the very `packages/oauth-server` registration surface ADR 0041
  designs. The "just wrap OpenAuth" option therefore **does not avoid** the registration
  build; it only avoids the token-minting/JWKS core.
- **Building a from-scratch AS** obviously includes owning the registration surface too.

So the registration front door (DCR endpoint + CIMD resolver, feeding the `resolveClient`
seam) is a **fixed cost on both branches** of the AS-deferral ruling. It cannot be deferred
by choosing to wrap OpenAuth. This is a strike against treating "wrap OpenAuth" as a way to
sidestep the security-heaviest new surface: the *token core* can be borrowed, but the
*registration surface* — ADR 0041's highest-risk new attack class — must be Lesto's own on
every path. The MA-0 spike thus **hardens, not weakens**, ADR 0041's decision to build
`@lesto/oauth-server` as a real, reviewed registration surface.

---

## Sources

- MCP Authorization spec, 2025‑11‑25 (normative CIMD **SHOULD** / DCR **MAY** / RFC 9728
  **MUST** / RFC 8707 `resource` **MUST**; three registration approaches + priority order):
  https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- Aaron Parecki, "Client Registration and Enterprise Management in the November 2025 MCP
  Authorization Spec": https://aaronparecki.com/2025/11/25/1/mcp-authorization-spec-update
- WorkOS, "CIMD vs DCR: the new default for MCP client registration in 2025":
  https://workos.com/blog/mcp-client-registration-cimd-vs-dcr
- WorkOS, "Dynamic Client Registration (DCR) in MCP — what it is, why it exists, when to
  still use it": https://workos.com/blog/dynamic-client-registration-dcr-mcp-oauth
- Claude Code issue #52638 — "HTTP MCP servers with OAuth fail when auth server doesn't
  support dynamic client registration" (DCR-only, hard fail):
  https://github.com/anthropics/claude-code/issues/52638
- Claude Code issue #38102 — "MCP OAuth: does not support dynamic client registration":
  https://github.com/anthropics/claude-code/issues/38102
- Claude custom connectors / remote MCP (DCR + CIMD + manual + Anthropic-held credentials):
  https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers
  and https://sunpeak.ai/blogs/claude-connector-oauth-authentication/
- ChatGPT Apps SDK auth (CIMD prioritized, DCR, predefined clients, PKCE S256, `resource`):
  https://developers.openai.com/apps-sdk/build/auth
- VS Code CIMD support (first client to ship CIMD; `vscode.dev/oauth/client-metadata.json`):
  https://den.dev/blog/cimd-vs-code-mcp/ and https://den.dev/blog/mcp-november-authorization-spec/
- Cursor CIMD status (requested, not shipped early 2026): Cursor forum thread #148096
  https://forum.cursor.com/t/mcp-oauth-cimd-support-plans-and-timelines/148096 ; Cursor MCP
  auth overview: https://www.truefoundry.com/blog/mcp-authentication-in-cursor-oauth-api-keys-and-secure-configuration
- MCP Inspector / MCPJam OAuth Debugger (tests pre-reg, DCR, CIMD):
  https://docs.mcpjam.com/inspector/guided-oauth
- CIMD server-side adoption (3/78 tested AS: Stytch, WorkOS, Authlete):
  https://www.scalekit.com/blog/what-is-cimd
- OpenAuth issuer source (routes: `/authorize`, `/token`, `/.well-known/*`, `/userinfo`; no
  `/register`; arbitrary `client_id`; default `allow` = localhost/self host):
  https://github.com/openauthjs/openauth/blob/master/packages/openauth/src/issuer.ts
- Local grounding: `docs/adr/0041-open-mcp-client-registration.md`,
  `docs/adr/0039-mcp-auth-batteries-capstone.md`,
  `examples/mcp-auth-openauth/README.md` (OpenAuth 0.4.3: `aud = client_id`, no RFC 8707,
  no `scope` claim).
</content>
</invoke>
