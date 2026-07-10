# Batteries publish — de-privatize the headline battery set (L-691e4e81)

**Status:** PREPARED (manifests de-privatized) — NOT published. The irreversible
first publish is OTP-gated and out of this task's scope (see §5).
**Date:** 2026-07-06 · **Decision owner:** chief architect (this task) · **Ratify before publish:** yes.

## Context

Lesto `0.1.2` is live on npm as the **35-package scaffold closure** (`@lesto/*`
minus batteries, plus `create-lesto`; 36 public dirs total). The launch narrative
("batteries-included") names 13 headline batteries that were **built + 100%-covered
but `private: true`** — so they are not installable, which blocks the launch post
(L-80ff5e22 ← claims-refresh L-e5068dc0). This task makes exactly that set
publishable and stops before the manual OTP bootstrap.

The repo's release model (`scripts/publish.mjs` + `scripts/lib/pack-public.mjs`):
the publishable set is **every `packages/*` whose `package.json` is not
`private: true`**, packed with `bun pm pack` (rewrites `workspace:*` → exact
version), published **dependency-first, fail-closed** via OIDC trusted publishing.
So **de-privatizing a manifest IS what adds it to the release** — no allow-list edit.

## 1. Chosen publish set — 13 headline batteries (de-privatized)

Every one is a battery the launch copy names, and its full runtime `@lesto/*`
closure is satisfied by the already-published 36 **or** by another package in this
set (§3 proves this with the repo's own logic).

| Package | Runtime `@lesto/*` deps | Rationale (one line) |
|---|---|---|
| `@lesto/cache` | — | Headline battery: TTL cache; zero `@lesto` deps. |
| `@lesto/i18n` | — | Headline battery: i18n core; pure, zero deps. |
| `@lesto/pubsub` | — | Headline battery: in-process pub/sub; also the dep of `realtime`. |
| `@lesto/feeds` | errors | Headline battery: RSS/Atom generation. |
| `@lesto/flags` | web | Headline battery: first-class feature flags. |
| `@lesto/forms` | errors, ui | Headline battery: schema-driven forms. |
| `@lesto/workflows` | errors | Headline battery: resumable step memoization (scope caveat is in its own description). |
| `@lesto/webhooks` | errors, queue | Headline battery: signed outbound + inbound verify. |
| `@lesto/admin` | authz, db, errors | Headline battery: admin CRUD over `@lesto/db`. |
| `@lesto/mail` | errors, queue | Headline battery; required dep of `mailing-lists`; **optional peer** of `identity` (relaxed post-prep — see §7). |
| `@lesto/mailing-lists` | db, errors, **mail**, migrate, queue | Headline battery: double opt-in + broadcasts. |
| `@lesto/identity` | auth, db, errors, migrate, ratelimit (**mail** = optional peer, caller-wired) | Headline battery: batteries-included auth. |
| `@lesto/realtime` | **pubsub**, web | Headline battery: cross-process bus + SSE fan-out (ADR 0040). |

All are `MIT`, `type:module`, TS-source-shipped (`exports → ./src/*.ts`,
`files:["src"]`), matching the `@lesto/db`/`@lesto/queue` reference shape.

## 2. Excluded set — stays private for THIS wave (one line each)

Closure does not force any of these (no published package depends on them — §3), so
excluding them ships nothing broken. Each is deferrable to a later coordinated wave.

| Package | Why excluded now |
|---|---|
| `lesto-e2e` | Internal E2E harness; no `exports`. Never a user install. |
| `@lesto/integration` | Internal cross-package integration test harness; no `exports`. |
| `@lesto/bench` | Internal benchmark harness. Not a user-facing battery. |
| `@lesto/oauth-server` | **INTERIM** issuer; a from-scratch `@lesto` AS is reopened (L-7e67b9e6). Publishing an interim = support-forever burden on something slated for replacement. Defer. Non-functional ADR-0041 skeleton — see `packages/oauth-server/README.md` for why it stays private. |
| `@lesto/ai` | Not a named battery; ADR 0033 Phase-1 maturity; agent-native redaction residual still open pre-launch (L-570cf908). Defer to the agent-native wave. |
| `@lesto/client` | Contract-typed fetch client — genuinely user-facing, but not a named battery and still `v0.0.0`. Strong candidate for the **next** wave, not this one. |
| `@lesto/ui-kit`, `@lesto/ui-generate` | UI kit / generation atop published `@lesto/ui`; belongs to the Tailwind/shadcn epic (TW8 in flight), not the batteries launch. |
| `@lesto/live`, `@lesto/live-protocol`, `@lesto/live-server` | Tier-4 local-first sync ("the moat"). A headline **differentiator**, not a "battery." `live-server` carries a data-corruption hazard if misconfigured (single-writer slot; `--ha=false`). Publish only as its own hardened wave. |
| `@lesto/content-components`, `content-lint`, `content-mcp`, `content-mdx`, `content-prose`, `content-query`, `content-seo`, `content-vite` | The content subsystem; `content-core`'s own manifest labels these siblings **PREVIEW**. The published content closure (`content-core`/`-shared`/`-markdown`/`-search`/`-embeddings`/`-store`/`-umbra`) is already self-consistent without them. Ship as a coherent content wave (they're on the `0.1.0` line, a different version cadence). |

