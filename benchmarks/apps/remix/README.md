# React Router 7 (Remix) benchmark app — SCAFFOLD (not yet implemented)

Registered in `../../driver/apps.ts` with `status: "scaffold"` — the driver skips
it until built. Implement, flip to `"ready"`, done.

React Router 7 is the merged successor to Remix; build the framework-mode app
(the `@react-router/serve` / `@react-router/node` server).

## What to build

A minimal app serving the workload contract in `../../workloads.md` from a
**production** build:

- `app/routes/plaintext.ts` (resource route, `loader` returning a `Response`) →
  `Hello, World!` (`text/plain`)
- `app/routes/json.ts` (resource route) → `{"message":"Hello, World!"}`
  (`application/json`)
- `app/routes/ssr.tsx` rendering the 50-row list via the framework's native SSR.
  The body must match `ssrBody()` from `../_contract.mjs` — use a minimal
  `app/root.tsx` so no extra document chrome leaks in (or serve `/ssr` as a
  resource route that calls `renderToStaticMarkup`).

## Prepare + start (already wired in `apps.ts`)

```
prepare: npm install && npm run build
start:   npm run start         # react-router-serve ./build/server/index.js, honors $PORT
```

Pin the react-router versions and record them in `../../README.md`.
Tracked as a follow-up Studio task.
