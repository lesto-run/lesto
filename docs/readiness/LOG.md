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
| 2026-06-19 (run 2, fruit + de-privatize) | 8.4/10 | +0.1 (from 8.3) | The `.ts` bin can't run under `npm create`/`npx` (no node TS loader) — the one hard launch blocker; + bus-factor-1, unpublished, zero external soak | Make the CLI/`create-lesto` bin node-runnable (compiled JS bin or `tsx` shebang), then prove `npx create-lesto` (M) |
| 2026-06-19 (run 3, bin fix + fruit) | 7.8/10 | −0.6 (from 8.4) — **judge re-calibration, NOT a regression** | Never-published + never-soaked + bus-factor-1 (29 pkgs at unpublished 0.1.0, RELEASE_ENABLED dormant) — structural | Bounded `server.maxConnections` + in-flight 503 shed (`server.ts`, S) |
| 2026-07-03 (post live/MCP-auth/TW epics + 0.1.1 publish) | 8.0/10 | +0.2 (from 7.8) | CI dormant: 279 unpushed commits (last origin run FAILED) + tree fails its own typecheck/lint/format gates; published 0.1.1 stale, @lesto/live\* still private | Green the 4 broken local gates — typecheck ×2, lint ×2, format ×2, all mechanical (S) |

## 2026-07-03 — 8.0/10 (live data layer + MCP auth + TW/shadcn epics + 0.1.1 published; prev 7.8)

Calibrated, not averaged (dimension mean ≈8.25: crash-safety **9**, security-wiring **9**,
framework-correctness **9.5**, data-layer **8**, maturity/CI **7.5**, observability/deploy **6.5**).
All three named blockers from the 7.8 verdict are retired and verified: connection-volume DoS
(10k-conn/1k-in-flight shed + per-IP stream semaphores), browser-safe security default
(`secure: { browser: true }` preset + scaffold ships `originCheck` ON), and never-published
(0.1.1 live on npm with OIDC provenance, 2026-06-23).

Why only +0.2: **the process layer regressed and it matters.** Verified red this run: the tree
fails its own typecheck (2 pkgs), lint (2 errors), and format (2 files) gates; local main is
**279 commits ahead of origin** whose last CI run FAILED (check, scaffold-loop,
db-parity-postgres, bundle-size, deploy-cloudflare-dry) — ten days of security-critical
hardening has never passed the 15-job blocking matrix; npm 0.1.1 predates all of it and the
flagship `@lesto/live*`/`identity`/`client` packages are still `private:true@0.0.0`. New concrete
defect: **`lesto deploy --cloudflare` auto-rolls-back healthy deploys** — the CLI defaults its
health probe to `/readyz` (`run.ts:2300`) but the edge fetch handler serves no health route, so
the 404 reads unhealthy unless `--health-url` is passed. Beneath it all the durable ceiling is
unchanged: bus-factor-1 (720/720 commits), 24-day history, zero external soak, no metrics.

Fruit ceiling: **~8.3**. Judge's call: do the first three fruit NOW as mandatory hygiene (green
the four local gates ~half a day; push + drive the remote 15-job matrix green; fix the
`--cloudflare` health probe), then **STOP picking fruit and pivot to the adoption phase** the
last two judges already prescribed: cut 0.1.2 of the 279-commit-stale surface (+ decide the
publish story for the private live packages), get a second human through the core, run a real
external soak against live Postgres + CF, add minimal metrics. "The architecture is no longer
the constraint."

## 2026-06-19 (run 3) — 7.8/10 (launch blocker fixed + run-2 fruit; prev 8.4)

⚠️ **The number went DOWN (8.4→7.8) but the code did not regress** — this is judge-to-judge
calibration variance, and the run-3 judge was the more conservative one. Per-dimension scores are
flat-or-UP vs run-2: crash-safety **8.5** (run-2 9 — this assessor surfaced the connection-cap gap),
security-wiring **8.5** (↑ from 8), data-layer **9**, observability/deploy **8.5** (↓0 from 8.5),
maturity/CI **8.5** (↑ from 8), framework-correctness **9** (= dimension mean ≈8.7). The judge
states plainly: "engineering quality is 8.5–9 across the board, but production-readiness blends to
7.8 once the never-shipped / never-soaked / bus-factor-1 reality and the residual connection-DoS gap
are weighted in." It used a ~3.5 "before" (not 8.4) and recalibrated from scratch — "unsoaked,
single-author, never-published software does not earn an 8+ no matter how clean the code reads."

