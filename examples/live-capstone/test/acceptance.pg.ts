/**
 * The Tier-4 v1 **epic-closing acceptance gate** (ADR 0042 Inc8, `L-b1501de9`) — the whole v1 proven
 * TOGETHER on the REAL Postgres logical-replication path, over the actual capstone app: the per-row
 * shape-authz matrix (a)-(e), offline writes reconciled through the real client modules, at-least-once
 * idempotency, and a clean slot drop. It is the gallery-as-QA-gate that closes the local-first epic.
 *
 * Like `packages/live-server/test/live/pgoutput-shakeout.ts`, this is a **bun script, not a vitest
 * test** (and lives outside the `*.test.ts` glob): vitest's runner does not sustain a long-lived
 * replication COPY stream (it hangs), whereas the client works under a plain runtime. And like the
 * shakeout it needs a real logical-replication Postgres:
 *
 *   1. docker run -d --name lesto-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 \
 *        -e POSTGRES_INITDB_ARGS="-c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10" \
 *        postgres:16
 *   2. LESTO_LIVE_PG_URL=postgres://postgres:postgres@localhost:55432/postgres \
 *        bun examples/live-capstone/test/acceptance.pg.ts
 *
 * Exits 0 on success, 1 on any failed assertion (so CI gates on it). CI wires this as the
 * `live-capstone-acceptance` job. The browser-only guarantees (OPFS durability across reload, the
 * cross-tab BroadcastChannel relay + failover) are proven by `@lesto/live`'s injected-seam unit tests
 * + the manual browser checklist in `README.md` — the ratified fork-A scope; this gate proves the
 * server/wire half AND drives the REAL client store/outbox/consumer for the offline-reconcile leg.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { defineTable, eq, text } from "@lesto/db";
import { openPostgres } from "@lesto/pg";
import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";
import { createLiveMutations, createLiveQuery, createSqliteLiveStore } from "@lesto/live";
import type { MutationOutcome } from "@lesto/live";
import {
  createReplicaIdentityProbe,
  createShapeEngine,
  decodeResumeCursor,
  encodeResumeCursor,
} from "@lesto/live-server";
import { decodeChangeData, serializeShapeDefinition } from "@lesto/live-protocol";
import type { ShapeDefinition } from "@lesto/live-protocol";

import { buildApp, CAPSTONE_PUBLICATION, revokeMembership, revokeSession } from "../src/app";
import { capstoneTables, messages, messagesInRoom } from "../src/schema";
import { cleanPg, setupPgSchema } from "../src/pg-setup";
import { fetchLiveEnvironment, openSse } from "./harness";
import type { SseClient } from "./harness";

const URL =
  process.env.LESTO_LIVE_PG_URL ?? "postgresql://postgres:postgres@localhost:55432/postgres";
const SLOT = "lesto_capstone_acceptance";
const PUB = CAPSTONE_PUBLICATION;
const PROBE_TABLE = "capstone_probe_default";

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

/** One optimistic-row / wire-row shape, typed for the reads below. */
interface MessageRow extends Record<string, unknown> {
  readonly id: string;
  readonly roomId: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: number;
}

/** Poll `predicate` until true or the deadline — the replication tail is async (~ms). */
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

/**
 * A grace-timer scheduler for {@link createLiveMutations} that `unref`s its timer so a held write's
 * long grace `setTimeout` (60s in the reload legs) cannot keep the process's event loop alive after the
 * assertions finish. Correctness never depends on it — the real backstop is the 60s `graceMs` (the echo
 * always wins) plus the final `process.exit` — it just mirrors the repo's `unref` timer discipline.
 */
function unrefSchedule(cb: () => void, ms: number): void {
  const timer = setTimeout(cb, ms);

  (timer as { unref?: () => void }).unref?.();
}

/** The SSE subscribe path for a room's shape. */
function shapePath(room: string): string {
  return `/__lesto/live-data?shape=${encodeURIComponent(serializeShapeDefinition(messagesInRoom(room)))}`;
}

/** A temp SQLite path for a real durable client store (unique per use). */
let tmpSeq = 0;
function tmpFile(): string {
  return `${tmpdir()}/lesto-capstone-${process.pid}-${tmpSeq++}.sqlite3`;
}

