# SvelteKit benchmark app — SCAFFOLD (not yet implemented)

Registered in `../../driver/apps.ts` with `status: "scaffold"` — the driver skips
it until built. Implement, flip to `"ready"`, done.

## What to build

A minimal SvelteKit app on `@sveltejs/adapter-node`, serving the workload
contract in `../../workloads.md` from a **production** build:

- `src/routes/plaintext/+server.ts` → `Hello, World!` (`text/plain`)
- `src/routes/json/+server.ts` → `{"message":"Hello, World!"}` (`application/json`)
- `src/routes/ssr/+page.svelte` (+ `+page.server.ts` if needed) rendering the
  50-row list via SvelteKit's native SSR. The body must match `ssrBody()` from
  `../_contract.mjs` — set a bare `src/app.html` shell so no extra markup leaks
  in, or serve `/ssr` via a `+server.ts` that returns the rendered string.
- `src/routes/realistic/...` → the realistic catalog page (`text/html`), same
  mechanism as `/ssr`: `await simulateDbLatency()` then emit `realisticBody()` from
  `../_contract.mjs`, **re-rendered per request** (no caching). Native SSR must emit
  `realisticBody()` byte-for-byte (see `../../workloads.md`).

## Prepare + start (already wired in `apps.ts`)

```
prepare: npm install && npm run build      # adapter-node → build/
start:   node build/index.js               # honors $PORT
```

Pin the SvelteKit + adapter-node versions and record them in `../../README.md`.
Tracked as a follow-up Studio task.
