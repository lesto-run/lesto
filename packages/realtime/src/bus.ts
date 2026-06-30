/**
 * The realtime bus (ADR 0040) — the process-scoped composition that wires a
 * {@link Transport} to the in-process hub and the replay ring.
 *
 * The spine: **every topic flows through the listen stream, local or remote.** A
 * local write declares a dirty topic by calling {@link RealtimeBus.publish}, which
 * only issues the cross-process `NOTIFY`; Postgres delivers that `NOTIFY` back to
 * *this* node's own listener too, so the topic lands via the transport's
 * `onRemoteMessage` exactly like a topic from any other node. That single inbound
 * stream is where the ring records (assigning the global, commit-ordered cursor)
 * and where the hub fans out — so every node's ring agrees on order and a node
 * never double-records its own writes.
 *
 * `record` is synchronous and the hub fan-out is fired without `await` (the
 * non-blocking-listener invariant — the SSE connection listeners enqueue and
 * return synchronously), so landing a remote topic never blocks the delivery
 * stream. Composed from real `@lesto/pubsub` + `ReplayRing` over an injected
 * transport, so it is fully tested without a database.
 */

import { PubSub } from "@lesto/pubsub";

import type { ReplayRing } from "./replay-ring";
import type { Transport } from "./transport";

/** A running realtime bus: the hub the SSE fan-out subscribes to, plus publish/lifecycle. */
export interface RealtimeBus {
  /** The in-process hub (channels = topics, message = the ring-assigned cursor). */
  readonly hub: PubSub;

  /** The process replay ring (recorded by the inbound stream, read by reconnects). */
  readonly ring: ReplayRing;

  /**
   * Declare a topic dirty after a local write (ADR 0027). Fire-and-forget across
   * the fleet: it ships the `NOTIFY`, whose round-trip records + fans out locally.
   * MUST be called only AFTER the write's `await` resolves — publishing before
   * commit is the one non-resync-recoverable failure (a subscriber refetches
   * pre-write state and spends the invalidation).
   */
  publish(topic: string): void | Promise<void>;

  /** Open the transport (connect + `LISTEN`). */
  start(): Promise<void>;

  /** Close the transport and stop fan-out. */
  close(): Promise<void>;
}

/** What {@link createRealtimeBus} composes. */
export interface RealtimeBusOptions {
  /**
   * The transport. Its `bumpGeneration` MUST bump the SAME `ring` passed here (wire
   * `bumpGeneration: () => ring.bumpGeneration()` when constructing it), so a
   * re-LISTEN gap invalidates exactly the cursors this bus's ring issued.
   */
  readonly transport: Transport;

  /** The process replay ring — shared with the transport's generation bump. */
  readonly ring: ReplayRing;

  /** The in-process hub; a fresh {@link PubSub} by default. */
  readonly hub?: PubSub;
}

/**
 * Compose a transport, a replay ring, and the in-process hub into a running bus.
 *
 * Subscribes the transport's inbound topic stream to the ring+hub bridge at
 * construction; the bridge records each topic (global cursor) and fans it out to
 * the hub. `start`/`close` drive the transport; `publish` ships a local write's
 * dirty topic to the fleet.
 */
export function createRealtimeBus(options: RealtimeBusOptions): RealtimeBus {
  const { transport, ring } = options;
  const hub = options.hub ?? new PubSub();

  // The single inbound bridge: a topic from the listen stream (this node's own
  // NOTIFY round-trip or any other node's) records once — assigning the commit-
  // ordered cursor — then fans out to the hub. The hub message IS that cursor.
  transport.onRemoteMessage((topic) => {
    const cursor = ring.record(topic);

    // Fire-and-forget: the SSE connection listeners enqueue synchronously, so this
    // resolves synchronously; not awaiting honors the non-blocking-listener invariant.
    void hub.publish(topic, cursor);
  });

  return {
    hub,
    ring,

    publish(topic: string): void | Promise<void> {
      return transport.publishRemote(topic);
    },

    start(): Promise<void> {
      return transport.start();
    },

    close(): Promise<void> {
      return transport.close();
    },
  };
}
