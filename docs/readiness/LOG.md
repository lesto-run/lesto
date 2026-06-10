# Production-readiness log

Tracked by the `/readiness` skill. Each run scores the current tree 0–10 (calibrated,
not averaged — crash-safety/security/data weighted heavily), with the full breakdown in
the dated JSON beside this file.

| Date | Score | Δ | Top blocker | Next fruit |
|------|-------|---|-------------|-----------|
| 2026-06-09 | 4.5/10 | +2.5 (from 2.0) | async/Postgres unbuilt + security batteries wired into nothing | Set Node server timeouts (`server.ts`, S) |
| 2026-06-09 (run 2) | 5.5/10 | +1.0 (from 4.5) | async/Postgres unbuilt (sync `SqlDatabase`) — structural | Gate coverage in CI (S) |
| 2026-06-10 | 5.5/10 | +0.0 (flat from 5.5) | async/Postgres unbuilt (sync `SqlDatabase`) — structural | Wire a real readiness probe so `/readyz` stops lying (S) |

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
