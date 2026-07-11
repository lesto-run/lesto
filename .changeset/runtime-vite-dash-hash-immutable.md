---
"@lesto/runtime": patch
---

`staticCacheControl` now serves Vite/Rollup's default dash-separated content hashes as `immutable`, not `no-cache`.

`hasContentHash` matched only a dot-separated lowercase-hex hash (`name.4f3a9c2b.ext`), but Vite/Rollup's default emitted filename is dash-separated and mixed-case (`sqlite3-BqX9F35q.wasm`, `opfs-worker-BvJIRuxz.js`). So genuinely content-hashed wasm/JS chunks were served `cache-control: no-cache` and revalidated on every load — a ~939KB wasm paying a round-trip each time. The matcher now also recognizes the dash form: it inspects only the final dash-delimited segment before the extension and requires both a length gate (`[A-Za-z0-9_]{8,}`) and an entropy gate (a digit, or mixed case). That keeps the safe asymmetry — a hand-named dash-word such as `opfs-worker.js` or `opfs-controller.js` still gets `no-cache` (a pure-lowercase word never reads as a hash), so no legitimately-mutable URL is ever wrongly frozen; a miss only costs a revalidation. `hasContentHash` is shared by the docs/www static serving too, which sees the same win.
