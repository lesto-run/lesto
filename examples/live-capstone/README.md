# Local-first `live()` — the Tier-4 v1 capstone (ADR 0042 Inc8)

ONE multi-tenant local-first app that proves the whole of Tier-4 v1 **together**, over the **same
`live()` surface** on two change sources — the epic-closing gallery-as-QA gate (`L-b1501de9`).

```ts
// the shipped live() moat method — one query language / one AST / one row type, two runtimes.
// src/schema.ts mints this exact shape; src/main.ts opens it with .query() via createCrossTabLiveQuery.
const messages = live(messagesTable)
  .where(messagesTable.roomId, "eq", room)
  .orderBy(messagesTable.createdAt, "asc")
  .query(); //  LiveQuery<Message> — reads the local store, stays in sync, writable offline
```

What this app puts under one roof (no earlier increment combined all three):

- **The per-row shape-authz matrix** — parameter-level authorization (a bound `room_id` a principal
  may not see is refused at subscribe AND on every re-auth tick), delete-from-shape on a non-PK column
  under `REPLICA IDENTITY FULL`, both membership-revocation mechanisms, and LSN-exact resume vs
  re-snapshot on a failover.
- **Offline writes** — a write made offline is shown at once, is durably logged to OPFS (so it
  survives a reload where the app shell is available), and reconciles through the app's **normal
  authorized `POST`** on reconnect; a rejected write rolls back.
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

`LESTO_LIVE_SOURCE=pg` without `LESTO_LIVE_PG_URL` (and, symmetrically, a URL set while the source is
`poll`) is a **loud boot error**, never a silent fall back to the dev poll — a prod deploy that quietly
ran the stand-in would fake the parity claim.

