# Workload contract

Every app under `apps/<framework>/` MUST serve these three routes and produce
**byte-identical** bodies. If two apps disagree on output, they are not doing the
same work and the comparison is void. The driver probes `/plaintext` for
readiness, then `verifyParity` (in `driver/run.ts`) fetches every workload from the
live server and asserts the **body, `Content-Type`, and `Content-Encoding`** all
match this contract before recording a single number — a mismatch fails that app
loudly rather than polluting the table.

The three workloads are the TechEmpower-style classics plus SSR, the one that
actually exercises a fullstack framework. The first three are TechEmpower-style
hello-worlds; `/realistic` is the credible one (a real page under real I/O):

## `GET /plaintext`

- `Content-Type: text/plain`
- Body, exactly: `Hello, World!`

## `GET /json`

- `Content-Type: application/json`
- Body, exactly (no whitespace): `{"message":"Hello, World!"}`

## `GET /ssr`

- `Content-Type: text/html`
- Server-render a **50-row list** into a minimal HTML document. Rows are
  zero-indexed: `item 0` … `item 49`.
- Body, exactly (a single line — no newlines, no indentation; the fences below are
  `text`, not `html`, so this is never pretty-printed away from the real bytes):

  ```text
  <!doctype html><html><head><title>Bench</title></head><body><div class="box">ROWS</div></body></html>
  ```

  where `ROWS` is the 50 rows concatenated with no separator, each row exactly:

  ```text
  <div class="row"><span class="cell">item N</span></div>
  ```

The canonical body is produced by `apps/_contract.mjs` (`ssrBody()`,
`jsonBody`, `plaintextBody`), which every Node/Bun app imports so the bytes are
defined in exactly one place. React/Preact/Svelte/etc. renderers must be
configured to emit this exact markup (no hydration markers, no data attributes —
this is a render-throughput test, not a hydration test).

## `GET /realistic`

The credible workload, per the Platformatic ["corrected results" SSR
benchmark](https://blog.platformatic.dev/ssr-framework-benchmarks-v2-corrected-results):
plaintext/JSON/50-row pages flatter raw routers and hide what a real fullstack
request costs. This mirrors a **personalized e-commerce catalog page**.

- `Content-Type: text/html`
- Behaviour, identical for every app (all import the helpers, so this is fair):
  1. `await simulateDbLatency()` — a single simulated DB round-trip of **1–5 ms**,
     drawn per request. Models real, uncached I/O; the per-request jitter averages
     out across a load run, so it doesn't inflate the trial-to-trial CV.
  2. Render the page **fresh on every request** — NO response caching, to mirror a
     page that is personalized and therefore uncacheable.
- Body, exactly: `realisticBody()` from `apps/_contract.mjs` — a complete catalog
  document (`<head>` with meta + stylesheet link; site header / nav / search; a grid
  of **`REALISTIC_PRODUCTS` = 24** product cards; footer), on a single line. Each
  card and product is a pure function of its index (`realisticProduct(i)` /
  `realisticCard(p)`), so the bytes are deterministic across frameworks and runs.

This deliberately does **not** dogfood the examples gallery: byte-identity across
five frameworks (and, when built, the meta-framework native renderers) is far
simpler to guarantee from a fixed contract function than from a wired-in app.

For the **server tier** (lesto/hono/fastify/express/elysia) the contract bytes are
served directly after the simulated latency — a clean HTTP-layer + async-handling
comparison. For the **meta tier** (when built — see `apps/<fw>/README.md`), native
SSR must emit these exact bytes, same as `/ssr`.

## Fairness rules

- **Production mode.** Every app runs its production build / production server
  (`NODE_ENV=production`), never a dev server with HMR.
- **Same machine, same run.** Numbers are only ever compared within a single
  `driver/run.ts` invocation. Never across machines or runs.
- **Median of N.** The driver records the median of `--runs` repetitions after a
  warmup, never the best.
- **Pinned versions.** Each app pins its framework version in its own
  `package.json`; `README.md` records the matrix every published number cites.
- **No app-specific tricks** that the framework wouldn't do for a real user
  (hand-rolled HTTP parsing, caching the response across requests, etc.).
