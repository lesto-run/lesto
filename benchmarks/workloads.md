# Workload contract

Every app under `apps/<framework>/` MUST serve these three routes and produce
**byte-identical** bodies. If two apps disagree on output, they are not doing the
same work and the comparison is void. The driver probes `/plaintext` for
readiness, then `verifyParity` (in `driver/run.ts`) fetches every workload from the
live server and asserts the **body, `Content-Type`, and `Content-Encoding`** all
match this contract before recording a single number — a mismatch fails that app
loudly rather than polluting the table.

The three workloads are the TechEmpower-style classics plus SSR, the one that
actually exercises a fullstack framework:

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
