---
"@lesto/webhooks": minor
---

Narrow `SecretResolverContext` — the secret resolver no longer receives the request `signature`.

A `SecretResolver`'s job is to select a tenant's secret from the request (typically a header), never to verify it — the engine owns the constant-time HMAC comparison. Exposing the exact `signature` being verified only invited misuse (non-constant-time comparison, or logging it). The resolver context is now `{ body, headers, timestamp }`; `timestamp` is retained for time-based key rotation.

**Migration.** A resolver that read `ctx.signature` must stop — it has no legitimate role in selecting a secret. `body`, `headers`, and `timestamp` are unchanged.

Also documents an existing caller footgun: `verifyRequest` throws on an unresolved tenant but returns `signature_mismatch` on a bad signature — mapping the two to distinguishable HTTP statuses turns tenant-existence into an oracle. Collapse them to one status for untrusted callers.
