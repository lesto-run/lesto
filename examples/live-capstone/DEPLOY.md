# Deploying the live capstone (the long-lived `live()` host)

This is the **first long-lived Lesto deploy target** — reusable framework infra, not capstone-only.
It stands up a HOSTED, clickable instance of the Tier-4 v1 capstone so the local-first `live()` story
is a link, not just a local `bun run serve` (the missing piece behind epic-closure evidence
`L-aa9779f5`: a hosted instance makes the manual browser checklist in `README.md` reproducible for
anyone).

## Why this is NOT the stateless app deploy

The repo-root [`DEPLOY.md`](../../DEPLOY.md) describes Lesto's normal model: a **stateless** web tier
(`lesto serve`) you scale horizontally, with the database as the one durable substrate. **The capstone
on its prod path is the deliberate exception**, because it consumes a Postgres **logical-replication
slot**:

- A slot holds a **dedicated connection** and **pins WAL** until its consumer acks. That is not an
  edge/serverless fit, and not horizontally scalable — so this runs as **one long-lived process**, not
  N stateless replicas. (Edge fan-out — a Durable Object holding shapes for a key range — is ADR 0042's
  deferred vNext.)
- It needs a Postgres with **`wal_level=logical`**, which a stock managed Postgres does not always
  allow (see the host matrix below).
- The deployment — not the framework — **owns slot-lag alerting and the disk-pressure runbook** (the
  ADR 0042 _Consequences_ footgun: a stalled consumer pins WAL and fills the disk). Both are below.

