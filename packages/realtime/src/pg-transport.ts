/**
 * The Postgres `LISTEN/NOTIFY` transport (ADR 0040 Phase A, `L-ee9433f8`).
 *
 * One dedicated long-lived listening client per process — NOT from the `@lesto/db`
 * pool, because `LISTEN` pins a connection for the process's life and a pooled
 * client would starve normal queries. All processes `LISTEN` one channel
 * (`lesto_invalidate`) with the invalidation **topic** in the `NOTIFY` payload; a
 * received topic is re-published into the local in-process hub, where per-topic and
 * per-connection fan-out happens. Authz stays in the app (where the principal
 * lives), never in the database.
 *
 * **Ordering is the commit-ordered NOTIFY delivery stream, not a `SEQUENCE`.**
 * Postgres delivers `NOTIFY` to every listener in commit order, identically, so a
 * single node's receive stream IS commit-ordered — the cursor never needs a
 * fleet-global number. A `LISTEN` gap (the connection dropped) means missed
 * `NOTIFY`s (Postgres does not buffer them), so **every re-LISTEN bumps the replay
 * generation** (the injected {@link PostgresTransportOptions.bumpGeneration}),
 * making the gap detectable: a cursor from before the gap can no longer prove
 * continuity and is forced to resync.
 *
 * This module is the pure transport LOGIC, driven against an injected
 * {@link PgListenClient} seam so every branch is tested; the real `pg.Client`
 * factory (`createPgListenClient`) is the thin coverage-excluded wiring.
 */

import type { Transport } from "./transport";

/** The default `NOTIFY` channel every process listens on; the topic rides the payload. */
export const DEFAULT_CHANNEL = "lesto_invalidate";

/** One `NOTIFY` as the driver delivers it: the channel and the (optional) string payload. */
export interface PgNotification {
  readonly channel: string;

  readonly payload?: string | undefined;
}

/**
 * The slice of a `pg.Client` the transport drives — narrow on purpose so a fake
 * exercises every branch, and a real `pg.Client` satisfies it structurally
 * (`connect` / `query` / `on('notification'|'error')` / `end` are all native).
 */
export interface PgListenClient {
  connect(): Promise<void>;

  query(sql: string, params?: readonly unknown[]): Promise<unknown>;

  on(event: "notification", listener: (message: PgNotification) => void): unknown;

  on(event: "error", listener: (error: Error) => void): unknown;

  end(): Promise<void>;
}

/** What {@link PostgresTransport} needs — the client factory plus injectable seams. */
export interface PostgresTransportOptions {
  /**
   * Mints a fresh listening client. Called once on `start` and again on every
   * reconnect (a dropped `LISTEN` cannot be resumed — a new client must re-`LISTEN`).
   * The real factory wraps `new pg.Client(config)`; tests inject a fake.
   */
  readonly createClient: () => PgListenClient;

  /** The channel to `LISTEN`/`NOTIFY` on. Defaults to {@link DEFAULT_CHANNEL}. */
  readonly channel?: string;

  /**
   * Called on every **re-LISTEN** (a reconnect), never the first `LISTEN`. Wired to
   * the process `ReplayRing.bumpGeneration` so a gap forces stale cursors to resync.
   * Defaults to a no-op (the transport works standalone, e.g. for cache invalidation).
   */
  readonly bumpGeneration?: () => void;

  /** Where a connection/listen/publish failure is reported. Defaults to a no-op. */
  readonly onError?: (error: unknown) => void;

  /**
   * The backoff before a reconnect attempt, as an awaitable delay. Injected so a
   * test drives reconnection without real time; defaults to a real `setTimeout`.
   */
  readonly delay?: (ms: number) => Promise<void>;

  /** The fixed reconnect backoff in ms (kept simple — not exponential). Defaults to 1s. */
  readonly reconnectMs?: number;
}

const DEFAULT_RECONNECT_MS = 1_000;

const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    // A pending reconnect backoff must not keep the process alive on its own.
    timer.unref();
  });

/** The Postgres `LISTEN/NOTIFY` {@link Transport}. */
export class PostgresTransport implements Transport {
  readonly #createClient: () => PgListenClient;

  readonly #channel: string;

  readonly #bumpGeneration: () => void;

  readonly #onError: (error: unknown) => void;

  readonly #delay: (ms: number) => Promise<void>;

  readonly #reconnectMs: number;

  readonly #handlers = new Set<(topic: string) => void>();

  #client: PgListenClient | undefined;

  #closed = false;

