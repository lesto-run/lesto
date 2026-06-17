# Keel — Beyond v1 (the road to best-in-the-world)

> **`docs/ROADMAP-V1.md` shipped: Waves 0–5 are done.** This document is what comes
> *after* — the plan to turn an unusually disciplined v1 codebase into a framework an
> outsider can actually adopt, whose pitch is true by default, and that wins on
> features against the incumbents. It is sourced from a code-grounded, adversarially
> verified deep-dive run **2026-06-17** (32 agents: 10 domain auditors reading the
> real source, 6 competitive-landscape reads, then adversarial verification of the
> riskiest claims against the tree).

The execution detail lives on the **Studio board** (repo `crack`, projects
`Keel · Adoption Unblock` / `Keel · Make the Claims True` / `Keel · Differentiators`)
— that board is the system of record; this doc is the rationale and the map. Where this
doc and the board disagree, the board wins (it's live).

---

## 1. The honest verdict (why this doc exists)

The deep-dive's one-line read: **Keel is an unusually disciplined engineering prototype
wearing a framework's marketing.** The per-package correctness is genuinely strong —
often *ahead* of the JS incumbents on a specific axis — but at the product level it is a
research prototype against production platforms, and three of its loudest differentiators
are overstated or absent. The decisive fact is not quality; it is **maturity**: 240
commits, single author, ~8 days, 58 private unpublished packages, and no LICENSE — so
today an outsider literally cannot `npm create keel-app`.

**Verified-strong (keep, lean on these as the defensible core):** the Node runtime core
(never-throw per-request boundary, body cap, handler-timeout abort, slow-loris socket
limits, SIGTERM drain — more out-of-box hardening than bare Express/Hono); the queue
(dialect-aware `FOR UPDATE SKIP LOCKED` + visibility reclaim + fenced completion, exactly-
once proven on real `postgres:16` in CI); the security primitives (scrypt fixed-keylen
fail-closed, dual CSRF immune to the content-type-bypass CVE class, webhook SSRF guard);
the coded-error backbone that makes Node+Cloudflare parity real; and live cross-driver
SQLite/Postgres parity in CI for the data layer.

**Overstated or absent (verified at file:line):** no ORM (`@keel/orm` deliberately
deleted — single-table query builder, `TEXT/INTEGER/REAL` only); browser→server tracing
(the named headline differentiator) **does not exist** (zero browser span emission; only
a PII-free island-failure beacon); no CMS editing UI; auth is a Rails-1.0 core (no
OAuth/2FA/passkeys/magic-link); edge-Postgres is overstated (`@keel/pg` is Node-only, zero
Hyperdrive; the D1 path works but only as estate example code); pubsub is in-process
memory (no realtime to the browser).

---

## 2. The plan — three milestones, in dependency order

The sequencing deliberately inverts the v1 framing the deep-dive flagged as backwards:
**you cannot be best-in-world if no one can legally install it (A) → the pitch must be
true (B) → then win on features (C).**

### A · Adoption Unblock — the hard stops (P1)

Make Keel legally adoptable and actually installable by a stranger. None of this was
tracked by the v1 roadmap.

| Task | Why |
|---|---|
| **Add a LICENSE** (`L-5d07b979`) | No `LICENSE` file and no `license` field anywhere → all-rights-reserved by default → legally un-adoptable. |
| **Release engineering** (`L-ff94be39`) | All 58 packages `private` at 0.0.0/0.1.0; no `.changeset`, no publish path; `create-keel` uses `file:` pins → `npm create keel-app` can't resolve for outsiders. Add Changesets + semver + a (dry-run-able) publish workflow; switch the scaffold to real ranges with a `file:`/`--local` dev fallback. |
| **Public docs site** (`L-5d64ad98`) | Internal ADRs are not user docs. Quickstart + battery pages (linking gallery examples) + a deploy runbook. |
| **OSS governance** (`L-7c36dc4d`) | No `SECURITY.md` / `CONTRIBUTING.md` / issue+PR templates — the contributor on-ramp + vuln-disclosure path the "platforms win via ecosystem" thesis needs. (Code of Conduct intentionally omitted.) |

### B · Make the Claims True — credibility (P2–P3)

Close the gaps between the pitch and the tree.

| Task | Gap (verified) |
|---|---|
| **Browser→server RUM tracing** (`L-235cceb2`) | ARCHITECTURE.md:122's "browser spans stitch to the server trace" is unimplemented. Build real RUM stitched to the server trace — or the claim must be deleted. |
| **First-party D1 adapter** (`L-a5e307a6`) | The D1 edge path works only via hand-rolled estate code (`examples/estate/src/d1.ts`); promote it into `@keel/db`/`@keel/cloudflare`. |
| **Edge-Postgres via Hyperdrive** (`L-3ada4c16`) | `@keel/pg` is Node-only, zero Hyperdrive; "SQLite local → Postgres scale" is Node-tier-only. |
| **Scaffold→deploy loop** (`L-b1fdb166`) | `create-keel` emits no deploy template; the `wrangler deploy` spawn is coverage-excluded/untested; default `keel deploy` still fs-copies. |
| **Live-Postgres full-app journey** (`L-75e4da63`) | CI proves PG installers, not a full app journey under one running process. |
| **Deployment-topology doc** (`L-3a4879b7`) | The real shape (Workers web tier + a long-running Node worker process + one Postgres) is never documented or wired; the single-instance scheduler contradicts "edge-first". |
| **Orphan cleanup** (`L-e6b90968`) | `packages/{config,hooks,rbac}` are still empty dirs and `CONVENTIONS.md:101` falsely claims `@keel/hooks` "100% coverage". |

### C · Differentiators — best-in-world (P2–P3)

Feature gaps vs Rails 8 / Laravel 12 / AdonisJS 6 / Astro / Next 16 / Supabase.

| Task | Gap |
|---|---|
| **Relational data layer** (`L-a0876b79`) | No relations/JOINs/FKs, only 3 column types. Forward design (ADR) — *not* a `@keel/orm` redux. |
| **Typed server-mutation primitive** (`L-31086005`) | Only raw HTTP + form POST; no Server-Actions-class typed mutation. |
| **Generators** (`L-308fd6a6`) | No `keel g model\|controller\|migration\|page\|island`. |
| **Client-side router** (`L-ebf5482f`) · **File-based routing** (`L-4edf8d68`) | No soft-nav, no file-route convention. |
| **Realtime to the browser** (`L-dd3cdca1`) | pubsub is in-process memory; build WebSocket/SSE fan-out on the planned LISTEN/NOTIFY. |
| **Auth factors** (`L-551e609f`) | 2FA/TOTP, passkeys/WebAuthn, magic-link (OAuth is already a roadmap deferral). |
| **Queue operator dashboard** (`L-b061a267`) | No Horizon/Mission-Control equivalent; no batches/deps. |
| **Type-regression suite** (`L-206e92c6`) · **Benchmark harness** (`L-911da95a`) | The type-flow differentiator is untested; "ahead of incumbents" has no numbers. |
| **App-builder AI primitives** (`L-dcdfeab2`) | No model layer / agent loop / RAG / evals — the mainstream meaning of "AI-native". Decide via ADR, then spike. |

---

## 3. Explicitly NOT re-planned here (already deferred post-1.0 by ROADMAP-V1.md)

To avoid duplicating planned areas, these stay owned by the v1 roadmap's "v1 is NOT"
list and ADR 0014, and are **not** Studio tasks here: workflows crash-safe resume,
`@keel/pubsub` LISTEN/NOTIFY transport, the plugin/extensibility system (ADR 0014), the
full assets substrate / `<Image>` (Bet II), the multi-instance cron scheduler, OAuth
providers, CSP-by-default/nonce, the Studio visual editing UI, RSC, and Redis drivers.
Where a task above builds on one of these (realtime → LISTEN/NOTIFY; client router →
Bet I), it depends on the planned item rather than re-scoping it.

---

## 4. The bar (unchanged from v1)

Every task ships to `CONVENTIONS.md`: strict TS, ESM, 100% vitest coverage on touched
non-preview packages, coded errors, truthful doc comments, and the green serial gate
(`bun run ws:typecheck` / `ws:lint` / `ws:format:check` / `bun scripts/coverage-gate.ts`).
A change that touches runtime behavior or surface is wired into `examples/estate` in the
same change. Commits land on `main`, conventional, with the standard `Co-Authored-By`
trailer.
