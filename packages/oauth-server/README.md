# @lesto/oauth-server

> **This is a non-functional design skeleton — not a working package.** It is
> `private: true`, `v0.0.0`, and **unpublished on purpose**. Every entry point
> throws `OAUTH_NOT_IMPLEMENTED`. There is no persistence, no crypto, no metadata
> fetch, no rate limiting, and no `redirect_uri` validation. **Do not wire it to a
> live `/authorize`, and do not treat it as shippable Dynamic Client
> Registration.**

What lives here is the *shape* of open MCP client registration
([ADR 0041](../../docs/adr/0041-open-mcp-client-registration.md)) — the
`resolveClient` seam, the `RegisteredClient` / `ClientMetadataDocument` /
`RegistrationConfig` types, and the stable error codes — encoded and typed so the
design is legible *before* the real Authorization Server build
([ADR 0029](../../docs/adr/0029-oauth-authorization-server.md), Phase 3) exists.
It is a design artifact a reviewer can read, not a dependency an app can install.

## What throws

Every export that does work is a `notImplemented` stub. Calling any of these
throws an `OAuthServerError` with code `OAUTH_NOT_IMPLEMENTED`:

- `createClientResolver(config)` — returns a `ResolveClient` you can *type*
  against, but invoking the returned function throws.
- `looksLikeCimdClientId(clientId)`
- `resolveCimdClient(clientId)`
- `registerDynamicClient(document, config)`
- `lookupRegisteredClient(clientId)`

The remaining exports are types (`RegisteredClient`, `ClientMetadataDocument`,
`RegistrationConfig`, `RegistrationSource`, `ResolveClient`) and the error surface
(`OAuthServerError`, `OAuthServerErrorCode`, `notImplemented`). The other codes
declared on `OAuthServerErrorCode` (`OAUTH_UNKNOWN_CLIENT`,
`OAUTH_INVALID_CLIENT_METADATA`, `OAUTH_CIMD_URL_REJECTED`,
`OAUTH_CIMD_IDENTITY_MISMATCH`, `OAUTH_DCR_DISABLED`,
`OAUTH_SOFTWARE_STATEMENT_REQUIRED`) are the *future* contract — declared up front
so callers can branch on them, not raised by any code today.

## Three different things people call "OAuth" — don't wire the wrong one

The word "OAuth" collapses three distinct roles. This package is only the third
one, and even that is not built. If you landed here looking for auth, you almost
certainly want one of the other two.

| You want… | Role | Where it lives | Status |
| --- | --- | --- | --- |
| Your app to **be an OAuth provider / token issuer** (mint tokens for MCP clients) | Authorization Server | [ADR 0029](../../docs/adr/0029-oauth-authorization-server.md) — this package's *eventual* role | **Deferred.** The interim real issuer today ships via **OpenAuth** — see [`examples/mcp-auth-openauth`](../../examples/mcp-auth-openauth). |
| **"Sign in with Google / GitHub"** (your app is the OAuth *client*) | OAuth client / social sign-in | [ADR 0030](../../docs/adr/0030-oauth-client-social-signin.md) — a **separate, unbuilt** battery | **Not built.** This is what most people asking for "OAuth" actually want. It is *not* in this package. |
| The **RFC 7591 client-registration shape** an AS accepts (CIMD / DCR / pre-reg) | Client registration | [ADR 0041](../../docs/adr/0041-open-mcp-client-registration.md) — *this* skeleton | **Skeleton only.** Non-functional; encodes the contract, throws on every call. |

## The real supported auth path today

For actual authentication in a Lesto app right now, use the auth batteries —
**email/password + TOTP two-factor**, working on both Node and the edge:

- **[`@lesto/identity`](../identity)** — the account lifecycle: register, verify
  email, login, password reset, TOTP enrollment and challenge.
- **[`@lesto/auth`](../auth)** — the primitives underneath: runtime-adaptive
  password hashing, TOTP, recovery codes, and the session stores.

See the [Auth battery docs](../../site/content/docs/batteries/auth.md). For an
authenticated **MCP** server specifically, the interim issuer path is
[`examples/mcp-auth-openauth`](../../examples/mcp-auth-openauth); the governance
model is documented under [MCP governance](../../site/content/docs/batteries/mcp-governance.md).

## Why it's here at all

A typed skeleton makes a security-sensitive design reviewable before it is
implemented: the seam that keeps `/authorize` ignorant of *how* a client
registered, the exact-match `redirect_uri` rule, the off-by-default DCR posture,
and the CIMD-vs-opaque-id dispatch are all legible in the source. The real build
lands in ADR 0029 Phase 3, gated on the ADR 0041 D6 security posture and ADR 0039
D5's single end-to-end security review. Publishing an interim would be a
support-forever burden on something slated for a from-scratch replacement, so it
stays private — see [`docs/plans/batteries-publish.md`](../../docs/plans/batteries-publish.md).