  /**
   * Whether a reconnect is already in flight. A dropped connection can fire `error`
   * MORE THAN ONCE (the socket errors, then errors again on teardown), and the old
   * client's `error` listener is still wired while the new one connects — so without
   * this guard two `error`s would launch overlapping reconnects that each mint a
   * client and overwrite `#client`, orphaning (and leaking) the first and bumping
   * the generation twice (an avoidable double-resync). One reconnect at a time.
   */
  #reconnecting = false;

  constructor(options: PostgresTransportOptions) {
    this.#createClient = options.createClient;
    this.#channel = options.channel ?? DEFAULT_CHANNEL;
    this.#bumpGeneration = options.bumpGeneration ?? (() => {});
    this.#onError = options.onError ?? (() => {});
    this.#delay = options.delay ?? realDelay;
    this.#reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS;
  }

  /** Connect and `LISTEN` (the first time — no generation bump). */
  async start(): Promise<void> {
    await this.#openAndListen(false);
  }

  /**
   * Ship a locally-published topic to other processes via `NOTIFY`
   * (`SELECT pg_notify($1, $2)` — parameterized, so a topic is never spliced into
   * SQL). Fire-and-forget: a failure is reported and swallowed, because a dropped
   * topic is resync-recoverable (the ADR's load-bearing one-way guarantee). A
   * no-op before `start` / after `close`, when there is no client.
   */
  async publishRemote(topic: string): Promise<void> {
    const client = this.#client;

    if (client === undefined) return;

    try {
      await client.query("SELECT pg_notify($1, $2)", [this.#channel, topic]);
    } catch (error) {
      this.#onError(error);
    }
  }

  /**
   * Register a sink for every remote topic. The handler MUST return synchronously
   * (the ADR non-blocking-listener invariant — it lands the topic into the local
   * hub and returns). Returns an idempotent unsubscribe.
   */
  onRemoteMessage(handler: (topic: string) => void): () => void {
    this.#handlers.add(handler);

    return () => {
      this.#handlers.delete(handler);
    };
  }

  /** Close the transport: stop reconnecting, drop handlers, end the client. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#handlers.clear();

    await this.#endClient();
    this.#client = undefined;
  }

  /** Open a fresh client, wire its events, connect, and `LISTEN`. */
  async #openAndListen(isReconnect: boolean): Promise<void> {
    const client = this.#createClient();

    this.#client = client;

    client.on("notification", (message) => this.#onNotification(message));
    client.on("error", (error) => this.#onClientError(error));

    await client.connect();
    await client.query(`LISTEN ${this.#channel}`);

    // A re-LISTEN follows a gap in which `NOTIFY`s were missed, so bump the
    // generation: every cursor from before the gap can no longer prove continuity.
    // The FIRST listen keeps the ring's starting generation (nothing was missed).
    if (isReconnect) this.#bumpGeneration();
  }

  /** Decode a notification and fan it out — ignoring a foreign channel or empty payload. */
  #onNotification(message: PgNotification): void {
    if (message.channel !== this.#channel) return;

    const topic = message.payload;

    // An empty/absent payload carries no topic — nothing to invalidate.
    if (topic === undefined || topic === "") return;

    for (const handler of this.#handlers) handler(topic);
  }

  /** A client error tears the connection down and schedules a reconnect. */
  #onClientError(error: unknown): void {
    this.#onError(error);

    void this.#reconnect();
  }

  /**
   * Run ONE reconnect session — end the old client, back off, re-open and
   * re-`LISTEN` (bumping the generation), retrying until it succeeds or the
   * transport closes. The `#reconnecting` guard makes overlapping `error` events
   * collapse to a single session (no orphaned clients, no double generation bump).
   */
  async #reconnect(): Promise<void> {
    if (this.#reconnecting || this.#closed) return;

    this.#reconnecting = true;

    try {
      for (;;) {
        await this.#endClient();
        await this.#delay(this.#reconnectMs);

        // A `close` may have raced the backoff — do not resurrect a closed transport.
        if (this.#closed) return;

        try {
          await this.#openAndListen(true);

          return; // reconnected + re-LISTENed
        } catch (error) {
          // The reconnect itself failed (DB still down) — report and loop to retry.
          this.#onError(error);
        }
      }
    } finally {
      this.#reconnecting = false;
    }
  }

  /** Best-effort `end` of the current client; a failure to end is swallowed. */
  async #endClient(): Promise<void> {
    const client = this.#client;

    if (client === undefined) return;

    try {
      await client.end();
    } catch (error) {
      this.#onError(error);
    }
  }
}
