---
"@lesto/auth": patch
"@lesto/identity": patch
---

A first-class path for migrating an existing password database to the edge (L-5ecfb54e). The 0.1.4 edge-safe hasher covered greenfield edge apps; this covers apps that carry existing `scrypt$…` hashes (a Node→edge migration, or a hybrid Node-writes/edge-reads topology), where those hashes cannot be verified on a Workers isolate.

- **`@lesto/auth`**: `verifyPassword` now REFUSES a `scrypt$…` hash on a runtime that cannot run scrypt (the edge) — throwing a coded `AuthError` `AUTH_KDF_UNAVAILABLE` *before* touching the KDF, rather than attempting a ~128 MiB derive that would OOM-kill the whole isolate (an OOM is not a catchable error, so the refusal must happen at dispatch). PBKDF2 still verifies on every runtime; only scrypt-on-a-non-scrypt-host is refused. This also protects recovery-code verification (same code path).
- **`@lesto/identity`**: `login` catches that refusal and, keeping the branch timing- and shape-identical to a wrong password (one decoy derive, same penalty, same enumeration-quiet `login_failed`), returns a coded outcome selected by the new `IdentityOptions.onUnverifiableHash` — default `"invalid_credentials"` (enumeration-safe; recover via an out-of-band reset), opt-in `"require_reset"` (new `IDENTITY_PASSWORD_RESET_REQUIRED` for in-band reset UX, at the cost of an account-existence oracle). `verifyRecoveryCode` fails closed the same way.
- **`pbkdf2MigrationHasher`** (new export): a preset to wire on the still-live Node tier before cutover — it verifies existing scrypt hashes and re-mints them as PBKDF2 on each user's next login (convert-on-login), so the corpus drains to edge-safe hashes with no forced reset. Password hashes are one-way, so convert-on-login (or a reset) is the only way to migrate a hash — there is no offline batch conversion.
- **Docs**: `docs/guide/edge-password-migration.md` — the full reset-to-migrate runbook.

All additive and back-compat; existing Node behavior is unchanged.
