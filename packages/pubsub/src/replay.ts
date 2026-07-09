/**
 * The pure eviction arithmetic behind the `?since=<seq>` missed-message resume — the
 * "how much of a channel's recent history to keep" half of a bounded replay ring.
 *
 * The ring's STORAGE is substrate-specific: the hibernatable Durable Object in
 * `examples/pubsub/room.ts` keeps it in a `state.storage` sqlite table (under
 * hibernation the DO has no surviving memory to hold a ring in) and supplies the SQL.
 * But *which rows have fallen out of the window* is a pure function of the newest seq,
 * the wall clock, and the retention policy — so it lives here, dependency-free and
 * 100%-covered, where the example's coverage-exempt SQL cannot pin the off-by-one.
 *
 * A row is retained only while it is BOTH among the newest {@link ReplayRetention.maxEntries}
 * AND younger than {@link ReplayRetention.maxAgeMs}; it is evicted the moment it falls out
 * of EITHER window. The two bounds are therefore applied as two independent deletes whose
 * union is the eviction set. (The resume semantics this feeds — replay-before-live, the
 * client-side seq dedup floor, and what "below the window" means — are documented where
 * they live, on the DO in `examples/pubsub/room.ts`.)
 */

/** How much recent history a channel's replay ring keeps — the two window halves. */
export interface ReplayRetention {
  /** Keep at most this many of the most-recent messages (the count window). */
  readonly maxEntries: number;

  /** Keep messages published within this many milliseconds of now (the age window). */
  readonly maxAgeMs: number;
}

/**
 * The two eviction bounds for a replay ring at one instant, each phrased as the exact
 * SQL predicate that removes the rows outside its window (see {@link replayEvictionBounds}).
 */
export interface ReplayEvictionBounds {
  /**
   * Rows outside the COUNT window — `DELETE FROM ring WHERE seq <= seqAtOrBelow`.
   * Everything at or below this seq sits behind the newest `maxEntries` messages.
   */
  readonly seqAtOrBelow: number;

  /**
   * Rows outside the AGE window — `DELETE FROM ring WHERE at < agedOutBefore`.
   * Everything stamped before this instant is older than `maxAgeMs`.
   */
  readonly agedOutBefore: number;
}

/**
 * Compute the two eviction bounds for a replay ring whose newest message is `latestSeq`
 * at wall-clock `now`, under `retention`.
 *
 * The count bound keeps exactly the newest `maxEntries` seqs: seqs are a dense, 1-based,
 * monotonic run, so the newest `maxEntries` occupy `(latestSeq - maxEntries, latestSeq]`
 * and everything at or below `latestSeq - maxEntries` is evictable. When fewer than
 * `maxEntries` messages exist the bound drops to zero or below and matches no row — so
 * nothing is evicted, which is correct.
 */
export function replayEvictionBounds(
  latestSeq: number,
  now: number,
  retention: ReplayRetention,
): ReplayEvictionBounds {
  return {
    seqAtOrBelow: latestSeq - retention.maxEntries,
    agedOutBefore: now - retention.maxAgeMs,
  };
}
