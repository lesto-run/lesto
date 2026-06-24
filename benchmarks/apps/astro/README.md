# Astro benchmark app — SCAFFOLD (not yet implemented)

Registered in `../../driver/apps.ts` with `status: "scaffold"` — the driver skips
it until built. Implement, flip to `"ready"`, done.

## What to build

A minimal Astro app in **server (SSR) output** on `@astrojs/node` (standalone
mode), serving the workload contract in `../../workloads.md`:

- `src/pages/plaintext.ts` (endpoint) → `Hello, World!` (`text/plain`)
- `src/pages/json.ts` (endpoint) → `{"message":"Hello, World!"}` (`application/json`)
- `src/pages/ssr.astro` rendering the 50-row list via Astro SSR. The body must
  match `ssrBody()` from `../_contract.mjs` — keep the `.astro` page free of extra
  layout chrome so the emitted markup is exactly the contract document.

Note: Astro's strength is static/islands, so SSR throughput here is the relevant
(and fair) thing to measure for this workload.

## Prepare + start (already wired in `apps.ts`)

```
prepare: npm install && npm run build              # output: 'server', @astrojs/node standalone
start:   node ./dist/server/entry.mjs              # honors $PORT / HOST
```

Pin the Astro + @astrojs/node versions and record them in `../../README.md`.
Tracked as a follow-up Studio task.