## 3. Closure consistency + topological publish order

Verified by running the repo's **own** logic (not the packer):
`readPublicPackageDirs` + `lestoWorkspaceDeps` + `topoSortPackages`.

- Public package count after de-privatizing: **36 → 49**.
- **Closure blockers: NONE.** Every runtime `@lesto/*` dep of every public package
  resolves within the public set. The only hard intra-new-set edges are
  `mailing-lists → mail`, `realtime → pubsub` — both satisfied. (`identity → mail`
  was relaxed post-prep to an *optional* peer, so it's no longer a hard ordering
  constraint — see §7.)
- `peerDependencies` are (correctly) irrelevant to ordering: `publish.mjs` omits peers
  by design, and every `@lesto/*` peer in the public set is optional and resolves from
  the registry (post-prep, `identity` carries an optional `@lesto/mail` peer — still
  irrelevant to ordering, still resolves from the set).

**New-set relative publish order (dependency-first)** — the full-closure topo sort
interleaves these with the other 48 `@lesto/*` packages. ⚠️ Because every `@lesto/*`
is in one changeset `fixed` group (§5.1), the previously-published 36 do NOT "skip" —
they re-version to the same new line (e.g. `0.1.3`) and **republish** alongside the 13.
The safety-relevant intra-new-set constraints are `mailing-lists → mail` and
`realtime → pubsub` (`identity`'s mail edge is now an optional peer — no longer an
ordering constraint):

```
admin → cache → feeds → flags → forms → i18n → mail → identity
      → mailing-lists → pubsub → realtime → webhooks → workflows
```

(admin/cache/feeds/flags/forms/i18n/webhooks/workflows have no intra-new-set deps,
so their relative position is free; the constraints that matter hold.)

## 4. NEW-package OTP-bootstrap list

**All 13 are NEW** (were `private` at `v0.0.0` → never on the registry). Under OIDC
trusted publishing a package that does not yet exist **403s**, and there is no
trusted-publisher config for it. So **every one of the 13** needs the manual
token+OTP first publish before OIDC/CI can ever publish it:

```
@lesto/admin  @lesto/cache  @lesto/feeds  @lesto/flags  @lesto/forms
@lesto/i18n   @lesto/mail   @lesto/identity  @lesto/mailing-lists
@lesto/pubsub @lesto/realtime  @lesto/webhooks  @lesto/workflows
```

Because the release is fail-closed and dependency-first, a naive CI/OIDC run would
403 at the **first** new package it reaches (`admin`) and ship nothing — the manual
bootstrap of all 13 must happen first.

## 5. EXACT remaining OTP-gated steps (for the release owner — NOT done here)

1. **Bump versions first (REQUIRED).** All 13 are `v0.0.0`; publishing as-is is now
   blocked by the `assertVersionsBumped` guard (§7). Run `bun run version`
   (`changeset version`). ⚠️ **This repo puts every `@lesto/*` + `create-lesto` in ONE
   changeset `fixed` group** (`.changeset/config.json`), so the bump moves the ENTIRE
   public workspace — all 49 packages, the 36 already-published AND the 13 — to the same
   next line (e.g. `0.1.3`). You **cannot** scope it to just the 13, and you **must not**
   hand-edit the 36 back to `0.1.2` afterward — that desyncs the fixed group, the exact
   harm the guard warns about. The batteries launch is inherently a coordinated `0.1.3`
   release of the whole workspace. *(Deliberately not done in this prep task.)*
2. **Manual first publish (creates the packages + is OTP-gated).** Recommended path
   is the repo's own release script, run locally with a maintainer `npm login` +
   OTP — it packs with bun (rewriting `workspace:*`), publishes **dependency-first,
   fail-closed**, over the full public closure. At the bumped `0.1.3` line the 36
   previously-published packages **republish at `0.1.3`** (only a rerun at an
   *unchanged* version skips); the 13 publish for the first time (OTP-gated):
   ```
   npm login                      # a @lesto-org maintainer account
   export NPM_CONFIG_OTP=<code>   # or answer the interactive OTP prompt
   bun run release                # scripts/publish.mjs — packs + publishes the full public closure
   ```
   Do **not** `npm publish` from a package dir directly — npm would upload the literal
   `workspace:*` (`EUNSUPPORTEDPROTOCOL`). Per-package fallback if the script path is
   unavailable: `cd packages/<pkg> && bun pm pack --destination <vendor>` then
   `npm publish <vendor>/<tgz> --access public --otp=<code>`, done in the §3 order.
