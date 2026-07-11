---
"@lesto/web": minor
"@lesto/runtime": patch
"@lesto/cloudflare": patch
---

Add a multi-value query escape hatch so a repeated query key is no longer silently dropped.

`?tag=a&tag=b` used to collapse to `{ tag: "b" }` — last value wins — with no way to read the values that came before. `LestoRequest` now carries an optional `queryAll: Record<string, readonly string[]>` alongside the unchanged last-value `query`, and `Context` exposes `c.queries(name)`: every value a repeated key carried, in arrival order, or `[]` when the key is absent. `query` and `c.query(name)` are untouched (still last-wins), so this is purely additive. Both transports populate `queryAll` — the node runtime (`toLestoRequest`) and the Cloudflare edge adapter (`toFetchHandler`) — from the same `URLSearchParams` pass; a transport that hasn't populated it degrades `c.queries()` to the boxed single value rather than breaking. Both build `queryAll` on a null-prototype object (`Object.create(null)`), so a `?constructor=`/`?__proto__=` key is captured as ordinary data instead of triggering a prototype-pollution throw.

**Request headers are deliberately NOT given a `headerAll` twin.** A repeated *request* header arrives platform-folded on both runtimes (RFC 9110 §5.2 — the Workers `Headers` object comma-joins repeats, and node's `IncomingMessage.headers` discards all but one before dispatch), so a header multimap could not be honest on either transport. `c.header(name)` remains the single, folded value; see the `LestoRequest.headers` doc.
