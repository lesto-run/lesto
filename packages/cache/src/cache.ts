import { systemClock } from "./time";

import type { CacheStore, Clock } from "./types";

export interface CacheOptions {
  readonly store: CacheStore;

  /** Defaults to the system clock; tests inject a frozen one for determinism. */
  readonly clock?: Clock;
}

/** Optional knobs for a single write. */
export interface WriteOptions {
  /** Time-to-live in ms. Omitted → the entry never expires. */
  readonly ttlMs?: number;
}

/**
 * One in-flight `remember` lead.
 *
 * `promise` is what joiners await; `token` is a fresh per-lead identity the
 * leader checks before it writes or clears the ledger, so an invalidation (or a
 * superseding lead) that swaps the entry out wins the race against a late
 * resolve. The token is just an object — its only property is reference identity.
 */
interface InFlight<T> {
  readonly token: object;
  readonly promise: Promise<T>;
}

/**
 * A TTL cache over a pluggable store.
 *
 * Expiry policy lives here, in one place: the store remembers entries verbatim,
 * and the cache decides whether a remembered entry is still alive by comparing
 * its deadline against the injected clock. An expired entry is treated as a miss
 * and evicted on read, so stale rows never accumulate behind a hot key.
 */
export class Cache {
  private readonly store: CacheStore;

  private readonly clock: Clock;

  /**
   * In-flight computes, keyed by cache key — the single-flight ledger.
   *
   * When two callers miss the same key at once, the second must not kick off a
   * second compute; it must wait on the first. We park the *promise* here the
   * instant a compute starts (before any `await`, so concurrent callers in the
   * same tick all observe it) and delete it the instant the compute settles —
   * win or lose — so a failure never lingers as a poisoned promise.
   *
   * Each entry also carries a `token`: a fresh identity minted per lead. The
   * leader stamps the store and clears the ledger only while the entry it parked
   * still bears *its* token, so an invalidation that drops (or a later lead that
   * replaces) the entry mid-flight is never undone by a compute resolving late.
   *
   * This is process-local by design: it coalesces concurrency within one node,
   * which is exactly where a thundering herd forms. Cross-process stampede
   * protection is a different tool (an atomic DB lock) and lives elsewhere.
   */
  private readonly inFlight = new Map<string, InFlight<unknown>>();

  constructor(options: CacheOptions) {
    this.store = options.store;

    // The default clock branch: real time unless a test pins it.
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Return the live cached value, or produce, cache, and return a fresh one.
   *
   * On a hit `produce` is never called — that is the whole point of a cache. On
   * a miss or an expired entry we produce a new value, write it, and return it.
   */
  async fetch<T>(key: string, produce: () => T | Promise<T>, options?: WriteOptions): Promise<T> {
    const live = this.read<T>(key);

    if (live !== undefined) return live;

    const produced = await produce();

    this.write(key, produced, options);

    return produced;
  }

  /**
   * Like {@link fetch}, but single-flight: concurrent misses for the same key
   * share one compute instead of stampeding the origin.
   *
   * The flow is three guarded beats:
   *
   *  1. **Hit.** A live value short-circuits — `compute` never runs, and we
   *     never touch the in-flight ledger. That is the common, hot path.
   *  2. **Join.** A compute is already running for this key, so we hand back its
   *     promise. Every joiner resolves with the same value (or rejects with the
   *     same error) as the leader — `compute` runs exactly once for the herd.
   *  3. **Lead.** No value, no compute in flight: we become the leader. We
   *     register our promise *synchronously* (before awaiting `compute`) so any
   *     caller arriving later in the same tick joins us instead of racing.
   *
   * On success we write the value with its TTL, then release the ledger entry.
   * On failure we release the ledger entry and let the rejection flow to every
   * waiter — but we do **not** cache the failure. A failed compute leaves the
   * cache exactly as it was, so the very next call is free to retry.
   *
   * **Invalidation wins over an in-flight compute.** A `delete(key)` or `clear()`
   * issued while this compute is running drops our ledger entry, so on resolve
   * we find the ledger no longer points at us and skip the write. That is the
   * correct race outcome: a caller who explicitly invalidated mid-flight must
   * not have the now-stale value silently resurrected underneath them. Waiters
   * already joined to this compute still receive its produced value (the work
   * was real), but it is never written back to the store.
   */
  async remember<T>(
    key: string,
    compute: () => T | Promise<T>,
    options?: WriteOptions,
  ): Promise<T> {
    const live = this.read<T>(key);

    if (live !== undefined) return live;

    // Join an in-flight compute if one already owns this key.
    const pending = this.inFlight.get(key) as InFlight<T> | undefined;

    if (pending !== undefined) return pending.promise;

    // Lead the compute. Mint a token that marks the ledger entry as ours, then
    // park the promise before the first `await` so same-tick callers join us.
    //
    // Before writing — and before clearing the ledger — we confirm the entry
    // still bears our token. If an invalidation dropped it (or a later lead
    // replaced it) while we were computing, the token no longer matches, so we
    // suppress the write rather than resurrect the value the caller discarded,
    // and we leave the ledger alone rather than clobber a fresher leader.
    const token = {};

    const promise = (async () => {
      const produced = await compute();

      if (this.inFlight.get(key)?.token === token) this.write(key, produced, options);

      return produced;
    })().finally(() => {
      if (this.inFlight.get(key)?.token === token) this.inFlight.delete(key);
    });

    this.inFlight.set(key, { token, promise });

    return promise;
  }

  /**
   * Read a live value, or `undefined`.
   *
   * A missing key is a miss. An expired key is also a miss — and we delete it
   * here so the store sheds the dead entry the moment we notice it is dead.
   */
  read<T>(key: string): T | undefined {
    const entry = this.store.get(key);

    if (entry === undefined) return undefined;

    // `null` means never expires; otherwise the deadline is in epoch ms.
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock()) {
      this.store.delete(key);

      return undefined;
    }

    return entry.value as T;
  }

  /** Write a value, optionally with a TTL. No TTL → the entry never expires. */
  write(key: string, value: unknown, options?: WriteOptions): void {
    const ttlMs = options?.ttlMs;

    const expiresAt = ttlMs === undefined ? null : this.clock() + ttlMs;

    this.store.set(key, { value, expiresAt });
  }

  /**
   * Forget a key.
   *
   * We also drop any in-flight `remember` ledger entry for this key. Dropping it
   * is what makes invalidation win the race: a leader that resolves afterward
   * sees the ledger no longer points at it and skips its write, so an explicit
   * `delete` is never undone by a compute that was already running. (The next
   * `remember` simply leads a fresh compute, since the join slot is now empty.)
   */
  delete(key: string): void {
    this.store.delete(key);

    this.inFlight.delete(key);
  }

  /**
   * Forget every key.
   *
   * Like {@link delete}, this also abandons every in-flight `remember` ledger
   * entry so no leader resolving after a `clear` can write its value back into a
   * store the caller just emptied.
   */
  clear(): void {
    this.store.clear();

    this.inFlight.clear();
  }
}
