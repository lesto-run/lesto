/**
 * Basic slot-lag check for the capstone's prod (Postgres logical-replication) deployment
 * (ADR 0042 Inc8, `L-abe3f464`). A replication slot pins WAL until its consumer acks; a STALLED or
 * CRASHED consumer freezes the slot's `restart_lsn` while `pg_current_wal_lsn()` keeps advancing, so
 * the retained WAL grows without bound until it fills the Postgres disk — the ADR 0042 *Consequences*
 * footgun the deployment (not the framework) owns. `serve.ts` drops the slot on a clean SIGTERM and
 * self-heals a crash-orphaned slot on the next boot, but nothing warns you WHILE a consumer is wedged
 * and the disk is filling. This is that missing alarm.
 *
 * The "at least a basic slot-lag check" the capstone README + this task call for: a one-shot probe you
 * run on an interval (cron, a Fly `[checks]`, a monitor's exec probe) that reads the slot's
 * retained-WAL bytes and exits Nagios-style so any monitor reads it — **0 = OK, 1 = WARN, 2 =
 * CRITICAL** (a probe failure — DB down / disk full refusing connections — is also 2), **3 = UNKNOWN**
 * (misconfigured: no URL, or inverted thresholds). See `DEPLOY.md` → "Slot-lag alerting".
 *
 * Reusable framework infra, not capstone-only: point it at any Lesto replication slot via env
 * (`LESTO_LIVE_PG_URL`, `LESTO_LIVE_SLOT`, `LESTO_SLOT_LAG_WARN_BYTES`, `LESTO_SLOT_LAG_CRIT_BYTES`).
 *
 *   LESTO_LIVE_PG_URL=postgres://… bun run slot-lag
 */

import type { SqlDatabase } from "@lesto/db";
import { openPostgres } from "@lesto/pg";

import { CAPSTONE_SLOT } from "../src/app";

/** Retained-WAL thresholds: WARN at 256 MiB, CRITICAL at 1 GiB — override via env for a smaller disk. */
const DEFAULT_WARN_BYTES = 256 * 1024 * 1024;
const DEFAULT_CRIT_BYTES = 1024 * 1024 * 1024;

export type SlotLagLevel = "ok" | "warn" | "critical";

/** A slot's live state, as read from `pg_replication_slots`. */
export interface SlotLagReading {
  /** The slot name this reading is for. */
  readonly slot: string;

  /** Did the slot exist at all? A slot the deployment should hold but that is MISSING means the
   * consumer isn't attached — the live stream is down (though no WAL is being pinned). */
  readonly present: boolean;

  /** Is a consumer attached right now? An INACTIVE slot still pins WAL, but nobody is advancing it —
   * so its lag can only grow (a crashed/wedged consumer). */
  readonly active: boolean;

  /** Retained WAL bytes: `pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)`. `undefined` when the
   * slot is present but `restart_lsn` is unreserved (a brand-new slot that has not tailed yet). */
  readonly lagBytes: number | undefined;
}

/** The byte thresholds a reading is graded against. */
export interface SlotLagThresholds {
  readonly warnBytes: number;
  readonly critBytes: number;
}

/** The graded verdict: a level, the Nagios-style exit code, and a one-line human message. */
export interface SlotLagVerdict {
  readonly level: SlotLagLevel;
  readonly exitCode: 0 | 1 | 2;
  readonly message: string;
}

const EXIT_CODE: Record<SlotLagLevel, 0 | 1 | 2> = { ok: 0, warn: 1, critical: 2 };

/** Bump a level up one notch (`ok`→`warn`→`critical`, `critical` saturates). */
function escalate(level: SlotLagLevel): SlotLagLevel {
  return level === "ok" ? "warn" : "critical";
}

/** Human-readable byte size (`—` when unknown). */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Classify a slot reading against thresholds — PURE, so it unit-tests without a live Postgres.
 *
 * A MISSING slot is WARN (availability, not disk — nothing is being pinned, but the stream is down;
 * expected briefly during a restart). Otherwise the base level comes from the retained bytes
 * (`≥ critBytes` → CRITICAL, `≥ warnBytes` → WARN, else OK), and an INACTIVE slot is escalated one
 * notch because its lag cannot recover on its own — a wedged consumer only ever pins MORE WAL.
 */
