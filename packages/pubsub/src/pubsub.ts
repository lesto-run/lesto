/**
 * An in-process publish/subscribe hub.
 *
 *   const hub = new PubSub();
 *   const off = hub.subscribe("orders", (message, channel) => { ... });
 *   await hub.publish("orders", { id: 1 });   // awaits async listeners
 *   off();                                     // unsubscribe exactly this listener
 *
 * Delivery is in subscription order, and `publish` resolves only once every
 * listener — sync and async — has settled. State is process memory; the hub is
 * deliberately tiny and dependency-free.
 */

/**
 * A subscriber. Receives the published `message` and the `channel` it arrived
 * on. May be async — `publish` awaits the returned promise before resolving.
 */
export type Listener = (message: unknown, channel: string) => void | Promise<void>;

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
   * awaiting any async listeners. Resolves with the number of listeners
   * notified — `0` (and a no-op) for a channel with no subscribers.
   *
   * We snapshot the listeners up front so that a listener mutating its own
   * channel mid-publish cannot disturb this delivery.
   */
  async publish(channel: string, message: unknown): Promise<number> {
    const listeners = this.channels.get(channel);

    if (listeners === undefined) {
      return 0;
    }

    const snapshot = [...listeners];

    for (const listener of snapshot) {
      await listener(message, channel);
    }

    return snapshot.length;
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
