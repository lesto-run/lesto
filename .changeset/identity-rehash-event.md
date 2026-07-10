---
"@lesto/identity": patch
---

Add a `password_rehashed` identity event so the rehash-on-login seam is auditable — including a strength REDUCTION (L-c6132828).

The rehash-on-login seam transparently re-mints a stale password hash on a successful login but emitted no `IdentityEvent`, so a change in hash strength was invisible to audit/monitoring. That matters now that `needsRehashWeb` flags any off-target iteration count (not just a below-target one): with `pbkdf2MigrationHasher` wired, a legacy 600k `pbkdf2$…` row is walked *down* to the 100k edge ceiling on login — correct during a migration, but a one-way ~6× reduction if the migration hasher is left wired on a non-migrating Node tier, silently degrading every strong login with no signal.

- New `IdentityEvent` variant `password_rehashed` (`userId`, `at`, `from`, `to`), emitted at the login rehash site **only when the new hash actually persists**. `from`/`to` are secret-free `PasswordHashCost` descriptors — algorithm + cost params (scrypt `n`/`r`/`p`, or pbkdf2 `iterations`), never the salt or derived key — so a monitor can tell an up-rehash from a strength-reducing down-rehash from the payload alone.
- New exported type `PasswordHashCost`.
- `resetPassword` is unchanged: it persists a *new* password (already signalled by `password_reset`), not a silent rehash of an unchanged credential, so it emits no `password_rehashed`.

Additive and back-compat; `patch` under 0.x lockstep versioning.
