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

import { createPgReplicationClientFactory } from "../../src/pg-replication-client";
import { createPgReplicationSource } from "../../src/replication";
import type { ReplicationChange } from "../../src/replication";

const URL =
  process.env.LESTO_LIVE_PG_URL ?? "postgresql://postgres:postgres@localhost:55432/lesto_live";
const SLOT = "lesto_shakeout";
const PUB = "lesto_shakeout_pub";

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

interface AdminClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  end(): Promise<void>;
}

const require = createRequire(import.meta.url);
const { Client } = require("pg") as { Client: new (c: string) => AdminClient };
const admin = new Client(URL);
await admin.connect();

const cleanup = async (): Promise<void> => {
  await admin
    .query(
      `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name='${SLOT}' AND active_pid IS NOT NULL`,
    )
    .catch(() => {});
  await admin
    .query(
      `SELECT pg_drop_replication_slot('${SLOT}') FROM pg_replication_slots WHERE slot_name='${SLOT}'`,
    )
    .catch(() => {});
  await admin.query(`DROP PUBLICATION IF EXISTS ${PUB}`).catch(() => {});
  await admin.query("DROP TABLE IF EXISTS shakeout_messages").catch(() => {});
};

const poll = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
};

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
    createClient: createPgReplicationClientFactory(URL, { plugin: "pgoutput", publication: PUB }),
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
} finally {
  await cleanup();
  await admin.end();
}

console.log(
  failures === 0 ? "\n✅ pgoutput live shakeout PASSED" : `\n❌ ${failures} assertion(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
