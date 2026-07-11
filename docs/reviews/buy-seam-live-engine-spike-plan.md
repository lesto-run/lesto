# Phase-0 spike plan — "buy ElectricSQL under the `live()` façade" (build-vs-buy seam #1)

**Status:** proposed spike plan (decision `L-0993ff3e`, epic `L-c5fd5621`; live-GA epic `L-3c9f8069`).
**Precedent:** ADR 0029/0046 Phase-0 hard-gate discipline — *prove a platform-integration
claim on a real substrate BEFORE writing flow code*. This repo has two scars from deciding
integration questions in prose: `b932aa1` (CI-green / deployed-Worker-broken edge KDF) and the
ADR 0042 errata (OPFS live store shipped DOA in **every** browser under a fully green gate).
The build-vs-buy review's "buy Electric" recommendation rests on an **unverified integration
claim**; this spike is how we stop it being prose.

## The claim under test (the whole buy-case depends on it)

> `live()`'s **ORM-native, two-runtime, one-AST** semantics — a fluent builder over the app's
> **own `@lesto/db` schema** — can sit on **ElectricSQL's shape/sync/replication substrate**
> *without losing the moat properties*, and doing so is a **faster** path to a
> production-hardened engine than finishing the owned Tier-4 engine that **already exists**.

Two facts frame it honestly, and both cut against a reflexive "buy":

1. **A large fraction of the owned engine already exists and passed a gate.** Tier-4 v1
   (Inc1–9) is DONE and graded **A−** by the review: logical-replication → shape classifier →
   LSN-exact resume → OPFS store → offline outbox → cross-tab leader
   (`packages/live-server/src/{engine,resume}.ts`, `packages/live/src/*`). "Buy" here means
   **ripping out working, disciplined code**, not filling a void.
2. **The v0 `live()` shape surface is narrow** — single-table, key column, projected columns,
   AND-combined scalar `eq/ne/gt/gte/lt/lte`, one `orderBy`; the predicate is
   "evaluable in JS against a single row" and canonicalizes to a `shapeId`
   (`packages/live/src/builder.ts`, `packages/live-protocol/src/shape.ts`). This maps
   *relatively cleanly* onto an Electric shape (also single-table + WHERE) **today** — so the
   spike must test the **roadmap**, not just v0, or it will green a mapping that breaks the
   moment joins/richer predicates land.

So the honest question is **narrower than "build vs buy the engine"**: is *finishing +
hardening the four remaining owned seams* (F33 fenced snapshot↔tail, F34 durable shape logs,
F35 WHERE pushdown, HA single-writer) cheaper than *re-seating `live()` on Electric* — a
mapping that may not survive the roadmap and may fight the OPFS/offline/local-query stack the
owned engine already ships?

## Spike questions — each with a falsifiable PASS/FAIL (a FAIL kills or narrows the buy)

