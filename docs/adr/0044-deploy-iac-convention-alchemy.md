# ADR 0044 — Multi-resource repo infrastructure deploys with Alchemy (TypeScript IaC) — a convention **beside** wrangler, not a replacement for `lesto deploy`

- **Status:** **Accepted** (2026-07-03, chief-architect governance panel — verdict *ratify with
  amendments*; the two working `alchemy.run.ts` files and ADR 0015's un-reversed scope both
  verified against the tree). A **convention** ADR for the repo's *own* infrastructure — the
  cooperating-Worker examples and the live benchmark edge worker — plus the one genuine open
  question it answers (the shared state backend). It introduces no new package and no new
  product surface; it **records and generalizes** the pattern already proven in
  `examples/mcp-auth-openauth/alchemy.run.ts` and `examples/mcp-ops-console/alchemy.run.ts`
  (commit `a9b589d`) and picks the missing piece those two files left implicit (where Alchemy
  keeps its state). **Three blocking amendments, now folded in:** (1) Inc2 retires
  `benchmarks/apps/lesto/wrangler.jsonc` as *deploy authority only* — it stays as the local
  `wrangler dev` config (`start-edge.mjs` has no `--config` flag), with a compat-drift guard and a
  "driver still boots locally" acceptance; (2) the state-encryption passphrase is **one shared
  secret** across all adopting environments (D4), or a second machine cannot decrypt the shared
  state; (3) the `adopt` + `--dry-run` CLI flag names are verify-at-implementation, same as D5's
  state-backend API name. **Lock-in discipline:** the Alchemy dep is pinned caret on a `0.x`
  (`^0.93.x` → patch-only); a minor/major bump is a deliberate, reviewed act, not an automatic
  update.
- **Implementation status (2026-07-03): IMPLEMENTED, proven live SINGLE-machine.** Inc1 (both
  examples on the DO-backed `CloudflareStateStore`; a live deploy→`--destroy` over the DO store, with
  zero local state — the literal *two-machine* adoption is argued-by-construction, not yet run) and
  Inc2 (the benchmark `lesto-bench-edge` worker adopted via `adopt: true`, `wrangler.jsonc` retired to
  deploy-authority-only + made the drift-guard source, `start-edge.mjs` → `workerd` re-verified) are
  done and live-verified. Inc3 (`.github/workflows/deploy-examples.yml`, secret-gated) is in place;
  its green-deploy path runs the first time `main` is pushed with both secrets present. Inc2 uncovered — and a
  fable chief-architect panel resolved — that the benchmark's zero-dep/non-workspace design had
  already been broken by Bun 1.3 isolated installs; the fix was to make `benchmarks/apps/lesto` a
  workspace member (byte-identical measured code, still outside every `@lesto/*` gate). Full record:
  `docs/plans/alchemy-deploy-convention.md` → "Status".
- **Date:** 2026-07-02.
- **Deciders:** tech lead + owner (authored under board task `L-ff24955f`).
- **Reconciles with / does NOT reverse — ADR 0015.** ADR 0015 rejected IaC frameworks
  (Alchemy/SST) for **`lesto deploy`** — the *product's* deploy battery — and chose `wrangler`
  behind the Lesto-owned `CloudflareDeployer` seam. **That decision stands and this ADR does not
  touch it.** ADR 0044 is a **different scope**: the repo's own multi-resource infrastructure —
  resource *graphs* (two cooperating Workers + a resolved cross-worker URL + a Durable Object
  namespace + a service binding) that `wrangler.jsonc`'s single-worker model cannot express and
  that `a9b589d` proved Alchemy handles. This ADR stands as an **amendment note to ADR 0015** so
  the word "standard" here does not silently contradict a ratified ADR — 0015's
  "Reject the IaC frameworks" bullet is cross-linked to this ADR in place.
