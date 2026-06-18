# Production-readiness plan — 5.5 → 8+

Derived from the 2026-06-10 readiness run (`docs/readiness/2026-06-10.json`).
Current score **5.5/10**, fruit ceiling **~6.5**. The score is gated not by polish
but by a structural floor: a synchronous data layer with no Postgres/pool, a
file-copy deploy, and a request path with no metrics/traces. This plan clears the
fruit first, then takes the structural floor out in dependency order.

**Scoring philosophy (from the judge):** crash-safety, security, and data-layer
are weighted heavily; a low structural ceiling caps the holistic score regardless
of how high correctness/maturity climb. So the sequence is deliberately
fruit-then-keystone-then-breadth, not "raise every dimension a little."

Effort key: **S** ≤ ½ day · **M** ~1–2 days · **L** ~3–5 days · **XL** > 1 week.

---

## Phase 0 — Fruit pre-pass (no architecture change) → ~6.5

Eight sub-day wins. Independent of each other; do them first, in this order.

| # | Item | Effort | Location | Done when |
|---|------|--------|----------|-----------|
| 0.1 | **Real readiness probe** — CLI `runServe` passes an `isReady` that pings the DB handle so `/readyz` stops returning 200 over a dead DB | S | `runtime/server.ts:395`, `cli/run.ts:134`, `cli/bin.ts:57` | `/readyz` → 503 when a `SELECT 1` fails |
| 0.2 | **Edge body cap + handler timeout** — mirror the node `maxBytes` tally + `withTimeout` race into the CF adapter before `request.text()` | S | `cloudflare/fetch-handler.ts:115` | oversized edge body → 413; overrun → 503; tests |
| 0.3 | **Edge access log** — copy the node `logRequest` shape into `toFetchHandler` (today it logs errors only) | S | `cloudflare/fetch-handler.ts:231` | one structured access line per edge request |
| 0.4 | **Stronger default `secureStack`** in the scaffold — add `rateLimit` + a CSRF token to the generated app (primitives already compose in safe order) | S | `create-volo/templates.ts`, `kernel/secure-stack.ts:85` | new apps ship rate-limit + CSRF by default |
| 0.5 | **Seed a span per request** — wire the (already-built, orphaned) tracer into dispatch with the in-memory exporter; this is also the seam Phase 4 attaches OTel to | M | `kernel/kernel.ts`, `web/application.ts:92`, `observability/index.ts` | every dispatch opens/closes a span |
| 0.6 | **Flip CI format step to blocking** — `ws:format:check` already exits 0 everywhere; delete `continue-on-error` | S | `.github/workflows/ci.yml:62` | format regressions fail CI |
| 0.7 | **`git rm` 4 stray lockfiles** — 2 `package-lock.json` + 2 `pnpm-lock.yaml` against a bun-only toolchain | S | root, `loom/`, `content-markdown/`, `content-shared/` | only `bun.lock` tracked |
| 0.8 | **Tighten UI `treeJsonSchema`** — emit allow-list child `$ref`s instead of any-node so the model-facing schema matches `validateTree` | M | `ui/src/schema.ts:106`, `ui/src/validate.ts:31` | schema rejects a child the validator would reject |

**Exit criteria:** all eight merged, 100% coverage gate still green, score ≈ 6.5.

---

## Phase 1 — Async data layer + Postgres (THE keystone) → unblocks scale → ~7.5

The binding constraint. `SqlStatement.run/get/all` and `exec` return values, not
Promises (`db/src/sql.ts:18-25`); a networked Postgres pool cannot back that. This
is one coherent rewrite — **ADR 0006** — that ripples through a bounded set: the
seam is `SqlDatabase`, consumed by ~10 packages (identity, mailing-lists, admin,
cache/sql-store, content-store, queue, workflows, mcp, migrate, kernel) and ~12
files calling the sync terminals.

