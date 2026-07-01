/**
 * The Postgres **logical-replication change source** (ADR 0042 Tier 4, v1 Inc1) — the
 * production replacement for the v0 full-table poll ({@link file://./engine.ts}) as the
 * engine's change feed.
 *
 * A **dedicated** logical-replication connection (a replication slot + `pgoutput`/`wal2json`
 * decoding) streams *every* committed change with its row image and commit LSN — **beside**
 * the pool, never from it (the same discipline as ADR 0040's dedicated `LISTEN` client,
 * `@lesto/realtime`'s `pg-transport.ts`): a replication connection is special and long-lived,
 * and pulling it from the query pool would pin a pooled slot for the process's life.
 *
 * **The feed is FULL and UNFILTERED.** Every decoded change is emitted, none is dropped:
 * row-level filtering and authorization happen *later*, in the shape engine, where the
 * principal lives (ADR 0042 — "row-level filtering happens in the app/shape engine … never
 * in the database's replication output"). Filtering here would put authz in the wrong place
 * and off the one auditable seam. This module asserts that invariant in its tests.
 *
 * **The slot is a production-outage footgun this source OWNS.** A logical-replication slot
 * pins WAL until its consumer acknowledges, so a pinned/orphaned slot accumulates WAL
 * unboundedly and can **fill the database disk — a hard outage** (ADR 0042 *Consequences*).
 * Therefore the source **creates the slot on start and DROPS it on stop** ({@link stop}): a
 * crash-only slot is a liability, not durability. The owner must call `stop()` on graceful
 * shutdown (SIGTERM); a hard crash that skips it leaves an orphaned slot, which is why the
 * deployment runbook owns slot-lag alerting and the disk-pressure runbook.
 *
 * **This module is the pure change-source LOGIC** — reconnect/backoff, the slot lifecycle,
 * identity stamping, error routing — driven against an injected {@link PgReplicationClient}
 * seam so every branch is unit-reachable without a live Postgres. It is **decoder-agnostic**:
 * it consumes already-decoded {@link DecodedChange}s from the seam (exactly as
 * `pg-transport.ts` consumes decoded `PgNotification`s); the actual `pgoutput`/`wal2json`
 * binary/JSON decode lives ONLY in the thin, coverage-excluded real client
 * ({@link file://./pg-replication-client.ts}).
 *
 * Resume (Inc4) is not implemented here, but the source carries its *inputs*: it captures the
 * connection's `(systemId, timelineId)` from `IDENTIFY_SYSTEM` and stamps **both** on every
 * change (they are distinct — `systemId` is constant across failover/restore and catches a
 * *different cluster*; `timelineId` increments on failover/promotion and catches a
 * *same-cluster* failover), and it accepts a `startLsn` so replay can start from a client's
 * last-applied position. Inc1 thus exposes the failover *signal* (the stamped identity changes)
 * and the replay *entry point* (`startLsn`); Inc1 does **not** implement the *reaction* — the
 * replay-vs-re-snapshot decision, and the reconnect state machine's response to a slot that did
 * not survive a failover, are Inc4's, and they extend the reconnect logic in this file.
 */

import { LiveServerError } from "./errors";

/** The default replication slot name; a deployment may override it per source. */
export const DEFAULT_SLOT = "lesto_live";

/** The default fixed reconnect backoff in ms (kept simple — not exponential). */
const DEFAULT_RECONNECT_MS = 1_000;

/**
 * A full or partial row image as the decoder produces it (column name → value). Kept a plain
 * record on purpose — the source is decoder-agnostic and does not interpret cell types; the
 * shape engine projects/normalizes these downstream.
 */
export type RowImage = Record<string, unknown>;

/**
 * The Postgres system identity a change is resumable against — captured from `IDENTIFY_SYSTEM`
 * on every connect. The two fields are **distinct** and both load-bearing for Inc4's resume:
 * an LSN is only meaningful within one `timelineId` on one `systemId`.
 */
export interface SystemIdentity {
  /** `pg_control_system()` — fixed at initdb, **constant** across failover/restore; catches a different cluster. */
  readonly systemId: string;

  /** The WAL timeline id — **increments** on every failover/promotion (and on PITR); catches a same-cluster failover. */
  readonly timelineId: number;
}

