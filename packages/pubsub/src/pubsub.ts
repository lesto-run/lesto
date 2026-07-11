/**
 * An in-process publish/subscribe hub.
 *
 *   const hub = new PubSub();
 *   const off = hub.subscribe("orders", (message, channel) => { ... });
 *   await hub.publish("orders", { id: 1 });   // awaits async listeners
 *   off();                                     // unsubscribe exactly this listener
 *
 * Delivery is in subscription order, and `publish` resolves only once every
 * listener — sync and async — has settled. One listener throwing (or rejecting)
 * never aborts delivery to the rest: it is isolated and reported in
 * {@link PublishResult.failed}, exactly the invariant this package's sibling
 * `fanout()` enforces for sockets. State is process memory; the hub is
 * deliberately tiny and dependency-free.
 */

/**
 * A subscriber. Receives the published `message` and the `channel` it arrived
 * on. May be async — `publish` awaits the returned promise before resolving.
 */
export type Listener = (message: unknown, channel: string) => void | Promise<void>;

/**
 * The outcome of a {@link PubSub.publish}: how many listeners settled cleanly, and the
 * errors thrown (or promise-rejections) from the ones that didn't. `delivered +
 * failed.length` is the total number of listeners the message was handed to — a
 * channel with no subscribers yields `{ delivered: 0, failed: [] }`.
 */
export interface PublishResult {
  /** Listeners that received the message and settled without throwing. */
  readonly delivered: number;

  /**
   * The errors from listeners that threw or rejected, in delivery order. A dead
   * subscriber is collected here and NEVER aborts delivery to the rest — the same
   * invariant {@link fanout} enforces for a dead socket. It is the caller's call
   * whether to log them; `publish` itself never throws, so a fire-and-forget
   * `void hub.publish(...)` stays safe.
   */
  readonly failed: readonly unknown[];
}

export class PubSub {
  /**
   * Channel name -> its listeners, in subscription order. A `Set` gives us
   * stable insertion order plus O(1) add/delete, and naturally dedupes a
   * listener subscribed twice to the same channel.
   */
  private readonly channels = new Map<string, Set<Listener>>();

  /**
   * Register `listener` on `channel`. Returns an idempotent unsubscribe
   * function that removes exactly this listener — calling it more than once is
   * harmless.
   */
  subscribe(channel: string, listener: Listener): () => void {
    const listeners = this.channels.get(channel) ?? new Set<Listener>();

    listeners.add(listener);

    this.channels.set(channel, listeners);

    return () => {
      this.unsubscribe(channel, listener);
    };
  }

  /**
   * Remove `listener` from `channel`. A no-op if it was never subscribed. When
   * the channel empties we drop it entirely so `subscriberCount` and `clear`
   * stay honest.
   */
  unsubscribe(channel: string, listener: Listener): void {
    const listeners = this.channels.get(channel);

    if (listeners === undefined) {
      return;
    }

    listeners.delete(listener);

    if (listeners.size === 0) {
      this.channels.delete(channel);
    }
  }

  /**
   * Deliver `message` to every subscriber of `channel`, in subscription order,
   * awaiting any async listeners. Resolves with a {@link PublishResult} — the count
   * of listeners that settled cleanly plus the errors from any that didn't; a channel
   * with no subscribers is a no-op yielding `{ delivered: 0, failed: [] }`.
   *
   * We snapshot the listeners up front so that a listener mutating its own
   * channel mid-publish cannot disturb this delivery.
   *
   * Delivery stays SEQUENTIAL — each async listener is awaited before the next is
   * called — to honor the documented "in subscription order, every listener settled"
   * contract; concurrency would interleave async listeners' side effects and change
   * observable ordering. What changes is ISOLATION: each call sits in its own
   * try/catch, so a listener that throws or rejects is collected into `failed` and
   * never aborts delivery to the rest (the invariant `fanout()` enforces for sockets).
   */
  async publish(channel: string, message: unknown): Promise<PublishResult> {
    const listeners = this.channels.get(channel);

    if (listeners === undefined) {
      return { delivered: 0, failed: [] };
    }

    const snapshot = [...listeners];

    let delivered = 0;
    const failed: unknown[] = [];

    for (const listener of snapshot) {
      try {
        await listener(message, channel);

        delivered += 1;
      } catch (error) {
        failed.push(error);
      }
    }

    return { delivered, failed };
  }

  /** How many listeners are currently subscribed to `channel`. */
  subscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  /** Clear one channel's listeners, or every channel when `channel` is omitted. */
  clear(channel?: string): void {
    if (channel === undefined) {
      this.channels.clear();

      return;
    }

    this.channels.delete(channel);
  }
}
