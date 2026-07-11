---
"@lesto/cors": patch
"@lesto/web": minor
---

CORS no longer lets a controller's `Vary` clobber the policy's `Vary: Origin`.

The CORS middleware folds its policy headers *under* the controller's response so the controller wins a same-name clash. Under a non-wildcard origin policy the middleware sets `Vary: Origin` — the signal that stops a shared cache from cross-serving one origin's `Access-Control-Allow-Origin` to another. But any controller that set its own `Vary` (e.g. `Vary: Cookie`) with the same casing replaced `Vary: Origin` outright, reopening exactly that cross-origin cache leak (the failure was casing-dependent, so it surfaced intermittently).

The merge now routes through `mergeHeaders`, which keeps controller-wins for every header except `Vary`: `Vary` is token-unioned (comma lists on both sides, deduped case-insensitively, first-seen casing and order preserved) into one canonical header, so a controller's `Vary` and the policy's `Vary: Origin` coexist. `Set-Cookie` continues to accumulate as a multimap; every other header is unchanged.

`mergeHeaders(under, over)` is now exported from `@lesto/web` — the transport-neutral header merge (Vary-union + Set-Cookie accumulation + controller-wins) that both `withSecurityHeaders` and the CORS middleware share.
