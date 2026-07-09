/**
 * Safe fan-out of a channel's messages over arbitrary sockets — the transport-
 * neutral core that lets `@lesto/pubsub` back a live cross-process demo without
 * knowing anything about the socket underneath it.
 *
 * The core is deliberately split into two independent pieces, because the two
 * substrates that use it own the "who is subscribed" question differently:
 *
 *   - {@link fanout} is the pure **send policy**: given a set of sockets and one
 *     frame, write the frame to each, don't let a dead socket abort delivery to the
 *     rest, and report which sockets failed. It holds no state and no registry.
 *   - {@link FanoutRegistry} is a plain in-memory **registry** (channel → sockets)
 *     for a single-process server (`examples/pubsub/serve.ts`): one process owns its
 *     subscribers, so it keeps them in a `Map`.
 *
 * On a hibernatable Cloudflare Durable Object there is NO in-memory registry to
 * keep — the runtime is evicted between events, so `state.getWebSockets(tag)` IS the
 * registry. That DO therefore uses {@link fanout} directly over the runtime's socket
 * list and never touches {@link FanoutRegistry}. The single genuinely-shared surface
 * is "write this frame to these sockets, safely" — that is {@link fanout}, and both
 * substrates satisfy {@link FanoutSocket} structurally (a workerd `WebSocket` and a
 * Bun `ServerWebSocket` each expose `send(string)`).
 *
 * The per-message sequence number is NOT owned here: a single-process server keeps
 * an in-process `let seq`, while a hibernatable DO must keep a DURABLE counter (an
 * in-memory one would rewind on eviction). So the caller stamps `seq` into the
 * {@link FanoutFrame} it hands to {@link fanout}.
 */

/**
 * The only things {@link fanout} needs from a subscriber: somewhere to `send` a
 * framed string, and (optionally) how many bytes are queued but unsent. A workerd
 * `WebSocket` server end and a Bun `ServerWebSocket` both satisfy this structurally,
 * so neither substrate has to adapt its socket to a foreign interface.
 */
export interface FanoutSocket {
  send(data: string): void;

  /**
   * Bytes queued for send but not yet flushed. workerd exposes it as a property; Bun's
   * `ServerWebSocket` behind a small adapter (`getBufferedAmount()`); `undefined` means
   * backpressure is simply not observable on this transport. Read by {@link fanout}'s
   * {@link FanoutOptions.maxBufferedBytes} bound — a socket over the bound is a slow
   * consumer, reported in {@link FanoutResult.failed} and never buffered without limit.
   */
  readonly bufferedAmount?: number;
}

/**
 * A framed message on the wire: JSON, self-describing (`type`), carrying the
 * `channel` it was published on, a monotonic `seq` (an opaque ordering witness,
 * stamped by the caller — see the module doc on why `seq` is not owned here), and
 * the arbitrary `data` the publisher sent.
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

/**
 * Tuning for a {@link fanout}. Today just the backpressure bound; a struct so more can
 * be added without breaking callers.
 */
export interface FanoutOptions {
  /**
   * The most bytes a socket may have queued-but-unsent (`bufferedAmount`) and still be
   * written to. A socket over this bound is a SLOW CONSUMER: the frame is not sent to
   * it and it is returned in {@link FanoutResult.failed} for the caller to close
   * (drop-to-resync — workerd/Bun expose no drain event, so this is a poll at send
   * time, then close). A socket that does not report `bufferedAmount` is never bounded
   * here (the transport gives nothing to measure — honest). Omit to disable the bound.
   */
  readonly maxBufferedBytes?: number;
}

/**
 * The outcome of a {@link fanout}: how many sockets received the frame, and which failed.
 * Generic over the socket type so a caller that passed richer sockets (e.g. a workerd
 * `WebSocket` with `close`) gets them back in `failed` with that type, ready to reap.
 */
export interface FanoutResult<S extends FanoutSocket = FanoutSocket> {
  /** Sockets the frame was successfully written to. */
  readonly delivered: number;

