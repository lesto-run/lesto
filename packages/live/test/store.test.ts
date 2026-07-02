import type { ShapeDefinition } from "@lesto/live-protocol";
import { describe, expect, it, vi } from "vitest";

import { createLiveStore } from "../src/index";

// A shape ordered by `rank` ascending (the key `id` is the final tiebreak) so the tests can
// assert `getRows()` returns rows in the shape's total order, not insertion order.
const def: ShapeDefinition = {
  table: "posts",
  key: "id",
  columns: ["id", "rank"],
  where: [],
  orderBy: { column: "rank", direction: "asc" },
};

describe("createLiveStore", () => {
  it("applies a snapshot, replacing the whole set in the shape's total order", () => {
    const store = createLiveStore(def);

    store.applySnapshot([
      { id: "b", rank: 2 },
      { id: "a", rank: 1 },
    ]);
    expect(store.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);

    // A second snapshot REPLACES the set rather than merging into it.
    store.applySnapshot([{ id: "c", rank: 3 }]);
    expect(store.getRows()).toEqual([{ id: "c", rank: 3 }]);
  });

  it("inserts, updates, and deletes rows via applyChange", () => {
    const store = createLiveStore(def);

    store.applyChange({ op: "insert", key: "a", row: { id: "a", rank: 2 } });
    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 1 } });
    expect(store.getRows()).toEqual([
      { id: "b", rank: 1 },
      { id: "a", rank: 2 },
    ]);

    // An update replaces the row under the same key and re-sorts it.
    store.applyChange({ op: "update", key: "a", row: { id: "a", rank: 0 } });
    expect(store.getRows()).toEqual([
      { id: "a", rank: 0 },
      { id: "b", rank: 1 },
    ]);

    // A delete-from-shape removes it.
    store.applyChange({ op: "delete", key: "b" });
    expect(store.getRows()).toEqual([{ id: "a", rank: 0 }]);
  });

  it("clears the slice on a resync", () => {
    const store = createLiveStore(def);

    store.applySnapshot([{ id: "a", rank: 1 }]);
    store.applyResync();
    expect(store.getRows()).toEqual([]);
  });

  it("returns a stable getRows() reference until the next mutation", () => {
    const store = createLiveStore(def);
    store.applySnapshot([{ id: "a", rank: 1 }]);

    const first = store.getRows();
    // No mutation between the two reads → the cached array is handed back by identity.
    expect(store.getRows()).toBe(first);

    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } });
    // A mutation invalidated the cache → a fresh, differently-identified array.
    expect(store.getRows()).not.toBe(first);
  });

  it("notifies subscribers on each mutation and stops after unsubscribe", () => {
    const store = createLiveStore(def);
    const listener = vi.fn();
    const off = store.subscribe(listener);

    store.applySnapshot([{ id: "a", rank: 1 }]);
    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } });
    store.applyResync();
    expect(listener).toHaveBeenCalledTimes(3);

    off();
    store.applySnapshot([]);
    // Unsubscribed: no further notifications.
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("tracks the last applied cursor as a variable (undefined before the first frame + after resync)", () => {
    const store = createLiveStore(def);
    expect(store.getCursor()).toBeUndefined();

    store.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
    expect(store.getCursor()).toBe("v1:s:1:1");

    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } }, "v1:s:1:2");
    expect(store.getCursor()).toBe("v1:s:1:2");

    // A resync abandons the local position — the cursor is cleared, not carried forward.
    store.applyResync();
    expect(store.getCursor()).toBeUndefined();
  });

  describe("optimistic overlay (Inc6)", () => {
    it("applyOptimistic shows a write over the authorized set and notifies", () => {
      const store = createLiveStore(def);
      const listener = vi.fn();
      store.subscribe(listener);

      store.applySnapshot([{ id: "a", rank: 1 }]);
      store.applyOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });

      expect(store.getRows()).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);
      expect(listener).toHaveBeenCalledTimes(2); // snapshot + optimistic
    });

    it("clearOptimistic rolls the write back to the authorized row", () => {
      const store = createLiveStore(def);

      store.applySnapshot([{ id: "a", rank: 1 }]);
      store.applyOptimistic("m1", { op: "update", key: "a", row: { id: "a", rank: 9 } });
      expect(store.getRows()).toEqual([{ id: "a", rank: 9 }]);

      store.clearOptimistic("m1");
      expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);
    });

    it("the optimistic overlay does NOT touch the authorized cursor (wire-only)", () => {
      const store = createLiveStore(def);

      store.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
      store.applyOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });

      // A local write must not advance (or clear) the resume cursor — that tracks the authorized
      // stream position only, so a reconnect still resumes from the last server frame.
      expect(store.getCursor()).toBe("v1:s:1:1");
    });

    it("a resync leaves a pending optimistic write intact (the outbox owns clearing it)", () => {
      const store = createLiveStore(def);

      store.applySnapshot([{ id: "a", rank: 1 }]);
      store.applyOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });

      // The wire resync drops the authorized slice but must not roll back an unrelated offline write.
      store.applyResync();
      expect(store.getRows()).toEqual([{ id: "b", rank: 2 }]);
    });

    it("the in-memory store exposes no durable outbox (session-only writes)", () => {
      const store = createLiveStore(def);

      expect(store.outbox).toBeUndefined();
    });
  });

  describe("held overlay + echo settlement (L-436724ba)", () => {
    it("holdOptimistic keeps the acked write shown without a re-render", () => {
      const store = createLiveStore(def);
      store.applySnapshot([{ id: "a", rank: 1 }]);
      store.applyOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });

      const listener = vi.fn();
      store.subscribe(listener);
      store.holdOptimistic("m1");

      // Held is invisible to the view — no subscriber fires — but the write stays shown.
      expect(listener).not.toHaveBeenCalled();
      expect(store.getRows()).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);
    });

    it("applyChange settles a held optimistic entry atomically and notifies onEchoSettled", () => {
      const store = createLiveStore(def);
      const settled: string[] = [];
      store.onEchoSettled((id) => settled.push(id));

      store.applySnapshot([{ id: "a", rank: 1 }]);
      store.applyOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });
      store.holdOptimistic("m1");

      // The authoritative echo for `b` lands — the held entry clears in the SAME mutation, so the
      // view never drops `b` (it was held) and never double-shows it (same value): zero flash.
      store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } });

      expect(settled).toEqual(["m1"]);
      expect(store.getRows()).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);
    });

    it("applySnapshot settles a held optimistic entry for a snapshotted key", () => {
      const store = createLiveStore(def);
      const settled: string[] = [];
      store.onEchoSettled((id) => settled.push(id));

      store.applySnapshot([{ id: "a", rank: 1 }]);
      store.applyOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });
      store.holdOptimistic("m1");

      // A fresh snapshot that carries `b` is its echo — the held entry clears.
      store.applySnapshot([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);

      expect(settled).toEqual(["m1"]);
      expect(store.getRows()).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);
    });
  });
});
