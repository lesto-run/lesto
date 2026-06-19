# Production-readiness log

Tracked by the `/readiness` skill. Each run scores the current tree 0–10 (calibrated,
not averaged — crash-safety/security/data weighted heavily), with the full breakdown in
the dated JSON beside this file.

| Date | Score | Δ | Top blocker | Next fruit |
|------|-------|---|-------------|-----------|
| 2026-06-09 | 4.5/10 | +2.5 (from 2.0) | async/Postgres unbuilt + security batteries wired into nothing | Set Node server timeouts (`server.ts`, S) |
| 2026-06-09 (run 2) | 5.5/10 | +1.0 (from 4.5) | async/Postgres unbuilt (sync `SqlDatabase`) — structural | Gate coverage in CI (S) |
| 2026-06-10 | 5.5/10 | +0.0 (flat from 5.5) | async/Postgres unbuilt (sync `SqlDatabase`) — structural | Wire a real readiness probe so `/readyz` stops lying (S) |
| 2026-06-10 (run 2, post async-merge) | 6.5/10 | +1.0 (from 5.5) | deploy is a non-atomic file copy + observability orphaned (no traces/metrics, `/readyz` lies) — structural | Reformat `@lesto/db` (committed `oxfmt` regression) (S) |
| 2026-06-16 (post Waves 0–5) | 6.8/10 | +0.3 (from 6.5) | `lesto deploy` is still a file copy (never invokes `wrangler deploy`; `remoteReleaseStore` unwired) + secure defaults opt-in, not kernel-enforced — structural | Add `server.maxConnections` cap (`server.ts`, S) |
| 2026-06-18 (§C in-flight) | 7.3/10 | +0.5 (from 6.8) | Bus-factor-1 + unpublished 0.x (~10-day history) — structural; AND local 100%-gate non-reproducible (better-sqlite3 ABI 115-vs-127 → 71/71 db tests red off-CI) | Pin/rebuild native sqlite ABI so `ws:test` is green locally (`sqlite-drivers.ts` + root postinstall, S) |
| 2026-06-19 (§C W3 landed) | 8.3/10 | +1.0 (from 7.3) | Adoption-blocked: all 60 pkgs `private:true@0.0.0`, unpublished, bus-factor-1, ~10-day history — structural (publish-day) | Delete empty `packages/rbac` shell + `config`/`hooks` placeholder dirs (S) |

## 2026-06-19 — 8.3/10 (§C Wave 3 landed; prev 7.3)

Calibrated, not averaged (dimension mean ≈8.5). 7-agent run on the **clean** tree at `d78225c` (file-based
routing `0bb14a2`, client soft-nav `bdc3bdb`, queue dashboard `a5a215f`, type-regression suite `d78225c`).
The judge **verified all three structural caps at source, not on trust**: (1) Postgres is genuinely built —
`packages/pg/src/adapter.ts` is a complete async `SqlDatabase` over a structural `pg.Pool` with a correctly
bracketed pooled-client transaction (only the dynamic-`require` engine in `pg-driver.ts` is coverage-excluded);
(2) `lesto deploy` is a real deploy tool — `bin.ts` spawns `wrangler deploy`, recovers the workers.dev URL,
health-gates `/readyz` (10s timeout), `wrangler rollback`s on failure; (3) batteries are wired —
`kernel.ts:307` wraps EVERY `app.handle` in `runPipeline(secure, …)`, `secureStack` composes
cors→rateLimit→originCheck→csrf, rate-limit ON by default. Dimension now-scores: crash-safety **9**,
framework-correctness **9**, data-layer **9**, observability/deploy **8.5**, security-wiring **8**, maturity/CI **7.5**.

