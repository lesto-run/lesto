/**
 * One live SSE connection's outbound logic (ADR 0040 Phase B) — pure over an
 * injected frame controller, so every decision (initial replay vs resync,
 * per-delivery framing, backpressure overflow, heartbeat, teardown) is tested
 * without a socket. The socket itself is the controller the handler injects.
 *
 * Two invariants from the ADR live here:
 *
 *   - **The hub callback returns synchronously and never awaits the socket.**
 *     {@link LiveConnection.deliver} does its whole job — frame, enqueue — with no
 *     `await`, so one slow client can never head-of-line-block every subscriber on
 *     a topic, nor back-pressure the node's whole invalidation stream.
 *   - **Backpressure drops the one slow connection to a `resync`, never stalls
 *     others.** The injected controller's `desiredSize` IS the bounded queue: when
 *     it is exhausted (the client is not draining), this connection is sent a final
 *     `resync` and closed, rather than buffering without bound.
 */

import { commentFrame, encodeCursor, invalidateFrame, resyncFrame } from "./sse";
import type { Cursor, ReplayRing } from "./replay-ring";

/**
 * The slice of a `ReadableStreamDefaultController<string>` a connection writes
 * through — narrow on purpose so a fake drives every branch, and a real stream
 * controller satisfies it structurally.
 *
 * `desiredSize` is the backpressure signal: a positive number is remaining buffer,
 * `<= 0` means the high-water mark is reached (a slow client), and `null` means the
 * stream is errored/closed. `enqueue` may throw if the stream was closed out from
 * under us (a racing teardown); the connection guards its own `closed` flag so it
 * never enqueues after close in the normal path.
 */
export interface FrameController {
  readonly desiredSize: number | null;

  enqueue(frame: string): void;

  close(): void;
}

/** What a {@link LiveConnection} needs: the process replay ring + its controller. */
export interface LiveConnectionOptions {
  /**
   * The PROCESS-wide replay ring (fed by the transport, shared by every
   * connection). The connection only READS it — to reconcile a reconnect cursor;
   * it never records (the transport assigns cursors once, in global order).
   */
  readonly ring: ReplayRing;

  /** The stream controller this connection's frames are enqueued into. */
  readonly controller: FrameController;

  /**
   * Called once when backpressure forces this connection to drop to a resync
   * (its buffer is full). The handler uses it to tear the connection down —
   * unsubscribe from the hub, clear timers — after the final `resync` frame.
   */
  readonly onOverflow: () => void;
}

/** The outbound half of one live SSE connection. */
export class LiveConnection {
  readonly #ring: ReplayRing;

  readonly #controller: FrameController;

  readonly #onOverflow: () => void;

  #closed = false;

  constructor(options: LiveConnectionOptions) {
    this.#ring = options.ring;
    this.#controller = options.controller;
    this.#onOverflow = options.onOverflow;
  }

  /**
   * Emit the initial frames for a freshly opened connection, reconciling its
   * resume cursor against the process ring:
   *
   *   - **No cursor** (a brand-new client, no `Last-Event-ID`): nothing was missed
   *     — emit nothing. The client fetches on mount and then rides live deliveries.
   *   - **A cursor that proves continuity** (same process, generation, within the
   *     ring): emit one `invalidate` per missed topic — precise replay.
   *   - **Anything else** (different node, prior generation, evicted): one `resync`
   *     — the always-correct floor.
   *
   * Returns nothing; the frames are enqueued through the controller.
   */
  open(since: Cursor | undefined): void {
    if (since === undefined) return;

    const reconcile = this.#ring.reconcile(since);

    if (reconcile.kind === "resync") {
      this.#emit(resyncFrame(encodeCursor(this.#ring.cursor())));

      return;
    }

    for (const topic of reconcile.topics) {
      this.#emit(invalidateFrame(topic, encodeCursor(this.#ring.cursor())));
    }
  }

  /**
   * Deliver one topic the hub fanned out, with the cursor the ring assigned it
   * (NOT recorded here — the transport already recorded it once, in global order).
   * Synchronous and never awaits the socket (the non-blocking-listener invariant).
   *
   * If the controller's buffer is exhausted — a slow client that is not draining —
   * this connection is dropped to a `resync` and closed, rather than buffering
   * without bound or stalling the shared delivery stream.
   */
  deliver(topic: string, cursor: Cursor): void {
    if (this.#closed) return;

    if (this.#isFull()) {
      this.#dropToResync(cursor);

      return;
    }

    this.#emit(invalidateFrame(topic, encodeCursor(cursor)));
  }

  /** Emit a heartbeat comment, unless already closed. */
  heartbeat(): void {
    if (this.#closed) return;

    this.#emit(commentFrame("ping"));
  }

  /** Whether this connection has been closed (by overflow or teardown). */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Close the connection's controller exactly once. The handler calls this on
   * `context.signal` disconnect / TTL / revocation; overflow calls it internally.
   */
  close(): void {
    if (this.#closed) return;

    this.#closed = true;
    this.#safeClose();
  }

  /** A slow client's buffer is full → final `resync`, close, and signal overflow. */
  #dropToResync(cursor: Cursor): void {
    // Best-effort final frame so the client knows to reconcile on reconnect, then
    // close and let the handler tear the subscription down.
    this.#emit(resyncFrame(encodeCursor(cursor)));
    this.#closed = true;
    this.#safeClose();
    this.#onOverflow();
  }

  /** True once the controller's bounded buffer is exhausted (slow client). */
  #isFull(): boolean {
    const { desiredSize } = this.#controller;

    // `null` (errored/closed stream) counts as no room; a non-positive size means
    // the high-water mark — our bounded queue — is reached.
    return desiredSize === null || desiredSize <= 0;
  }

  /**
   * Enqueue a frame. Every caller already guards `#closed` (or runs at open, before
   * any close), so this does not re-check it — but a racing teardown (the consumer
   * cancelled, the stream errored) can still close the controller out from under us
   * between that guard and the `enqueue`; that throws, and we treat it as closed
   * rather than letting it escape.
   */
  #emit(frame: string): void {
    try {
      this.#controller.enqueue(frame);
    } catch {
      this.#closed = true;
    }
  }

  /** Close the controller, tolerating a stream the machinery already closed. */
  #safeClose(): void {
    try {
      this.#controller.close();
    } catch {
      // The consumer cancelled (or the stream errored) and already closed the
      // controller — closing again throws; the connection is closed either way.
    }
  }
}