| Step | Work | Effort |
|------|------|--------|
| 1.1 | **ADR 0006 — async data layer.** Decide & document: `SqlStatement`/`SqlDatabase` become `Promise`-returning; `.get()/.all()/.run()/.count()` become async; no sync escape hatch (a sync-over-async shim re-introduces the blocking footgun). | S |
| 1.2 | **Flip the interface** in `@volo/db`: `exec`, `run`, `get`, `all` → `Promise`. Update the query builder so terminals `await` the driver. Keep `defineTable`/columns/conditions/DDL untouched (pure values). | M |
| 1.3 | **SQLite driver stays the dev default** — wrap `openSqlite` so its sync better-sqlite3/`bun:sqlite` calls present the async interface (trivially `async`). Zero-config local is preserved. | S |
| 1.4 | **Postgres adapter** — new `@volo/pg` (or `@volo/db/pg`): a `node-postgres` (`pg`) `Pool` implementing the async `SqlDatabase`; `?`→`$1` placeholder translation; type/row mapping. | L |
| 1.5 | **Migrate `@volo/migrate`** to `await` its DDL/bookkeeping (it owns `exec` + the versions table). | M |
| 1.6 | **Ripple the ~10 consumers**: identity, mailing-lists, admin, cache `sql-store`, content-store, queue, workflows, mcp — make their query helpers + the controllers/services that call them `async`/`await`. Most are already in async request paths. | L |
| 1.7 | **Kernel + examples**: `createApp` accepts an async db; `examples/estate` + `examples/blog` + the scaffold await their queries. | M |
| 1.8 | **Cross-driver test matrix** — run the gated suites against **both** SQLite and a Postgres test container; the existing 100% bar must hold on both. | M |

**Exit criteria:** `createApp` boots on a `pg.Pool`; identity/queue/content all pass
on Postgres and SQLite; ADR 0006 marked implemented. Score ≈ 7.5.

---

## Phase 2 — Connection pooling + per-request scoping (needs Phase 1) → ~7.5

| Step | Work | Effort |
|------|------|--------|
| 2.1 | **Pool** lives in the PG adapter (1.4). Expose checkout/release; size from config. | S |
| 2.2 | **Per-request connection scoping** via `AsyncLocalStorage` — reuse the existing `RequestContext` (`web/src/context.ts`) so a request (and its transaction) binds one connection, not a module global. | M |
| 2.3 | **Transactions** — a request-scoped `db.transaction(fn)` that commits/rolls back around a handler. | M |
| 2.4 | **Retire the orm module-global** path for any remaining consumer (orm is already LEGACY; ensure no in-tree code depends on `useDatabase`). | S |

**Exit criteria:** concurrent requests provably use distinct pooled connections; a
handler can run a request-scoped transaction. Removes the "no fleet concurrency
story" blocker.

---

## Phase 3 — Real deploy path (independent — can run parallel to Phase 1) → +deploy dimension

Today `volo deploy` is a planner + non-atomic file copy; the dynamic tier just
prints `run volo serve`.

| Step | Work | Effort |
|------|------|--------|
| 3.1 | **Atomic static swap** — ship into a versioned dir, swap a `current` symlink; a deploy is instantaneous and reversible. | M |
| 3.2 | **Post-deploy health gate** — after swap, poll the new target's `/readyz` (now real, 0.1); abort + roll back on failure. | M |
| 3.3 | **Rollback command** — `volo rollback` repoints `current` to the previous version. | S |
| 3.4 | **Dynamic-tier deploy** — beyond printing `volo serve`: a container recipe (Dockerfile already exists) or a process-target adapter, with the same health-gate. | L |
| 3.5 | **Real uploader backend** — an S3/R2 implementation of the existing injectable `ShipDeps` seam (the local file copy stays the default). | M |

**Exit criteria:** a deploy is atomic, health-gated, and reversible; the dynamic
tier actually ships. Removes the "non-atomic file copy, no rollback" blocker.

---

## Phase 4 — Observability in the request path (mostly independent) → +observability dimension

Builds on the span seam from fruit 0.5.

| Step | Work | Effort |
|------|------|--------|
| 4.1 | **OTel exporter adapter** for `@volo/observability` (it ships in-memory only today) — OTLP out, behind the existing exporter interface. | M |
| 4.2 | **Metrics** — request count, latency histogram, error-rate counter, emitted from dispatch on both node and edge. | M |
| 4.3 | **Edge parity** — spans + the access log (0.3) on the CF handler, the real prod target. | S |
| 4.4 | **Structured request log** — promote the one-line access log to structured fields (status, latency, correlation id) consumable by a log pipeline. | S |

