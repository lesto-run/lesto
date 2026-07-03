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
