---
"@lesto/auth": patch
"@lesto/identity": patch
---

Harden the runtime-adaptive password hasher shipped in 0.1.4 (post-review), fail-closed fixes with no behavior change for any hash the module actually mints:

- **PBKDF2 digest allow-list is now prototype-safe.** `parseStored` matched the digest tag with a bare object index, so a crafted tag naming an `Object.prototype` member (`pbkdf2$toString$…`, `pbkdf2$constructor$…`) resolved to a function instead of `undefined`, slipped past the "unknown digest" guard, and made `verifyPasswordWeb` **throw** (violating its documented "resolves `false`, never rejects" contract) instead of failing closed. Now guarded with `Object.hasOwn`.
- **scrypt verify rejects an over-cost `N`.** A well-formed hash with `N` above today's default (e.g. `scrypt$524288$…`) would exceed `maxmem` and make the derive throw; `parseStored` now rejects `N > DEFAULT_N` (a cost we never mint) so verification resolves `false` rather than rejecting.
- **Docs.** The facade now documents the cross-runtime caveat explicitly — a `scrypt$…` hash cannot be verified on the edge, so a migrated/hybrid DB must mint everything the edge reads with `hashPasswordWeb` (a first-class migration path is tracked separately) — and stale "scrypt-at-rest" references for recovery codes are corrected to the runtime-adaptive KDF.

Both are DB-corruption/DB-write-gated (an attacker who can write arbitrary hash strings already owns the row), so this is defense-in-depth, not a live vulnerability.