**Exit criteria:** traces + metrics flow from the request path on node and edge;
SLOs are graphable. Removes the "no metrics/traces, lying readiness" blocker.

---

## Phase 5 — Persistent stores + security depth (stores need Phase 1) → +security dimension

| Step | Work | Effort |
|------|------|--------|
| 5.1 | **SQL-backed session store** (post-1, poolable) — sessions survive restart and are shared across a fleet (today in-memory only). | M |
| 5.2 | **SQL-backed rate-limit store** — same, so limits are fleet-wide not per-process. | M |
| 5.3 | **Wire `@volo/rbac` into a request-path authorization middleware** — it's pure logic wired into zero request paths today; mount it in `secureStack`. | M |
| 5.4 | **Default `secureStack` hardening** — fold in rate-limit + CSRF token across kernel defaults (extends fruit 0.4 from scaffold-only to the framework default story). | S |

**Exit criteria:** sessions/rate-limits survive a restart and a fleet; an
unauthorized request is refused by middleware before the controller. Removes the
"thin default posture, RBAC unwired, in-memory stores" blocker.

---

## Phase 6 — Edge parity & release maturity (ongoing)

| Step | Work | Effort |
|------|------|--------|
| 6.1 | Edge body cap + timeout (= fruit 0.2) — node parity on the real prod target. | S |
| 6.2 | **Release automation** — changesets + versioning + a publish pipeline. This also **unblocks the deferred #1** (a scaffolded app installs once packages are on npm). | L |
| 6.3 | **Bus factor / version maturity** — a second contributor; move packages off `0.0.0`; tags. Time + people, not code. | XL |
| 6.4 | **Sync-blocking DoS** (ReDoS, huge sync parse) — accepted as architectural; mitigate by *not writing it* (router refuses ambiguous backtracking patterns); the body cap blunts the sync-parse variant. Documented, not a runtime guard. | — |

---

## Dependency graph & sequencing

```
Phase 0 (fruit) ──────────────────────────────► ~6.5   [do first, parallelizable]
        │
        ├── Phase 1 (async + Postgres) ◄── KEYSTONE ──► ~7.5
        │        │
        │        ├── Phase 2 (pool + scoping)
        │        └── Phase 5.1/5.2 (persistent stores)
        │
        ├── Phase 3 (deploy)      ─┐ independent of data layer —
        ├── Phase 4 (observability)─┤ can run in parallel with Phase 1
        └── Phase 5.3 (RBAC wiring)─┘
                                          └────────────► ~8.5
```

- **Phase 1 is the keystone**: pooling (2) and persistent stores (5.1/5.2) cannot
  land until the data layer is async.
- **Phases 3, 4, and 5.3 are independent** of the data layer and can proceed in
  parallel with Phase 1 (good work to hand to a second contributor — see 6.3).
- **Fruit 0.5** (span seam) and **0.1** (real `/readyz`) seed Phases 4 and 3.

## Expected score trajectory

| Milestone | Score | What moved |
|-----------|-------|-----------|
| Today | 5.5 | — |
| After Phase 0 (fruit) | ~6.5 | readiness/edge-hardening/observability seam/CI |
| After Phases 1–2 | ~7.5 | async data layer + Postgres + pool — the horizontal-scale ceiling lifts |
| After Phases 3–5 | ~8.5 | safe deploy + real observability + persistent stores + wired RBAC |
| After Phase 6 (time) | 9+ | release maturity, second contributor, install story |

## Coverage of the readiness findings

Every fruit item (0.1–0.8) and every named blocker is mapped: async data layer →
P1; pooling/scoping → P2; deploy safety → P3; observability/metrics/readiness →
P0.1 + P4; thin security/persistent stores/RBAC → P5; edge body-cap → P0.2/P6.1;
sync-blocking DoS → P6.4 (accepted-architectural). Nothing from the run is left
unaddressed.