- **Grounded in (seams audited 2026-07-02):** the proven pattern
  `examples/mcp-auth-openauth/alchemy.run.ts` + `examples/mcp-ops-console/alchemy.run.ts`
  (`a9b589d` — two `Worker(...)` resources, the issuer `url` resolved and passed into the RS's
  `OPENAUTH_ISSUER` binding, the `OPENAUTH_DO` `DurableObjectNamespace` declared inline, and the
  `ISSUER` **service binding** carrying the RS→issuer JWKS subrequest around CF error 1042); the
  injected-`fetch` seam `examples/mcp-auth-openauth/mcp/governance.ts:66` (`jwksFetch?: typeof
  fetch`, consumed at `:169-172` via `createOpenAuthVerifier`) that lets the byte-identical
  governance run against a service binding on the edge **or** a real external issuer under global
  `fetch`; the wrangler consumers to reconcile — the product emitter
  `packages/cloudflare/src/wrangler.ts` (behind `lesto deploy --cloudflare`), the reference config
  `examples/estate/wrangler.jsonc` + its `deploy` script, `www/` + `site/` (single-worker static
  sites), and the **live benchmark edge worker** `benchmarks/apps/lesto/wrangler.jsonc` +
  `start-edge.mjs` (live since `c15d3f7`). The DO-over-KV state lesson is the repo's own
  (`c782e4e` / `L-35a55b2e`).

## Context

**Scope, stated up front so it cannot be misread: this ADR is about the *repo's own*
multi-resource infrastructure — the example apps whose deploy is a graph of cooperating
Cloudflare resources, and the live benchmark edge worker — NOT about `lesto deploy`, the product's
deploy battery, which ADR 0015 settled on `wrangler` behind the `CloudflareDeployer` seam and
which this ADR leaves exactly as it is.**

ADR 0015 asked *how `lesto deploy` should reach Cloudflare* and, for a deliberately tiny per-app
resource surface (one Worker, one D1, static assets, two secrets), rejected an IaC framework as
"massive over-engineering" and "the zoo of external services Lesto exists to avoid," choosing the
official `wrangler` CLI behind a Lesto-owned seam. That reasoning is sound **for a single Worker**
and is not reopened.

But the repo itself has since grown deploys that are **not** a single Worker. The MCP-auth wedge
(ADR 0039) ships two examples whose deploy is an irreducible **resource graph**:

- **Worker A** — the OpenAuth issuer, with a **Durable Object** (`OpenAuthKeyStore`) holding its
  ES256 signing keys (a single DO on purpose: eventually-consistent CF-KV caused the JWKS
  key-storm, `c782e4e` / `L-35a55b2e`).
- **Worker B** — the Lesto MCP Resource Server, which must be handed **Worker A's deployed URL**
  as its `OPENAUTH_ISSUER` binding, and which must reach Worker A's JWKS through a **service
  binding** because a same-account `workers.dev → workers.dev` subrequest is refused (**Cloudflare
  error 1042**).

None of that fits `wrangler.jsonc`'s single-worker file. `wrangler.jsonc` cannot declare two
Workers, cannot resolve one Worker's post-deploy URL into another's binding, and has no native
way to express "bind Worker B to Worker A." The two examples solved it with **Alchemy**
(`alchemy.run.ts`, TypeScript-as-IaC): `const issuer = await Worker(...)` then
`bindings: { OPENAUTH_ISSUER: issuer.url, ISSUER: issuer }` — the resolved URL and the service
binding fall out of ordinary `await` and object literals. That pattern is **already merged and
proven** (`a9b589d`); this ADR ratifies it as the repo convention and closes the one thing it left
unspecified — where Alchemy stores its resource state — so a second machine or CI can adopt and
tear down the same resources without orphaning them.

The benchmark edge worker (`benchmarks/apps/lesto/`, live since `c15d3f7`) is the *simplest*
single-worker case and is the natural second migration — not because it needs a graph, but because
it is the low-risk exercise that proves the convention on a live, single-resource deploy before
anything harder rides on it.

## Decision

Adopt **Alchemy (`alchemy.run.ts`, TypeScript-as-IaC) as the deploy convention for the repo's own
multi-resource infrastructure**, beside — never replacing — `wrangler`. Six decisions:

### D1 — Placement + verbs: `alchemy.run.ts` at the example root, `bun` runs it

Each multi-resource deploy is a single `alchemy.run.ts` at the app/example root (already the
pattern for the two MCP examples). The verbs are:

