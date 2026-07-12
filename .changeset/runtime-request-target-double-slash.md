---
"@lesto/runtime": patch
---

`parseRequestTarget` now rejects a request target whose RESOLVED pathname begins `//`, aligning the node server with the edge adapter.

Node's origin-form guard checked only the RAW target string for a `//` or `/\` prefix, so `GET /..//evil` — which begins `/..`, not `//` — slipped through and routed as pathname `//evil`, while the Cloudflare edge twin (which checks `url.pathname.startsWith("//")`) rejected it. That tier divergence is a path-confusion risk: a front proxy that ACL-matched the raw `/..//evil` while the app routes `//evil`. Node now also rejects when the resolved `url.pathname` starts with `//` (throwing the same `RUNTIME_INVALID_REQUEST_TARGET`), closing the divergence. Legitimate dot-segment paths like `/a/../b`, which normalize to a single-slash `/b`, still route.
