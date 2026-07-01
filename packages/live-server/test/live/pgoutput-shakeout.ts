/**
 * Live-Postgres shakeout for the REAL pgoutput replication client (ADR 0042 Tier 4, L-4b7edd48).
 *
 * This is the CI/manual integration proof for the coverage-excluded socket wiring in
 * `../../src/pg-replication-client.ts` — the part no unit test can reach (the pure decoders are
 * unit-tested against real captured bytes in `pgoutput.test.ts` / `wal2json.test.ts`). It drives
 * the actual `createPgReplicationSource` + `createPgReplicationClientFactory` against a real
 * logical-replication slot and asserts the end-to-end contract: insert/update/delete arrive with
 * the right images, a real commit LSN, and the connection's system identity, and `stop()` drops
 * the slot (no orphaned WAL pin).
 *
 * It is a **bun script, not a vitest test** (and lives outside the `*.test.ts` glob) on purpose:
 * vitest's runner does not sustain the long-lived replication COPY stream (it hangs), whereas the
 * client works under a plain runtime — so this is the honest, reproducible harness.
 *
 *   1. spin a logical-replication Postgres, e.g.:
 *      docker run -d --name lesto-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=lesto_live \
 *        -p 55432:5432 debezium/postgres:16
 *   2. bun packages/live-server/test/live/pgoutput-shakeout.ts
 *      # or: LESTO_LIVE_PG_URL=postgres://user:pw@host:port/db bun …/pgoutput-shakeout.ts
 *
 * Exits 0 on success, 1 on any failed assertion (so CI can gate on it).
 */

import { createRequire } from "node:module";

import { createDb, defineTable, integer, text } from "@lesto/db";
import type { SqlDatabase } from "@lesto/db";
import type { ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

import { createShapeEngine } from "../../src/engine";
import { createReplicaIdentityProbe } from "../../src/pg-catalog";
import { createPgReplicationClientFactory } from "../../src/pg-replication-client";
import { createPgReplicationSource } from "../../src/replication";
import type { ReplicationChange } from "../../src/replication";

const URL =
  process.env.LESTO_LIVE_PG_URL ?? "postgresql://postgres:postgres@localhost:55432/lesto_live";
const SLOT = "lesto_shakeout";
const PUB = "lesto_shakeout_pub";
// The engine phase (Inc2 wiring) uses its own slot/publication + two tables so it never collides
// with the raw-decoder phase above.
const ENGINE_SLOT = "lesto_shakeout_engine";
const ENGINE_PUB = "lesto_shakeout_engine_pub";

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

interface AdminClient {
  connect(): Promise<void>;
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  end(): Promise<void>;
}

const require = createRequire(import.meta.url);
const { Client } = require("pg") as { Client: new (c: string) => AdminClient };
const admin = new Client(URL);
await admin.connect();

const cleanup = async (): Promise<void> => {
  for (const slot of [SLOT, ENGINE_SLOT]) {
    await admin
      .query(
        `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name='${slot}' AND active_pid IS NOT NULL`,
      )
      .catch(() => {});
    await admin
      .query(
        `SELECT pg_drop_replication_slot('${slot}') FROM pg_replication_slots WHERE slot_name='${slot}'`,
      )
      .catch(() => {});
  }
  await admin.query(`DROP PUBLICATION IF EXISTS ${PUB}`).catch(() => {});
  await admin.query(`DROP PUBLICATION IF EXISTS ${ENGINE_PUB}`).catch(() => {});
  await admin.query("DROP TABLE IF EXISTS shakeout_messages").catch(() => {});
  await admin.query("DROP TABLE IF EXISTS shakeout_full").catch(() => {});
  await admin.query("DROP TABLE IF EXISTS shakeout_default").catch(() => {});
};

/** Translate `?` placeholders to `$n` for parity with the real `@lesto/pg` adapter. */
const translate = (sql: string): string => {
  let n = 0;

  return sql.replace(/\?/g, () => `$${++n}`);
};

/**
 * A minimal {@link SqlDatabase} over the admin `pg` connection, just enough for the engine's
 * parameterless snapshot read (`SELECT … FROM <table>`).
 */
const makeSqlDb = (client: AdminClient): SqlDatabase => {
  const db: SqlDatabase = {
    exec: async (sql) => {
      await client.query(sql);
    },
    prepare: (sql) => ({
      run: async (params = []) => {
        await client.query(translate(sql), params as unknown[]);

        return { changes: 0 };
      },
      get: async (params = []) => (await client.query(translate(sql), params as unknown[])).rows[0],
      all: async (params = []) => [
        ...(await client.query(translate(sql), params as unknown[])).rows,
      ],
    }),
    transaction: async (fn) => fn(db),
  };

  return db;
};

const poll = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
};

