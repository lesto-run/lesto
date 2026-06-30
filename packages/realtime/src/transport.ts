/**
 * The cross-process transport seam (ADR 0040).
 *
 * `@lesto/pubsub` stays the dependency-free in-process hub — the universal delivery point
 * for the node tier. A transport's only job is to (a) ship a locally-published invalidation
 * *topic* out to other processes and (b) land remote topics back INTO the local hub, where
 * the SSE fan-out and any other in-process consumer pick them up. The seam is THIS interface,
 * not the `PubSub` class — so the Postgres `LISTEN/NOTIFY` implementation can live beside the
 * `pg` driver and the edge Durable-Object implementation in `@lesto/cloudflare`, while
 * `@lesto/pubsub` carries no transport dependency.
 *
 * The wire carries `(topic, cursor)` only — never row data (the ADR 0027 invariant). A
 * cross-process publish is fire-and-forget: you cannot await remote delivery, and a dropped
 * topic is recoverable by resync (see {@link ReplayRing}).
 */
export interface Transport {
  /** Ship a locally-published invalidation `topic` to other processes (fire-and-forget). */
  publishRemote(topic: string): void | Promise<void>;

  /**
   * Register the sink that lands a remote `topic` into the local hub. The handler MUST
   * return synchronously and never await the socket (ADR 0040 non-blocking-listener
   * invariant), or one slow consumer back-pressures the whole delivery stream. Returns an
   * unsubscribe thunk.
   */
  onRemoteMessage(handler: (topic: string) => void): () => void;

  /** Open the transport (e.g. connect + `LISTEN`). */
  start(): Promise<void>;

  /** Close the transport. Idempotent. */
  close(): Promise<void>;
}
