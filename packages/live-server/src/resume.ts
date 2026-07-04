/**
 * LSN-exact resume (ADR 0042 Tier 4, v1 Inc4, `L-6841d65d`) — the resume cursor + the
 * per-shape replay ring behind "a reconnect replays EXACTLY the missed changes, or
 * re-snapshots — never silently misses a change".
 *
 * This is the Tier-4 analogue of ADR 0040's missed-message core (`@lesto/realtime`'s
 * `replay-ring.ts`/`sse.ts`), sharpened for logical replication. Where ADR 0040 keys its
 * cursor on a per-process `(instanceId, generation, index)` — because `LISTEN/NOTIFY` has
 * no persistent global sequence — Tier 4 keys on the Postgres commit **LSN**, the real,
 * fleet-global, replayable position. But an LSN alone is a **false continuity proof** across
 * a failover/restore (the LSN-level twin of the cross-node bug ADR 0040's round-2 review
 * caught), so the cursor carries the database's system identity too:
 *
 *   - **`systemId`** (`pg_control_system()`, fixed at initdb) — **constant** across a
 *     failover/restore, so it catches a client resuming against a *different cluster*.
 *   - **`timelineId`** (the WAL timeline) — **increments** on every failover/promotion (and
 *     changes on PITR), so it catches a *same-cluster failover* a `systemId`-only check misses.
 *
 * The cursor is therefore `(systemId, timelineId, LSN)`. Replay is permitted ONLY when BOTH
 * identities match the live database's; on any mismatch — or when the LSN has aged past the
 * ring's retained window (the engine-side analogue of the slot's WAL retention) — the client
 * **re-snapshots** rather than replaying. Everything that cannot prove continuity falls back
 * to the always-correct re-snapshot floor.
 *
 * The wire cursor stays **opaque to the client**: the browser's `EventSource` round-trips the
 * `id:` line as `Last-Event-ID` without parsing it, and `@lesto/live`'s consumer structurally
 * refuses to read it (a compile error, `consumer.ts`). Encoding/decoding lives ONLY here, on
 * the server, so the format can evolve without a client change — which is exactly why the
 * versioned `v1:` prefix earns its keep.
 */

import type { Cursor, ShapeChange } from "@lesto/live-protocol";

import type { SystemIdentity } from "./replication";

/** The resume-cursor wire version. `v0:` (the poll path) can never resume — it decodes to `undefined`. */
const RESUME_VERSION = "v1";

/**
 * The cursor stamped on every `resync` frame — a deliberately **non-resumable** sentinel. A resync
 * says "your local slice is gone; drop it and re-snapshot", so its `id:` must NOT let the client's
 * next reconnect prove LSN-continuity: a real cursor there would make an `EventSource` reconnect
 * `Last-Event-ID`-continuous and replay missed changes onto the just-emptied slice (a durable,
 * strictly-worse divergence — L-802b3e7b). It carries the `v0:` prefix so {@link decodeResumeCursor}
 * returns `undefined` for it (only 2 colon-parts, never 4), forcing the always-correct re-snapshot
 * floor. The frame and its `id:` then AGREE: both say "you are not continuous — re-snapshot".
 */
export const RESYNC_CURSOR = "v0:resync";

/**
 * A Postgres LSN is `<hex>/<hex>` (high 32 bits `/` low 32 bits). A client-presented cursor is
 * untrusted, so its LSN must match this before it is compared or trusted — the same guard the
 * real client applies before splicing an LSN into `START_REPLICATION` (`pg-replication-client.ts`).
 */
const LSN_PATTERN = /^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/;

/** A non-negative decimal integer — the shape a serialized `timelineId` must take on decode. */
const TIMELINE_PATTERN = /^\d+$/;

/**
 * True iff `lsn` is a well-formed Postgres LSN (`<hex>/<hex>`). Guards both the untrusted client
 * cursor (in {@link decodeResumeCursor}) and, at the engine's replication ingest, the commit LSN a
 * {@link PgReplicationClient} decoded — so a malformed value can never reach {@link compareLsn}
 * (whose `BigInt` parse would otherwise throw).
 */
export function isValidLsn(lsn: string): boolean {
  return LSN_PATTERN.test(lsn);
}

/**
 * The `(systemId, timelineId, LSN)` resume cursor, decoded. It is exactly {@link SystemIdentity}
 * (the database identity the LSN is meaningful within) plus the commit LSN of the last change the
 * client applied — everything a reconnect needs to decide replay-vs-re-snapshot.
 */
