# Island Fast Refresh

The dev-loop DX gate for **island Fast Refresh** (DX-parity round 2, ADR 0011).

## What it shows

`lesto dev` normally full-page-reloads on every edit, which destroys in-page state
(scroll, form input, an island's `useState`). Install **`@lesto/island-dev`** (already a
`devDependency` here) and `lesto dev` instead stands up a Vite dev server with **Preact
Fast Refresh**: editing `app/islands/counter.tsx` re-renders the island **in place**,
preserving its `count`, with no reload.

This app is deliberately minimal — one page (`app/routes/page.tsx`) rendering one
interactive island (`app/islands/counter.tsx`). It uses the **Preact dialect**
(`ui.dialect: "preact"`), the scaffold default, so it exercises the exact path
`npm create lesto-app` produces (`@prefresh/vite` Fast Refresh, the `react` →
`preact/compat` island alias).

## How to run

```bash
bun install            # from the repo root, links the workspace packages
cd examples/island-fast-refresh
bun run dev            # lesto dev — open the printed URL
```

Click the **count** button a few times, then edit the button label in
`app/islands/counter.tsx` (e.g. change `count:` to `tally:`) and save. The label updates
and the count is preserved — no reload. Remove `@lesto/island-dev` from
`devDependencies` and the same edit triggers a full reload that resets the count: the
before/after contrast is the feature.

## How it's verified

The live, state-preserving Fast Refresh round-trip is proven in CI by
[`packages/e2e/island-fast-refresh.spec.ts`](../../packages/e2e/island-fast-refresh.spec.ts),
which boots this app under a real `lesto dev` and drives a real browser: it asserts the
island hydrates, the HMR WebSocket connects, and an edit to the island applies new code
while keeping `useState`. The pure config behind it (`@lesto/island-dev`) is unit- and
transform-tested at 100% coverage.