/**
 * One change as the replication client decodes it off the WAL stream, **before** the source
 * stamps system identity. Modeled precisely per operation: an `insert` has only a `newImage`,
 * a `delete` has only an `oldImage`, an `update` has **both** (the old image is what
 * delete-from-shape classification needs, and Postgres emits it only under
 * `REPLICA IDENTITY FULL` — see the real client).
 */
export type DecodedChange =
  | {
      readonly op: "insert";
      readonly table: string;
      readonly commitLSN: string;
      readonly newImage: RowImage;
    }
  | {
      readonly op: "update";
      readonly table: string;
      readonly commitLSN: string;
      readonly newImage: RowImage;
      readonly oldImage: RowImage;
    }
  | {
      readonly op: "delete";
      readonly table: string;
      readonly commitLSN: string;
      readonly oldImage: RowImage;
    };

/**
 * A fully-decoded, identity-stamped change event — the source's public output: a
 * {@link DecodedChange} intersected with the connection's {@link SystemIdentity}. The
 * intersection distributes over the per-op union, so every variant keeps its exact op→image
 * correlation (insert=newImage, delete=oldImage, update=both) and additionally carries
 * `systemId` + `timelineId`. Those two plus `commitLSN` are exactly what Inc4's LSN-exact
 * resume keys on, so all three are stamped on **every** emitted change.
 */
export type ReplicationChange = DecodedChange & SystemIdentity;

/**
 * The narrow slice of a real replication client the source drives — narrow on purpose so a
 * fake exercises every branch, and a real replication client (e.g. `pg` in `replication:
 * 'database'` mode, in {@link file://./pg-replication-client.ts}) satisfies it structurally.
 * The binary/JSON WAL decode lives entirely behind this seam.
 */
export interface PgReplicationClient {
  /** Open the dedicated replication-mode connection. */
  connect(): Promise<void>;

  /** `IDENTIFY_SYSTEM` — the cluster's `(systemId, timelineId)`, re-read on every connect. */
  identifySystem(): Promise<SystemIdentity>;

  /** `CREATE_REPLICATION_SLOT <slot> LOGICAL …` — run once, on first start; errors if it exists. */
  createSlot(slot: string): Promise<void>;

  /** `DROP_REPLICATION_SLOT <slot>` — releases the WAL the slot pins; run on stop. */
  dropSlot(slot: string): Promise<void>;

  /**
   * `START_REPLICATION SLOT <slot> LOGICAL <startLsn?>` — begin streaming. When `startLsn` is
   * omitted, replication resumes from the slot's own confirmed position (never "now"), so the
   * tail cannot gap. Decoded changes then arrive via `on("change")`.
   */
  startReplication(slot: string, startLsn?: string): Promise<void>;

  on(event: "change", listener: (change: DecodedChange) => void): unknown;

  on(event: "error", listener: (error: Error) => void): unknown;

  /** End the connection. */
  end(): Promise<void>;
}

/** A subscriber to the change feed — one fully-decoded, identity-stamped change. */
export type ChangeHandler = (change: ReplicationChange) => void;

/** A subscriber to source errors (connection/replication/slot failures, routed never thrown). */
export type SourceErrorHandler = (error: unknown) => void;

/**
 * A change feed the engine can consume: start it, subscribe to changes and errors, stop it.
 * The Tier-4 production twin of the v0 poll (whose {@link file://./engine.ts} diff + authz
 * seam Inc2 will keep, only swapping *where the changes come from*).
 */
export interface ChangeSource {
  /**
   * Connect, `IDENTIFY_SYSTEM`, create the slot (first start only), and start streaming.
   * Rejects with a coded {@link LiveServerError} on misuse (already started / already
   * stopped); a *connection/replication* failure on the first start propagates from the
   * driver (and any partially-created slot is dropped by a subsequent {@link stop}).
   */
  start(): Promise<void>;

  /** Register a change sink; returns an idempotent unsubscribe. */
  onChange(handler: ChangeHandler): () => void;

  /** Register an error sink; returns an idempotent unsubscribe. */
  onError(handler: SourceErrorHandler): () => void;

  /** Stop streaming and **DROP the slot** (releasing pinned WAL). Idempotent and terminal. */
  stop(): Promise<void>;
}

/**
 * The Postgres logical-replication {@link ChangeSource}, plus the Postgres-specific system
 * identity it exposes. Inc4's LSN-exact resume reads {@link identity} to detect a
 * failover/restore (a `systemId`/`timelineId` mismatch) and decide replay-vs-re-snapshot.
 */