**Q1 — Shape mapping totality (v0 + roadmap).** Write a `ShapeDefinition → Electric shape`
adapter for the v0 surface and run the existing `live-protocol` shape corpus through it.
- **PASS:** every v0 `ShapeDefinition` maps to a semantically-equivalent Electric shape
  (same rows, same key, same predicate) — verified by a differential test (owned engine's
  `matchesShape` vs Electric's shape membership over a generated row corpus).
- **FAIL (kills or narrows buy):** any v0 predicate/order/key Electric's shape model can't
  express *without server-side pre-materialization*; OR the **joins/multi-table roadmap**
  (ADR 0018 relations; `live()` vNext) requires abandoning ORM-native joins because Electric
  shapes are single-table — i.e. buying Electric caps `live()`'s roadmap at v0.

**Q2 — Two-runtime, one-AST property survives.** The moat is that `live()` is *one AST of typed
`Table`/`Column` values* over the app's own schema, same language client and server, **no
external sync service in the authoring surface**.
- **PASS:** Electric sits entirely *below* the `ShapeDefinition` seam; the app author still
  writes `live(todos).where(todos.list,"eq","home")` and never sees an Electric shape URL,
  Electric's dialect, or a second schema.
- **FAIL:** the mapping leaks Electric's shape/URL/auth model into the author surface, or
  requires a second schema definition — the "no framework that merely consumes an external
  sync service can offer this" property (builder.ts:16) is lost.

**Q3 — The client stack (the part Electric does NOT replace).** Electric ships a sync client;
`live()` ships OPFS-SQLite local store + **local queryability** + offline **outbox** (local
writes) + **cross-tab leader** (one sync conn for N tabs). Electric is read-path shape sync.
- **PASS:** Electric's client slots under the OPFS store as a *replication source* and the
  outbox/local-query/cross-tab layers are preserved unchanged (they're above the source seam).
- **FAIL:** Electric's client assumes its own local store (PGlite) and fights OPFS-SQLite, OR
  the offline write/outbox path has no Electric equivalent and must stay owned anyway — in
  which case "buy" only replaces the WAL-shipping half, and the integration tax may exceed the
  hardening it saves.

**Q4 — The actual reason to buy: HA + durability.** The genuinely-hard unbuilt part is HA —
the owned engine uses a **single-writer replication slot**; running two machines drops the slot
= corruption (F34 also: server restart → full re-snapshot storm, engine state in-memory).
- **PASS:** Electric provides multi-consumer durability / HA that the owned engine would take
  multiple quarters to build (durable per-shape logs, fenced resume, no single-writer
  corruption) — quantify the delta in engineer-quarters saved.
- **FAIL / NARROWS:** Electric's own HA story is weaker than assumed, OR the owned F33/F34/F35
  fixes are bounded (weeks, not quarters) once scoped — in which case finish the owned engine.

**Q5 — Operational + supply-chain cost of the dep.** Electric is a stateful sync *service*
(a process + its own Postgres relationship), not a library. `@lesto/live` is being de-privatized
and published (`L-f421d6b8`); the edge/Workers deploy story (ADR 0042 runs the engine on a
Worker) must survive.
- **PASS:** Electric deploys inside Lesto's one-command deploy story (node AND the Workers edge
  target) without a second ops runbook or a compat-flag dependency.
- **FAIL:** Electric can't run on the edge target `live-server` targets, or needs a separate
  managed service — reintroducing exactly the integration/deploy tax the framework eliminates.

## Method (mirrors the ADR 0046 spike's rigor)

- Stand up Electric against a real Postgres with logical replication (docker; the same pg the
  owned engine uses — `docs/plans` live capstone infra). NOT a mock.
- Build the thin `ShapeDefinition → Electric shape` adapter for v0 only.
- **Differential oracle:** generate a row corpus + a shape corpus; assert Electric's shape
  membership ≡ the owned `matchesShape` for every (row, shape) pair. A divergence is a Q1 FAIL.
- Drive the four moat properties (Q2–Q3) against `examples/live-capstone` as the real client.
- Probe HA (Q4): kill the Electric consumer mid-stream, restart, assert no lost/double rows
  (the fence the owned F33 lacks); compare to the owned engine's behavior under the same fault.
- **Beware the false oracles this repo has been bitten by:** a green single-machine run does
  NOT prove HA (the OPFS-DOA class); a passing v0 mapping does NOT prove the joins roadmap maps
  (test it explicitly); assert the failure case is RED before trusting any negative claim
  (the vacuous-assertion trap). Record engineer-quarter estimates for BOTH paths, not just the
  buy path.

## Decision procedure (what the spike returns)

- **Buy Electric** iff Q1–Q3 PASS (mapping total incl. a credible joins path, moat surface
  intact, client stack preserved) AND Q4 shows a multi-quarter HA delta AND Q5 PASS (deploys
  in-story). Then: Electric under the façade, keep the entire `@lesto/live` client stack.
- **Finish the owned engine** iff any of Q1–Q3 FAIL (the mapping imports a mismatch or caps the
  roadmap), OR Q4 shows the remaining owned seams are bounded (weeks), OR Q5 FAIL (edge/deploy
  breaks). Then scope F33/F34/F35 + HA as owned work.
- **Hybrid** (plausible outcome): keep the owned client stack (OPFS/outbox/cross-tab — Q3) and
  the `live()` surface (Q2), buy Electric ONLY as the server-side replication/shape source if
  Q1 maps and Q4 justifies it. This is the "keep the surface, rent the WAL shipping" reading
  the review actually recommends — the spike confirms whether it's real.

## Non-goals / guardrails

- Not a rewrite; a thin adapter + differential test + fault probe. Throwaway (`spikes/`),
  deleted after, exactly like `spikes/adr-0046-edge-kdf/`.
- **Does NOT gate the P0 security fixes** (F1–F6) or the P1 reliability set — those ship
  regardless of this decision.
- **Time-sensitivity:** the live-GA epic is moving (`L-f421d6b8` de-privatize/publish,
  `L-9f7a5098` app-shell precache). Work that hardens the **surface/client** (`@lesto/live`)
  is safe either way. Work that pours quarters into the **server engine internals** (F33/F34/F35
  beyond bounded fixes) is the effort at risk of waste if the buy wins — sequence the spike
  BEFORE committing engineer-quarters to owned engine hardening.
