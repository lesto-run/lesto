import type { BucketState, RateLimitStore } from "./types";

/**
 * The simplest store that works: an in-process Map.
 *
 * State lives only in memory, so it is per-process and resets on restart — fine
 * for a single node or for tests. Swap in a SQL- or Redis-backed store (same
 * interface) when limits must hold across a fleet.
 *
 * `update` is atomic by construction: single-threaded JS plus a synchronous
 * `mutate` means nothing can interleave between the read and the write.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();

  async update(
    key: string,
    mutate: (current: BucketState | undefined) => BucketState,
  ): Promise<BucketState> {
    const next = mutate(this.buckets.get(key));

    this.buckets.set(key, next);

    return next;
  }
}
