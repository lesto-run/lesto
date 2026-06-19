# Publish-day readiness tracker

The runbook for *how* a release happens is [RELEASING.md](../../RELEASING.md). This file
tracks *where we are against it* — verified status, the gaps the runbook doesn't yet name,
and the decisions that gate execution. Publish day is the deliberately-LAST structural phase
(per the project sequencing); this is the staging work that de-risks it.

Last verified: **2026-06-19** (against the post-Wave-3 tree).

## Gate 0 — names are free ✅ (was the blocker; now CLEARED)

RELEASING.md §0 (written 2026-06-17, pre-rename) says `create-lesto` / `lesto` are taken and
"publish day starts with a rename." **That is stale** — the Keel→Lesto rename already landed
(`@lesto` org secured) and a live registry check on 2026-06-19 returns `E404` (unclaimed) for
every name a publish would touch:

| name | `npm view … version` | verdict |
|------|----------------------|---------|
| `create-lesto` | `E404` | free |
| `lesto` | `E404` | free |
| `@lesto/cli`, `@lesto/db`, `@lesto/kernel`, `@lesto/runtime`, `@lesto/errors` | `E404` | free |

→ Re-run the full closure check on the morning of publish (names can be claimed by anyone
until we take them), but the rename gate itself is satisfied. RELEASING.md §0 updated to match.

## The published surface — the 28-package closure

Authoritative list in RELEASING.md. A `create-lesto` app's transitive `@lesto/*` closure is
**28 packages**; all must be public for an install to resolve. Everything else stays `private`.

### Closure readiness (verified counts, /28)

| metric | state | gap |
|--------|-------|-----|
| `private: true` | 28/28 | all 28 must drop it (first-release batch) |
| `version: 0.1.0` | 6/28 | 22 still `0.0.0` → bump to `0.1.0` |
| `publishConfig.access: public` | 5/28 | 23 missing (changeset config sets `access: public` globally, so this is belt-and-suspenders, but add it) |
| **`files` field** | **0/28** | **ALL missing — see hygiene gap below** |
| `repository` | 4/28 | and those 4 are **wrong** — see Docks-metadata gap |
| `main → ./dist/*` | 5/28 | **broken** — no `dist` build exists in the TS-direct model |

## Gaps the runbook doesn't yet name

### A. `files` field — every package would ship its tests to npm

No closure package declares `files`. A `npm pack --dry-run` on `@lesto/errors` ships
`test/errors.test.ts`, `test/result.test.ts`, `tsconfig.json`, and `vitest.config.ts` in the
tarball. Lesto runs TypeScript directly (exports point at `./src/index.ts`, no build step), so
the published package must include `src/` but **only** `src/` (+ the auto-included
`package.json`, `README`, `LICENSE`). Fix: add `"files": ["src"]` to each closure package as
part of the de-privatization batch. (RELEASING.md step 1 updated to require it.)

### B. content-\* carry foreign "Docks" metadata + a broken `dist` main

The `content-*` packages were re-badged from a separate **Docks** project and still carry its
publish metadata:

- `repository.url` → `git+https://github.com/usedocks/docks.git`, `homepage` →
  `https://usedocks.dev`, `author` → "Docks Contributors". These would publish **wrong repo
  links** on npm.
- `main`/`module`/`types` → `./dist/index.mjs` / `./dist/index.d.mts`. There is **no `dist`
  build** in the TS-direct model — `exports` correctly points at `./src`, but a consumer
  resolving via `main`/`types` (older tooling) would hit a missing file. Either drop the
  `dist` `main`/`module`/`types` (rely on `exports`) or add a real build for these.

→ Reconcile content-\* metadata to Lesto's repo + resolution model before they publish.

### C. No `repository` for the framework — repo URL unknown

There is **no git remote configured** and no `repository` field on the core packages, so the
canonical GitHub URL for `repository`/`homepage`/`bugs` is unknown. **Decision needed** (see
below) — this blocks filling correct provenance/repo metadata.

## Already in good shape ✅

- Release pipeline armed-but-dormant: `.github/workflows/release.yml` gated on
  `RELEASE_ENABLED=='true'`, `id-token: write` + `NPM_CONFIG_PROVENANCE` for provenance.
- `.changeset/config.json` present, `access: public`, `baseBranch: main`.
- `RELEASING.md` runbook + this tracker.
- `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (MIT), issue/PR templates, `CODEOWNERS`.
- `create-lesto` resolves `@lesto/*` via an injected pin: published `^0.1.0` default,
  `file:` pins under `--local` (so `LESTO_DEP_RANGE` must satisfy the published minor).

## Execution checklist (the publish-day batch — gated on the decisions below)

1. [ ] Re-run the closure name-availability check (all `E404`).
2. [ ] Set `repository` / `homepage` / `bugs` from the chosen GitHub URL on every closure pkg.
3. [ ] For each of the 28 closure packages: drop `private`, set `version: 0.1.0`, add
       `publishConfig.access: public`, add `files: ["src"]`.
4. [ ] Reconcile content-\* metadata (gap B): remove the Docks repo/homepage/author + the
       `dist` `main`/`module`/`types`.
5. [ ] Decide preview trim: a hello-world app currently drags in `content-*` packages tagged
       PREVIEW in ARCHITECTURE.md (dependency-shape change, tracked separately).
6. [ ] Confirm `LESTO_DEP_RANGE` (`^0.1.0`) satisfies the published `0.1.0`.
7. [ ] Add the `bun pm pack` → scaffold-from-tarball → boot CI job (RELEASING.md §Verifying,
       "next increment").
8. [ ] `bun run version` (consume changesets) → commit.
9. [ ] Set `RELEASE_ENABLED=true` + add `NPM_TOKEN` secret → `bun run release` publishes with
       provenance. **(Irreversible — the explicit go.)**

## Decisions needed before the batch

- **GitHub repo URL** for `repository`/`homepage`/`bugs` (no remote is configured).
- **Go/no-go on running steps 2–4 now** (reversible — nothing publishes until step 9) vs
  staging them behind the explicit publish-day go.
- **Preview trim** (step 5): ship the preview `content-*` in the 1.0 closure, or narrow the
  supported surface first.
