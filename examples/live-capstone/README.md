# Local-first `live()` — the Tier-4 v1 capstone (ADR 0042 Inc8)

ONE multi-tenant local-first app that proves the whole of Tier-4 v1 **together**, over the **same
`live()` surface** on two change sources — the epic-closing gallery-as-QA gate (`L-b1501de9`).

```ts
// one query language, one authz seam, one mutation path — two runtimes and two change sources
const messages = db.select().from(messagesTable).where(eq(messagesTable.roomId, room)).live();
```

What this app puts under one roof (no earlier increment combined all three):

- **The per-row shape-authz matrix** — parameter-level authorization (a bound `room_id` a principal
  may not see is refused at subscribe AND on every re-auth tick), delete-from-shape on a non-PK column
  under `REPLICA IDENTITY FULL`, both membership-revocation mechanisms, and LSN-exact resume vs
  re-snapshot on a failover.
- **Offline writes** — a write made offline is shown at once, survives reload (OPFS), and reconciles
  through the app's **normal authorized `POST`** on reconnect; a rejected write rolls back.
- **Cross-tab** — one leader tab holds the sync connection + durable store; the rest mirror it over
  BroadcastChannel; leadership fails over on tab close.

## Dev/prod parity is REAL and stated, not hidden

The app runs on either change source, selected by one **fail-closed** env seam
(`src/app.ts` → `resolveSourceConfig`):

|                             | dev (default)                                               | prod                                         |
| --------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `LESTO_LIVE_SOURCE`         | `poll`                                                      | `pg`                                         |
| change source               | SQLite full-table poll (the v0 stand-in)                    | Postgres logical replication (`pgoutput`)    |
| resume                      | re-snapshots every reconnect (coarse floor)                 | LSN-exact replay, or re-snapshot on failover |
| everything above the source | **identical** — the same `live()`, authz, and mutation path | **identical**                                |

`LESTO_LIVE_SOURCE=pg` without `LESTO_LIVE_PG_URL` is a **loud boot error**, never a silent fall back
to the dev poll — a prod deploy that quietly ran the stand-in would fake the parity claim.

## Run it

```bash
# dev (SQLite poll — zero setup):
bun install                     # from the repo root
cd examples/live-capstone
bun run build                   # vite build -> dist/ (bundles the ~1.1 MB OPFS engine)
bun run serve                   # http://127.0.0.1:3000

# prod (the REAL Postgres logical-replication path):
docker run -d --name lesto-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 \
  -e POSTGRES_INITDB_ARGS="-c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10" \
  postgres:16
LESTO_LIVE_SOURCE=pg LESTO_LIVE_PG_URL=postgres://postgres:postgres@localhost:55432/postgres \
  bun run build && LESTO_LIVE_SOURCE=pg LESTO_LIVE_PG_URL=postgres://postgres:postgres@localhost:55432/postgres \
  bun run serve
```

The app is auth-scoped by `?user=` / `?room=` (a session cookie in production): `lobby` is public;
`engineering` is members-only (alice, carol). Try `?user=bob&room=engineering` to see the parameter
authz refuse before any stream opens.

**Deploy story (honest):** the v1 replication path deploys to a **long-lived** bun/node host — a
logical-replication slot consumer is not an edge/serverless fit (it holds a dedicated connection and
pins WAL until it acks). Edge fan-out (a Durable Object holding shapes for a key range) is the ADR's
deferred vNext. The v0 poll path has no such constraint.

## The manual browser checklist (the one piece the sandbox cannot run)

OPFS-SQLite and the cross-tab primitives need a real browser — there is no Node/Bun OPFS, and vitest
cannot drive Web Locks / BroadcastChannel across tabs. So, exactly like `examples/live-durable`, the
browser session is manual; the automated gate proves the server/wire half (below). After `bun run
serve`, in a real browser:

1. **Durable first paint** — send a message, reload: it repaints instantly from OPFS before the stream
   reconnects.
2. **Offline writes** — DevTools → Network → Offline, send a message (it appears at once and, on
   reload, is STILL there — the outbox persisted it), go back online, watch it drain to `POST
/messages` and reconcile under its client-generated id.
3. **Cross-tab** — open a second tab on the same `?room=`: a follower mirrors the leader with no
   connection of its own. Close the leader tab; the follower is promoted and resumes the stream.

> **Known boundary (`L-f5a4f807`, a filed child of this capstone):** the offline outbox lives on the
> leader's store, so a FOLLOWER tab's send takes the plain authorized `POST` (no follower-local
> optimistic paint — it still appears everywhere via the leader's echo). Write-relay + failover-orphan
> handling is that follow-up.

## The automated gate (`test/acceptance.pg.ts`)

The epic-closing gate. A **bun script, not a vitest test** (vitest hangs on a live replication COPY
stream — the same reason `packages/live-server/test/live/pgoutput-shakeout.ts` is a script), run by CI's
`live-capstone-acceptance` job against a real `wal_level=logical` Postgres. It boots the capstone app
on the real replication path and asserts, over real SSE sockets + a real `POST`:

1. boot on the app's own PG bootstrap (schema + `REPLICA IDENTITY FULL` + publication);
2. (a) a shape bound to a non-member room is refused (403);
3. continuous re-auth — (c cross-relation) membership revoke and (d) session revoke both purge (resync)
   before severing, with the non-resumable sentinel;
4. (c on-row / b) reassigning `room_id` delivers delete-from-shape sub-interval, and a real `DELETE`
   keys correctly under `FULL`;
5. (b) BOTH registration-guard refusal arms on the live catalog (a non-PK filter AND a unique-non-PK key);
6. (e) resume replays from a live cursor, and re-snapshots on a `systemId` OR `timelineId` mismatch;
7. offline reconcile through the **real** `@lesto/live` store + outbox + consumer — no read-your-writes
   flash, durable outbox row removed on echo;
8. reload rebuild — a pending write re-queues, a held (acked) write rebuilds as held;
9. a server-rejected (403) write rolls back locally and never lands on the server;
10. an at-least-once duplicate-id replay is idempotent (no duplicate row);
11. `stop()` drops the WAL-pinning slot.

Run it locally against the docker Postgres above:

```bash
LESTO_LIVE_PG_URL=postgres://postgres:postgres@localhost:55432/postgres bun run acceptance:pg
```

The **dev-parity leg** (`test/acceptance.sqlite.test.ts`, a normal vitest run via `bun run test`)
proves the SAME app's authz/liveness surface on the SQLite poll — so what a developer builds against on
SQLite is byte-identical to prod.