- `bun alchemy.run.ts` — deploy the graph; **print the resolved resource URLs** (for the MCP-auth
  examples: issuer discovery, JWKS, the RS `/mcp` + `/.well-known/oauth-protected-resource` — those
  are the *example*, not the convention verb), so a human or CI can immediately probe the live
  resources.
- `bun alchemy.run.ts --destroy` — tear the graph down.
- **Best-effort warmups after `app.finalize()` are allowed** (the two examples prime OpenAuth's
  lazy ES256/RSA keygen with one sequential dance) — but a warmup failure must be caught and must
  **not** fail the deploy (`try/catch → console.warn`), exactly as `a9b589d` does. Warmups are a
  latency prime, never a correctness gate.

### D2 — Naming + stages: `alchemy("lesto-<example>")`, resources `${app.name}-${app.stage}-<role>`, stage from env

- The app is `alchemy("lesto-<example>")` (e.g. `lesto-mcp-auth-openauth`, `lesto-mcp-ops-console`).
- Each resource is named `` `${app.name}-${app.stage}-<role>` `` (e.g. `…-issuer`, `…-rs`) —
  already the pattern.
- **Stage is read from the environment**: in CI it is set explicitly (`ci`, `prod`); locally it
  defaults to `$USER`. Per-stage naming gives **isolation** — a developer's `$USER` stage and CI's
  `ci` stage deploy disjoint resources and cannot clobber each other, which is what makes a shared
  state backend (D5) safe to turn on.

### D3 — Service bindings are the law for same-account worker→worker, with an injected `fetch` seam in app code

Any same-account Worker→Worker call **must** go through a **service binding**, not a public
`workers.dev` URL — a same-account `workers.dev → workers.dev` subrequest is refused with
**Cloudflare error 1042**. Every future two-Worker example hits this; it is written down here so no
one rediscovers it. Correspondingly, **app code takes the cross-worker call as an injected `fetch`
seam** — the `jwksFetch?: typeof fetch` parameter in `mcp/governance.ts:66`, defaulted to global
`fetch`. The edge deploy passes the service-binding `fetch`; a Node run or a **real external
issuer** passes nothing and rides global `fetch`. The same governed code therefore runs unchanged
against a service binding *or* a genuine third-party endpoint — the seam is what keeps
"the issuer is config, the transport is a swap" (ADR 0039) true across substrates.

### D4 — CI auth: `CLOUDFLARE_API_TOKEN` in the environment, never `alchemy login` in CI

Locally, `bunx alchemy login` (one-time) is fine — Alchemy needs its own CF credentials, distinct
from wrangler's. **In CI, authentication is `CLOUDFLARE_API_TOKEN` in the environment** (an
interactive `alchemy login` cannot run in CI), plus a **password for Alchemy's state encryption**
(Alchemy encrypts secrets in its state under this passphrase). **That passphrase must be ONE shared
secret across every adopting environment — provisioned identically in CI secrets and the team
secret store — not a per-environment value** (panel-caught blocking amendment). Alchemy's state
secrets are encrypted under it, so Inc1's acceptance — a *different* machine reads the shared state
and `--destroy`s resources it did not create — is **unsatisfiable if each environment mints its
own passphrase**: the second machine could read the state records but not decrypt the secrets
within them. The API token's account is the account the state backend (D5) must live in — see D5.