What it independently CONFIRMED on the clean tree: the launch blocker is fixed (structure verified —
async PG adapter, real health-gated deploy with atomic flip + rollback, default-on secure pipeline
on both node + CF edge); and it debunked the maturity assessor's "ws:test parallel red" as a
**bun-test-vs-vitest runner artifact** (passes 2/2 under the real vitest runner; CI's serial path is
immune) — validating the run-2 finding that the content-mcp flake is already fixed.

New concrete blocker this run: **no `server.maxConnections` / in-flight cap** — the per-request
limits close process-crash and socket-hang, but a cheap unauthenticated *connection-volume* flood can
still exhaust sockets (currently delegated to the CF/LB edge in the deploy model). Plus the standing
caps: browser apps not cross-site-safe by default (opt-in `originCheck`), event-loop-blocking sync
DoS out of scope, and real wrangler/live-PG legs validated only at deploy-time / in CI service
containers, never in a PR gate.

Fruit ceiling: **~8.3**. Judge's call: pick the first two fruit (connection cap + browser-safe
security default — both high/S, each retires a named blocker), then **PIVOT to the structural phase —
do NOT keep grinding fruit**. Everything above ~8.3 is gated by the maturity reality (bus-factor-1,
never published, never soaked) that no fruit can move. The binding constraint is now the
deliberately-last publish-day work: **flip `RELEASE_ENABLED` + real 0.x publish → a second human
reviews the core → a real workload / external soak against live Postgres + CF.** "The code is ready
enough that the remaining ceiling is organizational and operational, not architectural."

## 2026-06-19 (run 2) — 8.4/10 (fruit 1–5 + publish-day de-privatization; prev 8.3)

Calibrated, not averaged (dimension mean ≈8.6). 7-agent run on the **clean** tree at `79ac991`.
The 8.3 run's named #1 blocker — "all 60 packages `private:true@0.0.0`, unpublished" — is now
**half-cleared on disk**: the 28-package publish closure **+ `create-lesto`** are de-privatized at
`version 0.1.0` (`publishConfig.access:public`, `files:["src"]`, `repository`→`lesto-run/lesto`,
content-* "Docks" metadata reconciled — `982a62d`/`85ad687`), and the npm name gate is verified
free (`E404`). Low-hanging fruit 1–5 also landed (`9057970` env timeouts, `5bec1ee` content-mcp
flake, `b40ecc9` webhooks `nodePinningFetch` TOCTOM closure, `cb96691` CODEOWNERS; the empty
`rbac`/`config`/`hooks` were untracked → already clean). Dimension moves since 8.3:
**security-wiring 8→8.5** (empty `rbac` shell deleted, folded into `@lesto/authz`; webhook tests
38→55), **observability/deploy 8.5→9**, **maturity/CI 7.5→8** (de-privatized surface + CODEOWNERS);
crash-safety **9**, data-layer **9**, framework-correctness **9** hold.

Why only +0.1 to 8.4: the de-privatization is metadata, not *proof*. The judge surfaced **one hard
launch blocker that publishing would otherwise expose**: every package ships `.ts` and the
`create-lesto`/`@lesto/cli` `bin` points at `./src/bin.ts`, which `npm create`/`npx` cannot run
under node without a TS loader — so the entrypoint and CLI are **non-functional for an external
consumer** until a compiled/loader bin lands. Below that, the cap is unchanged and maturity-shaped:
bus-factor-1, ~312 commits / 10-day history, nothing published, zero external/production soak;
pg pooling only proven in gated CI, never under real contention.

Fruit ceiling: **~8.6**. Judge's call: **pivot to a short launch-readiness phase — do NOT keep
picking generic fruit.** The heavy dimensions (crash-safety/security/data) are already 9/8.5 and
verified, so the fruit list is thin and capped at ~8.6. The keystone is the **`.ts`-bin fix → prove
`npx`/`lesto` in a clean node sandbox → flip `RELEASE_ENABLED` → publish `0.1.0` → one external-consumer
smoke test**. That publish-and-prove phase (then a real multi-worker pg / second-author / adoption
soak) is the only path into the 9+ band — what caps the repo now is unproven/unpublished maturity,
not missing architecture. The non-bin fruit (Node-22 `.nvmrc` enforcement, the content-mcp flake,
content-core NaN guard, CSRF opt-in doc nudge) are a worthwhile sub-day cleanup in passing, but polish.

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
