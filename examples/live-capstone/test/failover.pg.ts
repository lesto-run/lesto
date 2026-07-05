/**
 * The Tier-4 v1 **real-failover leg** (ADR 0042 Inc4/Inc8, `L-45e1b56b`) — the LSN-exact
 * resume decision proven against a REAL Postgres timeline increment, not a forged cursor.
 *
 * The epic-closing acceptance gate (`test/acceptance.pg.ts`, assertion 6) already proves the (e)
 * resume DECISION logically — it `encodeResumeCursor`s a `timelineId + 1` cursor by hand and asserts
 * a re-snapshot. That is deterministic and needs no standby, and it is enough to cover the BRANCH.
 * What it CANNOT do is prove the branch fires on the mechanic the real world produces: a WAL timeline
 * that increments because a physical standby was `pg_promote`d, with the `systemId` held constant.
 * This leg closes that gap end-to-end:
 *
 *   1. A primary + a **physical streaming-replication standby** (the standby replays the primary's
 *      WAL byte-for-byte; `systemId` shared, both on timeline 1 initially).
 *   2. A live consumer on the PRIMARY captures a REAL v1 `(systemId, timelineId=1, LSN)` resume
 *      cursor off a change frame — a genuine pre-failover position, replicated into the standby's WAL.
 *   3. That consumer STOPS (its slot on the primary is dropped) — then `SELECT pg_promote(...)` turns
 *      the standby into a primary: the timeline INCREMENTS to 2, the `systemId` stays constant.
 *   4. A fresh consumer on the PROMOTED node reconnects. A client presenting its pre-failover cursor
 *      `(systemId, 1, LSN)` RE-SNAPSHOTS against the new timeline — a real `timelineId` mismatch, the
 *      false-continuity trap a `systemId`-only check would miss (the LSN is a plausible position in the
 *      promoted node's shared WAL history, so nothing but the timeline tells the two apart). The
 *      positive control — a live post-failover cursor on the SAME (promoted) timeline — still replays
 *      exactly the missed change with no snapshot, mirroring `acceptance.pg.ts` 6a/6c but with a REAL
 *      increment from `pg_promote`, not a forged one.
 *
 * Like `test/acceptance.pg.ts` and `packages/live-server/test/live/pgoutput-shakeout.ts`, this is a
 * **bun script, not a vitest test** (and lives outside the `*.test.ts` glob): vitest's runner does not
 * sustain a long-lived replication COPY stream (it hangs), whereas the client works under a plain
 * runtime. Exits 0 on all-pass, 1 on any failed assertion, so CI can gate on it.
 *
 * ── Slot / consumer lifecycle across the promote (the single-writer HAZARD, respected) ────────────
 * A logical-replication slot has exactly ONE consumer, ever. This leg never runs two: the pre-failover
 * consumer on the primary is fully STOPPED (its slot dropped, its connection ended) BEFORE the standby
 * is promoted — modeling a real failover where the old primary is gone. The promoted node starts a
 * NEW timeline, and a stock `pg_promote` does NOT carry the old primary's logical slot across (logical
 * slots are not created on a physical standby in PG16), so the post-failover consumer creates a FRESH
 * slot on the promoted node. No split-brain, no two-writer window on any one slot.
 *
 * ── Setup: a primary + a promotable physical standby (docker; EXECUTED, wired to a push/dispatch CI job) ─
 * EXECUTED 2026-07-04 (`L-839c47e8`): the two-node stack below was booted on the OFFICIAL `postgres:16`
 * image and this leg ran end-to-end — 9/9 assertions, exit 0. The console plus a DB-level
 * systemId/timeline proof (systemId constant, timeline 1→2 from a real `pg_promote`) are filed under
 * `evidence/failover-pg.log` + `evidence/failover-pg-identity.txt` + `evidence/failover-pg-proof.json`,
 * making `L-45e1b56b`'s "validates the failover fix end-to-end" claim true. It stays env-gated (needs
 * the two `LESTO_LIVE_PG_*_URL`s). A promotable streaming standby is not expressible as a plain GitHub
 * Actions `services:` image, so CI runs it via a docker-compose-in-job workflow (`live-capstone-failover.yml`,
 * `L-c052144e`) on `push`/`dispatch` — NOT yet a per-PR gate (promotion once a first GH-hosted run is
 * green is tracked in `L-34963d5f`). Two runnable paths:
 *
 *   A) docker-compose (recommended — one command):
 *        docker compose -f examples/live-capstone/docker-compose.failover.yml up -d --wait
 *        LESTO_LIVE_PG_PRIMARY_URL=postgresql://postgres:postgres@localhost:55432/postgres \
 *        LESTO_LIVE_PG_STANDBY_URL=postgresql://postgres:postgres@localhost:55433/postgres \
 *          bun examples/live-capstone/test/failover.pg.ts
 *      (See that compose file's header — official `postgres:16`, `pg_basebackup -R` standby, VERIFIED.)
 *
 *   B) manual, with the official `postgres:16` image + `pg_basebackup` (the streaming-replica recipe):
 *        - Primary: `wal_level=logical`, `max_wal_senders>=10`, `max_replication_slots>=10`,
 *          `hot_standby=on`, a `REPLICATION` role, and a `pg_hba` line allowing replication.
 *        - Standby: `pg_basebackup -h <primary> -D <pgdata> -Fp -Xs -R` (the `-R` writes
 *          `standby.signal` + `primary_conninfo` into PGDATA, PG12+), then boot it on its own port.
 *          `wal_level` follows the primary through `pg_control`, so the promoted node can decode
 *          logically after `pg_promote`.
 *        - Promote it with `SELECT pg_promote(true, 60)` (this leg does that step itself).
 *      A promotion is IRREVERSIBLE — a re-run needs the standby re-built from a fresh `pg_basebackup`
 *      (once promoted it is on the new timeline and can no longer follow the primary).
 */