`serve.ts` already owns the slot lifecycle: it drops the slot on `SIGINT`/`SIGTERM`, and on boot drops
any slot a **prior hard crash** left orphaned before recreating it (so a restart never wedges on
`CREATE_REPLICATION_SLOT … already exists`, and a crashed consumer's WAL stops pinning). The app VM
itself is stateless — a connecting client re-snapshots — so only the **Postgres** disk is durable state.

## Pick a host

Fly.io is the natural fit (a persistent VM + a Postgres you can set `wal_level=logical` on); Render and
Railway also work. The one hard requirement is a Postgres you can put in **logical** WAL mode:

| Postgres option                          | `wal_level=logical`?                                             |
| ---------------------------------------- | --------------------------------------------------------------- |
| **Self-run `postgres:16` container**     | ✅ Yes — pass the exact args CI uses (below). Most reproducible. |
| **Fly Postgres** (`fly pg create`)       | ✅ Yes — it's a Postgres app you control; set the config.        |
| **Neon / Supabase** (managed)            | ✅ Yes — both support logical replication (enable it).           |
| **Render Managed Postgres**              | ❌ No — no `wal_level` control; run a container Postgres instead. |
| **Railway Postgres plugin**              | ⚠️ Deploy the `postgres:16` image with the args, not the plugin. |

The **most reproducible** path (byte-for-byte what the `live-capstone-acceptance` CI job runs) is a
self-run `postgres:16`:

```bash
docker run -d --name lesto-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 \
  -e POSTGRES_INITDB_ARGS="-c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10" \
  postgres:16
```

## The container

[`Dockerfile`](./Dockerfile) builds the app for the **prod (pg) path**. Its build context is the **repo
root** (the capstone resolves `@lesto/* : workspace:*` from the monorepo), so build from the root:

```bash
docker build -f examples/live-capstone/Dockerfile -t lesto-live-capstone .
```

It installs the workspace, adds the `pg` peer (exactly as CI does), builds the client bundle, and runs
`serve.ts` with `LESTO_LIVE_SOURCE=pg`, `HOST=0.0.0.0` (so the host's proxy can reach it — the local
default is loopback), and `PORT=3000`.

### Runtime env

| Var                        | Required | Default          | Notes                                                        |
| -------------------------- | -------- | ---------------- | ------------------------------------------------------------ |
| `LESTO_LIVE_SOURCE`        | —        | `pg` (in image)  | `pg` selects the replication path (fail-closed).             |
| `LESTO_LIVE_PG_URL`        | **yes**  | —                | The `wal_level=logical` Postgres. A **secret**.              |
| `HOST`                     | —        | `0.0.0.0` (image)| Bind the machine interface, not loopback.                    |
| `PORT`                     | —        | `3000`           | The port the host routes to.                                 |
| `LESTO_LIVE_SLOT`          | —        | `lesto_capstone` | Slot name (also read by the slot-lag check).                 |
| `LESTO_LIVE_PUBLICATION`   | —        | `lesto_capstone_pub` | Publication name.                                        |

`LESTO_LIVE_SOURCE=pg` **without** `LESTO_LIVE_PG_URL` is a **loud boot error**, never a silent fall
back to the dev SQLite poll — a prod deploy that quietly ran the stand-in would fake the parity claim
(`src/app.ts` → `resolveSourceConfig`).

## Deploy — Fly.io (recommended)

[`fly.toml`](./fly.toml) is the runtime config (rename `app`, set `primary_region`). It pins the app to
**exactly one machine** — a logical-replication slot is a single-writer resource, so two machines would
fight over the same slot name. **Never `fly scale count > 1`.**

```bash
# 1. Create the app (no deploy yet) and a wal_level=logical Postgres.
fly apps create lesto-live-capstone
fly pg create --name lesto-capstone-pg          # then set wal_level=logical on it (fly pg config …),
                                                #   OR point at a Neon/Supabase/self-run PG instead.

# 2. Give the app its Postgres URL as a SECRET (never in fly.toml).
fly secrets set LESTO_LIVE_PG_URL='postgres://…@…:5432/postgres' --app lesto-live-capstone

# 3. Deploy — from the REPO ROOT, so the monorepo is the build context.
fly deploy --config examples/live-capstone/fly.toml \
  --dockerfile examples/live-capstone/Dockerfile .

# 4. Confirm exactly one machine is running.
fly scale count 1 --app lesto-live-capstone
fly status --app lesto-live-capstone
```

Open the app URL, then walk the manual browser checklist in [`README.md`](./README.md) (durable first
paint, offline writes, cross-tab failover).

## Deploy — Render / Railway

Both build the same `Dockerfile` (context = repo root). Configure a **single instance** (no
autoscaling — same single-writer slot reason), set the env vars above (`LESTO_LIVE_PG_URL` as a secret),
and point at a `wal_level=logical` Postgres (a container Postgres or Neon/Supabase, per the matrix).

## Slot-lag alerting + the disk-pressure runbook

This is the operational cost of the replication path, and it is **the deployment's to own**.

### The footgun (ADR 0042 _Consequences_)

A replication slot's `restart_lsn` only advances when its consumer **acks**. If the consumer stalls,
crashes without dropping the slot, or is stopped ungracefully, `restart_lsn` freezes while the server's
WAL keeps advancing — Postgres **retains every WAL segment** back to that frozen point, and the disk
fills. A full Postgres disk stops accepting writes (and can refuse to start).

### The alert: `bun run slot-lag`

[`ops/slot-lag-check.ts`](./ops/slot-lag-check.ts) is a one-shot probe over `pg_replication_slots`. It
exits **Nagios-style** so any monitor reads it — **`0` OK, `1` WARN, `2` CRITICAL**:

```bash
LESTO_LIVE_PG_URL='postgres://…' bun run slot-lag
# [OK] slot "lesto_capstone" active; retained WAL 4.0 MiB (warn 256.0 MiB / crit 1.0 GiB)
```

It grades the slot's retained WAL against thresholds (override with `LESTO_SLOT_LAG_WARN_BYTES` /
`LESTO_SLOT_LAG_CRIT_BYTES`), and **escalates an INACTIVE slot** one notch — a slot with no consumer
attached can only pin more WAL. Wire it on an interval and page on a non-zero exit, e.g. cron:

```cron
*/5 * * * * LESTO_LIVE_PG_URL='postgres://…' bun /repo/examples/live-capstone/ops/slot-lag-check.ts || notify-oncall
```

(or a Fly scheduled machine / your monitor's exec probe). Size the Postgres disk with headroom over the
CRITICAL threshold so the alert fires well before the disk is full.

### Recovery (disk filling / slot lag CRITICAL)

1. **Restart the app** — the clean fix. `serve.ts`'s boot self-heal drops the orphaned slot and
   recreates it; clients re-snapshot (the slot holds no client state, so nothing is lost). This
   immediately unpins the retained WAL.
2. **If the app can't come back and the disk is critical, drop the slot by hand** — it unpins WAL at
   once; the next app boot recreates it:
   ```sql
   SELECT pg_drop_replication_slot('lesto_capstone');   -- unpins retained WAL immediately
   ```
3. **If the disk is 100% full and Postgres won't start**, grow the volume first, then drop the slot.
4. Confirm recovery: `bun run slot-lag` returns `[OK]` and the retained WAL falls.

## Repeatability

The whole target is reproducible from this directory: the `Dockerfile` (build), `fly.toml` (runtime),
`ops/slot-lag-check.ts` (alerting), and the commands above. To re-provision, repeat the "Deploy" steps
against a fresh app + a `wal_level=logical` Postgres. Turning this into infra-as-code (an Alchemy
program) is the natural next step — the ADR 0044 Alchemy convention could own it later.