export interface PgReplicationSource extends ChangeSource {
  /** The current connection's captured `(systemId, timelineId)`, or `undefined` before start. */
  readonly identity: SystemIdentity | undefined;
}

/** What {@link createPgReplicationSource} needs — the client factory plus injectable seams. */
export interface PgReplicationSourceOptions {
  /**
   * Mints a fresh replication client. Called once on `start` and again on every reconnect (a
   * dropped replication stream cannot be resumed on the same socket — a new connection must
   * re-`START_REPLICATION`). The real factory wraps a `pg` replication client; tests inject a fake.
   */
  readonly createClient: () => PgReplicationClient;

  /** The replication slot name. Defaults to {@link DEFAULT_SLOT}. */
  readonly slot?: string;

  /**
   * The LSN to `START_REPLICATION` from. Omitted, replication resumes from the slot's own
   * confirmed position. This is the seam Inc4's LSN-exact resume drives; the source only
   * forwards it (it implements no replay logic itself).
   *
   * **Security note for Inc4:** a replication-protocol command cannot bind parameters, so a real
   * client interpolates this straight into `START_REPLICATION` (see `pg-replication-client.ts`).
   * In Inc1 `startLsn` is trusted config; once Inc4 makes it **client-presented**, it MUST be
   * format-validated (`<hex>/<hex>`) at the boundary before it reaches the seam — the real client
   * validates it, but a custom `PgReplicationClient` must not skip that check.
   */
  readonly startLsn?: string;

  /**
   * The backoff before a reconnect attempt, as an awaitable delay. Injected so a test drives
   * reconnection without real time; defaults to a real, `unref`'d `setTimeout`.
   */
  readonly delay?: (ms: number) => Promise<void>;

  /** The fixed reconnect backoff in ms (kept simple — not exponential). Defaults to 1s. */
  readonly reconnectMs?: number;
}

const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    // A pending reconnect backoff must not keep the process alive on its own.
    timer.unref();
  });

/** The Postgres logical-replication {@link PgReplicationSource} implementation. */
class PgLogicalReplicationSource implements PgReplicationSource {
  readonly #createClient: () => PgReplicationClient;

  readonly #slot: string;

  readonly #startLsn: string | undefined;

  readonly #delay: (ms: number) => Promise<void>;

  readonly #reconnectMs: number;

  readonly #changeHandlers = new Set<ChangeHandler>();

  readonly #errorHandlers = new Set<SourceErrorHandler>();

  #client: PgReplicationClient | undefined;

  /** The current connection's identity, captured at each connect. Exposed via {@link identity}. */
  #identity: SystemIdentity | undefined;

  /**
   * Whether the slot has been created (and therefore must be dropped on stop). Set once, after
   * the first successful `createSlot` — so a `start` that failed *after* creating the slot
   * (e.g. `START_REPLICATION` threw) still has its orphaned slot dropped by a later `stop`.
   */
  #slotCreated = false;

  /** `start` has been called (guards double-start, which would re-`CREATE` the slot and leak). */
  #started = false;

  /** `stop` has been called — terminal (the slot is dropped, the source cannot resume). */
  #stopped = false;

  /**
   * Whether streaming has been established at least once (the first `start` reached
   * `START_REPLICATION`). Until then, a client `error` event is the CALLER's to handle via the
   * rejected `start()` promise — a background reconnect before the first success would (pre-slot)
   * re-`START` a slot that was never created and loop forever, or (post-slot) resurrect a source
   * the caller already discarded, leaking a WAL-pinning slot. So {@link #onClientError} only
   * reconnects once this is set.
   */
  #connected = false;

  /**
   * Whether a reconnect is already in flight. A dropped connection can fire `error` MORE THAN
   * ONCE (the socket errors, then errors again on teardown), and the old client's `error`
   * listener is still wired while the new one connects — so without this guard two `error`s
   * would launch overlapping reconnects that each mint a client and overwrite `#client`,
   * orphaning (and leaking) the first. One reconnect session at a time.
   */
  #reconnecting = false;

  constructor(options: PgReplicationSourceOptions) {
    this.#createClient = options.createClient;
    this.#slot = options.slot ?? DEFAULT_SLOT;
    this.#startLsn = options.startLsn;
    this.#delay = options.delay ?? realDelay;
    this.#reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS;
  }

  /** The current connection's captured `(systemId, timelineId)`, or `undefined` before start. */
  get identity(): SystemIdentity | undefined {
    return this.#identity;
  }

