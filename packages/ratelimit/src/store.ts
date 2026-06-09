import type { BucketState, RateLimitStore } from "./types";

/**
 * The simplest store that works: an in-process Map.
 *
 * State lives only in memory, so it is per-process and resets on restart — fine
 * for a single node or for tests. Swap in a SQL- or Redis-backed store (same
 * interface) when limits must hold across a fleet.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();

  get(key: string): BucketState | undefined {
    return this.buckets.get(key);
  }

  set(key: string, state: BucketState): void {
    this.buckets.set(key, state);
  }
}