async function main(): Promise<void> {
  const { db: handle, close } = await openPostgres({ connectionString: URL });

  // Clean slate (a prior aborted run may have left the slot/publication/tables), then the app's OWN
  // bootstrap — the same migration `serve.ts` runs in prod, not a test-private one.
  await cleanPg(handle, { tables: [...capstoneTables], publication: PUB, slots: [SLOT] });
  await handle.exec(`DROP TABLE IF EXISTS ${PROBE_TABLE}`).catch(() => {});
  await setupPgSchema(handle, { tables: [...capstoneTables], publication: PUB });

  const booted = await buildApp({
    handle,
    source: { kind: "pg", url: URL, slot: SLOT, publication: PUB },
    reauthMs: 300, // so (c)/(d) don't wait the 60s production default
  });

  if (booted.source === undefined) throw new Error("pg mode must build a replication source");

  const source = booted.source;
  const open: SseClient[] = [];
  const tmpFiles: string[] = [];
  let server: Server | undefined;

  const post = (
    user: string,
    input: { id: string; room: string; body: string },
  ): Promise<Response> =>
    fetch(`http://127.0.0.1:${server!.port}/messages?user=${user}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

  try {
    await source.start();
    server = await serve(booted.app, { port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${server.port}`;

    const track = async (room: string, user: string, resume?: string): Promise<SseClient> => {
      const client = await openSse(base, shapePath(room), {
        user,
        ...(resume === undefined ? {} : { lastEventId: resume }),
      });
      open.push(client);

      return client;
    };

    // ---- 1. Boot on the app's own Postgres path -------------------------------------------------
    check(
      "1. booted on the real logical-replication path (identity captured, server up)",
      source.identity !== undefined && /^\d+$/.test(source.identity.systemId) && server.port > 0,
      { identity: source.identity, port: server.port },
    );

    // ---- 2. (a) parameter-authz refusal ---------------------------------------------------------
    const denied = await fetch(`${base}${shapePath("engineering")}&user=bob`, {
      headers: { accept: "text/event-stream" },
    });
    await denied.text();
    const allowedController = new AbortController();
    const allowed = await fetch(`${base}${shapePath("engineering")}&user=alice`, {
      headers: { accept: "text/event-stream" },
      signal: allowedController.signal,
    });
    allowedController.abort();
    check(
      "2. (a) a shape bound to a non-member room is refused (403); a member's opens (200)",
      denied.status === 403 && allowed.status === 200,
      { denied: denied.status, allowed: allowed.status },
    );

    // ---- 3. Continuous re-auth: (c) cross-relation + (d) session, purge-before-sever -------------
    const carol = await track("engineering", "carol");
    await carol.waitFor((f) => f.event === "snapshot");
    revokeMembership("carol", "engineering"); // a relation the messages stream cannot observe
    const carolResync = await carol.waitFor((f) => f.event === "resync", 2000);
    check(
      "3a. (c cross-relation) membership revoke purges the slice (resync) within the re-auth interval",
      carolResync.event === "resync",
    );
    check(
      "3b. the resync frame carries the NON-resumable sentinel (a reconnect re-snapshots, never replays onto a purged slice)",
      carolResync.id === "v0:resync",
      carolResync.id,
    );

    const sessionUser = await track("lobby", "bob");
    await sessionUser.waitFor((f) => f.event === "snapshot");
    revokeSession("bob"); // valid membership (lobby is public), invalid session — the (d) axis
    const sessionResync = await sessionUser.waitFor((f) => f.event === "resync", 2000);
    check(
      "3c. (d) a revoked session purges (resync w/ the non-resumable sentinel) within the re-auth interval even while membership holds",
      sessionResync.event === "resync" && sessionResync.id === "v0:resync",
    );

    // ---- 4. (c on-row) / (b) delete-from-shape live on a FULL table ------------------------------
    const alice = await track("engineering", "alice");
    await alice.waitFor((f) => f.event === "snapshot");

    const reassignId = crypto.randomUUID();
    check(
      "4a. authorized write accepted (201)",
      (await post("alice", { id: reassignId, room: "engineering", body: "reassign me" })).status ===
        201,
    );
    await alice.waitFor(
      (f) => f.event === "change" && decodeChangeData(f.data).op === "insert",
      3000,
    );
    // Move the row OUT of the shape by reassigning its OWN room_id (a non-PK column) — the replication
    // classifier needs the OLD image (REPLICA IDENTITY FULL) to see it left, and emits delete-from-shape.
    await booted.db
      .update(messages)
      .set({ roomId: "lobby" })
      .where(eq(messages.id, reassignId))
      .run();
    let sawReassignDelete = false;
    await waitUntil(() => {
      sawReassignDelete = alice.frames.some(
        (f) => f.event === "change" && decodeChangeData(f.data).op === "delete",
      );

      return sawReassignDelete;
    }, 3000);
    check(
      "4b. (c on-row / b) reassigning room_id delivers delete-from-shape sub-interval, no re-auth wait",
      sawReassignDelete,
    );

    // A REAL DELETE keys correctly under FULL (the old image carries the client key).
    const deleteId = crypto.randomUUID();
    await post("alice", { id: deleteId, room: "engineering", body: "delete me" });
    await alice.waitFor(
      (f) =>
        f.event === "change" &&
        (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === deleteId,
      3000,
    );
    await booted.db.delete(messages).where(eq(messages.id, deleteId)).run();
    let sawRealDelete = false;
    await waitUntil(() => {
      sawRealDelete = alice.frames.some(
        (f) =>
          f.event === "change" && (decodeChangeData(f.data) as { key?: string }).key === deleteId,
      );

      return sawRealDelete;
    }, 3000);
    check("4c. (b) a real DELETE under FULL keys the delete-from-shape correctly", sawRealDelete);

    // ---- 5. (b) BOTH refusal arms on the live catalog (a table left REPLICA IDENTITY DEFAULT) ----
    await handle.exec(
      `CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (id text primary key, slug text unique, room_id text, body text)`,
    );
    // NOTE: deliberately NOT set REPLICA IDENTITY FULL — the guard must refuse a shape that needs the
    // old image on it. A separate engine so the app's registry stays clean; it shares the app's source.
    const probeCols = {
      id: text("id").primaryKey(),
      slug: text("slug").unique(),
      roomId: text("room_id"),
      body: text("body"),
    };
    const probeTable = defineTable(PROBE_TABLE, probeCols);
    const probeEngine = createShapeEngine({
      db: booted.db,
      tables: [probeTable],
      replication: { source, replicaIdentity: createReplicaIdentityProbe(URL) },
    });

    const refusalCode = async (def: ShapeDefinition): Promise<string | undefined> => {
      try {
        await probeEngine.subscribe(def, () => {});

        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };

    const filterArm = await refusalCode({
      table: PROBE_TABLE,
      key: "id",
      columns: ["id", "slug", "roomId", "body"],
      where: [{ column: "roomId", op: "eq", value: "x" }],
      orderBy: undefined,
    });
    const keyArm = await refusalCode({
      table: PROBE_TABLE,
      key: "slug",
      columns: ["id", "slug", "roomId", "body"],
      where: [],
      orderBy: undefined,
    });
    probeEngine.stop();
    check(
      "5. (b) BOTH refusal arms refuse at registration on a non-FULL table (non-PK filter AND unique-non-PK key)",
      filterArm === "LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT" &&
        keyArm === "LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT",
      { filterArm, keyArm },
    );

    // ---- 6. (e) resume at the wire: replay vs re-snapshot on identity match/mismatch -------------
    // A keeper subscription keeps the shape entry + its replay ring alive across the resumer's close.
    const keeper = await track("engineering", "alice");
    await keeper.waitFor((f) => f.event === "snapshot");
    const resumer1 = await track("engineering", "alice");
    await resumer1.waitFor((f) => f.event === "snapshot");

    const r1 = crypto.randomUUID();
    await post("alice", { id: r1, room: "engineering", body: "before disconnect" });
    const c1Frame = await resumer1.waitFor(
      (f) =>
        f.event === "change" && (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === r1,
      3000,
    );
    const realCursor = c1Frame.id; // a real v1 (systemId, timelineId, LSN) cursor
    resumer1.close();

    const r2 = crypto.randomUUID();
    await post("alice", { id: r2, room: "engineering", body: "while disconnected" });
    await keeper.waitFor(
      (f) =>
        f.event === "change" && (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === r2,
      3000,
    );

    // Positive control: resume from the real cursor → REPLAY the missed r2 change, NO snapshot frame.
    const replayer = await track("engineering", "alice", realCursor);
    await replayer.waitFor(
      (f) =>
        f.event === "change" && (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === r2,
      3000,
    );
    check(
      "6a. (e) resume from a live cursor REPLAYS exactly the missed change, with no re-snapshot",
      replayer.frames.some(
        (f) =>
          f.event === "change" && (decodeChangeData(f.data) as { row?: MessageRow }).row?.id === r2,
      ) && replayer.frames.every((f) => f.event !== "snapshot"),
      replayer.frames.map((f) => f.event),
    );

    const decoded = decodeResumeCursor(realCursor);
    if (decoded === undefined)
      throw new Error("expected a decodable v1 cursor from the change frame");

    // Forged systemId (a different cluster) → re-snapshot, never a false-continuity replay.
    const forgedSystem = encodeResumeCursor({ ...decoded, systemId: `${decoded.systemId}9` });
    const reSnapA = await track("engineering", "alice", forgedSystem);
    const snapA = await reSnapA.waitFor((f) => f.event === "snapshot", 3000);
    check(
      "6b. (e) a systemId mismatch re-snapshots (different cluster)",
      snapA.event === "snapshot",
    );

    // Forged timelineId only (a same-cluster failover — the case a systemId-only check would MISS).
    const forgedTimeline = encodeResumeCursor({ ...decoded, timelineId: decoded.timelineId + 1 });
    const reSnapB = await track("engineering", "alice", forgedTimeline);
    const snapB = await reSnapB.waitFor((f) => f.event === "snapshot", 3000);
    check(
      "6c. (e) a timelineId mismatch re-snapshots (same-cluster failover the systemId-only check misses)",
      snapB.event === "snapshot",
    );

    // ---- 7. Offline reconcile through the REAL client store + outbox + consumer ------------------
    const lobbyDef = messagesInRoom("lobby");
    const file = tmpFile();
    tmpFiles.push(file);
    const { db: storeDb, close: closeStore } = await openSqlite(file);
    const store = await createSqliteLiveStore({ def: lobbyDef, db: storeDb });

    let online = false;
    const submit = async (_name: string, input: unknown): Promise<MutationOutcome> => {
      if (!online) return "retry"; // the ordinary offline case
      const response = await post("alice", input as { id: string; room: string; body: string });

      if (response.ok) return "ok";

      return response.status >= 400 && response.status < 500 ? "rejected" : "retry";
    };
    // A long grace so the replication echo (arriving in ms) always wins the read-your-writes race —
    // never the grace backstop; that keeps the no-flash assertion about the echo, not the timer.
    const outbox = createLiveMutations({ store, submit, graceMs: 60_000, schedule: unrefSchedule });

    // Drive the REAL consumer over the fetch shim, so real snapshot/change frames apply to the store.
    const query = createLiveQuery<MessageRow>(lobbyDef, {
      store,
      environment: fetchLiveEnvironment(base, "alice"),
    });
    await waitUntil(() => store.getCursor() !== undefined, 3000); // initial snapshot applied

    const w = crypto.randomUUID();
    let flashed = false;
    let submitted = false;
    const unsub = query.subscribe(() => {
      if (submitted && !query.getSnapshot().some((row) => row.id === w)) flashed = true;
    });

    // Offline: submit is optimistic-only (shown at once, durably logged), never posts.
    outbox.submit({
      name: "messages",
      input: { id: w, room: "lobby", body: "written offline" },
      optimistic: {
        op: "insert",
        key: w,
        row: {
          id: w,
          roomId: "lobby",
          author: "alice",
          body: "written offline",
          createdAt: Date.now(),
        },
      },
    });
    submitted = true;
    check(
      "7a. an offline write is applied optimistically (shown at once)",
      query.getSnapshot().some((row) => row.id === w),
    );

    // Online: drive the outbox drain to completion through the REAL authorized POST. The offline
    // submit above started a drain that suspended on a synchronous "retry" (draining === true), so a
    // single `flush()` would only JOIN that stale drain (which exits without posting). Loop `flush()`
    // until the queue actually drains — the first call joins the stale drain, a fresh one then posts w.
    online = true;
    await waitUntil(async () => {
      await outbox.flush();

      return outbox.pending() === 0; // w has been POSTed and acked (now held, awaiting its echo)
    }, 8000);

    // The write is acked + held; now the pgoutput echo lands under the same client key and settles the
    // held overlay in the SAME store mutation (no flash), which clears the durable outbox row. Assert
    // the CLEARED state explicitly — `waitUntil` swallows its timeout, so its result must be captured.
    let outboxCleared = false;
    await waitUntil(async () => {
      const row = (await storeDb
        .prepare("SELECT count(*) AS n FROM lesto_live_outbox")
        .get([])) as {
        n: number;
      };

      return (outboxCleared = row.n === 0);
    }, 8000);

    check(
      "7b. the write reconciles with NO read-your-writes flash (held until the echo lands)",
      !flashed,
    );
    check(
      "7c. the durable outbox row is removed once the echo settles, and the row is still shown",
      outboxCleared && query.getSnapshot().some((row) => row.id === w),
    );

    unsub();
    query.disconnect();
    await store.whenIdle();
    await closeStore();

    // ---- 8. Reload rebuild (real durable store, no live echo — deterministic) --------------------
    // 8a: a PENDING offline write survives reload and re-queues.
    const pendingFile = tmpFile();
    tmpFiles.push(pendingFile);
    const p = crypto.randomUUID();
    {
      const opened = await openSqlite(pendingFile);
      const s = await createSqliteLiveStore({ def: lobbyDef, db: opened.db });
      const box = createLiveMutations({ store: s, submit: async () => "retry" }); // stays offline
      box.submit({
        name: "messages",
        input: { id: p, room: "lobby", body: "pending" },
        optimistic: {
          op: "insert",
          key: p,
          row: { id: p, roomId: "lobby", author: "alice", body: "pending", createdAt: Date.now() },
        },
      });
      await s.whenIdle();
      await opened.close();
    }
    {
      const reopened = await openSqlite(pendingFile);
      const s = await createSqliteLiveStore({ def: lobbyDef, db: reopened.db });
      const box = createLiveMutations({ store: s, submit: async () => "retry" });
      check(
        "8a. a pending offline write survives reload (shown, re-queued)",
        (s.getRows() as MessageRow[]).some((row) => row.id === p) && box.pending() === 1,
        { rows: s.getRows().length, pending: box.pending() },
      );
      await reopened.close();
    }

    // 8b: a HELD (acked, not-yet-echoed) write rebuilds as held — shown, but NOT re-queued.
    const heldFile = tmpFile();
    tmpFiles.push(heldFile);
    const h = crypto.randomUUID();
    {
      const opened = await openSqlite(heldFile);
      const s = await createSqliteLiveStore({ def: lobbyDef, db: opened.db });
      // A long grace so the held mark persists to disk before any backstop could clear it (no live echo).
      const box = createLiveMutations({
        store: s,
        submit: async () => "ok",
        graceMs: 60_000,
        schedule: unrefSchedule,
      });
      box.submit({
        name: "messages",
        input: { id: h, room: "lobby", body: "held" },
        optimistic: {
          op: "insert",
          key: h,
          row: { id: h, roomId: "lobby", author: "alice", body: "held", createdAt: Date.now() },
        },
      });
      await waitUntil(() => box.pending() === 0, 2000); // ack drops it from the queue (held, not cleared)
      await s.whenIdle();
      await opened.close();
    }
    {
      const reopened = await openSqlite(heldFile);
      const s = await createSqliteLiveStore({ def: lobbyDef, db: reopened.db });
      const box = createLiveMutations({
        store: s,
        submit: async () => "ok",
        schedule: unrefSchedule,
      });
      check(
        "8b. a held (acked) write rebuilds as held on reload (shown, NOT re-queued)",
        (s.getRows() as MessageRow[]).some((row) => row.id === h) && box.pending() === 0,
        { rows: s.getRows().length, pending: box.pending() },
      );
      await reopened.close();
    }

    // ---- 9. Reject rollback: a cross-tenant write → 403 → rolled back, server untouched ----------
    const rejectFile = tmpFile();
    tmpFiles.push(rejectFile);
    const z = crypto.randomUUID();
    const opened = await openSqlite(rejectFile);
    const rejectStore = await createSqliteLiveStore({
      def: messagesInRoom("engineering"),
      db: opened.db,
    });
    // The submit posts as BOB (not an `engineering` member) → the server refuses (403) → "rejected".
    const rejectBox = createLiveMutations({
      store: rejectStore,
      submit: async (_n, input) => {
        const response = await post("bob", input as { id: string; room: string; body: string });

        return response.ok
          ? "ok"
          : response.status >= 400 && response.status < 500
            ? "rejected"
            : "retry";
      },
    });
    rejectBox.submit({
      name: "messages",
      input: { id: z, room: "engineering", body: "cross-tenant" },
      optimistic: {
        op: "insert",
        key: z,
        row: {
          id: z,
          roomId: "engineering",
          author: "bob",
          body: "cross-tenant",
          createdAt: Date.now(),
        },
      },
    });
    const shownBeforeReject = (rejectStore.getRows() as MessageRow[]).some((row) => row.id === z);
    await rejectBox.flush();
    await waitUntil(
      () => !(rejectStore.getRows() as MessageRow[]).some((row) => row.id === z),
      3000,
    );
    const serverRows = await booted.db.select().from(messages).where(eq(messages.id, z)).all();
    check(
      "9. a server-rejected (403) write is rolled back locally and never landed on the server",
      shownBeforeReject &&
        !(rejectStore.getRows() as MessageRow[]).some((row) => row.id === z) &&
        serverRows.length === 0,
      { shownBeforeReject, serverRows: serverRows.length },
    );
    await rejectStore.whenIdle();
    await opened.close();

    // ---- 10. At-least-once idempotency: a duplicate-id replay is idempotent success -------------
    const dup = crypto.randomUUID();
    const first = await post("alice", { id: dup, room: "lobby", body: "once" });
    const second = await post("alice", { id: dup, room: "lobby", body: "once" });
    const dupRows = await booted.db.select().from(messages).where(eq(messages.id, dup)).all();
    check(
      "10. an at-least-once duplicate-id replay is idempotent success — no duplicate row",
      first.status === 201 && second.status === 200 && dupRows.length === 1,
      { first: first.status, second: second.status, rows: dupRows.length },
    );

    // ---- 11. Teardown drops the WAL-pinning slot ------------------------------------------------
    booted.engine.stop();
    await source.stop();
    const slotRow = (await handle
      .prepare(`SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name = '${SLOT}'`)
      .get([])) as { n: number } | undefined;
    check(
      "11. stop() dropped the replication slot (no orphaned WAL pin)",
      slotRow?.n === 0,
      slotRow,
    );
  } finally {
    for (const client of open.splice(0)) client.close();
    booted.engine.stop();
    await source.stop().catch(() => {});
    if (server !== undefined) await server.close();
    await cleanPg(handle, { tables: [...capstoneTables], publication: PUB, slots: [SLOT] });
    await handle.exec(`DROP TABLE IF EXISTS ${PROBE_TABLE}`).catch(() => {});
    await close();
    for (const file of tmpFiles) {
      await rm(file, { force: true }).catch(() => {});
      await rm(`${file}-wal`, { force: true }).catch(() => {});
      await rm(`${file}-shm`, { force: true }).catch(() => {});
    }
  }
}

try {
  await main();
} catch (error) {
  // A thrown timeout (a `waitFor` that never resolved) or a boot failure: report it as a hard failure
  // with a non-zero exit, after `main`'s own `finally` has already dropped the slot + cleaned up.
  console.error("\n❌ capstone acceptance crashed before completing:", error);
  process.exit(1);
}

console.log(
  failures === 0
    ? "\n✅ Tier-4 v1 capstone acceptance PASSED — the epic-closing gate is green"
    : `\n❌ ${failures} assertion(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
