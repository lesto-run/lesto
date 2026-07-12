---
"@lesto/identity": patch
---

Login-rehash now persists behind a compare-and-swap so it cannot silently revert a concurrent password reset.

The rehash-on-login seam re-mints a stale password hash and persists it. That write was unconditional, so a `resetPassword` landing in the ~one-KDF window between the login's hash read and the rehash write could be silently overwritten — undoing a security-motivated reset even though its session revocation had already taken effect. The persist now uses a compare-and-swap (`UPDATE ... WHERE passwordHash = <the hash the login verified against>`): if a reset changed the stored hash in that window the CAS matches nothing, the rehash is dropped (and simply retries on the next login), and the reset survives. `resetPassword` remains the authoritative single writer and stays unconditional.