export interface ResumeCursor extends SystemIdentity {
  /** The commit LSN (`<hex>/<hex>`) of the client's last-applied change — its resume position. */
  readonly lsn: string;
}

/**
 * Encode a {@link ResumeCursor} into the single SSE `id:` line. Format:
 * `v1:<systemId>:<timelineId>:<lsn>`. None of the fields can hold a `:` — `systemId` is the
 * numeric `pg_control_system()`, `timelineId` is an integer, and an LSN is `<hex>/<hex>` — so the
 * four parts never collide, and {@link decodeResumeCursor} splits them back cleanly.
 */
export function encodeResumeCursor(cursor: ResumeCursor): Cursor {
  return `${RESUME_VERSION}:${cursor.systemId}:${cursor.timelineId}:${cursor.lsn}`;
}

/**
 * Decode a `Last-Event-ID` token back into a {@link ResumeCursor}, or `undefined` when it is
 * absent, a `v0:` (non-resumable) cursor, or otherwise malformed. A `undefined` result is not an
 * error — it forces the coarse re-snapshot floor, the always-correct fallback. Every field is
 * validated so a hostile or truncated value can never be mistaken for a valid resume position.
 */
export function decodeResumeCursor(token: string | undefined): ResumeCursor | undefined {
  if (token === undefined) return undefined;

  const parts = token.split(":");

  // `v1` + systemId + timelineId + lsn — and no field may itself contain a colon.
  if (parts.length !== 4) return undefined;

  const [version, systemId, timeline, lsn] = parts as [string, string, string, string];

  if (version !== RESUME_VERSION) return undefined;
  if (systemId === "") return undefined;
  if (!TIMELINE_PATTERN.test(timeline)) return undefined;
  if (!isValidLsn(lsn)) return undefined;

  return { systemId, timelineId: Number(timeline), lsn };
}

/** Parse an `<hex>/<hex>` LSN to its 64-bit value. Callers validate the format first (LSN_PATTERN). */
function lsnToBigInt(lsn: string): bigint {
  const slash = lsn.indexOf("/");
  const high = BigInt(`0x${lsn.slice(0, slash)}`);
  const low = BigInt(`0x${lsn.slice(slash + 1)}`);

  return (high << 32n) + low;
}

/**
 * Compare two LSNs by their numeric WAL position: negative if `a < b`, positive if `a > b`, 0 when
 * equal — so `"0/0" < "0/A" < "1/0"`, honoring the high/low-word split (a naive string compare
 * would order `"0/A"` after `"0/9"` correctly but `"1/0"` before `"0/A"` wrongly).
 */
export function compareLsn(a: string, b: string): number {
  const av = lsnToBigInt(a);
  const bv = lsnToBigInt(b);

  if (av < bv) return -1;
  if (av > bv) return 1;

  return 0;
}

/** One retained change: the shape change plus the commit LSN it was stamped with. */
interface RingEntry {
  readonly lsn: string;
  readonly change: ShapeChange;
  readonly at: number;
}

/** A change to replay on resume — the change plus the LSN the engine re-stamps its cursor from. */
export interface ReplayItem {
  readonly lsn: string;
  readonly change: ShapeChange;
}

/**
 * What a reconnect should do. `replay` carries exactly the retained changes at or after the
 * client's LSN (inclusive — see {@link ShapeReplayRing.reconcile}); `resync` is the always-correct
 * re-snapshot floor when continuity cannot be proven (a different cluster/timeline, or a position
 * aged past the retained window).
 */
export type RingReconcile =
  | { readonly kind: "resync" }
  | { readonly kind: "replay"; readonly changes: readonly ReplayItem[] };

/** Construction options for a {@link ShapeReplayRing}. `now` is injected for deterministic tests. */
export interface ShapeReplayRingOptions {
  /** Cap on retained entries — the count half of the retained window. */
  readonly maxEntries: number;

  /** Cap on retained age in ms — the time half of the retained window. */
  readonly maxAgeMs: number;

  /** Clock seam — defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A bounded, per-shape ring of recently delivered changes keyed by commit LSN — the engine-side
 * stand-in for the replication slot's WAL retention. A reconnect within the window replays exactly
 * its missed changes; a reconnect from before it (evicted) re-snapshots.
 *
 * Every retained entry belongs to the ring's current {@link SystemIdentity}; a change stamped with
 * a DIFFERENT identity resets the ring (the failover/restore case — ADR 0040's `bumpGeneration`
 * twin), so the ring only ever holds one WAL-position space and a pre-failover cursor can never
 * match it.
 */
export class ShapeReplayRing {
  readonly #maxEntries: number;

