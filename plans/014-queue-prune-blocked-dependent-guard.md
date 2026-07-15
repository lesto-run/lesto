# Plan 014: Stop `Queue.prune()` from resurrecting a blocked dependent of a failed prerequisite

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/queue/`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED (changes prune retention / possibly batch counts)
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

The queue's stated invariant (`queue.ts:250-256`) is: **one failed job means its
dependents stay `blocked` forever.** But `prune()` breaks it. `prune` deletes
terminal rows (`done`/`failed`) past a cutoff, then sweeps dependency edges whose
prerequisite row is gone. `releaseReadyDependents` treats a **missing**
prerequisite row as satisfied (a `NOT EXISTS` join). So: batch `C dependsOn
[A, B]`; A **fails** permanently; B is still running; a `prune` sweep older than
the cutoff deletes A and the C→A edge; when B later completes,
`releaseReadyDependents` sees no unmet edges and flips C to `ready` — C runs
against an input that failed, exactly what the design forbids. It is a slow-burn
integrity bug (needs a prune cutoff shorter than a batch's tail latency), not a
hot path — but it silently violates the batch contract.

## Current state

- The invariant:
  ```ts
  // packages/queue/src/queue.ts:250-256  "one failed job means dependents stay blocked forever"
  ```
- `prune` deletes terminal rows then sweeps orphaned edges:
  ```ts
  // packages/queue/src/queue.ts:732
  const result = await tx.prepare(
    `DELETE FROM ${TABLE} WHERE status IN ('done','failed') AND finished_at IS NOT NULL AND finished_at < ?`
  ).run([cutoff]);
  // :743 sweep edges whose job on EITHER side is gone
  await tx.prepare(
    `DELETE FROM ${DEPS_TABLE}
       WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} j WHERE j.id = ${DEPS_TABLE}.job_id)
          OR NOT EXISTS (SELECT 1 FROM ${TABLE} j WHERE j.id = ${DEPS_TABLE}.depends_on_id)`
  ).run([]);
  ```
- The "missing prerequisite = satisfied" release logic:
  ```ts
  // packages/queue/src/queue.ts:566  releaseReadyDependents
  //   UPDATE ... SET status='ready' WHERE status='blocked'
  //     AND id IN (dependents of jobId)
  //     AND NOT EXISTS (an edge to a prerequisite p WHERE p.status <> 'done')
  ```
  The `JOIN ${TABLE} p ON p.id = d.depends_on_id` means a **deleted** prerequisite
  contributes no row → counts as satisfied.

### Conventions to follow

- All multi-statement queue work runs inside `this.db.transaction(...)` (see
  `prune` and `discard`). Keep the guard inside the same transaction.
- SQL is dialect-portable (SQLite dev / Postgres prod with `SKIP LOCKED`) — the
  guard must be plain SQL that runs on both (the existing prune SQL is).
- Errors carry codes; a retained row is not an error.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Gate | `cd packages/queue && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` | exit 0, 100% |
| pg leg (if runnable) | (the repo's pg integration command — see `pg-integration-test-teardown` memory) | pass |

## Scope

**In scope**:
- `packages/queue/src/queue.ts` — the `prune` job-delete (add a guard) and the
  stale `releaseReadyDependents`/`discard` doc blocks (CORR-05).
- `packages/queue/test/*` — add the resurrection regression + a doc-behavior test.

**Out of scope**:
- `discard`'s cascade-delete semantics — they are correct; only the docs that
  wrongly describe `discard` as calling `releaseReadyDependents` change.
- The fencing-token / reclaim logic (separate findings).

## Steps

### Step 1: Guard the prune job-delete

Do NOT delete a terminal row that still has a `blocked` dependent. Add a
`NOT EXISTS` clause to the job DELETE so such a prerequisite is retained until its
dependents are resolved:
```sql
DELETE FROM lesto_jobs
  WHERE status IN ('done','failed')
    AND finished_at IS NOT NULL
    AND finished_at < ?
    AND NOT EXISTS (
      SELECT 1 FROM lesto_job_deps d
        JOIN lesto_jobs j ON j.id = d.job_id
       WHERE d.depends_on_id = lesto_jobs.id
         AND j.status = 'blocked'
    )
```
(Use the real `TABLE` / `DEPS_TABLE` constants as the surrounding code does.)
The edge sweep and batch-cleanup that follow are unchanged — they only remove
edges/batches whose jobs are actually gone.

**Verify**: `cd packages/queue && bun run typecheck` → exit 0.

### Step 2: Fix the stale docs (CORR-05) AND the invariant doc

Three doc edits:
- Update `releaseReadyDependents`' doc block (the `/**` opens at `queue.ts:532`)
  and `discard`'s: `discard` does NOT call `releaseReadyDependents` — it
  cascade-DELETEs blocked dependents (`queue.ts:1157-1203`, the actual `DELETE`
  at ~:1196). Name `complete` as the **sole** caller of `releaseReadyDependents`
  (verified: the only call is at ~:1249 inside `complete`→`settle`), and describe
  discard's cascade.
- **Update the invariant doc at `queue.ts:250`** (required, not a maintenance
  note): the Step-1 guard makes a failed-prerequisite batch **immortal under
  `prune` alone** — its blocked dependents are never terminal, so the failed row
  is retained until an operator `discard`s. That is the invariant's price; state
  it so the next audit doesn't "find" a prune leak.

**Verify**: the docs no longer claim discard calls `releaseReadyDependents`; the
`queue.ts:250` invariant doc names the retain-until-discard behavior.

### Step 3: Tests + gate

**Verify**:
```
cd packages/queue && bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```
→ exit 0, 100%.

## Test plan

Add to `packages/queue/test`, modeled on the existing batch/prune/dependents tests:
1. **Resurrection regression**: build `C dependsOn [A, B]`; fail A permanently;
   leave B unfinished; run `prune` with a cutoff past A's `finished_at`; assert A
   is **retained** (not deleted) and the C→A edge survives; then complete B and
   assert C stays `blocked` (NOT `ready`). Confirm this test goes RED without the
   Step 1 guard.
2. **Normal prune still works**: a fully-terminal batch (all jobs done, no
   blocked dependents) is still pruned past the cutoff.
3. Keep the assertions positive and non-vacuous.

## Done criteria

- [ ] `cd packages/queue && bun run test:cov` exit 0, 100%, resurrection regression present and red-without-the-fix
- [ ] `cd packages/queue && bun run lint && bun run format:check` exit 0
- [ ] `grep -n "NOT EXISTS" packages/queue/src/queue.ts` shows the new prune guard
- [ ] `releaseReadyDependents`/`discard` docs corrected (no false "discard calls it")
- [ ] `plans/README.md` status row for 014 updated

## STOP conditions

Stop and report if:
- The excerpts don't match (drift), or the prune SQL has already grown a
  blocked-dependent guard.
- The pg leg behaves differently from SQLite for the new `NOT EXISTS` (it should
  not — plain ANSI SQL) — report the divergence.
- Reaching 100% coverage forces asserting on wall-clock timing — it should not
  (drive cutoffs with the injected clock / explicit `finished_at`).

## Maintenance notes

- If a future change makes `prune` cascade-fail (rather than retain) a blocked
  dependent whose prerequisite failed, that is an alternative valid fix but it
  changes observable batch counts — decide deliberately and update the invariant
  doc at `queue.ts:250`.
- Reviewer should confirm the guard is inside the prune transaction and that the
  edge/batch sweeps still only touch truly-gone rows.
