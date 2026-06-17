# Production-readiness log

Tracked by the `/readiness` skill. Each run scores the current tree 0–10 (calibrated,
not averaged — crash-safety/security/data weighted heavily), with the full breakdown in
the dated JSON beside this file.

| Date | Score | Δ | Top blocker | Next fruit |
|------|-------|---|-------------|-----------|
| 2026-06-09 | 4.5/10 | +2.5 (from 2.0) | async/Postgres unbuilt + security batteries wired into nothing | Set Node server timeouts (`server.ts`, S) |
| 2026-06-09 (run 2) | 5.5/10 | +1.0 (from 4.5) | async/Postgres unbuilt (sync `SqlDatabase`) — structural | Gate coverage in CI (S) |
| 2026-06-10 | 5.5/10 | +0.0 (flat from 5.5) | async/Postgres unbuilt (sync `SqlDatabase`) — structural | Wire a real readiness probe so `/readyz` stops lying (S) |
| 2026-06-10 (run 2, post async-merge) | 6.5/10 | +1.0 (from 5.5) | deploy is a non-atomic file copy + observability orphaned (no traces/metrics, `/readyz` lies) — structural | Reformat `@keel/db` (committed `oxfmt` regression) (S) |
| 2026-06-16 (post Waves 0–5) | 6.8/10 | +0.3 (from 6.5) | `keel deploy` is still a file copy (never invokes `wrangler deploy`; `remoteReleaseStore` unwired) + secure defaults opt-in, not kernel-enforced — structural | Add `server.maxConnections` cap (`server.ts`, S) |

## 2026-06-16 — 6.8/10 (post Waves 0–5; prev 6.5)

Calibrated, not averaged (dimension mean ≈7.6). The three heavily-weighted dimensions are now
genuinely strong on the clean tree: **crash-safety 2→8.5** (never-throwing per-request error
boundary, 1 MiB body cap, handler/socket/slow-loris timeouts, SIGTERM drain through the real CLI,
edge adapter at hardening parity; 118 server tests), **security-wiring 2→8** (real onion middleware
pipeline; every 2026-06-09 finding fixed at file:line — CSRF session-binding, CORS wildcard+creds
guard, SSRF-guarded webhooks, fail-closed scrypt, hashed-at-rest SQL sessions), **data-layer 3→9**
(sync ORM deleted; async `@keel/db` + real `@keel/pg` adapter, transactional cross-process-locked
migrations, fenced at-least-once queue). Also: framework-correctness 6→9, maturity/CI 2→6.5,
observability/deploy 3→6.5.

Why only +0.3 despite Waves 0–5: the structural ceilings the 6.5 run already named are still open.
**Three caps:** (1) `keel deploy` is verified to be a file copy — `remoteReleaseStore` has zero refs
in `cli/src`, `bin.ts` wires only fs stores, and nothing invokes `wrangler deploy`; (2) secure
defaults are opt-in — the kernel never injects `secureStack`, so an app that forgets `.use()` ships
with zero CSRF/CORS/rate-limit; (3) no live-Postgres integration journey and zero release engineering
(0/61 build scripts, no changeset/publish path, single author, ~1 week history).

Fruit ceiling: **~7.4**. Judge's call: **PIVOT** to a structural phase — real `keel deploy`
(remote store + `wrangler deploy` invoke + health-gated flip) and a kernel-enforced secure baseline
are the highest-leverage moves; they are unreachable by fruit.

## 2026-06-09 — 4.5/10 (baseline 2.0)

Phase-0 hardening (all 29 REVIEW findings) committed as `621fe4c`; CI added (`4349414`).

Dimension scores (before → now): crash-safety 2→6.5 · framework-correctness 2→8 · data-layer 2→5 · maturity/CI 2→5 · security-wiring 2→4.5 · observability/deploy 2→3.

Fruit ceiling: **~6.0** (reachable by ops/safety fruit alone). Past that, three structural
ceilings dominate: async/Postgres unbuilt, security pipeline unwired, `keel deploy` is a file copy.

## 2026-06-09 (run 2) — 5.5/10

After Tier 0 (`a1b84ac`), Keystone 1 binary/stream body (`b37438f`), and Tier 1.B pipeline +
ALS context + Tier 2 streaming SSR (`d730810`), plus the parallel track's `@keel/identity` and
cleanup. Full breakdown in `2026-06-09-run2.json`.

Dimension scores (orig → now): crash-safety 2→**8** · security-wiring 3→**7** · framework-correctness
5→**8** · maturity/CI 5→**6** · data-layer 3→**5.5** · observability/deploy 3→**5**.

Fruit ceiling: **~6.5**. The judge's call: do a half-day fruit pre-pass (coverage gate, binary-safe
uploader, edge IP context for rate-limit, queue parse guard, CI hygiene), then **PIVOT to a
structural phase** — the six biggest blockers (async/Postgres, real `keel deploy`, CF-edge hardening
parity, observability+metrics, RBAC/auth-middleware/DB-sessions, bus factor) are unreachable by fruit.
Highest-leverage structural move: **async data layer + Postgres adapter** (the sync `SqlDatabase`
interface is a breaking seam everything downstream calcifies against).