Why +1.0 to 8.3 (and not higher): the entire crash-safety/security/data/correctness backlog is resolved and
regression-pinned, so the dimensions are genuinely 8–9. The judge docked ~1.7 from a naive read for
**adoption-maturity, not engineering**: all 60 packages are `private:true@0.0.0` and unpublished (so the
`create-lesto` scaffold's `^0.1.0` deps can't resolve and no external consumer can prove it), live-PG is
exercised only in CI (not this local tree), there is no metrics/log-shipping pipeline, bus-factor is 1 on a
10-day history, and the documented residuals stand (webhook DNS-rebinding TOCTOU, CSRF enforcement opt-in by
design, handler-timeout can't bound event-loop-blocking sync work). Calibration note: a first `ws:test` showed
80 queue failures — pure environment artifact (bun can't load the Node-ABI better-sqlite3 binding); re-run under
Node 22 (the CI runtime) it's 91/91, and kernel/cors/csrf/webhooks/runtime/deploy are all green.

Fruit ceiling: **~8.7**. Judge's call: **PIVOT to the publish-and-prove phase — do NOT keep picking fruit.**
What's left (env-tunable socket timeouts, delete the empty `rbac` shell, the content-mcp parallel-coverage
flake, the webhook TOCTOU, a CONTRIBUTING file) sums to ~1 day and lifts the score only ~0.4–0.5. The ceiling
is no longer structure-capped (Postgres built, deploy real, batteries wired — all verified). It's capped by the
ONE deliberately-deferred structural phase: **publish-day** (un-private the 60 packages → ship 0.x to npm so
the scaffold resolves → stand up live-PG soak) plus the last unbuilt §C differentiator (realtime, blocked on
PG LISTEN/NOTIFY). Same-day warm-up fruit is fine, but the needle-mover from here is publish + prove-with-a-real-consumer.

## 2026-06-18 — 7.3/10 (§C differentiators in-flight; prev 6.8)

Calibrated, not averaged (dimension mean ≈8.3). The 6.8 run's two named structural caps are now
**resolved on disk and independently verified**: (1) `lesto deploy` is NO LONGER a file copy — it
spawns `wrangler deploy`, parses the workers.dev URL, health-gates `/readyz`, and `wrangler rollback`s
on failure (`bin.ts:45-90`, `run.ts:785-815`); the static path does immutable `releases/<v>/` trees with
an atomic symlink-rename + SigV4 S3/R2 PUTs. (2) Security is wired by default — `createApp` runs a real
onion pipeline (`runPipeline`/`secureStack`) on both node and the CF edge. Dimension jumps since 6.8:
**crash-safety 8.5→9** (full DoS stack, 118 tests), **data-layer 9** (two real PG adapters, FKs enforced),
**security-wiring 8→8.5**, **maturity/CI 6.5→8** (8 blocking CI jobs incl. real-PG parity + hermetic CF
deploy dry-run; 42 pkgs at 100%), **framework-correctness 9→8.5** (one new named defect found),
**observability/deploy 6.5→7** (real OTLP + deploy, but query child-spans unwired through `lesto serve`).

Why only +0.5 despite the structural caps clearing: the *holistic* ceiling is now dominated by
**non-fruit maturity reality** — bus-factor-1, every package `private:true`, `release.yml` gated off,
~10 days of history, zero adoption/soak. Two honest deductions kept it off a naive ~8.3 weighted blend:
the working tree is **NOT clean** (uncommitted ADR-0018 §3 JOIN/alias work in 5 `@lesto/db` files —
typechecks, sound, but multiple assessors wrongly asserted "clean"; **verified dirty this run**), and the
headline **100%-coverage gate is not locally reproducible** — `bun run ws:test` is red on any local
checkout (71/71 db tests fail) purely from the better-sqlite3 NODE_MODULE_VERSION 115-vs-127 ABI skew
(environmental, CI-immune via the pinned Bun runtime).

Fruit ceiling: **~7.8**. Judge's call: **pick the fruit FIRST** (~1 day: ABI-pin to restore local-test
trust, the ui schema/validator divergence, the `onQuery` span plumb, DoS-knob surfacing), then **pivot to
the adoption-ship phase** (publish → second maintainer → docs site → soak) — the per-package craft is
already production-grade, so the remaining gap is structural and unreachable by fruit.