Operationally, `ALCHEMY_STATE_TOKEN` is the **bearer credential** the `alchemy-state-service` worker
checks on every request — it is the worker's `STATE_TOKEN` binding, which only changes on a
`forceUpdate` deploy. So the token lives in three copies (worker binding, the local `~/.alchemy` file,
the CI secret) that must stay identical; changing one alone silently drifts and 401s. Rotating it is
scripted (`scripts/rotate-alchemy-state-token.ts`, gated behind `ALCHEMY_STATE_FORCE_UPDATE=1` in each
`alchemy.run.ts`) — see [docs/runbooks/rotate-alchemy-state-token.md](../runbooks/rotate-alchemy-state-token.md).
(NB: this bearer token is distinct from Alchemy's state-*encryption* passphrase `ALCHEMY_PASSWORD`,
which this repo does not currently set — see the follow-up on reconciling D4's encryption framing.)

### D5 — Shared state backend: a Durable-Object-backed store, keyed per app+stage (the open question, answered)

**The problem.** Alchemy's default local, gitignored `.alchemy/` state means CI and teammates
**cannot adopt or destroy each other's resources**: a resource deployed from one machine is
invisible to another, so a redeploy collides on the resource name and a `--destroy` from a machine
without the state cannot clean up — orphaned Workers accumulate. A repo-shared deploy convention
**requires** shared state.

**The decision.** Adopt an **Alchemy Cloudflare-hosted state backend in the same account the
`CLOUDFLARE_API_TOKEN` reaches**, keyed **per app + stage** (so D2's isolation carries into state:
`$USER` state and `ci` state stay separate). **Prefer a Durable-Object-backed state store** over
any R2/KV-class option, on this repo's own hard-won lesson: **eventually-consistent CF storage is
unviable for correctness-bearing shared state.** That is exactly the JWKS key-storm that forced the
issuer's keys off CF-KV and into a single Durable Object (`c782e4e` / `L-35a55b2e`) — deploy state
has the same shape (a read-modify-write on shared, correctness-bearing records where a stale read
orphans or double-creates a resource), so it earns the same strong-consistency answer.

**Verification caveat (do not pin an unverified name).** Alchemy's exact current state-backend API
(the concrete class/name for a DO-backed vs. R2/KV-backed store, and its configuration surface)
**must be verified against Alchemy's live documentation at implementation time** — this ADR fixes
the *requirement* (shared, same-account, strongly consistent, keyed per app+stage; DO-backed
preferred) and deliberately does **not** commit to an unverified Alchemy API name.

> **Resolved (2026-07-03, against the installed `alchemy@0.93.12`):** the store is
> **`CloudflareStateStore`** from `alchemy/state` — *"backed by a SQLite database in a Cloudflare
> Durable Object"* (the DO-backed, strongly-consistent store this D5 requires; the older
> `DOStateStore` is `@deprecated`). Wired via `alchemy(name, { stateStore: (scope) => new
> CloudflareStateStore(scope) })`; the one shared secret is its `stateToken` (default
> `ALCHEMY_STATE_TOKEN`), whose own doc note — *"You must use the same token for all deployments on
> your Cloudflare account"* — is exactly D4. Full findings + the remaining live-acceptance gate in
> `docs/plans/alchemy-deploy-convention.md` ("Verified Alchemy API").

### D6 — What stays on wrangler, what migrates (explicit, so nothing drifts silently)

**The principle behind the enumeration:** *user-path dogfoods never migrate* (estate, `www/`,
`site/` — their whole value is running the path users run), while *the repo's own ops
infrastructure migrates when Alchemy buys something wrangler can't — a resource graph, or
CI-deployability.* The bench worker is the one deliberate exception below: it has no graph, but it
migrates because it is repo-own infra where CI-deployability (Inc3) is the payoff. The list below
is that principle applied, not an ad-hoc enumeration.

**Stays on `wrangler` — unchanged by this ADR:**

- **`lesto deploy --cloudflare`** — the product deploy battery, ADR 0015, `wrangler` behind
  `CloudflareDeployer`. The `packages/cloudflare/src/wrangler.ts` emitter and its byte-identical
  round-trip test are untouched.
- **`examples/estate`** — it deliberately dogfoods the **user-facing** build + `wrangler deploy`
  path (`bun run build.ts && wrangler deploy`), and its `wrangler.jsonc` is the reference config
  the emitter regenerates byte-for-byte. It **should keep doing exactly that** — migrating it would
  throw away the dogfood of the very path users run.
- **`www/` and `site/`** — single-worker static sites (`lesto build && wrangler deploy`); no
  resource graph, so no reason to migrate. They stay on wrangler unless a future graph gives them
  one.
- **`wrangler dev` local loops** — the benchmark driver's `start-edge.mjs` boots local `workerd`
  via `wrangler dev --local` for its apples-to-apples edge throughput path; that local loop stays
  on wrangler (Alchemy is a *deploy* convention, not a local-runtime one).

**Migrates to Alchemy:**

- The **multi-resource example topologies** — already on Alchemy (`a9b589d`); D5 completes them by
  wiring the shared state backend.
- The **live benchmark edge worker** — its *deploy authority* only (the `wrangler.jsonc` stays as
  local-runtime config, Inc2), as the simplest single-worker exercise, after the state backend is
  proven (see *Migration sequencing*, and its safety warning).

