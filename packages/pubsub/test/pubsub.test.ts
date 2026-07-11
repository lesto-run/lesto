import { describe, expect, it } from "vitest";

import { PubSub } from "../src/pubsub";

// A sleep that yields a real macrotask, so async listeners genuinely settle
// after a turn of the event loop rather than collapsing into a microtask.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

// A listener that does nothing — hoisted so each test reuses the same identity
// (and so the linter does not flag a fresh inner function that captures nothing).
const noop = () => {};

// A second distinct no-op, for tests that need two separate listener identities.
const noop2 = () => {};

describe("PubSub", () => {
  it("delivers to multiple listeners with (message, channel) in subscription order", async () => {
    const hub = new PubSub();

    const calls: Array<[string, unknown, string]> = [];

    hub.subscribe("orders", (message, channel) => {
      calls.push(["first", message, channel]);
    });

    hub.subscribe("orders", (message, channel) => {
      calls.push(["second", message, channel]);
    });

    const result = await hub.publish("orders", { id: 1 });

    expect(result).toEqual({ delivered: 2, failed: [] });

    expect(calls).toEqual([
      ["first", { id: 1 }, "orders"],
      ["second", { id: 1 }, "orders"],
    ]);
  });

  it("publishing to a channel with no subscribers returns 0 and is a no-op", async () => {
    const hub = new PubSub();

    const result = await hub.publish("empty", "hello");

    expect(result).toEqual({ delivered: 0, failed: [] });

    expect(hub.subscriberCount("empty")).toBe(0);
  });

  it("the returned unsubscribe function removes exactly that listener", async () => {
    const hub = new PubSub();

    const seen: string[] = [];

    const off = hub.subscribe("c", () => {
      seen.push("kept");
    });

    hub.subscribe("c", () => {
      seen.push("removed");
    });

    off();

    const result = await hub.publish("c", null);

    expect(result).toEqual({ delivered: 1, failed: [] });

    expect(seen).toEqual(["removed"]);
  });

  it("the returned unsubscribe function is idempotent", () => {
    const hub = new PubSub();

    const off = hub.subscribe("c", noop);

    off();
    off();

    expect(hub.subscriberCount("c")).toBe(0);
  });

  it("explicit unsubscribe(channel, listener) removes the listener", async () => {
    const hub = new PubSub();

    hub.subscribe("c", noop);

    expect(hub.subscriberCount("c")).toBe(1);

    hub.unsubscribe("c", noop);

    expect(hub.subscriberCount("c")).toBe(0);

    expect(await hub.publish("c", null)).toEqual({ delivered: 0, failed: [] });
  });

  it("unsubscribe on an unknown channel is a no-op", () => {
    const hub = new PubSub();

    hub.unsubscribe("never", noop);

    expect(hub.subscriberCount("never")).toBe(0);
  });

  it("awaits async listeners — publish resolves only after they complete", async () => {
    const hub = new PubSub();

    let completed = false;

    hub.subscribe("c", async () => {
      await tick();

      completed = true;
    });

    const result = await hub.publish("c", null);

    expect(completed).toBe(true);

    expect(result).toEqual({ delivered: 1, failed: [] });
  });

  it("a listener that throws does not abort delivery to the rest — it is isolated and reported", async () => {
    const hub = new PubSub();

    const seen: string[] = [];
    const boom = new Error("first listener is dead");

    // The FIRST of three listeners throws synchronously. The regression this pins: a
    // single dead subscriber must not abort delivery to the second and third — the exact
    // invariant `fanout()` enforces for a dead socket.
    hub.subscribe("c", () => {
      seen.push("first");

      throw boom;
    });

    hub.subscribe("c", () => {
      seen.push("second");
    });

    hub.subscribe("c", () => {
      seen.push("third");
    });

    const result = await hub.publish("c", { id: 1 });

    // The survivors still received the message, in subscription order.
    expect(seen).toEqual(["first", "second", "third"]);

    // The throw is reported, not swallowed, and `publish` itself never rejected.
    expect(result).toEqual({ delivered: 2, failed: [boom] });
  });

  it("an async listener that rejects is isolated exactly like a synchronous throw", async () => {
    const hub = new PubSub();

    const seen: string[] = [];
    const boom = new Error("async subscriber rejected");

    hub.subscribe("c", async () => {
      await tick();

      seen.push("first");

      throw boom;
    });

    hub.subscribe("c", async () => {
      await tick();

      seen.push("second");
    });

    const result = await hub.publish("c", null);

    expect(seen).toEqual(["first", "second"]);

    expect(result).toEqual({ delivered: 1, failed: [boom] });
  });

  it("collects the errors of every failed listener in delivery order", async () => {
    const hub = new PubSub();

    const first = new Error("first");
    const third = new Error("third");

    hub.subscribe("c", () => {
      throw first;
    });

    hub.subscribe("c", noop);

    hub.subscribe("c", () => {
      throw third;
    });

    const result = await hub.publish("c", null);

    expect(result).toEqual({ delivered: 1, failed: [first, third] });
  });

  it("subscriberCount reflects subscribe and unsubscribe", () => {
    const hub = new PubSub();

    expect(hub.subscriberCount("c")).toBe(0);

    hub.subscribe("c", noop);
    hub.subscribe("c", noop2);

    expect(hub.subscriberCount("c")).toBe(2);

    hub.unsubscribe("c", noop);

    expect(hub.subscriberCount("c")).toBe(1);
  });

  it("clear(channel) clears one channel only", () => {
    const hub = new PubSub();

    hub.subscribe("a", noop);
    hub.subscribe("b", noop);

    hub.clear("a");

    expect(hub.subscriberCount("a")).toBe(0);

    expect(hub.subscriberCount("b")).toBe(1);
  });

  it("clear() clears all channels", () => {
    const hub = new PubSub();

    hub.subscribe("a", noop);
    hub.subscribe("b", noop);

    hub.clear();

    expect(hub.subscriberCount("a")).toBe(0);

    expect(hub.subscriberCount("b")).toBe(0);
  });
});