## 2026-06-16 — 6.8/10 (post Waves 0–5; prev 6.5)

Calibrated, not averaged (dimension mean ≈7.6). The three heavily-weighted dimensions are now
genuinely strong on the clean tree: **crash-safety 2→8.5** (never-throwing per-request error
boundary, 1 MiB body cap, handler/socket/slow-loris timeouts, SIGTERM drain through the real CLI,
edge adapter at hardening parity; 118 server tests), **security-wiring 2→8** (real onion middleware
pipeline; every 2026-06-09 finding fixed at file:line — CSRF session-binding, CORS wildcard+creds
guard, SSRF-guarded webhooks, fail-closed scrypt, hashed-at-rest SQL sessions), **data-layer 3→9**
(sync ORM deleted; async `@lesto/db` + real `@lesto/pg` adapter, transactional cross-process-locked
migrations, fenced at-least-once queue). Also: framework-correctness 6→9, maturity/CI 2→6.5,
observability/deploy 3→6.5.

Why only +0.3 despite Waves 0–5: the structural ceilings the 6.5 run already named are still open.
**Three caps:** (1) `lesto deploy` is verified to be a file copy — `remoteReleaseStore` has zero refs
in `cli/src`, `bin.ts` wires only fs stores, and nothing invokes `wrangler deploy`; (2) secure
defaults are opt-in — the kernel never injects `secureStack`, so an app that forgets `.use()` ships
with zero CSRF/CORS/rate-limit; (3) no live-Postgres integration journey and zero release engineering
(0/61 build scripts, no changeset/publish path, single author, ~1 week history).

Fruit ceiling: **~7.4**. Judge's call: **PIVOT** to a structural phase — real `lesto deploy`
(remote store + `wrangler deploy` invoke + health-gated flip) and a kernel-enforced secure baseline
are the highest-leverage moves; they are unreachable by fruit.

## 2026-06-09 — 4.5/10 (baseline 2.0)

Phase-0 hardening (all 29 REVIEW findings) committed as `621fe4c`; CI added (`4349414`).

Dimension scores (before → now): crash-safety 2→6.5 · framework-correctness 2→8 · data-layer 2→5 · maturity/CI 2→5 · security-wiring 2→4.5 · observability/deploy 2→3.

Fruit ceiling: **~6.0** (reachable by ops/safety fruit alone). Past that, three structural
ceilings dominate: async/Postgres unbuilt, security pipeline unwired, `lesto deploy` is a file copy.

## 2026-06-09 (run 2) — 5.5/10

After Tier 0 (`a1b84ac`), Keystone 1 binary/stream body (`b37438f`), and Tier 1.B pipeline +
ALS context + Tier 2 streaming SSR (`d730810`), plus the parallel track's `@lesto/identity` and
cleanup. Full breakdown in `2026-06-09-run2.json`.

Dimension scores (orig → now): crash-safety 2→**8** · security-wiring 3→**7** · framework-correctness
5→**8** · maturity/CI 5→**6** · data-layer 3→**5.5** · observability/deploy 3→**5**.

Fruit ceiling: **~6.5**. The judge's call: do a half-day fruit pre-pass (coverage gate, binary-safe
uploader, edge IP context for rate-limit, queue parse guard, CI hygiene), then **PIVOT to a
structural phase** — the six biggest blockers (async/Postgres, real `lesto deploy`, CF-edge hardening
parity, observability+metrics, RBAC/auth-middleware/DB-sessions, bus factor) are unreachable by fruit.
Highest-leverage structural move: **async data layer + Postgres adapter** (the sync `SqlDatabase`
interface is a breaking seam everything downstream calcifies against).
