---
"@lesto/runtime": patch
---

`staticCacheControl` now serves Vite/Rollup's default dash-separated content hashes as `immutable`, not `no-cache`.

`hasContentHash` matched only a dot-separated lowercase-hex hash (`name.4f3a9c2b.ext`), but Vite/Rollup's default emitted filename is dash-separated and mixed-case (`sqlite3-BqX9F35q.wasm`, `opfs-worker-BvJIRuxz.js`). So genuinely content-hashed wasm/JS chunks were served `cache-control: no-cache` and revalidated on every load — a ~939KB wasm paying a round-trip each time. The matcher now also recognizes the dash form: it inspects only the final dash-delimited segment before the extension and requires both a length gate (`[A-Za-z0-9_]{8,}`) and an entropy gate (a digit, or mixed case). That keeps the asymmetry safe for build output — a hand-named dash-word such as `opfs-worker.js` or `opfs-controller.js` still gets `no-cache` (a pure-lowercase word never reads as a hash), and a miss only costs a revalidation, never a wrong freeze of a bundler chunk. `hasContentHash` is shared by the docs/www static serving too, which sees the same win.

One residual to be aware of: the heuristic is name-shape only, so a **hand-named, mutable-in-place** file whose final segment happens to look like a hash — a digit-bearing or mixed-case run of ≥8 chars, e.g. `Report-Version12.pdf` or `data-Q3Final.csv` served from `public/` — would be frozen `immutable` and go stale until its URL changes. Bundler-emitted assets are content-hashed (safe by construction) and Lesto's own hand-named output is lowercase-kebab (below the entropy gate); the residual only bites arbitrary user `public/` files that adopt that shape. Version such URLs (or rename them) if they must stay mutable.
