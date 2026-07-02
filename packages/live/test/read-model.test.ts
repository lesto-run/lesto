import type { Row, ShapeDefinition } from "@lesto/live-protocol";
import { describe, expect, it, vi } from "vitest";

import { createReadModel } from "../src/read-model";

// A shape ordered by `rank` ascending (the key `id` is the final tiebreak), matching the two
// stores' own tests so all three prove the same total-order + stable-reference contract.
const def: ShapeDefinition = {
  table: "posts",
  key: "id",
  columns: ["id", "rank"],
  where: [],
  orderBy: { column: "rank", direction: "asc" },
};

/** A minimal `rowsByKey`-shaped map the read model's `getRowsSnapshot` thunk reads from. */
function rowsMap(rows: readonly Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [String(row.id), row]));
}

describe("createReadModel", () => {
  it("sorts the rows returned by getRowsSnapshot in the shape's total order", () => {
    let map = rowsMap([
      { id: "b", rank: 2 },
      { id: "a", rank: 1 },
    ]);
    const model = createReadModel(def, () => map.values());

    expect(model.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);

    // The snapshot thunk is re-read fresh once dirtied — a store swapping in a whole new map
    // (as the in-memory store does) is picked up correctly.
    map = rowsMap([{ id: "c", rank: 3 }]);
    model.mutated();
    expect(model.getRows()).toEqual([{ id: "c", rank: 3 }]);
  });

  it("returns the SAME array reference across reads until mutated() is called", () => {
    const map = rowsMap([{ id: "a", rank: 1 }]);
    const model = createReadModel(def, () => map.values());

    const first = model.getRows();

    // Repeated reads with no intervening `mutated()` hand back the identical reference — the
    // `useSyncExternalStore` stable-snapshot contract this module exists to centralize.
    expect(model.getRows()).toBe(first);
    expect(model.getRows()).toBe(first);

    // Mutating the underlying map WITHOUT calling `mutated()` must not change what `getRows()`
    // returns — the cache is keyed off the dirty flag, not off polling the map.
    map.set("b", { id: "b", rank: 2 });
    expect(model.getRows()).toBe(first);

    // Only `mutated()` dirties the cache, producing a fresh (differently-identified) array that
    // reflects the map's current contents.
    model.mutated();
    const second = model.getRows();
    expect(second).not.toBe(first);
    expect(second).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);
    // And it, too, is now stable until the next `mutated()`.
    expect(model.getRows()).toBe(second);
  });

  it("tracks the cursor via setCursor/getCursor, undefined before the first set", () => {
    const model = createReadModel(def, () => []);

    expect(model.getCursor()).toBeUndefined();

    model.setCursor("v1:s:1:1");
    expect(model.getCursor()).toBe("v1:s:1:1");

    model.setCursor("v1:s:1:2");
    expect(model.getCursor()).toBe("v1:s:1:2");

    // A resync clears it back to undefined, exactly like the stores' own `applyResync`.
    model.setCursor(undefined);
    expect(model.getCursor()).toBeUndefined();
  });

  it("notifies subscribers on mutated() and stops after unsubscribe", () => {
    const model = createReadModel(def, () => []);
    const listener = vi.fn();
    const off = model.subscribe(listener);

    model.mutated();
    model.mutated();
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    model.mutated();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("supports multiple independent subscribers", () => {
    const model = createReadModel(def, () => []);
    const a = vi.fn();
    const b = vi.fn();

    model.subscribe(a);
    const offB = model.subscribe(b);

    model.mutated();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offB();
    model.mutated();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  describe("optimistic overlay (Inc6)", () => {
    it("merges an optimistic insert over the authorized set, in total order", () => {
      const map = rowsMap([
        { id: "a", rank: 1 },
        { id: "c", rank: 3 },
      ]);
      const model = createReadModel(def, () => map.values());

      // A new row not in the authorized set — shown immediately, sorted into place by `rank`.
      model.setOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });
      model.mutated();

      expect(model.getRows()).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
        { id: "c", rank: 3 },
      ]);
    });

    it("an optimistic update overrides the authorized row for that key (overlay wins)", () => {
      const map = rowsMap([{ id: "a", rank: 5 }]);
      const model = createReadModel(def, () => map.values());

      model.setOptimistic("m1", { op: "update", key: "a", row: { id: "a", rank: 9 } });
      model.mutated();

      expect(model.getRows()).toEqual([{ id: "a", rank: 9 }]);
    });

    it("an optimistic delete removes the authorized row from the merged view", () => {
      const map = rowsMap([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);
      const model = createReadModel(def, () => map.values());

      model.setOptimistic("m1", { op: "delete", key: "a" });
      model.mutated();

      expect(model.getRows()).toEqual([{ id: "b", rank: 2 }]);
    });

    it("clearOptimistic rolls back to the authorized row (a purely additive overlay)", () => {
      const map = rowsMap([{ id: "a", rank: 5 }]);
      const model = createReadModel(def, () => map.values());

      model.setOptimistic("m1", { op: "update", key: "a", row: { id: "a", rank: 9 } });
      model.mutated();
      expect(model.getRows()).toEqual([{ id: "a", rank: 9 }]);

      // Clearing the overlay reveals the untouched authorized row again — the rollback.
      model.clearOptimistic("m1");
      model.mutated();
      expect(model.getRows()).toEqual([{ id: "a", rank: 5 }]);
    });

    it("a newer write to the same key wins the merged view (both entries coexist by id)", () => {
      const map = rowsMap([{ id: "a", rank: 1 }]);
      const model = createReadModel(def, () => map.values());

      // Two independent in-flight writes to the SAME row key — kept as separate entries (keyed by
      // mutation id, not row key). Insertion order is submission order, so the newer one wins.
      model.setOptimistic("m1", { op: "update", key: "a", row: { id: "a", rank: 2 } });
      model.setOptimistic("m2", { op: "update", key: "a", row: { id: "a", rank: 3 } });
      model.mutated();

      expect(model.getRows()).toEqual([{ id: "a", rank: 3 }]);
    });

    it("with an empty overlay, getRows is byte-identical to the pre-Inc6 sort fast-path", () => {
      // The overlay-empty branch must not perturb the stable-reference contract: repeated reads
      // hand back the SAME array, and a set-then-clear that leaves the overlay empty again keeps
      // that fast-path (no lingering merged copy).
      const map = rowsMap([{ id: "a", rank: 1 }]);
      const model = createReadModel(def, () => map.values());

      const first = model.getRows();
      expect(model.getRows()).toBe(first);

      model.setOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });
      model.clearOptimistic("m1");
      model.mutated();

      const afterEmptyAgain = model.getRows();
      expect(afterEmptyAgain).toEqual([{ id: "a", rank: 1 }]);
      expect(model.getRows()).toBe(afterEmptyAgain);
    });
  });

  describe("held overlay + echo settlement (L-436724ba)", () => {
    it("holdOptimistic is invisible to getRows and a no-op on an unknown id", () => {
      const map = rowsMap([{ id: "a", rank: 1 }]);
      const model = createReadModel(def, () => map.values());

      model.setOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });
      model.mutated();
      const shown = model.getRows();

      // Marking held renders identically to a pending entry, so it dirties nothing — the same array
      // reference comes back (no needless re-render), and the row is still shown.
      model.holdOptimistic("m1");
      expect(model.getRows()).toBe(shown);
      expect(shown).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);

      // Holding an id with no pending entry (already echo-cleared) is a tolerated no-op.
      model.holdOptimistic("ghost");
      expect(model.getRows()).toBe(shown);
    });

    it("settleEcho drops the oldest held entry for a key, notifies, and leaves a newer pending write", () => {
      const map = rowsMap([{ id: "a", rank: 1 }]);
      const model = createReadModel(def, () => map.values());
      const settled: string[] = [];
      model.onEchoSettled((id) => settled.push(id));

      model.setOptimistic("m1", { op: "update", key: "a", row: { id: "a", rank: 2 } });
      model.holdOptimistic("m1"); // acked, awaiting echo
      model.setOptimistic("m2", { op: "update", key: "a", row: { id: "a", rank: 3 } }); // newer, pending
      model.mutated();
      expect(model.getRows()).toEqual([{ id: "a", rank: 3 }]); // newest wins

      // The echo for `a` settles the OLDEST held entry (m1), reports it, and leaves m2 showing.
      model.settleEcho("a");
      model.mutated();
      expect(settled).toEqual(["m1"]);
      expect(model.getRows()).toEqual([{ id: "a", rank: 3 }]);
    });

    it("with two held writes to one key, the first echo clears the older held without changing the view", () => {
      const map = rowsMap([{ id: "a", rank: 1 }]);
      const model = createReadModel(def, () => map.values());
      const settled: string[] = [];
      model.onEchoSettled((id) => settled.push(id));

      // Two writes to key `a`, BOTH acked (held) before either echo lands — the case the flat,
      // insertion-ordered overlay is chosen to handle without an intermediate-value flash.
      model.setOptimistic("m1", { op: "update", key: "a", row: { id: "a", rank: 2 } });
      model.holdOptimistic("m1");
      model.setOptimistic("m2", { op: "update", key: "a", row: { id: "a", rank: 3 } });
      model.holdOptimistic("m2");
      model.mutated();
      expect(model.getRows()).toEqual([{ id: "a", rank: 3 }]); // newest held wins

      // m1's echo lands first → clears the OLDER held (m1); m2 (newer, still held) keeps the view
      // pinned at rank 3, so the older write's echo never flashes an intermediate value.
      model.settleEcho("a");
      model.mutated();
      expect(settled).toEqual(["m1"]);
      expect(model.getRows()).toEqual([{ id: "a", rank: 3 }]);

      // m2's echo lands → clears the last held entry, revealing the authorized row.
      model.settleEcho("a");
      model.mutated();
      expect(settled).toEqual(["m1", "m2"]);
      expect(model.getRows()).toEqual([{ id: "a", rank: 1 }]);
    });

    it("settleEcho is a no-op when only a pending (unheld) entry targets the key", () => {
      const map = rowsMap([{ id: "a", rank: 1 }]);
      const model = createReadModel(def, () => map.values());
      const settled: string[] = [];
      model.onEchoSettled((id) => settled.push(id));

      model.setOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } }); // pending, not held
      model.mutated();

      model.settleEcho("b"); // no held entry for `b` → nothing settled
      model.mutated();
      expect(settled).toEqual([]);
      expect(model.getRows()).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);
    });

    it("settleEcho ignores a held entry for a different key", () => {
      const map = rowsMap([{ id: "a", rank: 1 }]);
      const model = createReadModel(def, () => map.values());
      const settled: string[] = [];
      model.onEchoSettled((id) => settled.push(id));

      model.setOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });
      model.holdOptimistic("m1");
      model.mutated();

      model.settleEcho("zzz"); // no entry targets `zzz`
      model.mutated();
      expect(settled).toEqual([]);
      expect(model.getRows()).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);
    });

    it("onEchoSettled stops notifying after unsubscribe", () => {
      const map = rowsMap([{ id: "a", rank: 1 }]);
      const model = createReadModel(def, () => map.values());
      const listener = vi.fn();
      const off = model.onEchoSettled(listener);

      model.setOptimistic("m1", { op: "insert", key: "b", row: { id: "b", rank: 2 } });
      model.holdOptimistic("m1");
      model.settleEcho("b");
      expect(listener).toHaveBeenCalledTimes(1);

      off();
      model.setOptimistic("m2", { op: "insert", key: "c", row: { id: "c", rank: 3 } });
      model.holdOptimistic("m2");
      model.settleEcho("c");
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
