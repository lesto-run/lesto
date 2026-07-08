/**
 * Safe fan-out of a channel's messages over arbitrary sockets — the transport-
 * neutral core that lets `@lesto/pubsub` back a live cross-process demo without
 * knowing anything about the socket underneath it.
 *
 * `PubSub` is a per-process hub (its listeners live in one isolate's memory). On
 * an edge runtime there is no shared memory across isolates, so a cross-isolate
 * demo needs ONE coordination point — a Cloudflare Durable Object — that
 * terminates every subscriber's WebSocket and fans published messages out to
 * them. `FanoutRoom` is the brain of that point: it wraps a `PubSub`, turns each
 * subscriber into a listener that writes a framed message to a socket, and stamps
 * a monotonic sequence on every frame. It carries ZERO Cloudflare specifics — the
 * DO (`examples/pubsub/room.ts`) and the Node `serve.ts` both satisfy
 * {@link FanoutSocket} structurally (a workerd `WebSocket` server end and a Bun
 * `ServerWebSocket` each expose `send(string)`), so the SAME core serves both.
 */

import { PubSub } from "./pubsub";

/**
 * The only thing {@link FanoutRoom} needs from a subscriber: somewhere to `send`
 * a framed string. A workerd `WebSocket` server end and a Bun `ServerWebSocket`
 * both satisfy this structurally, so neither the edge DO nor the Node server has
 * to adapt its socket to a foreign interface.
 */
export interface FanoutSocket {
  send(data: string): void;
}

/**
 * A framed message on the wire: JSON, self-describing (`type`), carrying the
 * `channel` it was published on, a per-room monotonic `seq` (a diagnostic — lets
 * a client spot a dropped frame), and the arbitrary `data` the publisher sent.
 */
export interface FanoutFrame {
  type: "message";
  channel: string;
  seq: number;
  data: unknown;
}

/** Serialize a {@link FanoutFrame} for {@link FanoutSocket.send}. */
export function encodeFrame(frame: FanoutFrame): string {
  return JSON.stringify(frame);
}

/** A validated `POST /publish` body: which channel, and the message to fan out. */
export interface PublishRequest {
  channel: string;
  message: unknown;
}

/**
 * Validate an untrusted `/publish` body. Returns the {@link PublishRequest} for a
 * shape with a non-empty string `channel` and a present `message` key (any value,
 * `null` included); returns `undefined` for anything else, so a caller answers a
 * malformed body with a 400 instead of publishing garbage.
 */
export function parsePublishBody(raw: unknown): PublishRequest | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const channel = record.channel;

  if (typeof channel !== "string" || channel.length === 0) {
    return undefined;
  }

  if (!("message" in record)) {
    return undefined;
  }

  return { channel, message: record.message };
}

/** The envelope {@link FanoutRoom} publishes onto its hub — `seq` stamped, `data` verbatim. */
interface FanoutEnvelope {
  seq: number;
  data: unknown;
}

/**
 * A fan-out room: subscribers register a {@link FanoutSocket} on a channel, a
 * publisher sends an arbitrary message to a channel, and every socket subscribed
 * to that channel receives one framed copy.
 *
 * Built on `PubSub`, but hardened for real sockets (two load-bearing invariants):
 *
 *   1. **A socket whose `send` throws is dropped, never rethrown.** `PubSub.publish`
 *      awaits its listeners in a loop with no try/catch, so a throwing listener
 *      would abort fan-out to every subscriber after it. {@link add}'s listener
 *      therefore wraps `send` in try/catch and self-unsubscribes on failure.
 *      Because `publish` snapshots its listeners before delivering, a listener
 *      removing itself mid-delivery cannot disturb the delivery in progress.
 *   2. **{@link add} registers synchronously.** A caller that registers the socket
 *      before returning its `101 Switching Protocols` upgrade response guarantees
 *      the socket is live before any post-`open` publish can arrive — closing the
 *      "publish races subscribe" gap (see `examples/pubsub/room.ts`).
 */
export class FanoutRoom {
  private readonly hub: PubSub;

  /** Monotonic per-room sequence, stamped on every published frame. */
  private seq = 0;

  /**
   * `hub` is injectable so a caller can share ONE `PubSub` across rooms (or a
   * test can observe delivery on the raw hub); omitted, each room owns a private
   * hub.
   */
  constructor(opts?: { hub?: PubSub }) {
    this.hub = opts?.hub ?? new PubSub();
  }

  /**
   * Subscribe `socket` to `channel`. Returns an idempotent close thunk that
   * unsubscribes it — call it from the socket's close/error handler. The socket
   * receives one {@link encodeFrame}'d {@link FanoutFrame} per published message.
   */
  add(socket: FanoutSocket, channel: string): () => void {
    const off = this.hub.subscribe(channel, (message) => {
      const { seq, data } = message as FanoutEnvelope;

      try {
        socket.send(encodeFrame({ type: "message", channel, seq, data }));
      } catch {
        // A dead socket (closed / errored mid-delivery) must not abort fan-out to
        // everyone after it (invariant 1): drop it and swallow. `publish` took its
        // snapshot before the loop, so removing ourselves here is safe.
        off();
      }
    });

    return off;
  }

  /**
   * Fan `message` out to every socket subscribed to `channel`. Resolves with the
   * number of subscribers the message was DISPATCHED to — the snapshot length at
   * publish time. A socket that throws mid-send is dropped for future publishes
   * but is still counted here (it was in the snapshot), so treat the return as a
   * diagnostic and prove receipt on the socket itself, not by this count
   * (invariant 3).
   */
  async publish(channel: string, message: unknown): Promise<number> {
    const seq = ++this.seq;

    return this.hub.publish(channel, { seq, data: message } satisfies FanoutEnvelope);
  }

  /** How many sockets are currently subscribed to `channel`. */
  subscriberCount(channel: string): number {
    return this.hub.subscriberCount(channel);
  }
}
