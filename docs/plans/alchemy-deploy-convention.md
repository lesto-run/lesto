# Alchemy multi-resource deploy convention — plan

Derived from `docs/adr/0044-deploy-iac-convention-alchemy.md` (which rules). Adopts Alchemy
(`alchemy.run.ts`, TypeScript-as-IaC) as the deploy convention for the repo's **own**
multi-resource infrastructure — the cooperating-Worker examples and the live benchmark edge worker
— **beside** wrangler, never replacing `lesto deploy` (ADR 0015 stands). The two Alchemy examples
already exist (`examples/mcp-auth-openauth/alchemy.run.ts`, `examples/mcp-ops-console/alchemy.run.ts`,
commit `a9b589d`); this plan wires their missing shared state and extends the convention.

**The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; truthful doc comments; one
conventional commit on `main`. Deploy increments are DOCS/scripts, not shipped `@lesto/*` packages —
no coverage gate, but any touched package keeps its 100% bar. **No live Cloudflare mutation without
the adopt/`--dry-run` discipline in Inc2.**

## Increments (ordered)

1. **ADR + shared state backend on the two existing examples** — `[P0 | de-risks everything after]`
   Files: `docs/adr/0044-deploy-iac-convention-alchemy.md` (this ADR); `examples/mcp-auth-openauth/alchemy.run.ts` + `examples/mcp-ops-console/alchemy.run.ts` — wire a **Durable-Object-backed, same-account, per-app+stage** Alchemy state store (D5), replacing the default local gitignored `.alchemy/`. Verify Alchemy's exact current state-backend API against its live docs before pinning a name (do not commit an unverified API name). Stage from env (`ci`/`prod` in CI, `$USER` locally); CI auth is `CLOUDFLARE_API_TOKEN` + a CI-secret state passphrase, never `alchemy login`.
   The state passphrase is **ONE shared secret** across every adopting environment (identical in CI secrets + the team store), not a per-environment value — else a second machine reads the shared state but cannot decrypt the secrets in it, and the acceptance below is unsatisfiable.
   Acceptance: a **second machine or CI adopts the shared state** — deploys, then a *different* environment reads that state and cleanly `--destroy`s resources it did not create, with no orphan and no name collision.

2. **Migrate the benchmark edge worker; retire its wrangler config as *deploy authority only*** — `[P1 | simplest single-worker exercise]`
   Files: new `benchmarks/apps/lesto/alchemy.run.ts` (single edge Worker, no assets/D1 — matches the current `wrangler.jsonc`: `nodejs_compat`, observability off) so **Alchemy owns the deploy**. **Do NOT delete `benchmarks/apps/lesto/wrangler.jsonc`** — `start-edge.mjs` runs `wrangler dev --local` with `cwd` = the app dir and **no `--config` flag**, so that file IS the local edge loop's config; deleting it kills the driver's edge tier. Retire it as deploy authority (re-comment it *local-runtime config, deploy owned by alchemy.run.ts*, or generate it from the Alchemy Worker definition). **Drift guard:** compat date + flags must match between the two (or one generates the other) or the benchmark loses its apples-to-apples claim.
   **SAFETY:** Alchemy has **no state** for the already-`wrangler`-deployed `lesto-bench-edge` worker → a blind `bun alchemy.run.ts` can **orphan or duplicate** it. Use Alchemy's **adopt** path + **`--dry-run`** first (flag names **verified against Alchemy's live docs at implementation time** — the requirement is pinned, not the spelling), confirm Alchemy *takes over the existing resource* (not a second copy), and **never** run a blind `--destroy` against the live worker.
   Acceptance: `bun alchemy.run.ts` deploys/updates the *same* `lesto-bench-edge` resource (proven via `--dry-run` showing adopt, not create); the live edge tier still serves; **`start-edge.mjs` → live `workerd` still boots locally** after the retirement; `wrangler.jsonc` retained as local-runtime config.

3. **CI deploy job** — `[P1 | makes gallery-as-QA-gate's "it deploys" leg mechanical]`
   Files: a CI workflow step running `bun alchemy.run.ts` per migrated example, **gated on the D4 secrets** (`CLOUDFLARE_API_TOKEN` + state passphrase) so it skips-out-loud on forks/PRs without secrets.
   Acceptance: the deploy job runs green on `main` with secrets present and is cleanly skipped (not failed) without them; a per-wave "it deploys" check that no longer relies on a manual run.

**Never in scope:** `lesto deploy` / `packages/cloudflare/src/wrangler.ts` (ADR 0015 emitter);
`examples/estate`'s `wrangler deploy` dogfood path; `www/` + `site/` single-worker static deploys.

