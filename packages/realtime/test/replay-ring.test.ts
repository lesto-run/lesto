import { describe, expect, it } from "vitest";

import { ReplayRing } from "../src/index";

// Seed a ring with four topics (indices 1..4) on an injected clock.
function seeded(now = () => 0): ReplayRing {
  const ring = new ReplayRing({ instanceId: "n1", maxEntries: 8, maxAgeMs: 100_000, now });
  ring.record("a");
  ring.record("b");
  ring.record("c");
  ring.record("d");

  return ring;
}

describe("ReplayRing — cursor + record", () => {
  it("starts at index 0 with the given instanceId and a default generation of 0", () => {
    // Omits `now` and `generation` to exercise the `?? Date.now` / `?? 0` defaults.
    const ring = new ReplayRing({ instanceId: "n1", maxEntries: 8, maxAgeMs: 1000 });

    expect(ring.cursor()).toEqual({ instanceId: "n1", generation: 0, index: 0 });
  });

  it("records topics with a monotonically increasing index and stamps the cursor", () => {
    let now = 0;
    const ring = new ReplayRing({
      instanceId: "n1",
      maxEntries: 8,
      maxAgeMs: 1000,
      now: () => now,
      generation: 3,
    });

    expect(ring.record("a")).toEqual({ instanceId: "n1", generation: 3, index: 1 });
    now = 5;
    expect(ring.record("b")).toEqual({ instanceId: "n1", generation: 3, index: 2 });
    expect(ring.cursor()).toEqual({ instanceId: "n1", generation: 3, index: 2 });
  });

  it("bumpGeneration starts a fresh epoch: generation+1, index reset, ring cleared", () => {
    const ring = new ReplayRing({ instanceId: "n1", maxEntries: 8, maxAgeMs: 1000, now: () => 0 });
    ring.record("a");

    expect(ring.bumpGeneration()).toBe(1);
    expect(ring.cursor()).toEqual({ instanceId: "n1", generation: 1, index: 0 });
    // The pre-bump cursor is from a prior generation → resync.
    expect(ring.reconcile({ instanceId: "n1", generation: 0, index: 1 })).toEqual({
      kind: "resync",
    });
  });
});

describe("ReplayRing — reconcile", () => {
  it("resyncs a cursor from a different instance (closes the cross-node mis-replay hole)", () => {
    const ring = seeded();

    expect(ring.reconcile({ instanceId: "n2", generation: 0, index: 2 })).toEqual({
      kind: "resync",
    });
  });

  it("resyncs a cursor from a different generation", () => {
    const ring = seeded();

    expect(ring.reconcile({ instanceId: "n1", generation: 9, index: 2 })).toEqual({
      kind: "resync",
    });
  });

  it("replays nothing when the cursor is already at the latest index", () => {
    const ring = seeded();

    expect(ring.reconcile({ instanceId: "n1", generation: 0, index: 4 })).toEqual({
      kind: "replay",
      topics: [],
    });
  });

  it("replays exactly the topics missed since the cursor", () => {
    const ring = seeded();

    expect(ring.reconcile({ instanceId: "n1", generation: 0, index: 2 })).toEqual({
      kind: "replay",
      topics: ["c", "d"],
    });
  });

  it("dedupes a topic invalidated more than once in the missed window", () => {
    const ring = new ReplayRing({
      instanceId: "n1",
      maxEntries: 8,
      maxAgeMs: 100_000,
      now: () => 0,
    });
    ring.record("posts");
    ring.record("posts");
    ring.record("users");

    expect(ring.reconcile({ instanceId: "n1", generation: 0, index: 0 })).toEqual({
      kind: "replay",
      topics: ["posts", "users"],
    });
  });
});

describe("ReplayRing — eviction forces resync past the window", () => {
  it("evicts by the count window and resyncs a cursor needing an evicted entry", () => {
    const ring = new ReplayRing({
      instanceId: "n1",
      maxEntries: 2,
      maxAgeMs: 100_000,
      now: () => 0,
    });
    ring.record("a");
    ring.record("b");
    ring.record("c");
    ring.record("d"); // keeps only indices 3,4 (c,d); oldest retained = 3

    // A client at index 1 needs entry 2, evicted → can't prove continuity → resync.
    expect(ring.reconcile({ instanceId: "n1", generation: 0, index: 1 })).toEqual({
      kind: "resync",
    });
    // A client at index 3 is within the ring → precise replay.
    expect(ring.reconcile({ instanceId: "n1", generation: 0, index: 3 })).toEqual({
      kind: "replay",
      topics: ["d"],
    });
  });

  it("evicts by the age window and resyncs a cursor needing an aged-out entry", () => {
    let now = 0;
    const ring = new ReplayRing({
      instanceId: "n1",
      maxEntries: 100,
      maxAgeMs: 10,
      now: () => now,
    });
    ring.record("a"); // index 1 at t0
    now = 100; // a is now older than the 10ms window
    ring.record("b"); // index 2 at t100; evicts a, keeps b

    // A client at index 0 needs entry 1 (a), aged out → resync.
    expect(ring.reconcile({ instanceId: "n1", generation: 0, index: 0 })).toEqual({
      kind: "resync",
    });
    // A client that saw a (index 1) → entry 2 (b) is retained → replay.
    expect(ring.reconcile({ instanceId: "n1", generation: 0, index: 1 })).toEqual({
      kind: "replay",
      topics: ["b"],
    });
  });
});