3. **Configure a trusted publisher for each of the 13** on npmjs.com (owner
   `lesto-run`, repo `lesto`, workflow `release.yml`) so future releases authenticate
   via OIDC with no token.
4. **Subsequent releases** run through CI (`.github/workflows/release.yml`,
   `workflow_dispatch`) via OIDC only — no token, no `.npmrc`.
5. **Only after publish** update the launch copy / claims (unblocks L-80ff5e22 via
   L-e5068dc0) and clear the `batteries-built-not-published` dragon.

## 6. Risks & things to ratify

- **Support-forever.** Publishing 13 packages is a permanent public-API commitment.
  `workflows` (not crash-safe durable execution) and `realtime`/`pubsub` (v0) are the
  least-settled; their maturity caveats live in their own descriptions — keep them.
- **`v0.0.0` (biggest risk).** Must be bumped (§5.1) before publish or they ship as
  `0.0.0`. This is the single most likely foot-gun. **Post-prep:** `publish.mjs` now
  has a fail-closed floor guard (`assertVersionsBumped`, commit `af1998b`) that refuses
  to publish any package at `0.0.0` — so a naive `bun run release` aborts instead of
  shipping placeholder versions. The bump is still required; the guard just makes
  forgetting it safe.
- **`@lesto/forms` react dep — CORRECTED post-prep.** The original flag ("forms is the
  odd one out; make react a peer like the rest of the UI story") rested on a wrong
  premise: `@lesto/ui` *and* `@lesto/web` (both already published) declare `react`/
  `react-dom` as regular `dependencies`; the edge Preact win is a **build-time alias**
  in `@lesto/assets`, not a peer. So forms-with-react-as-a-dep is *consistent* with the
  published stack, and flipping forms alone would be inconsistent + pointless
  (`forms → @lesto/ui → react` pulls react regardless). `react-dom` **was** a genuine
  bug — test-only, so moved to `devDependencies` (`d8e1119`). Whether the *whole* UI
  stack should move react→peer to avoid a double copy is a real but stack-wide question
  (**L-863b3f6f**, low) — **not** a batteries-publish gate.
- **`@lesto/identity` description** references `@lesto/csrf`, which is not in its
  `dependencies` (cosmetic doc drift, not a closure issue — left untouched, out of
  manifest-field scope).
- **No READMEs** on the 13 → bare npm pages. Non-blocking; nice-to-have before launch.
- **content-mdx peer (L-4395e2d9):** intentionally **NOT** re-added to
  `@lesto/content-core`. That re-add is conditional on publishing `@lesto/content-mdx`,
  which this wave excludes; `content-core` is left as-is (mdx stays a `devDependency`,
  only `zod` is an optional peer). Re-open when the content wave publishes `content-mdx`.

## Files changed by this task

- `packages/{admin,cache,feeds,flags,forms,i18n,identity,mail,mailing-lists,pubsub,realtime,webhooks,workflows}/package.json`
  — removed `private`, added `publishConfig.access:"public"`, `files:["src"]`,
  `repository` (+`directory`), `homepage`, `bugs` to match the `@lesto/db` reference.
- `docs/plans/batteries-publish.md` — this decision record.

## 7. Post-prep updates (2026-07-07, wrap-up + follow-up)

Landed after the initial prep (`43dc942`), clearing the pre-publish gate:

- **`d8e1119`** — `@lesto/forms`: `react-dom` was test-only → moved to `devDependencies`
  (phantom runtime dep removed). `react` stays a regular dep (consistent with published
  `@lesto/ui`/`@lesto/web`; see §6). Stack-wide react→peer question deferred to L-863b3f6f.
- **`af1998b`** — `scripts/publish.mjs` gained `assertVersionsBumped()`: a fail-closed
  floor that lists every package still at `0.0.0` and aborts *before* any pack/publish.
  (L-dbfcaed5.)
- **`@lesto/identity`** — `@lesto/mail` demoted from a hard `dependency` to an **optional
  peer** (identity never imports mail; the caller wires an adapter, `identity.ts:193`).
  Removes an unused forced install; relaxes the `identity → mail` ordering edge. (L-6428ed83.)

**Still gating the actual first publish (unchanged):** the coordinated version bump
(§5.1 — the `fixed` group bumps ALL 49 to the next line, e.g. `0.1.3`; it can NOT be
scoped to the 13), then the manual OTP bootstrap of the 13 NEW packages in §3 order,
then per-package trusted-publisher config (L-518d4388). Tracked on L-fe189047.
