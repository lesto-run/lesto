/**
 * The resume-cursor replay ring (ADR 0040, the missed-message core `L-dbd589ef`).
 *
 * The realtime transport delivers invalidation *topics*, never data. A browser that
 * briefly disconnects must not be left silently stale, so each delivered frame carries a
 * **resume cursor** and reconnect reconciles. Correctness rests on a floor, not on cursor
 * arithmetic: **every reconnect that cannot PROVE continuity gets a coarse `resync`**
 * (the client refetches everything it subscribes to — idempotent, always correct). The
 * ring is a per-process latency optimization that narrows a reconnect to just the missed
 * topics *only when continuity is provable*.
 *
 * The cursor is `(instanceId, generation, index)`:
 *   - `instanceId` — a per-PROCESS id minted at boot. It is load-bearing: without it two
 *     nodes reuse the same `(generation, index)` space, so a client reconnecting to a
 *     DIFFERENT node (the common case behind a non-sticky load balancer) would present a
 *     cursor the new node mistakes for its own position and "replay" the wrong frames →
 *     silent staleness. Precise replay therefore requires `since.instanceId === ours`.
 *   - `generation` — the LISTEN epoch, bumped on every re-LISTEN. A gap in `LISTEN` means
 *     missed `NOTIFY`s (Postgres does not buffer them), so a bump invalidates every prior
 *     cursor (→ resync) and the ring starts fresh.
 *   - `index` — the position in this node's contiguous receive stream within a generation.
 *
 * Postgres delivers `NOTIFY` to every listener in commit order, so a single node's receive
 * stream IS commit-ordered; the ring never needs a fleet-global sequence.
 */

/** A resume cursor — the `id:` field of an SSE frame, presented back as `Last-Event-ID`. */
export interface Cursor {
  /** The process that issued it (minted at boot). */
  readonly instanceId: string;

  /** The LISTEN epoch it belongs to. */
  readonly generation: number;

  /** The position in that generation's contiguous receive stream. */
  readonly index: number;
}

/**
 * What a reconnect should do. `replay` carries exactly the topics missed since the cursor
 * (deduped — invalidating a topic twice is idempotent); `resync` means "refetch everything
 * you subscribe to" — the always-correct floor when continuity cannot be proven.
 */
export type Reconcile =
  | { readonly kind: "replay"; readonly topics: readonly string[] }
  | { readonly kind: "resync" };

/** Construction options. `now` and `generation` are injected for deterministic tests. */
export interface ReplayRingOptions {
  /** This process's id (minted at boot); stamped into every cursor. */
  readonly instanceId: string;

  /** Cap on retained entries (the count half of the fast-path window). */
  readonly maxEntries: number;

  /** Cap on retained age in ms (the time half of the fast-path window). */
  readonly maxAgeMs: number;

  /** Clock seam — defaults to `Date.now`. */
  readonly now?: () => number;

  /** Starting generation — defaults to `0`. */
  readonly generation?: number;
}

interface Entry {
  readonly index: number;
  readonly topic: string;
  readonly at: number;
}

/** A bounded, per-process ring of recently delivered topics keyed by the resume cursor. */
export class ReplayRing {
  readonly #instanceId: string;

  readonly #maxEntries: number;

  readonly #maxAgeMs: number;

  readonly #now: () => number;

  #generation: number;

  #lastIndex = 0;

  #entries: Entry[] = [];

  constructor(options: ReplayRingOptions) {
    this.#instanceId = options.instanceId;
    this.#maxEntries = options.maxEntries;
    this.#maxAgeMs = options.maxAgeMs;
    this.#now = options.now ?? Date.now;
    this.#generation = options.generation ?? 0;
  }

  /** The cursor for the latest delivered position (index `0` until the first `record`). */
  cursor(): Cursor {
    return { instanceId: this.#instanceId, generation: this.#generation, index: this.#lastIndex };
  }

  /** Record a delivered `topic`, evict what fell out of the window, and return its cursor. */
  record(topic: string): Cursor {
    this.#lastIndex += 1;
    this.#entries.push({ index: this.#lastIndex, topic, at: this.#now() });
    this.#evict();

    return this.cursor();
  }

  /**
   * Bump the generation (call on a `LISTEN` reconnect): a gap means missed `NOTIFY`s, so
   * every prior cursor must resync and the ring starts fresh. Returns the new generation.
   */
  bumpGeneration(): number {
    this.#generation += 1;
    this.#lastIndex = 0;
    this.#entries = [];

    return this.#generation;
  }

  /**
   * Decide a reconnect carrying `since`. Precise `replay` is permitted ONLY when the cursor
   * is from this process (`instanceId`), this generation, and still within the ring; every
   * other case — a different node, a prior generation, or a cursor older than the ring's
   * oldest retained entry — falls back to `resync`.
   */
  reconcile(since: Cursor): Reconcile {
    if (since.instanceId !== this.#instanceId) return { kind: "resync" };
    if (since.generation !== this.#generation) return { kind: "resync" };

    // At or beyond the latest delivered position → nothing was missed.
    if (since.index >= this.#lastIndex) return { kind: "replay", topics: [] };

    // The oldest index we can still replay from (retained indices are contiguous).
    let oldest = this.#lastIndex + 1;

    for (const entry of this.#entries) {
      oldest = entry.index;
      break;
    }

    // A needed entry (since.index + 1) was already evicted → can't prove continuity.
    if (since.index + 1 < oldest) return { kind: "resync" };

    const seen = new Set<string>();
    const topics: string[] = [];

    for (const entry of this.#entries) {
      if (entry.index <= since.index) continue;
      if (seen.has(entry.topic)) continue;

      seen.add(entry.topic);
      topics.push(entry.topic);
    }

    return { kind: "replay", topics };
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

    if (drop > 0) this.#entries.splice(0, drop);
  }
}