**Two honest deltas the "identical above the source" row does NOT hide** (the app code is the same
file; these live in the change source, per ADR 0042 _Phasing_): (1) the `REPLICA IDENTITY FULL` /
unique-non-PK registration guards exist only on the **pg** path — a shape that subscribes fine on the
dev poll can be _refused at prod boot_ if its table can't supply the old image (fail-closed, never a
leak, but a boot surprise to know about). (2) The replication path's **snapshot↔tail boundary is
unfenced** (`L-85e3eb10`): a change committing in the tiny window between a subscribe-time snapshot read
and the entry going live can be lost or double-applied until the next reconnect (which re-snapshots and
heals). Both are tracked residuals of v1, not regressions.

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
bun add pg                        # the Postgres change source's optional peer (loaded lazily)
export LESTO_LIVE_SOURCE=pg LESTO_LIVE_PG_URL=postgres://postgres:postgres@localhost:55432/postgres
bun run build && bun run serve    # bootstraps the schema + REPLICA IDENTITY FULL + publication
```

The app is auth-scoped by `?user=` / `?room=` (a session cookie in production): `lobby` is public;
`engineering` is members-only (alice, carol). Try `?user=bob&room=engineering` to see the parameter
authz refuse before any stream opens.

**Deploy story (honest):** the v1 replication path deploys to a **long-lived** bun/node host — a
logical-replication slot consumer is not an edge/serverless fit (it holds a dedicated connection and
pins WAL until it acks). `serve.ts` drops the slot on SIGINT/SIGTERM, and on boot drops any slot a
**prior hard crash** left orphaned before recreating it (so a restart never wedges on
`CREATE_REPLICATION_SLOT … already exists`, and a crashed consumer's WAL stops pinning) — a real
deployment still owns slot-lag alerting + the disk-pressure runbook (ADR 0042 _Consequences_). Edge
fan-out (a Durable Object holding shapes for a key range) is the ADR's deferred vNext. The v0 poll path
has no such constraint.

**[`DEPLOY.md`](./DEPLOY.md)** is the concrete host for that story — the first long-lived Lesto deploy
target (reusable framework infra, not capstone-only): a `Dockerfile` + `fly.toml` for a single
long-lived Fly/Render/Railway machine on a `wal_level=logical` Postgres, the `bun run slot-lag`
alerting probe (`ops/slot-lag-check.ts`), and the disk-pressure recovery runbook.

## The manual browser checklist (the one piece the sandbox cannot run)

OPFS-SQLite and the cross-tab primitives need a real browser — there is no Node/Bun OPFS, and vitest
cannot drive Web Locks / BroadcastChannel across tabs. So, exactly like `examples/live-durable`, the
browser session is manual; the automated gate proves the server/wire half (below). The durable engine
runs in a **dedicated Worker** (`@lesto/live/opfs` → `opfs-worker.ts`), because OPFS's
`createSyncAccessHandle` is Worker-only in every browser (booting it on the main thread was the Inc9
P0 — see [`evidence/`](./evidence/README.md)). After `bun run serve`, in a real browser:

1. **Durable first paint** — send a message, reload: the durable rows repaint from OPFS one async hop
   after an initially-empty first frame (while the OPFS worker boots + hydrates), and always **before
   the stream connects** (the leader opens the SSE only after the store attaches). To prove OPFS — not
   the wire — is the source, block the server's data routes and reload: it still paints (see the
   evidence's network-log proof).
2. **Offline writes** — DevTools → Network → Offline, send a message: it appears at once and is durably
   logged to OPFS; go back online and watch it drain to `POST /messages` and reconcile under its
   client-generated id. (A *reload while fully offline* can't re-fetch the app shell — no service
   worker ships here — so the reload-survival of a pending write is proven over Node SQLite in the gate
   below, not yet in a browser.)
3. **Cross-tab** — open a second tab on the same `?room=`: a follower mirrors the leader with no
   connection of its own. Close the leader tab; the follower is promoted and resumes the stream.

> **Recorded run:** [`evidence/`](./evidence/README.md) holds a real Chromium 149 execution of this
> checklist (screenshots + a network-log proof + notes) as the epic-closure evidence (`L-aa9779f5`) —
> including the "block the server's data routes, still paints from OPFS" durability proof (the
> aborted-request log is the load-bearing artifact — a screenshot alone can't show the wire was
> blocked) and two honest boundaries (a fully-offline *reload* needs a service-worker shell cache this
> example doesn't ship; the status line's message count reads the empty init-time snapshot, so it
> witnesses the empty first frame — the list is authoritative). The regression gate for this class is
> the **filed** headless-browser smoke `L-2e410682`, not yet in CI.

> **Known boundary (`L-f5a4f807`, a filed child of this capstone):** the offline outbox lives on the
> LEADER's store, so a FOLLOWER tab's send takes the plain authorized `POST` and is **not queued** —
> online it lands everywhere via the leader's echo (no follower-local optimistic paint), but offline it
> **fails immediately** and says so in the status line rather than silently dropping the text. Relaying a
> follower's write to the leader's outbox is that follow-up.

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
8. reload rebuild over the real store logic — a pending write re-queues, a held (acked) write rebuilds
   as held (this leg also re-exercises `@lesto/live`'s unit-covered outbox rehydration, end-to-end).
   NB: legs 7–8 run the store over **Node SQLite** (`openSqlite`) — Node has no OPFS, so the OPFS
   *engine* itself is not exercised here; that is the browser's job (`evidence/`, `L-2e410682`). The
   store logic above OPFS is identical on either handle, which is why this leg is meaningful;
9. a server-rejected (403) write rolls back locally and never lands on the server;
10. an at-least-once duplicate-id replay is idempotent (no duplicate row);
11. `stop()` drops the WAL-pinning slot.

Run it locally against the docker Postgres above (install the `pg` peer first — see the prod snippet):

```bash
bun add pg
LESTO_LIVE_PG_URL=postgres://postgres:postgres@localhost:55432/postgres bun run acceptance:pg
```

The **dev-parity leg** (`test/acceptance.sqlite.test.ts`, a normal vitest run via `bun run test`)
proves the SAME app's authz/liveness surface on the SQLite poll — the app code is the same file,
verbatim, so what a developer builds against on SQLite matches prod above the change source.