## Migration sequencing

Three increments, ordered so the riskiest thing (shared state adoption) is de-risked first and
nothing touches a live resource blind. (This plan is also captured, for tracking, in
`docs/plans/alchemy-deploy-convention.md`.)

- **Inc1 — this ADR + wire the shared state backend into the two existing Alchemy examples.**
  Turn on the D5 DO-backed, same-account, per-app+stage state store for
  `examples/mcp-auth-openauth` and `examples/mcp-ops-console`. **Proven by a second machine (or CI)
  adopting the state** — deploying, then having a *different* environment read that same state and
  cleanly `--destroy` the resources it did not create. This increment de-risks everything after it:
  until shared state works, no migration is safe.
- **Inc2 — migrate the benchmark edge worker; retire its `wrangler.jsonc` as *deploy authority
  only*.** Author `benchmarks/apps/lesto/alchemy.run.ts` for the single edge Worker so **Alchemy
  owns the deploy**. **Do NOT delete `benchmarks/apps/lesto/wrangler.jsonc`** — `start-edge.mjs`
  spawns `wrangler dev --local` with `cwd` = the app dir and **no `--config` flag**, so that file
  *is* the local edge loop's config (`main: worker.ts`, `compatibility_date`, `nodejs_compat`,
  observability-off). Deleting it kills the driver's edge tier (the exact panel-caught
  contradiction with "the local loop is unaffected"). Instead: retire it as deploy authority —
  re-comment it as *local-runtime config, deploy owned by `alchemy.run.ts`* (or **generate** it
  from the Alchemy Worker definition — verify Alchemy's wrangler-json emission surface at
  implementation time). **Add a drift guard:** the compat date + flags must match between the two
  (or one must be generated from the other) — a benchmark whose local `workerd` config silently
  diverges from the deployed worker forfeits its apples-to-apples claim.
  **SAFETY (from red-team — put in the ADR so it is unmissable): Alchemy has NO state for the
  already-`wrangler`-deployed `lesto-bench-edge` worker, so a blind `bun alchemy.run.ts` can ORPHAN
  the existing resource or DUPLICATE it under a new name.** The migration **must** use Alchemy's
  **adopt** path and a **`--dry-run`** first, confirm that Alchemy *takes over the existing
  resource* rather than creating a second one, and **never** run a blind `--destroy` against a live
  or shared worker. The adopt + `--dry-run` **flag names are verify-at-implementation** against
  Alchemy's live docs (same caveat as D5's state-backend API) — the *requirement* is pinned, not
  the exact CLI spelling. **Acceptance additionally asserts the driver's edge tier still boots
  locally** (`start-edge.mjs` → live `workerd`) after the retirement.
  > **Resolved (2026-07-03, `alchemy@0.93.12`):** *adopt* is `Worker({ adopt: true })` (or `alchemy
  > deploy --adopt --force`); the *dry-run* preview is the **`alchemy run <entrypoint>`** read-only
  > subcommand (there is no `--dry-run` flag). Run `alchemy run` first to confirm it reports **adopt,
  > not create**. Details in `docs/plans/alchemy-deploy-convention.md`.
- **Inc3 — a CI deploy job.** `bun alchemy.run.ts` per migrated example, gated on the D4 secrets
  (`CLOUDFLARE_API_TOKEN` + the state passphrase) being present, so the job is skipped-out-loud on
  forks/PRs without secrets. This makes the **gallery-as-QA-gate**'s "it deploys" leg *mechanically
  checkable* per wave instead of a manual step.

**Never in scope:** touching `lesto deploy`, the `wrangler.ts` emitter, or `examples/estate`'s
wrangler path (D6).

## Non-goals

- **Not reversing ADR 0015.** `lesto deploy` stays `wrangler` behind `CloudflareDeployer`. This ADR
  does not make Alchemy the *product's* deployer for users' apps.
- **Not a new package or product surface.** `alchemy.run.ts` files are repo build/deploy scripts,
  not a shipped `@lesto/*` battery.
- **Not migrating single-worker static sites** (`www/`, `site/`) or the estate reference deploy —
  no resource graph, and estate's wrangler path is a deliberate dogfood.
