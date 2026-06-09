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

    const notified = await hub.publish("orders", { id: 1 });

    expect(notified).toBe(2);

    expect(calls).toEqual([
      ["first", { id: 1 }, "orders"],
      ["second", { id: 1 }, "orders"],
    ]);
  });

  it("publishing to a channel with no subscribers returns 0 and is a no-op", async () => {
    const hub = new PubSub();

    const notified = await hub.publish("empty", "hello");

    expect(notified).toBe(0);

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

    const notified = await hub.publish("c", null);

    expect(notified).toBe(1);

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

    expect(await hub.publish("c", null)).toBe(0);
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

    const notified = await hub.publish("c", null);

    expect(completed).toBe(true);

    expect(notified).toBe(1);
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
