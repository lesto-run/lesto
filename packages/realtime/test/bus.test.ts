import { describe, expect, it } from "vitest";

import { PubSub } from "@lesto/pubsub";

import { createRealtimeBus } from "../src/bus";
import { ReplayRing } from "../src/replay-ring";
import type { Transport } from "../src/transport";

/** A fake transport that captures the inbound bridge and records lifecycle calls. */
function fakeTransport(): {
  transport: Transport;
  emit: (topic: string) => void;
  published: string[];
  started: number;
  closed: number;
} {
  let handler: ((topic: string) => void) | undefined;
  const published: string[] = [];
  const state = { started: 0, closed: 0 };

  const transport: Transport = {
    publishRemote: (topic) => {
      published.push(topic);
    },
    onRemoteMessage: (cb) => {
      handler = cb;

      return () => {
        handler = undefined;
      };
    },
    start: async () => {
      state.started += 1;
    },
    close: async () => {
      state.closed += 1;
    },
  };

  return {
    transport,
    emit: (topic) => handler?.(topic),
    published,
    get started() {
      return state.started;
    },
    get closed() {
      return state.closed;
    },
  };
}

describe("createRealtimeBus", () => {
  it("records an inbound topic into the ring and fans it out to the hub with the cursor", async () => {
    const { transport, emit } = fakeTransport();
    const ring = new ReplayRing({ instanceId: "node-a", maxEntries: 100, maxAgeMs: 60_000 });

    const bus = createRealtimeBus({ transport, ring });

    const seen: unknown[] = [];
    bus.hub.subscribe("org:1:posts", (message) => {
      seen.push(message);
    });

    emit("org:1:posts");
    // The hub delivery is fired synchronously (the listener is sync), so it has run.
    await Promise.resolve();

    // The ring advanced (recorded once, assigning the global cursor)…
    expect(ring.cursor()).toEqual({ instanceId: "node-a", generation: 0, index: 1 });
    // …and the hub message IS that cursor.
    expect(seen).toEqual([{ instanceId: "node-a", generation: 0, index: 1 }]);
  });

  it("publish ships the topic to the transport (the NOTIFY round-trips back)", async () => {
    const { transport, published } = fakeTransport();
    const ring = new ReplayRing({ instanceId: "n", maxEntries: 10, maxAgeMs: 1_000 });

    const bus = createRealtimeBus({ transport, ring });

    await bus.publish("org:1:posts");

    expect(published).toEqual(["org:1:posts"]);
  });

  it("start and close drive the transport", async () => {
    const fake = fakeTransport();
    const ring = new ReplayRing({ instanceId: "n", maxEntries: 10, maxAgeMs: 1_000 });

    const bus = createRealtimeBus({ transport: fake.transport, ring });

    await bus.start();
    await bus.close();

    expect(fake.started).toBe(1);
    expect(fake.closed).toBe(1);
  });

  it("uses an injected hub when provided, else mints a fresh one", () => {
    const ring = new ReplayRing({ instanceId: "n", maxEntries: 10, maxAgeMs: 1_000 });

    const injected = new PubSub();
    const withHub = createRealtimeBus({
      transport: fakeTransport().transport,
      ring,
      hub: injected,
    });
    expect(withHub.hub).toBe(injected);

    const withoutHub = createRealtimeBus({ transport: fakeTransport().transport, ring });
    expect(withoutHub.hub).toBeInstanceOf(PubSub);
  });

  it("the inbound bridge does not block on a slow hub listener (fire-and-forget publish)", async () => {
    const { transport, emit } = fakeTransport();
    const ring = new ReplayRing({ instanceId: "n", maxEntries: 10, maxAgeMs: 1_000 });

    const bus = createRealtimeBus({ transport, ring });

    // An async listener that never resolves would hang an awaited publish; the bridge
    // voids the publish, so `emit` returns synchronously regardless.
    bus.hub.subscribe("t", async () => new Promise(() => {}));

    const before = ring.cursor().index;
    emit("t");

    // The record ran synchronously despite the pending listener.
    expect(ring.cursor().index).toBe(before + 1);
  });
});
