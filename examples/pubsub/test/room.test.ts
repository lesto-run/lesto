/**
 * `room.ts`'s `PubSubRoom` driven in-process against a fake, minimal Durable Object
 * state — no real workerd. This exists to prove the `/subscribe` guard added for
 * L-3d5d4ae6: a request with no `Upgrade: websocket` header must get a clean `426`,
 * not fall through to `new WebSocketPair()` (a workerd global this test environment
 * does not even provide — so the unguarded path throws a `ReferenceError` here, the
 * in-process analogue of the opaque `500` a real workerd instance returns).
 */

import { describe, expect, it } from "vitest";

import { PubSubRoom } from "../room";

/** A `DurableObjectState` stand-in carrying just the surface `PubSubRoom` touches. */
function fakeState() {
  return {
    acceptWebSocket(): void {
      // not reached by the 426 path this test exercises
    },
    getWebSockets(): WebSocket[] {
      return [];
    },
    storage: {
      get<T>(): Promise<T | undefined> {
        return Promise.resolve(undefined);
      },
      put(): Promise<void> {
        return Promise.resolve();
      },
      sql: {
        exec<T>() {
          return { toArray: (): T[] => [] };
        },
      },
    },
  };
}

describe("examples/pubsub — PubSubRoom#fetch /subscribe", () => {
  it("answers a non-upgrade /subscribe with 426, not a WebSocketPair crash", async () => {
    const room = new PubSubRoom(fakeState());

    const res = await room.fetch(new Request("http://x/subscribe?channel=demo"));

    expect(res.status).toBe(426);
  });
});