  async start(): Promise<void> {
    // Lifecycle guards carry codes: re-starting would re-`CREATE` the slot (errors) and orphan
    // the first connection; starting after the terminal, slot-dropping stop cannot resume.
    if (this.#stopped) {
      throw new LiveServerError(
        "LIVE_SERVER_REPLICATION_STOPPED",
        "Cannot start a replication source that has already been stopped (its slot is dropped); create a fresh source.",
        { slot: this.#slot },
      );
    }

    if (this.#started) {
      throw new LiveServerError(
        "LIVE_SERVER_REPLICATION_ALREADY_STARTED",
        "Replication source is already started.",
        { slot: this.#slot },
      );
    }

    // Mark started BEFORE opening: a first start that fails cannot be naively re-`start`ed
    // (a re-`CREATE` on the maybe-created slot would error) — the caller must `stop()` (which
    // drops any partial slot) and build a fresh source.
    this.#started = true;

    await this.#openAndStart(false);
  }

  onChange(handler: ChangeHandler): () => void {
    this.#changeHandlers.add(handler);

    return () => {
      this.#changeHandlers.delete(handler);
    };
  }

  onError(handler: SourceErrorHandler): () => void {
    this.#errorHandlers.add(handler);

    return () => {
      this.#errorHandlers.delete(handler);
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;

    this.#stopped = true;
    this.#changeHandlers.clear();

    // END the streaming connection FIRST, then drop the slot. A logical slot cannot be dropped on
    // its own active streaming connection — a same-connection `DROP_REPLICATION_SLOT` deadlocks
    // against the running COPY (proven by the live shakeout, L-4b7edd48) — and the slot must be
    // INACTIVE to drop. Ending the stream releases the slot; the real client's `dropSlot` then
    // runs on a FRESH connection. Both best-effort: a failure is routed, never thrown, so a
    // degraded stop still completes. (A hard crash that skips `stop()` still orphans the slot —
    // the runbook's disk-pressure case — which is why the deployment also owns slot-lag alerting.)
    await this.#endClient();
    await this.#dropSlot();

    this.#errorHandlers.clear();
    this.#client = undefined;
  }

  /** Open a fresh client, capture identity, create the slot (first start), and start streaming. */
  async #openAndStart(isReconnect: boolean): Promise<void> {
    const client = this.#createClient();

    this.#client = client;

    // Wire the error path before connecting — a connect failure surfaces as an error event.
    client.on("error", (error) => this.#onClientError(error));

    await client.connect();

    // A stop() can race ANY await here (a SIGTERM during a slow connect/identify/createSlot).
    // stop() already dropped the slot + ended the client it saw, but THIS local client may have
    // raced past it — so after each await, bail if stopped, tearing down exactly what this call
    // built. Without the re-check a stopped source could still reach `createSlot` below and
    // orphan a WAL-pinning slot stop() had already decided not to drop (the disk-fill footgun).
    if (await this.#abortIfStopped(client, false)) return;

    // IDENTIFY_SYSTEM before anything streams: its `(systemId, timelineId)` stamps every change
    // this connection decodes. Re-read on EVERY connect so a reconnect that crossed a failover
    // captures the NEW timeline (the same-cluster failover Inc4's resume must not miss).
    const identity = await client.identifySystem();

    this.#identity = identity;

    if (await this.#abortIfStopped(client, false)) return;

    // Create the slot on the FIRST start only; it persists in Postgres across reconnects
    // (re-`CREATE`ing an existing slot errors). This is the WAL-pinning resource the source
    // owns and MUST drop on stop.
    if (!isReconnect) {
      await client.createSlot(this.#slot);
      this.#slotCreated = true;
    }

    // A stop() that raced the createSlot above ran its own drop while the slot did not yet exist
    // (a no-op) — so drop it here, on this client, rather than orphan it.
    if (await this.#abortIfStopped(client, !isReconnect)) return;

    // Only now, with identity known, wire the change sink — so every decoded change is stamped
    // with THIS connection's identity, closing the window on an unstamped change.
    client.on("change", (change) => this.#emitChange(change, identity));

    // Resume from the caller's LSN if given (Inc4), else from the slot's confirmed position —
    // the tail never starts "now" and gaps over `(snapshot, tail]`.
    await client.startReplication(this.#slot, this.#startLsn);

    // Streaming is established: only NOW may a later connection error trigger a background
    // reconnect (see {@link #connected}).
    this.#connected = true;
  }

  /**
   * If `stop()` ran while `#openAndStart` was mid-flight, tear THIS connection down and report
   * the abort so the open unwinds. Drops the slot it just created (only `stop()` can't, because
   * at the moment it ran the slot did not yet exist) and ends the client — both best-effort,
   * routed not thrown, so a degraded teardown still completes.
   */
  async #abortIfStopped(client: PgReplicationClient, createdSlot: boolean): Promise<boolean> {
    if (!this.#stopped) return false;

    if (createdSlot) {
      try {
        await client.dropSlot(this.#slot);
      } catch (error) {
        this.#routeError(error);
      }
    }

    try {
      await client.end();
    } catch (error) {
      this.#routeError(error);
    }

    return true;
  }

  /** Stamp the connection's identity onto a decoded change and fan it, unfiltered, to every sink. */
  #emitChange(decoded: DecodedChange, identity: SystemIdentity): void {
    // `decoded` is a well-formed per-op union member; stamping exactly the two identity fields
    // onto it yields the same-op `ReplicationChange`. TS can't track that a spread preserves the
    // op→image correlation, so this is the one asserted narrowing.
    const change = {
      ...decoded,
      systemId: identity.systemId,
      timelineId: identity.timelineId,
    } as ReplicationChange;

    // FULL, UNFILTERED feed: every change is emitted, none is dropped — authorization is the
    // shape engine's job downstream, never here (ADR 0042).
    for (const handler of this.#changeHandlers) handler(change);
  }

  /**
   * Report a source error to every registered sink. A sink must not break the source, so a
   * throwing handler is swallowed — otherwise it would escape into the driver's EventEmitter
   * (this runs from a client `error`-event callback) or reject the fire-and-forget
   * `void #reconnect()` as an unhandled rejection.
   */
  #routeError(error: unknown): void {
    for (const handler of this.#errorHandlers) {
      try {
        handler(error);
      } catch {
        // A broken error sink cannot be allowed to crash the source's event loop.
      }
    }
  }

  /** A client error tears the connection down and schedules a reconnect. */
  #onClientError(error: unknown): void {
    this.#routeError(error);

    // Only reconnect once streaming was established (see {@link #connected}); a failure during
    // the first start is surfaced to the caller as a rejected `start()`, never a hidden loop.
    if (this.#connected) void this.#reconnect();
  }

  /**
   * Run ONE reconnect session — end the old client (KEEPING the slot, to resume from it), back
   * off, re-open and re-`START_REPLICATION`, retrying until it succeeds or the source stops.
   * The `#reconnecting` guard collapses overlapping `error` events into a single session (no
   * orphaned clients). Reconnect never re-creates the slot — the slot persists across the drop.
   */
  async #reconnect(): Promise<void> {
    if (this.#reconnecting || this.#stopped) return;

    this.#reconnecting = true;

    try {
      for (;;) {
        await this.#endClient();
        await this.#delay(this.#reconnectMs);

        // A `stop` may have raced the backoff — do not resurrect a stopped source.
        if (this.#stopped) return;

        try {
          await this.#openAndStart(true);

          return; // reconnected + re-streaming
        } catch (error) {
          // The reconnect itself failed (DB still down) — report and loop to retry.
          this.#routeError(error);
        }
      }
    } finally {
      this.#reconnecting = false;
    }
  }

  /** Best-effort `DROP_REPLICATION_SLOT`; only when a slot was created and a client exists. */
  async #dropSlot(): Promise<void> {
    const client = this.#client;

    if (client === undefined || !this.#slotCreated) return;

    try {
      await client.dropSlot(this.#slot);
    } catch (error) {
      this.#routeError(error);
    }
  }

  /** Best-effort `end` of the current client; a failure to end is routed, not thrown. */
  async #endClient(): Promise<void> {
    const client = this.#client;

    if (client === undefined) return;

    try {
      await client.end();
    } catch (error) {
      this.#routeError(error);
    }
  }
}

/**
 * Build a Postgres logical-replication {@link ChangeSource}.
 *
 * Pair it with the real client factory from {@link file://./pg-replication-client.ts}
 * (`createClient`) in production; inject a fake in tests. Own the returned source's lifecycle
 * explicitly: `start()` it once, and `stop()` it on graceful shutdown so the slot is dropped
 * and WAL stops piling up.
 */
export function createPgReplicationSource(
  options: PgReplicationSourceOptions,
): PgReplicationSource {
  return new PgLogicalReplicationSource(options);
}
