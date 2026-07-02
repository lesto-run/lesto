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
});
