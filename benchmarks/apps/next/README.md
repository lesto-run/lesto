# Next.js benchmark app — SCAFFOLD (not yet implemented)

This app is registered in `../../driver/apps.ts` with `status: "scaffold"`, so the
driver **skips** it until the server below exists. Implement it, flip the status
to `"ready"`, and it joins the run.

## What to build

A minimal Next.js app (App Router) that serves the workload contract in
`../../workloads.md` from a **production** build:

- `app/plaintext/route.ts` → `Hello, World!` (`text/plain`)
- `app/json/route.ts` → `{"message":"Hello, World!"}` (`application/json`)
- `app/ssr/route.ts` **or** an RSC page at `app/ssr/page.tsx` that renders the
  50-row list. For a fair SSR comparison against the other meta-frameworks, use
  the framework's native server rendering (an RSC page), not a hand-built string.
  The emitted body must match `ssrBody()` from `../_contract.mjs` (no extra
  framework markup — strip the default `app/layout.tsx` chrome, or serve via a
  Route Handler that calls `renderToStaticMarkup`).
- `app/realistic/...` → the realistic catalog page (`text/html`), same mechanism as
  `/ssr`: `await simulateDbLatency()` then emit `realisticBody()` from
  `../_contract.mjs`, **re-rendered per request** (no caching). Native SSR must emit
  `realisticBody()` byte-for-byte (see `../../workloads.md`).

## Prepare + start (already wired in `apps.ts`)

```
prepare: npm install && npm run build
start:   npm run start        # next start, NODE_ENV=production, honors $PORT
```

Pin the Next version in `package.json` and record it in `../../README.md`'s
version matrix. Tracked as a follow-up Studio task (see the session notes).
