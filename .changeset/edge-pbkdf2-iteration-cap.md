---
"@lesto/auth": patch
"@lesto/identity": patch
---

Fix a P0 where **every** password hash threw on a deployed Cloudflare Worker (L-f0145c40) and close the local-green/prod-broken divergence that hid it (L-7a8faaf6).

The edge PBKDF2 hasher minted at 600,000 iterations, but workerd's WebCrypto hard-rejects any PBKDF2 derive above 100,000 (`cloudflare/workerd#1346`, not raisable by any compat flag) — and that limit gates verifying as well as minting. So on a deployed Worker every `register`/`login`/`reset` threw `NotSupportedError`: `identity.register` silently no-op'd and `identity.login` 500'd. It stayed hidden because Node's WebCrypto has no such cap, so the whole unit suite + a local one-origin e2e passed under Node while deployed auth was 100% broken — the single most trust-eroding failure mode.

- **`@lesto/auth`**: `hashPasswordWeb` now mints at `EDGE_MAX_ITERATIONS` (100,000) on **every** runtime — a `pbkdf2$…` hash exists to run on the edge, so it stays edge-runnable by construction (Node deployments keep memory-hard scrypt via the facade). New `hashPasswordWeb(password, { iterations })` override lets a caller lower the cost; asking for a non-positive/non-integer count, or anything above the ceiling, throws the new coded `AuthError` `AUTH_INVALID_ITERATIONS` at the mint boundary (loud, never a silent clamp) — which, because it fires on Node too, makes the ceiling testable without a real Worker. `verifyPasswordWeb` refuses a legacy/hybrid over-ceiling `pbkdf2$…` row on workerd with the same `AUTH_KDF_UNAVAILABLE` used for scrypt-on-edge (both un-derivable shapes now flow through one migration path); off the edge it verifies normally. `needsRehash` re-baselines to the pinned target so an edge-minted hash is never flagged stale (no re-hash-on-every-login loop) and a legacy 600k row walks *down* to 100k on the next login. New exports: `EDGE_MAX_ITERATIONS`, `HashPasswordWebOptions`, `isWorkerd`.
- **`@lesto/identity`**: no code change — `pbkdf2MigrationHasher` now produces genuinely edge-safe (100k) hashes automatically, so the migration preset no longer mints hashes the edge can't verify.
- **Docs**: `docs/guide/edge-password-migration.md` documents the 100k edge ceiling and adds over-ceiling `pbkdf2$…` rows to the drain query.

All additive and back-compat; existing Node scrypt behavior is unchanged.