export function classifySlotLag(
  reading: SlotLagReading,
  thresholds: SlotLagThresholds,
): SlotLagVerdict {
  if (!reading.present) {
    return {
      level: "warn",
      exitCode: EXIT_CODE.warn,
      message:
        `slot "${reading.slot}" not present — no consumer attached (the live stream is down, but ` +
        "no WAL is being pinned). Expected briefly during a restart; investigate if sustained.",
    };
  }

  const { lagBytes } = reading;

  const base: SlotLagLevel =
    lagBytes === undefined
      ? "ok"
      : lagBytes >= thresholds.critBytes
        ? "critical"
        : lagBytes >= thresholds.warnBytes
          ? "warn"
          : "ok";

  const level = reading.active ? base : escalate(base);

  const state = reading.active ? "active" : "INACTIVE (no consumer — lag will only grow)";
  const lag = formatBytes(lagBytes);
  const warn = formatBytes(thresholds.warnBytes);
  const crit = formatBytes(thresholds.critBytes);

  return {
    level,
    exitCode: EXIT_CODE[level],
    message: `slot "${reading.slot}" ${state}; retained WAL ${lag} (warn ${warn} / crit ${crit})`,
  };
}

/** Read one slot's live state off `pg_replication_slots` — the I/O shell around {@link classifySlotLag}. */
export async function readSlotLag(db: SqlDatabase, slot: string): Promise<SlotLagReading> {
  // `?` is the seam's placeholder (translated to `$1` by @lesto/pg). `pg_current_wal_lsn()` is a
  // primary-only function — the demo's Postgres is a primary; a standby would need
  // `pg_last_wal_replay_lsn()` instead (out of scope for the single-primary demo).
  const row = (await db
    .prepare(
      "SELECT active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint AS lag_bytes " +
        "FROM pg_replication_slots WHERE slot_name = ?",
    )
    .get([slot])) as { active?: unknown; lag_bytes?: unknown } | undefined;

  if (row === undefined || row === null) {
    return { slot, present: false, active: false, lagBytes: undefined };
  }

  const lag = row.lag_bytes;

  return {
    slot,
    present: true,
    // node-postgres parses a `boolean` column to a JS boolean; coerce defensively for other drivers.
    active: row.active === true || row.active === "t" || row.active === 1,
    lagBytes: lag === null || lag === undefined ? undefined : Number(lag),
  };
}

/** Parse a positive-integer env override, falling back to `fallback` when unset/blank/invalid. */
function envBytes(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();

  if (raw === "") return fallback;

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** The CLI: probe the configured slot, print the verdict, exit with its Nagios-style code. */
async function main(): Promise<void> {
  const url = (process.env.LESTO_LIVE_PG_URL ?? process.env.DATABASE_URL ?? "").trim();

  // A misconfiguration (missing URL, inverted thresholds) is Nagios exit 3 = UNKNOWN — "the check
  // can't run", NOT 2 = CRITICAL, so a forgotten env var doesn't page oncall as if the DB were dying.
  if (url === "") {
    console.error(
      "slot-lag-check: set LESTO_LIVE_PG_URL (or DATABASE_URL) to the deployment's Postgres.",
    );
    process.exit(3);
  }

  const slot = process.env.LESTO_LIVE_SLOT ?? CAPSTONE_SLOT;
  const thresholds: SlotLagThresholds = {
    warnBytes: envBytes("LESTO_SLOT_LAG_WARN_BYTES", DEFAULT_WARN_BYTES),
    critBytes: envBytes("LESTO_SLOT_LAG_CRIT_BYTES", DEFAULT_CRIT_BYTES),
  };

  // Guard the WARN band: `classifySlotLag` tests `≥ crit` before `≥ warn`, so a WARN threshold set
  // ABOVE crit (easy to fat-finger on a small disk) would make WARN unreachable and silently hide the
  // early-warning tier. Refuse it loudly rather than grade wrong.
  if (thresholds.warnBytes > thresholds.critBytes) {
    console.error(
      `slot-lag-check: LESTO_SLOT_LAG_WARN_BYTES (${thresholds.warnBytes}) exceeds ` +
        `LESTO_SLOT_LAG_CRIT_BYTES (${thresholds.critBytes}); the WARN band would be unreachable.`,
    );
    process.exit(3);
  }

  const { db, close } = await openPostgres({ connectionString: url });

  let verdict: SlotLagVerdict;

  try {
    verdict = classifySlotLag(await readSlotLag(db, slot), thresholds);
  } finally {
    await close();
  }

  const line = `[${verdict.level.toUpperCase()}] ${verdict.message}`;

  if (verdict.level === "ok") console.log(line);
  else console.error(line);

  // Exit AFTER draining the pool so the check never leaks a connection (which would itself pin nothing,
  // but a leaked walsender-adjacent connection is exactly the kind of ops smell this script guards).
  process.exit(verdict.exitCode);
}

// Run as a CLI only — importing the module (the unit test) must NOT probe a live Postgres or exit.
// A probe FAILURE (DB unreachable, a full disk refusing connections, a missing `pg` peer) must exit
// 2 = CRITICAL — the disk-fill scenario this alarm exists to catch — NOT the code 1 (WARN) an
// unhandled rejection would default to, which a CRITICAL-only monitor could miss.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("slot-lag-check:", error);
    process.exit(2);
  });
}
