// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { observePageLifecycle } from "../src/client";
import type { LifecycleTarget } from "../src/client";

// ---------------------------------------------------------------------------
// A fake event target that records every listener and lets a test fire events,
// so the bfcache helper is exercised with no real navigation.
// ---------------------------------------------------------------------------

function fakeTarget(): {
  target: LifecycleTarget;
  fire: (type: string, event: Event) => void;
  types: () => string[];
  count: () => number;
} {
  const listeners = new Map<string, Set<(event: Event) => void>>();

  const target: LifecycleTarget = {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();

      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    target,
    fire(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    types: () => [...listeners.keys()].filter((type) => (listeners.get(type)?.size ?? 0) > 0),
    count: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
}

/** A pageshow/pagehide-shaped event carrying the `persisted` flag. */
function transitionEvent(type: string, persisted: boolean): Event {
  return Object.assign(new Event(type), { persisted });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("observePageLifecycle — bfcache-safe wiring", () => {
  it("NEVER attaches unload or beforeunload (the bfcache disqualifiers)", () => {
    const { target, types } = fakeTarget();

    observePageLifecycle(
      {
        onPageHide: () => undefined,
        onPageShow: () => undefined,
        onVisibilityChange: () => undefined,
      },
      { target },
    );

    expect(types()).toEqual(["pagehide", "pageshow", "visibilitychange"]);
    expect(types()).not.toContain("unload");
    expect(types()).not.toContain("beforeunload");
  });

  it("attaches only the handlers that were provided", () => {
    const { target, types } = fakeTarget();

    observePageLifecycle({ onPageShow: () => undefined }, { target });

    expect(types()).toEqual(["pageshow"]);
  });

  it("attaches nothing when no handlers are given", () => {
    const { target, count } = fakeTarget();

    observePageLifecycle({}, { target });

    expect(count()).toBe(0);
  });

  it("passes the persisted flag through pagehide and pageshow", () => {
    const { target, fire } = fakeTarget();

    const hides: boolean[] = [];

    const shows: boolean[] = [];

    observePageLifecycle(
      { onPageHide: (p) => hides.push(p), onPageShow: (p) => shows.push(p) },
      { target },
    );

    fire("pagehide", transitionEvent("pagehide", true));
    fire("pageshow", transitionEvent("pageshow", true));

    expect(hides).toEqual([true]);
    expect(shows).toEqual([true]);
  });

  it("treats a missing persisted flag as false (a plain Event)", () => {
    const { target, fire } = fakeTarget();

    const shows: boolean[] = [];

    observePageLifecycle({ onPageShow: (p) => shows.push(p) }, { target });

    fire("pageshow", new Event("pageshow"));

    expect(shows).toEqual([false]);
  });

  it("reports visibility via the injected reader", () => {
    const { target, fire } = fakeTarget();

    const visible: boolean[] = [];

    let state = "visible";

    observePageLifecycle(
      { onVisibilityChange: (v) => visible.push(v) },
      { target, visibilityState: () => state },
    );

    fire("visibilitychange", new Event("visibilitychange"));
    state = "hidden";
    fire("visibilitychange", new Event("visibilitychange"));

    expect(visible).toEqual([true, false]);
  });

  it("stop() removes exactly the listeners it added, and is idempotent", () => {
    const { target, fire, count } = fakeTarget();

    const hides: boolean[] = [];

    const stop = observePageLifecycle({ onPageHide: (p) => hides.push(p) }, { target });

    expect(count()).toBe(1);

    stop();

    expect(count()).toBe(0);

    // After stopping, a fired event reaches nobody.
    fire("pagehide", transitionEvent("pagehide", false));

    expect(hides).toEqual([]);

    // A second stop() is a harmless no-op.
    expect(() => stop()).not.toThrow();
  });
});

describe("observePageLifecycle — real defaults", () => {
  it("defaults the target to window and reads document.visibilityState", () => {
    const visible: boolean[] = [];

    const shown: boolean[] = [];

    // No target/visibilityState injected: exercises the real window listener and
    // the default `document.visibilityState` reader under jsdom. We dispatch on
    // `window` itself (the default target), not relying on document→window
    // bubbling, which jsdom does not perform for visibilitychange.
    const stop = observePageLifecycle({
      onVisibilityChange: (v) => visible.push(v),
      onPageShow: (p) => shown.push(p),
    });

    window.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));

    // jsdom's default document.visibilityState is "visible"; the plain pageshow
    // event carries no `persisted`, so the default-false branch applies.
    expect(visible).toEqual([true]);
    expect(shown).toEqual([false]);

    stop();
  });
});