## Verified Alchemy API (resolved against the installed `alchemy@0.93.12`)

ADR 0044 deliberately left three surfaces as *verify-at-implementation-time* (D5's state-backend
name, and Inc2's `adopt` + `--dry-run` flag names). Resolved here against the **installed package's
own type declarations** — the authoritative source for the pinned `^0.93.x`, more reliable than the
docs site — so the eventual live implementation is turnkey. (The live-deploy *acceptance* of each
increment still gates completion; see "What still requires a live environment" below.)

- **D5 — shared state backend → `CloudflareStateStore` (from `alchemy/state`).** Its declaration
  (`node_modules/alchemy/lib/state/cloudflare-state-store.d.ts`) reads verbatim: *"A state store
  backed by a SQLite database in a Cloudflare Durable Object."* That is the **DO-backed, strongly
  consistent** store D5 requires (the R2/KV eventual-consistency options are explicitly rejected on
  the `c782e4e` / `L-35a55b2e` key-storm lesson). **Do NOT use the older `DOStateStore`** — in
  `0.93.x` it is `@deprecated` (it aliases `DOFSStateStore`) and its own deprecation note points to
  `CloudflareStateStore`. Wiring:

  ```ts
  import alchemy from "alchemy";
  import { CloudflareStateStore } from "alchemy/state";

  const app = await alchemy("lesto-mcp-ops-console", {
    // alchemy()'s options carry `stateStore?: StateStoreType`, where
    // `StateStoreType = (scope: Scope) => StateStore` (lib/state.d.ts).
    stateStore: (scope) => new CloudflareStateStore(scope),
  });
  ```

  Config surface (`CloudflareStateStoreOptions`): `stateToken?: Secret<string>` (default
  `process.env.ALCHEMY_STATE_TOKEN`) — its own doc note: *"You must use the same token for all
  deployments on your Cloudflare account."* That is **exactly ADR D4's ONE-shared-secret rule**, now
  confirmed as a first-class Alchemy constraint (not merely our convention). Plus `CloudflareApiOptions`
  (the `CLOUDFLARE_API_TOKEN` / account the state-service worker is provisioned in — same account as
  D4's deploy token), a `scriptName?` (default `"alchemy-state-service"` — the worker Alchemy stands
  up to host the state DO), and a `forceUpdate?` recovery escape hatch. Per-app+stage keying (D2/D5)
  is intrinsic: the store keys on `app.name` + `app.stage`.

- **Inc2 — `adopt`.** Two verified mechanisms: the **`Worker({ ..., adopt: true })` resource option**
  (`lib/cloudflare/worker.d.ts:132` — *"Whether to adopt the Worker if it already exists when
  creating"*) — the in-script form, preferred for the bench migration so adopt is declarative — **or**
  the **`alchemy deploy --adopt --force`** CLI flags (`--adopt` *"Adopt resources if they already
  exist … (requires --force)"*). Either makes Alchemy **take over** the existing `wrangler`-deployed
  `lesto-bench-edge` worker instead of duplicating it — the orphan/duplicate footgun ADR 0044 flags
  as its chief risk.

- **Inc2 — "`--dry-run`".** There is **no `--dry-run` flag** in `0.93.x`; the read-only preview is the
  **`alchemy run <entrypoint>`** subcommand (its help: *"run alchemy in read-only mode"* — it
  evaluates the program and reports the Create/Update/Delete plan while **applying nothing**). Run it
  first to confirm the bench migration reports **adopt, not create**, before any `alchemy deploy`.
  (State can also be inspected read-only with `alchemy state tree|list|get`.)

### What still requires a live environment (this sandbox cannot execute it)

Every increment's **acceptance** is a live-Cloudflare operation that cannot be run — or safely
run — from this sandbox (no live-mutation credential for a second machine, `wrangler dev` server
starts are blocked, and ADR 0044 forbids a blind deploy against the live bench worker):

- **Inc1 acceptance** — a *second machine / CI* adopts the shared `CloudflareStateStore` and cleanly
  `--destroy`s resources it did not create — is inherently multi-environment.
- **Inc2 acceptance** — `alchemy run` shows **adopt** (not create) against the live `lesto-bench-edge`
  worker, then the edge tier still serves and `start-edge.mjs` → `workerd` still boots — needs the
  live worker + a `wrangler dev` start.
- **Inc3 acceptance** — the secret-gated CI job runs green with `CLOUDFLARE_API_TOKEN` +
  `ALCHEMY_STATE_TOKEN` present and skips-out-loud without them — needs CI secrets.

The API above is pinned and turnkey; the implementation + live acceptance is a follow-up for an
environment with live Cloudflare access and a second machine.