// A room-1 shape (filters the NON-key room_id, so it needs the old image → REPLICA IDENTITY FULL).
const room1 = (table: string): ShapeDefinition => ({
  table,
  key: "id",
  columns: ["id", "roomId", "body"],
  where: [{ column: "roomId", op: "eq", value: 1 }],
  orderBy: undefined,
});

try {
  await cleanup();
  await admin.query(
    "CREATE TABLE shakeout_messages (id serial primary key, room_id int, body text)",
  );
  await admin.query("ALTER TABLE shakeout_messages REPLICA IDENTITY FULL");
  await admin.query(`CREATE PUBLICATION ${PUB} FOR TABLE shakeout_messages`);
  console.log("setup: table + REPLICA IDENTITY FULL + publication");

  const changes: ReplicationChange[] = [];
  const source = createPgReplicationSource({
    createClient: createPgReplicationClientFactory(URL, { publication: PUB }),
    slot: SLOT,
  });
  source.onError((error) => console.log("source error:", (error as Error)?.message));
  source.onChange((change) => changes.push(change));

  await source.start();
  console.log("source started, identity:", JSON.stringify(source.identity));

  try {
    await admin.query("INSERT INTO shakeout_messages (room_id, body) VALUES (42, 'hi')");
    await admin.query("UPDATE shakeout_messages SET room_id = 99 WHERE body = 'hi'");
    await admin.query("DELETE FROM shakeout_messages WHERE body = 'hi'");
    await poll(() => changes.length >= 3);
  } finally {
    await source.stop();
  }

  check(
    "delivered insert → update → delete in order",
    JSON.stringify(changes.map((c) => c.op)) === JSON.stringify(["insert", "update", "delete"]),
    changes.map((c) => c.op),
  );

  const identity = source.identity;
  check("captured a real system identity", !!identity && /^\d+$/.test(identity.systemId), identity);

  for (const change of changes) {
    check(
      `  ${change.op}: stamped with connection identity`,
      change.systemId === identity?.systemId && change.timelineId === identity?.timelineId,
      change,
    );
    check(
      `  ${change.op}: real commit LSN (not 0/0)`,
      /^[0-9A-F]+\/[0-9A-F]+$/.test(change.commitLSN) && change.commitLSN !== "0/0",
      change.commitLSN,
    );
  }

  const insert = changes[0] as Extract<ReplicationChange, { op: "insert" }> | undefined;
  const update = changes[1] as Extract<ReplicationChange, { op: "update" }> | undefined;
  const del = changes[2] as Extract<ReplicationChange, { op: "delete" }> | undefined;
  check(
    "insert newImage (text-encoded pgoutput values)",
    insert?.newImage.room_id === "42" && insert?.newImage.body === "hi",
    insert?.newImage,
  );
  check(
    "update oldImage present (REPLICA IDENTITY FULL)",
    update?.oldImage.room_id === "42",
    update?.oldImage,
  );
  check("update newImage", update?.newImage.room_id === "99", update?.newImage);
  check(
    "delete oldImage (full old row)",
    del?.oldImage.room_id === "99" && del?.oldImage.body === "hi",
    del?.oldImage,
  );

  const { rows } = await admin.query(
    `SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name='${SLOT}'`,
  );
  check("stop() dropped the slot (no orphaned WAL pin)", rows[0]?.n === 0, rows[0]);

  // -------------------------------------------------------------------------
  // Engine phase (ADR 0042 Inc2 wiring): the shape engine consuming the LIVE source, exercising
  // the registration guard (a non-key shape on a non-FULL table is refused) and delete-from-shape
  // end-to-end on a FULL table — the parts no unit test can reach without a live REPLICA IDENTITY.
  // -------------------------------------------------------------------------
  console.log("\nengine phase: shape engine over the live source");

  await admin.query("CREATE TABLE shakeout_full (id serial primary key, room_id int, body text)");
  await admin.query("ALTER TABLE shakeout_full REPLICA IDENTITY FULL");
  // shakeout_default keeps REPLICA IDENTITY DEFAULT on purpose — the guard must refuse a non-key shape on it.
  await admin.query(
    "CREATE TABLE shakeout_default (id serial primary key, room_id int, body text)",
  );
  await admin.query(`CREATE PUBLICATION ${ENGINE_PUB} FOR TABLE shakeout_full, shakeout_default`);

  const columns = {
    id: integer("id").primaryKey(),
    roomId: integer("room_id"),
    body: text("body"),
  };
  const fullTable = defineTable("shakeout_full", columns);
  const defaultTable = defineTable("shakeout_default", columns);

  const db = createDb(makeSqlDb(admin), { dialect: "postgres" });
  const engineSource = createPgReplicationSource({
    createClient: createPgReplicationClientFactory(URL, { publication: ENGINE_PUB }),
    slot: ENGINE_SLOT,
  });
  engineSource.onError((error) => console.log("engine source error:", (error as Error)?.message));

  const engineErrors: unknown[] = [];
  const engine = createShapeEngine({
    db,
    tables: [fullTable, defaultTable],
    replication: { source: engineSource, replicaIdentity: createReplicaIdentityProbe(URL) },
    onError: (error) => {
      engineErrors.push(error);
      console.log("engine error:", (error as Error)?.message);
    },
  });

  await engineSource.start();

  try {
    // 1) The registration guard: a non-key-predicate shape on a non-FULL table is refused.
    let refusalCode: string | undefined;
    try {
      await engine.subscribe(room1("shakeout_default"), () => {});
    } catch (error) {
      refusalCode = (error as { code?: string }).code;
    }
    check(
      "refuses a non-key-predicate shape on a non-FULL table",
      refusalCode === "LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT",
      refusalCode,
    );

    // 2) delete-from-shape end-to-end on a FULL table: seed a room-1 row, then move it OUT.
    await admin.query("INSERT INTO shakeout_full (room_id, body) VALUES (1, 'stay')");

    const shapeChanges: ShapeChange[] = [];
    const sub = await engine.subscribe(room1("shakeout_full"), (change) =>
      shapeChanges.push(change),
    );
    check(
      "seeded snapshot contains the room-1 row",
      sub.snapshot.length === 1 && (sub.snapshot[0] as { roomId?: number }).roomId === 1,
      sub.snapshot,
    );

    await admin.query("UPDATE shakeout_full SET room_id = 2 WHERE body = 'stay'");
    await poll(() => shapeChanges.some((change) => change.op === "delete"));

    check(
      "delete-from-shape fires end-to-end on a FULL table",
      shapeChanges.some((change) => change.op === "delete"),
      shapeChanges,
    );

    // 3) FULL→DEFAULT downgrade AFTER registration (the L-08619e99 leak, live): a DELETE now sends a
    //    key-only ('K') old tuple with room_id nulled — value-indistinguishable from a real null. The
    //    marker guard must throw OLD_IMAGE_INCOMPLETE (routed to onError), never silently drop the
    //    delete-from-shape. The shakeout never exercised a live downgrade before this.
    await admin.query("INSERT INTO shakeout_full (room_id, body) VALUES (1, 'downgrade')");
    await poll(() => shapeChanges.some((change) => change.op === "insert"));
    check(
      "the downgrade row entered the shape (a real row to leak)",
      shapeChanges.some((change) => change.op === "insert"),
      shapeChanges,
    );

    await admin.query("ALTER TABLE shakeout_full REPLICA IDENTITY DEFAULT");
    await admin.query("DELETE FROM shakeout_full WHERE body = 'downgrade'");
    await poll(() =>
      engineErrors.some(
        (e) => (e as { code?: string }).code === "LIVE_SERVER_OLD_IMAGE_INCOMPLETE",
      ),
    );

    check(
      "FULL→DEFAULT downgrade DELETE throws OLD_IMAGE_INCOMPLETE (not a silent delete-from-shape drop)",
      engineErrors.some(
        (e) => (e as { code?: string }).code === "LIVE_SERVER_OLD_IMAGE_INCOMPLETE",
      ),
      engineErrors.map((e) => (e as { code?: string }).code),
    );
  } finally {
    engine.stop();
    await engineSource.stop();
  }
} finally {
  await cleanup();
  await admin.end();
}

console.log(
  failures === 0 ? "\n✅ pgoutput live shakeout PASSED" : `\n❌ ${failures} assertion(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