  /**
   * Sockets NOT written to and left for the caller to reap: a `send` that threw (a
   * dead/closed connection) OR a slow consumer over {@link FanoutOptions.maxBufferedBytes}.
   */
  readonly failed: readonly S[];
}

/**
 * Write one `frame` to every socket in `sockets`, safely.
 *
 * Encodes the frame ONCE, then sends it to each socket in turn. A socket is left unsent
 * and dropped into {@link FanoutResult.failed} — never aborting delivery to the rest (the
 * load-bearing invariant) — when either it is a slow consumer whose `bufferedAmount`
 * exceeds {@link FanoutOptions.maxBufferedBytes}, or its `send` throws (a closed/errored
 * connection). `delivered` counts only the sockets the frame was *successfully written
 * to*; everything in `failed` is for the caller to reap (a single-process server calls
 * {@link FanoutRegistry.drop} + closes; a hibernatable DO closes the socket, and the
 * runtime evicts it from the tag set).
 *
 * `fanout` holds no state and does not mutate `sockets`; the caller owns the registry
 * and does any reaping after this returns.
 */
export function fanout<S extends FanoutSocket>(
  sockets: Iterable<S>,
  frame: FanoutFrame,
  opts?: FanoutOptions,
): FanoutResult<S> {
  const encoded = encodeFrame(frame);
  const maxBufferedBytes = opts?.maxBufferedBytes;

  let delivered = 0;
  const failed: S[] = [];

  for (const socket of sockets) {
    // Backpressure: a socket whose queued-but-unsent bytes exceed the bound has fallen
    // behind — skip the send and report it so the caller closes it (a socket that does
    // not report `bufferedAmount` cannot be bounded, so it is always sent to).
    if (
      maxBufferedBytes !== undefined &&
      socket.bufferedAmount !== undefined &&
      socket.bufferedAmount > maxBufferedBytes
    ) {
      failed.push(socket);
      continue;
    }

    try {
      socket.send(encoded);
      delivered += 1;
    } catch {
      failed.push(socket);
    }
  }

  return { delivered, failed };
}

/**
 * A single-process channel → sockets registry, for a server that owns its
 * subscribers in memory (`examples/pubsub/serve.ts`). A hibernatable Durable Object
 * does NOT use this — the workerd runtime owns its sockets, enumerated by
 * `state.getWebSockets(tag)`; only a long-lived single process keeps its own `Map`.
 */
export class FanoutRegistry<S extends FanoutSocket = FanoutSocket> {
  /** Channel name → its subscribed sockets. Insertion-ordered, O(1) add/delete. */
  private readonly channels = new Map<string, Set<S>>();

  /**
   * Subscribe `socket` to `channel`. Returns an idempotent drop thunk — call it from
   * the socket's close/error handler (calling it more than once is harmless).
   */
  add(channel: string, socket: S): () => void {
    const sockets = this.channels.get(channel) ?? new Set<S>();

    sockets.add(socket);

    this.channels.set(channel, sockets);

    return () => {
      this.drop(channel, socket);
    };
  }

  /** The sockets subscribed to `channel` — an empty iterable when there are none. */
  socketsFor(channel: string): Iterable<S> {
    return this.channels.get(channel) ?? EMPTY;
  }

  /**
   * Remove `socket` from `channel`. A no-op if it was never subscribed. When the
   * channel empties we drop it entirely so {@link subscriberCount} stays honest.
   */
  drop(channel: string, socket: S): void {
    const sockets = this.channels.get(channel);

    if (sockets === undefined) {
      return;
    }

    sockets.delete(socket);

    if (sockets.size === 0) {
      this.channels.delete(channel);
    }
  }

  /** How many sockets are currently subscribed to `channel`. */
  subscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}

/** A shared empty list, returned by {@link FanoutRegistry.socketsFor} for an unknown channel. */
const EMPTY: readonly never[] = [];