import type { SqlDatabase } from "@lesto/db";
import { openPostgres } from "@lesto/pg";
import { serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";
import { decodeResumeCursor } from "@lesto/live-server";
import { decodeChangeData, serializeShapeDefinition } from "@lesto/live-protocol";

import { buildApp, CAPSTONE_PUBLICATION } from "../src/app";
import { capstoneTables, messagesInRoom } from "../src/schema";
import { cleanPg, setupPgSchema } from "../src/pg-setup";
import { openSse } from "./harness";
import type { SseClient } from "./harness";

// Two nodes: the primary we capture the pre-failover cursor against, and the physical standby we
// promote. Sane localhost defaults (mirroring `acceptance.pg.ts`), overridable per node.
const PRIMARY_URL =
  process.env.LESTO_LIVE_PG_PRIMARY_URL ??
  "postgresql://postgres:postgres@localhost:55432/postgres";
const STANDBY_URL =
  process.env.LESTO_LIVE_PG_STANDBY_URL ??
  "postgresql://postgres:postgres@localhost:55433/postgres";
const SLOT = "lesto_capstone_failover";
const PUB = CAPSTONE_PUBLICATION;

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

/** One optimistic-row / wire-row shape, typed for the change-frame reads below. */
interface MessageRow extends Record<string, unknown> {
  readonly id: string;
  readonly roomId: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: number;
}

/** The SSE subscribe path for a room's shape (the wire-serialized `ShapeDefinition`). */
function shapePath(room: string): string {
  return `/__lesto/live-data?shape=${encodeURIComponent(serializeShapeDefinition(messagesInRoom(room)))}`;
}

/** Poll `predicate` until true or the deadline — replication + the WAL replay tail are async (~ms). */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Run a parameterless `SELECT` (constants only — no injection surface) and return its single row. */
async function queryOne(
  handle: SqlDatabase,
  sql: string,
): Promise<Record<string, unknown> | undefined> {
  return (await handle.prepare(sql).get([])) as Record<string, unknown> | undefined;
}

/** How many replication slots named `slot` a node currently holds — the WAL-pin count. */
async function slotCount(handle: SqlDatabase, slot: string): Promise<number> {
  const row = await queryOne(
    handle,
    `SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name = '${slot}'`,
  );

  return (row as { n?: number } | undefined)?.n ?? -1;
}

async function main(): Promise<void> {
  const { db: primaryHandle, close: closePrimary } = await openPostgres({
    connectionString: PRIMARY_URL,
  });
  const { db: standbyHandle, close: closeStandby } = await openPostgres({
    connectionString: STANDBY_URL,
  });

  const open: SseClient[] = [];
  let primaryServer: Server | undefined;
  let promotedServer: Server | undefined;
  let primaryBooted: Awaited<ReturnType<typeof buildApp>> | undefined;
  let promotedBooted: Awaited<ReturnType<typeof buildApp>> | undefined;

  const post = (
    server: Server,
    user: string,
    input: { id: string; room: string; body: string },
  ): Promise<Response> =>
    fetch(`http://127.0.0.1:${server.port}/messages?user=${user}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

  const track = async (
    base: string,
    room: string,
    user: string,
    resume?: string,
  ): Promise<SseClient> => {
    const client = await openSse(base, shapePath(room), {
      user,
      ...(resume === undefined ? {} : { lastEventId: resume }),
    });
    open.push(client);

    return client;
  };

  try {
    // ---- 1. Setup sanity: the standby is a REAL physical replica of the primary --------------------
    // A physical `pg_basebackup` standby shares the primary's `system_identifier` (it is a byte copy)
    // and is in recovery until promoted. If either is false, this is not a promotable standby — fail
    // LOUD with the setup pointer rather than silently "pass" against two unrelated primaries.
    if (PRIMARY_URL === STANDBY_URL) {
      check("1. primary and standby URLs are distinct nodes", false, { PRIMARY_URL, STANDBY_URL });

      return;
    }

    const primarySid = (await queryOne(
      primaryHandle,
      "SELECT system_identifier::text AS sid FROM pg_control_system()",
    )) as { sid?: string } | undefined;
    const standbyState = (await queryOne(
      standbyHandle,
      "SELECT pg_is_in_recovery()::text AS in_recovery, (SELECT system_identifier::text FROM pg_control_system()) AS sid",
    )) as { in_recovery?: string; sid?: string } | undefined;

    const standbyIsReplica =
      standbyState?.in_recovery === "true" &&
      standbyState.sid !== undefined &&
      standbyState.sid === primarySid?.sid;
    check(
      "1. the standby is a physical streaming replica in recovery, sharing the primary's systemId",
      standbyIsReplica,
      { primarySid: primarySid?.sid, standby: standbyState },
    );

    if (!standbyIsReplica) return; // not a promotable standby — the setup is wrong; stop here.

    // Clean slate on the PRIMARY (a prior aborted run may have left the slot/publication/tables), then
    // the app's OWN bootstrap. `REPLICA IDENTITY FULL` + the publication + the table stream physically
    // to the standby, so the promoted node inherits them — no setup is (or can be) run against the
    // read-only standby.
    await cleanPg(primaryHandle, { tables: [...capstoneTables], publication: PUB, slots: [SLOT] });
    await setupPgSchema(primaryHandle, { tables: [...capstoneTables], publication: PUB });

    // ---- 2. Pre-failover: a live consumer on the PRIMARY captures a real v1 resume cursor ----------
    primaryBooted = await buildApp({
      handle: primaryHandle,
      source: { kind: "pg", url: PRIMARY_URL, slot: SLOT, publication: PUB },
    });
    if (primaryBooted.source === undefined)
      throw new Error("pg mode must build a replication source (primary)");
    const primarySource = primaryBooted.source;

    await primarySource.start(); // IDENTIFY_SYSTEM → (systemId, timeline 1); creates the slot on the primary
    primaryServer = await serve(primaryBooted.app, { port: 0, host: "127.0.0.1" });
    const primaryBase = `http://127.0.0.1:${primaryServer.port}`;

    const preIdentity = primarySource.identity;

    const preClient = await track(primaryBase, "engineering", "alice");
    await preClient.waitFor((f) => f.event === "snapshot");

    const preId = crypto.randomUUID();
    await post(primaryServer, "alice", { id: preId, room: "engineering", body: "before failover" });
    const preChange = await preClient.waitFor(
      (f) =>
        f.event === "change" && (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === preId,
      5000,
    );
    const preCursor = preChange.id; // a REAL v1 (systemId, timeline 1, LSN) cursor, off the wire

    check(
      "2. booted a live consumer on the primary; captured its identity + a real v1 change cursor",
      preIdentity !== undefined &&
        /^\d+$/.test(preIdentity.systemId) &&
        preCursor.startsWith("v1:"),
      { identity: preIdentity, preCursor },
    );

    // ---- 3. The pre-failover cursor is a genuine position on the primary's timeline (not forged) ---
    const preDecoded = decodeResumeCursor(preCursor);
    check(
      "3. the pre-failover cursor decodes to the primary's (systemId, timelineId) — a real position",
      preDecoded !== undefined &&
        preIdentity !== undefined &&
        preDecoded.systemId === preIdentity.systemId &&
        preDecoded.timelineId === preIdentity.timelineId,
      { preDecoded, preIdentity },
    );
    if (preDecoded === undefined || preIdentity === undefined)
      throw new Error("expected a decodable pre-failover cursor with a captured identity");

    // The pre-failover row must have REPLICATED into the standby's WAL before we promote, so the
    // cursor's LSN is a real position in the promoted node's shared history (the false-continuity trap)
    // — and so the promoted snapshot actually contains the row.
    await waitUntil(async () => {
      const row = (await queryOne(
        standbyHandle,
        `SELECT count(*)::int AS n FROM messages WHERE id = '${preId}'`,
      )) as { n?: number } | undefined;

      return row?.n === 1;
    }, 10_000);

    // STOP the primary consumer BEFORE promoting — its slot on the primary is dropped and its
    // connection ended, so there is never a second consumer alive across the promote (the single-writer
    // hazard). This models the real failover: the old primary is gone.
    for (const client of open.splice(0)) client.close();
    primaryBooted.engine.stop();
    await primarySource.stop();
    if (primaryServer !== undefined) await primaryServer.close();
    primaryServer = undefined;

    // ---- 4. Failover: pg_promote the standby → it becomes a primary on a NEW timeline --------------
    const promoted = (await queryOne(
      standbyHandle,
      "SELECT pg_promote(true, 60)::text AS ok",
    )) as { ok?: string } | undefined;
    await waitUntil(async () => {
      const row = (await queryOne(standbyHandle, "SELECT pg_is_in_recovery()::text AS r")) as
        | { r?: string }
        | undefined;

      return row?.r === "false";
    }, 30_000);
    const stillInRecovery = (await queryOne(standbyHandle, "SELECT pg_is_in_recovery()::text AS r")) as
      | { r?: string }
      | undefined;
    check(
      "4. pg_promote turned the standby into a primary (out of recovery)",
      promoted?.ok === "true" && stillInRecovery?.r === "false",
      { promote: promoted?.ok, inRecovery: stillInRecovery?.r },
    );

    // ---- 5. Post-failover: the promoted node's identity — systemId CONSTANT, timelineId INCREMENTED -
    promotedBooted = await buildApp({
      handle: standbyHandle,
      source: { kind: "pg", url: STANDBY_URL, slot: SLOT, publication: PUB },
    });
    if (promotedBooted.source === undefined)
      throw new Error("pg mode must build a replication source (promoted)");
    const promotedSource = promotedBooted.source;

    await promotedSource.start(); // IDENTIFY_SYSTEM → (systemId, timeline 2); FRESH slot on the promoted node
    promotedServer = await serve(promotedBooted.app, { port: 0, host: "127.0.0.1" });
    const promotedBase = `http://127.0.0.1:${promotedServer.port}`;

    const postIdentity = promotedSource.identity;
    check(
      "5. the promoted node shares the systemId (same cluster) but its timelineId INCREMENTED (real pg_promote)",
      postIdentity !== undefined &&
        postIdentity.systemId === preIdentity.systemId &&
        postIdentity.timelineId > preIdentity.timelineId,
      { pre: preIdentity, promoted: postIdentity },
    );
    if (postIdentity === undefined) throw new Error("expected a captured promoted identity");

    // A keeper subscription keeps the shape entry + its replay ring alive across the resumers' closes,
    // and — crucially — recording ONE post-failover change makes the ring adopt the NEW timeline
    // identity, so the negative arm below hits the REAL `timelineId`-mismatch branch in
    // `ShapeReplayRing.reconcile` rather than the empty-ring short-circuit.
    const keeper = await track(promotedBase, "engineering", "alice");
    await keeper.waitFor((f) => f.event === "snapshot");

    const seedId = crypto.randomUUID();
    await post(promotedServer, "alice", { id: seedId, room: "engineering", body: "after failover" });
    const seedChange = await keeper.waitFor(
      (f) =>
        f.event === "change" &&
        (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === seedId,
      5000,
    );
    const seedCursor = seedChange.id; // a live post-failover v1 (systemId, timeline 2, LSN) cursor

    // ---- 6. The promoted WIRE cursor reflects the SAME real increment (wire ⇔ IDENTIFY_SYSTEM) -----
    const seedDecoded = decodeResumeCursor(seedCursor);
    check(
      "6. the promoted change cursor carries the incremented timelineId (constant systemId), matching IDENTIFY_SYSTEM",
      seedDecoded !== undefined &&
        seedDecoded.systemId === preDecoded.systemId &&
        seedDecoded.timelineId === postIdentity.timelineId &&
        seedDecoded.timelineId > preDecoded.timelineId,
      { preDecoded, seedDecoded, promotedTimeline: postIdentity.timelineId },
    );

    // ---- 7. NEGATIVE ARM: the pre-failover cursor RE-SNAPSHOTS against the promoted timeline --------
    // The ring is now on timeline 2 (the seed above). A client presenting `(systemId, 1, LSN)` — a
    // position whose LSN is a real, plausible point in the shared pre-promotion WAL — must NOT get a
    // false-continuity replay onto the diverged timeline; the `timelineId` mismatch forces the
    // always-correct re-snapshot floor (a `snapshot` frame). This is `acceptance.pg.ts` 6c, but the
    // increment is REAL (from pg_promote), not `encodeResumeCursor`d by hand.
    const reSnap = await track(promotedBase, "engineering", "alice", preCursor);
    await reSnap.waitFor((f) => f.event === "snapshot", 5000);
    // The semantic that matters: a re-snapshot arrived, and NO missed change was replayed onto the
    // slice before it (a false-continuity replay would put a `change` frame ahead of any snapshot).
    const firstSnapshotIdx = reSnap.frames.findIndex((f) => f.event === "snapshot");
    const firstChangeIdx = reSnap.frames.findIndex((f) => f.event === "change");
    check(
      "7. NEGATIVE ARM: a pre-failover cursor RE-SNAPSHOTS against the promoted timeline (real timelineId mismatch), never a false-continuity replay",
      firstSnapshotIdx >= 0 && (firstChangeIdx === -1 || firstSnapshotIdx < firstChangeIdx),
      { firstFrames: reSnap.frames.slice(0, 3).map((f) => f.event) },
    );
    reSnap.close();

    // ---- 8. POSITIVE CONTROL: a live post-failover cursor REPLAYS the missed change, no re-snapshot -
    // On the SAME (promoted) timeline, continuity DOES hold: a client that disconnects and reconnects
    // from a live post-failover cursor replays exactly the change it missed, with no snapshot — the
    // contrast that proves the negative arm above is the timeline mismatch talking, not a blanket
    // "always re-snapshot on the promoted node". (Mirrors `acceptance.pg.ts` 6a.)
    const resumer = await track(promotedBase, "engineering", "alice");
    await resumer.waitFor((f) => f.event === "snapshot");

    const r1 = crypto.randomUUID();
    await post(promotedServer, "alice", { id: r1, room: "engineering", body: "live before reconnect" });
    const liveChange = await resumer.waitFor(
      (f) =>
        f.event === "change" && (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === r1,
      5000,
    );
    const liveCursor = liveChange.id; // (systemId, timeline 2, LSN) — a same-timeline resume position
    resumer.close();

    const r2 = crypto.randomUUID();
    await post(promotedServer, "alice", { id: r2, room: "engineering", body: "missed while away" });
    await keeper.waitFor(
      (f) =>
        f.event === "change" && (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === r2,
      5000,
    ); // the keeper's ring retains r2 across the resumer's absence

    const replayer = await track(promotedBase, "engineering", "alice", liveCursor);
    await replayer.waitFor(
      (f) =>
        f.event === "change" && (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === r2,
      5000,
    );
    check(
      "8. POSITIVE CONTROL: a live post-failover cursor REPLAYS exactly the missed change on the promoted timeline, with no re-snapshot",
      replayer.frames.some(
        (f) =>
          f.event === "change" && (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === r2,
      ) && replayer.frames.every((f) => f.event !== "snapshot"),
      replayer.frames.map((f) => f.event),
    );

    // ---- 9. Teardown: both nodes' slots dropped — no orphaned WAL pin across the failover ----------
    for (const client of open.splice(0)) client.close();
    promotedBooted.engine.stop();
    await promotedSource.stop(); // drops the FRESH slot on the promoted node
    if (promotedServer !== undefined) await promotedServer.close();
    promotedServer = undefined;

    const primarySlots = await slotCount(primaryHandle, SLOT);
    const promotedSlots = await slotCount(standbyHandle, SLOT);
    check(
      "9. both the primary's (pre-failover) and the promoted node's slots are dropped — no orphaned WAL pin",
      primarySlots === 0 && promotedSlots === 0,
      { primarySlots, promotedSlots },
    );
  } finally {
    for (const client of open.splice(0)) client.close();
    promotedBooted?.engine.stop();
    await promotedBooted?.source?.stop().catch(() => {});
    if (promotedServer !== undefined) await promotedServer.close();
    primaryBooted?.engine.stop();
    await primaryBooted?.source?.stop().catch(() => {});
    if (primaryServer !== undefined) await primaryServer.close();
    // Best-effort slate wipe on BOTH nodes (each `cleanPg` swallows its own misses). The standby is
    // writable only AFTER promotion; before it, these are harmless no-ops.
    await cleanPg(primaryHandle, { tables: [...capstoneTables], publication: PUB, slots: [SLOT] });
    await cleanPg(standbyHandle, { tables: [...capstoneTables], publication: PUB, slots: [SLOT] });
    await closePrimary();
    await closeStandby();
  }
}

try {
  await main();
} catch (error) {
  // A thrown timeout (a `waitFor`/`waitUntil` that never resolved), a boot failure, or a missing
  // standby: report it as a hard failure with a non-zero exit, after `main`'s `finally` has already
  // dropped the slots + cleaned up.
  console.error("\n❌ capstone real-failover leg crashed before completing:", error);
  process.exit(1);
}

console.log(
  failures === 0
    ? "\n✅ Tier-4 v1 real-failover leg PASSED — pg_promote's timeline increment drives a real re-snapshot"
    : `\n❌ ${failures} assertion(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
