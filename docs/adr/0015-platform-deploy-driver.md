# ADR 0015 — Platform deploy is a thin, swappable driver (wrangler now)

- **Status:** Accepted
- **Date:** 2026-06-16

## Context

Keel generated a `wrangler.jsonc` (`@keel/cloudflare`'s `wranglerConfig`) and had
versioned-release machinery (`@keel/deploy`'s `shipRelease`/`rollback`, the local
`nodeReleaseStore`, and a real S3/R2 `remoteReleaseStore`) — but **nothing wired
them into a real deploy**: `keel deploy`'s dynamic-zone branch only *printed*
`"run keel serve (dynamic)"`, `wranglerConfig` had zero non-test callers, and
nothing anywhere invoked `wrangler deploy`. The framework could not ship a Worker
to a real target via its own CLI — the single largest gap to being a usable
product (the 2026-06-16 readiness review's #1 structural blocker).

The question was *how* `keel deploy` should reach Cloudflare. Three options:

1. **An IaC framework (Alchemy / SST).** A heavyweight external dependency that
   owns the whole infra model — neither in-house substrate nor a thin edge driver,
   and massive over-engineering for Keel's deliberately tiny resource surface (one
   Worker, one D1, static assets, two secrets). Rejected: it is the "zoo of
   external services" Keel exists to avoid, and it couples Keel's deploy identity
   to a third party's abstractions.
2. **A direct Cloudflare-API client (build our own).** Maximally in-house, and Keel
   is partway there (`remoteReleaseStore` already speaks S3 REST over `fetch` with
   in-house SigV4). But the Worker-script and Static-Assets *upload* protocols are
   non-trivial and Cloudflare-moving; reimplementing means chasing a target
   `wrangler` already tracks for free. High effort, high maintenance, little
   near-term benefit.
3. **The official `wrangler` CLI.** Always current (Cloudflare maintains it as the
   platform evolves), and the designed consumer of the `wrangler.jsonc` Keel
   already emits. A dev/CI binary dependency (like `git`), not a runtime one.

## Decision

Deploying to a specific platform is an **irreducible edge** — the platform owns the
upload protocol and it moves — exactly the category where Keel already chooses a
thin driver (mail transport, object storage, OAuth). So:

- **Use `wrangler` (option 3) now, behind a Keel-owned `CloudflareDeployer`
  interface** (`{ deploy(): { url? }, rollback() }`) injected into the CLI as a
  seam. The CLI core (`runDeploy` → `deployToCloudflare`) only ever sees the
  interface; the real `wrangler`-spawning impl lives in the coverage-excluded `bin`
  wiring, so the orchestration (build → deploy → health-gate → rollback-on-failure)
  is tested at 100% with an injected fake and no real binary.
- **Reject the IaC frameworks (option 1).**
- **Keep the direct-API client (option 2) as a deferred *implementation of the same
  interface*** — a drop-in the day the **agent control plane** needs binary-free
  programmatic deploy. The seam means that swap never touches `runDeploy`.

`keel deploy --cloudflare` builds the static output (so `wrangler` uploads fresh
assets), pushes the Worker + its bound Static Assets via the driver, then probes
`--health-url` (or the reported URL + `/readyz`) and **rolls back** on an unhealthy
result (`CLI_DEPLOY_UNHEALTHY`) rather than leaving a broken release live. With no
determinable URL the deploy still lands but the gate is skipped out loud.

## Consequences

- The framework can deploy a real Worker + assets to Cloudflare from its own CLI,
  health-gated, closing the readiness blocker's primary half.
- `wrangler` becomes a documented dev/CI dependency; the spawn + the post-deploy
  `fetch` are the irreducible edges, validated against a real account at deploy
  time (this repo's CI has no `wrangler` or Cloudflare credentials, so a *live*
  deploy is not exercised in CI — the tested contract is the gated orchestration).
- **Deferred (follow-ups), not in this slice:** wiring `wranglerConfig` into the
  deploy path to verify/emit `wrangler.jsonc` (needs a deploy-config surface); and
  a CLI-convention example exercising `keel deploy --cloudflare` end-to-end (the
  estate is in-process, so it deploys via its own `bun run deploy` = build +
  `wrangler deploy`). Wiring `remoteReleaseStore` into the CLI for a generic S3/R2
  *static* target — `keel deploy --release --bucket/--endpoint`, credentials from
  the environment — is now **done** (ADR 0017).