  readonly #maxAgeMs: number;

  readonly #now: () => number;

  #identity: SystemIdentity | undefined;

  #entries: RingEntry[] = [];

  /**
   * The largest LSN ever evicted from the front, or `undefined` before any eviction. Entries are
   * recorded in commit (non-decreasing LSN) order and evicted oldest-first, so every retained
   * entry is strictly newer than this — which makes it the exact retention floor: a cursor at or
   * below it can no longer be served (a change it still needs was dropped).
   */
  #maxEvictedLsn: string | undefined;

  constructor(options: ShapeReplayRingOptions) {
    this.#maxEntries = options.maxEntries;
    this.#maxAgeMs = options.maxAgeMs;
    this.#now = options.now ?? Date.now;
  }

  /** The commit LSN of the most recently recorded change, or `undefined` when the ring is empty. */
  latestLsn(): string | undefined {
    return this.#entries.at(-1)?.lsn;
  }

  /**
   * The {@link SystemIdentity} the retained entries belong to, or `undefined` before the first
   * change. A caller stamping a cursor from {@link latestLsn} must check this equals the live
   * identity first: a failover/restore can leave the ring holding pre-failover entries (a
   * stale-timeline LSN) after another table's change already advanced the live identity.
   */
  identity(): SystemIdentity | undefined {
    return this.#identity;
  }

  /**
   * Record a delivered change under `identity`. A change whose identity differs from the ring's
   * current one (a failover/restore crossed mid-life) resets the ring first, so it never mixes two
   * WAL-position spaces. Then append and evict what fell out of the retained window.
   */
  record(identity: SystemIdentity, lsn: string, change: ShapeChange): void {
    if (
      this.#identity === undefined ||
      this.#identity.systemId !== identity.systemId ||
      this.#identity.timelineId !== identity.timelineId
    ) {
      this.#identity = identity;
      this.#entries = [];
      this.#maxEvictedLsn = undefined;
    }

    this.#entries.push({ lsn, change, at: this.#now() });
    this.#evict();
  }

  /**
   * Decide a reconnect carrying `since`. Replay is permitted ONLY when the cursor's database
   * identity matches the ring's (same cluster AND same WAL timeline) and its LSN is still within
   * the retained window; every other case re-snapshots.
   *
   * Replay is **inclusive** of the client's own LSN (`>= since.lsn`): re-delivering a change the
   * client already applied is idempotent (the local store keys every set/delete), and inclusivity
   * closes the partial-commit window — all changes in one Postgres transaction share the commit
   * LSN, so a client whose cursor sits mid-commit still receives the rest of that commit.
   */
  reconcile(since: ResumeCursor): RingReconcile {
    if (this.#identity === undefined) return { kind: "resync" };
    if (since.systemId !== this.#identity.systemId) return { kind: "resync" };
    if (since.timelineId !== this.#identity.timelineId) return { kind: "resync" };

    // Aged past retention: a change at or after the client's position was already evicted, so the
    // ring can no longer prove it holds everything the client is missing — re-snapshot.
    if (this.#maxEvictedLsn !== undefined && compareLsn(since.lsn, this.#maxEvictedLsn) <= 0) {
      return { kind: "resync" };
    }

    const changes: ReplayItem[] = [];

    for (const entry of this.#entries) {
      if (compareLsn(entry.lsn, since.lsn) >= 0)
        changes.push({ lsn: entry.lsn, change: entry.change });
    }

    return { kind: "replay", changes };
  }

  /** Drop entries past the age window, then past the count window — both from the front. */
  #evict(): void {
    const cutoff = this.#now() - this.#maxAgeMs;
    let drop = 0;

    for (const entry of this.#entries) {
      if (entry.at >= cutoff) break;

      drop += 1;
    }

    const overflow = this.#entries.length - drop - this.#maxEntries;

    if (overflow > 0) drop += overflow;

    if (drop > 0) {
      const evicted = this.#entries.splice(0, drop);

      // The last of the front-evicted prefix is the largest LSN dropped (commit order), and LSNs
      // are non-decreasing, so this only ever advances — the monotonic retention floor.
      this.#maxEvictedLsn = evicted[evicted.length - 1]!.lsn;
    }
  }
}
