/**
 * One live data connection's outbound logic — pure over an injected frame controller,
 * so every decision (the initial snapshot, per-change framing, backpressure overflow,
 * heartbeat, teardown) is tested without a socket. The socket itself is the controller
 * the handler injects.
 *
 * The row-data twin of `@lesto/realtime`'s `LiveConnection`: same backpressure
 * discipline — a slow client whose bounded buffer fills is dropped to a `resync` and
 * closed, never buffered without bound or allowed to stall others — but the frames carry
 * auth-scoped rows (snapshot + insert/update/delete-from-shape), not invalidation topics.
 */

import { changeFrame, commentFrame, resyncFrame, snapshotFrame } from "@lesto/live-protocol";
import type { Cursor, Row, ShapeChange } from "@lesto/live-protocol";

import { RESYNC_CURSOR } from "./resume";

/**
 * The slice of a `ReadableStreamDefaultController<string>` a connection writes through —
 * narrow on purpose so a fake drives every branch, and a real controller satisfies it
 * structurally.
 *
 * `desiredSize` is the backpressure signal: positive is remaining buffer, `<= 0` is the
 * high-water mark (a slow client), `null` is an errored/closed stream. `enqueue` may throw
 * if the stream was closed out from under us by a racing teardown; the connection treats
 * that as closed rather than letting it escape.
 */
export interface FrameController {
  readonly desiredSize: number | null;

  enqueue(frame: string): void;

  close(): void;
}

/** What a {@link ShapeConnection} needs: its controller + an overflow callback. */
export interface ShapeConnectionOptions {
  /** The stream controller this connection's frames are enqueued into. */
  readonly controller: FrameController;

  /**
   * Called once when backpressure forces this connection to drop to a resync (its buffer
   * is full). The handler uses it to tear the connection down — unsubscribe from the
   * engine, clear timers — after the final `resync` frame.
   */
  readonly onOverflow: () => void;
}

/** The outbound half of one live data connection. */
export class ShapeConnection {
  readonly #controller: FrameController;

  readonly #onOverflow: () => void;

  #closed = false;

  constructor(options: ShapeConnectionOptions) {
    this.#controller = options.controller;
    this.#onOverflow = options.onOverflow;
  }

  /** Emit the initial snapshot — the shape's authorized rows at the snapshot cursor. */
  snapshot(rows: readonly Row[], cursor: Cursor): void {
    if (this.#closed) return;

    this.#emit(snapshotFrame(rows, cursor));
  }

  /**
   * Deliver one change (insert / update / delete-from-shape), stamped with its cursor.
   * If the controller's bounded buffer is exhausted — a slow client not draining — this
   * connection is dropped to a `resync` and closed, rather than buffering without bound.
   */
  deliver(change: ShapeChange, cursor: Cursor): void {
    if (this.#closed) return;

    if (this.#isFull()) {
      this.#dropToResync();

      return;
    }

    this.#emit(changeFrame(change, cursor));
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
   * Emit a final `resync` frame — instructing the client to drop its durable slice and
   * re-fetch a fresh snapshot — then close. The shared primitive behind backpressure
   * overflow ({@link deliver}) and behind the handler's own de-authorization path (a
   * shape/session re-auth failure must purge what was already delivered, not merely stop
   * delivering more of it — closing the socket alone leaves stale rows in the client's
   * durable store). A no-op once already closed, so a caller racing {@link close} is safe.
   *
   * The frame is stamped with the non-resumable {@link RESYNC_CURSOR}, never a real position: a
   * resync means "your slice is gone", and a real `id:` here would let the client's reconnect prove
   * LSN-continuity and replay missed changes onto the emptied slice — a durable, strictly-worse
   * divergence (L-802b3e7b). Taking no cursor argument makes that hole unreconstructable by
   * construction.
   */
  resync(): void {
    if (this.#closed) return;

    this.#emit(resyncFrame(RESYNC_CURSOR));
    this.#closed = true;
    this.#safeClose();
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
  #dropToResync(): void {
    this.resync();
    this.#onOverflow();
  }

  /** True once the controller's bounded buffer is exhausted (slow client). */
  #isFull(): boolean {
    const { desiredSize } = this.#controller;

    return desiredSize === null || desiredSize <= 0;
  }

  /** Enqueue a frame, treating a racing close-out-from-under-us as closed. */
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
      // The consumer cancelled (or the stream errored) and already closed the controller.
    }
  }
}