- **Not a local-runtime convention.** `wrangler dev` / local `workerd` loops stay; Alchemy governs
  *deploy* of multi-resource graphs only.
- **Does not pin an Alchemy state-backend API name** — D5 fixes the requirement; the concrete
  Alchemy API is verified at implementation time.

## Rejected alternatives

1. **Keep everything on `wrangler.jsonc`.** A `wrangler.jsonc` **can** declare a `services`
   binding to a *named* worker — so the service-binding wiring alone is not the gap. The
   irreducible gaps are the ones `a9b589d` proved Alchemy handles and a single file cannot:
   **deploy ordering** across two Workers, **resolving one Worker's post-deploy URL into another's
   binding** (`OPENAUTH_ISSUER: issuer.url`), and **graph-scoped shared state + teardown**. A
   single-worker file for a multi-worker deploy graph is a non-starter on those three, even though
   it could name the service binding.
2. **Public `workers.dev` URLs for worker→worker calls instead of service bindings.** Refused by
   **Cloudflare error 1042** for same-account `workers.dev → workers.dev` subrequests. Service
   bindings (D3) are mandatory, with the injected-`fetch` seam preserving external-issuer parity.
3. **Alchemy's default local `.alchemy/` state.** Un-shareable: CI and teammates can neither adopt
   nor destroy each other's resources, so redeploys collide and `--destroy` orphans. A shared,
   same-account, strongly consistent backend (D5) is required for a repo convention.
4. **An R2/KV-backed shared state store.** Rejected in favor of a Durable-Object-backed store on the
   repo's own key-storm lesson (`c782e4e` / `L-35a55b2e`): eventually-consistent CF storage is
   unviable for correctness-bearing shared state, and deploy state (read-modify-write over shared
   resource records) is exactly that class.
5. **Adopt Alchemy for `lesto deploy` too (make it the product deployer).** Out of scope and
   contrary to ADR 0015's still-sound reasoning for a single-Worker product deploy. Recorded instead
   as a **deferred** option below, not a decision.
6. **Blind `bun alchemy.run.ts` to migrate the benchmark worker.** Would orphan or duplicate the
   already-`wrangler`-deployed resource (no Alchemy state for it). Inc2's adopt + `--dry-run`
   discipline is mandatory.

## Deferred (noted, not committed)

- **An Alchemy-backed `CloudflareDeployer`.** ADR 0015 already keeps its deployer a swappable seam
  and names a direct-API client as the deferred drop-in "the day the **agent control plane** needs
  binary-free programmatic deploy." An **Alchemy-backed** `CloudflareDeployer` is an equally clean
  drop-in behind that same seam if the agent control plane ever wants programmatic, binary-free
  deploys of *product* apps — the swap never touches `runDeploy`. **Noted here, not committed**;
  it does not reopen ADR 0015's decision.

## Consequences

- The repo gains **one documented convention** for its multi-resource deploys: `alchemy.run.ts` at
  the app root, `bun` to run it, per-app+stage naming, service bindings for worker→worker, and a
  shared DO-backed state backend — generalizing the already-proven `a9b589d` pattern.
- **ADR 0015 stands, now cross-linked**, so "Alchemy is the repo standard for graphs" and
  "`wrangler` is the product deploy battery" coexist without contradiction — the amendment note in
  0015 points here and scopes its IaC-rejection to `lesto deploy`.
- The **shared state backend (D5)** is the load-bearing new piece and its adoption by a second
  machine/CI is Inc1's acceptance — until it works, migrations are unsafe.
- **Cloudflare error 1042** and the injected-`fetch` seam are now written down (D3), so every future
  two-Worker example gets the service-binding + external-issuer-parity pattern for free instead of
  rediscovering the 1042 refusal.
- **gallery-as-QA-gate's "it deploys" leg becomes mechanically checkable** (Inc3), turning a manual
  per-wave step into a gated CI job.
- The chief operational risk is the **Inc2 orphan/duplicate footgun** — Alchemy has no state for the
  live `wrangler`-deployed benchmark worker — mitigated by the mandatory adopt + `--dry-run` +
  never-blind-`--destroy` discipline recorded in the sequencing section.
