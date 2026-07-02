import { validateShapeDefinition } from "@lesto/live-protocol";
import type { Row, ShapeDefinition } from "@lesto/live-protocol";
import { describe, expect, it } from "vitest";

import {
  assertOldImageComplete,
  assertReplicaIdentity,
  predicateNeedsOldImage,
  prepareShapeClassifier,
  LiveServerError,
} from "../src/index";
import type { ImageCoercer } from "../src/index";
// `classifyChange` is deliberately NOT on the public barrel (callers go through the guarded
// `prepareShapeClassifier`); the pure function is imported from the module for direct unit coverage.
import { classifyChange } from "../src/classify";
import type { ReplicationChange, RowImage } from "../src/replication";

// A shape over `messages(id pk, room_id, body)`, filtering the NON-key column room_id = 1.
const shape = (where: ShapeDefinition["where"] = [{ column: "room_id", op: "eq", value: 1 }]) =>
  validateShapeDefinition({
    table: "messages",
    key: "id",
    columns: ["id", "room_id", "body"],
    where,
    orderBy: undefined,
  });

// A shape keyed on `room_id`, standing in for a UNIQUE **non-primary-key** shape key (`slug`/`email`)
// — the L-5c46b49b fail-closed case. `keyIsPrimaryKey` is passed `false` to the guards for this shape;
// under REPLICA IDENTITY DEFAULT the old tuple would be the PK (`id`) only, never `room_id`, so a key
// change strands the old row and a delete misses it — the guard must refuse it off a non-FULL table.
const uniqueKeyShape = (where: ShapeDefinition["where"] = []) =>
  validateShapeDefinition({
    table: "messages",
    key: "room_id",
    columns: ["id", "room_id", "body"],
    where,
    orderBy: undefined,
  });

// A coercer standing in for the engine's `@lesto/db`-backed one: project the shape's columns and
// coerce pgoutput's text integers to numbers (the real coercer keys off the column kind).
const coercer =
  (def: ShapeDefinition): ImageCoercer =>
  (image: RowImage): Row => {
    const row: Row = {};
    for (const column of def.columns) {
      const value = image[column];
      row[column] =
        column === "id" || column === "room_id"
          ? value == null
            ? (value ?? null)
            : Number(value)
          : (value ?? null);
    }
    return row;
  };

const stamp = { commitLSN: "0/1", systemId: "sys", timelineId: 1 } as const;

describe("predicateNeedsOldImage", () => {
  it("is true when a filter references a non-key column (PK key)", () => {
    expect(predicateNeedsOldImage(shape(), true)).toBe(true);
  });

  it("is false when every filter is over the PK key column (a key-only old image suffices)", () => {
    expect(predicateNeedsOldImage(shape([{ column: "id", op: "eq", value: 7 }]), true)).toBe(false);
  });

  it("is false for a filterless PK-keyed shape", () => {
    expect(predicateNeedsOldImage(shape([]), true)).toBe(false);
  });

  it("is true when the key is a UNIQUE non-PK column, even filterless (the missing arm — L-5c46b49b)", () => {
    // keyIsPrimaryKey=false: the old value of a non-PK key cannot be recovered from a DEFAULT old
    // tuple, so the shape needs the FULL old image regardless of its filters (here, none).
    expect(predicateNeedsOldImage(uniqueKeyShape([]), false)).toBe(true);
  });
});

// ADR 0042 acceptance (b), the "refuse-unsupported-shape" half: a shape whose table cannot
// supply the old image its predicate needs must be REFUSED at registration, not served and
// silently fail to emit delete-from-shape. See http-handlers.test.ts's "ADR 0042 acceptance
// matrix" for the full letter-by-letter gate.
describe("assertReplicaIdentity", () => {
  it("refuses a non-key-predicate shape when the table is not REPLICA IDENTITY FULL", () => {
    expect(() => assertReplicaIdentity(shape(), true, false)).toThrow(LiveServerError);
    try {
      assertReplicaIdentity(shape(), true, false);
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT");
    }
  });

  it("allows a non-key-predicate shape when the table IS REPLICA IDENTITY FULL", () => {
    expect(() => assertReplicaIdentity(shape(), true, true)).not.toThrow();
  });

  it("allows a PK-keyed key-only-predicate shape regardless of replica identity", () => {
    const keyOnly = shape([{ column: "id", op: "eq", value: 7 }]);
    expect(() => assertReplicaIdentity(keyOnly, true, false)).not.toThrow();
  });

  // L-5c46b49b: the missing arm. A shape keyed on a UNIQUE non-PK column (here room_id), even
  // filterless, MUST be refused off a non-FULL table — else an update changing the unique key strands
  // the old row (no old key emitted under DEFAULT) and a delete carries only the PK (missing the
  // client's key → the row survives). Both are silent, durable OPFS leaks; fail closed.
  it("refuses a UNIQUE non-PK-keyed shape when the table is not FULL (the update-strand / DELETE-leak fix)", () => {
    const def = uniqueKeyShape([]);
    expect(() => assertReplicaIdentity(def, false, false)).toThrow(LiveServerError);
    try {
      assertReplicaIdentity(def, false, false);
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT");
      // The message names the non-PK-key arm so the operator's fix is unambiguous.
      expect((error as LiveServerError).message).toContain("not the table's primary key");
    }
  });

  it("allows a UNIQUE non-PK-keyed shape when the table IS REPLICA IDENTITY FULL", () => {
    expect(() => assertReplicaIdentity(uniqueKeyShape([]), false, true)).not.toThrow();
  });
});

describe("assertOldImageComplete — the per-change runtime guard (marker + column presence, F1b)", () => {
  const required = ["id", "room_id"] as const;

  it("passes when the tuple is FULL and every required column is a transmitted value", () => {
    expect(() =>
      assertOldImageComplete(shape(), "full", required, { id: "5", room_id: "1", body: "hi" }),
    ).not.toThrow();
  });

  it("passes when a required column is a genuine null (a real, transmitted value — only undefined fails)", () => {
    expect(() =>
      assertOldImageComplete(shape(), "full", required, { id: "5", room_id: null }),
    ).not.toThrow();
  });

  it("throws (marker) when the old tuple is key-only ('K' after a FULL→DEFAULT downgrade)", () => {
    // The exact leak the value-based check MISSED: a 'K' tuple's non-key columns arrive as null, so
    // a value check (room_id === undefined) passed and the delete-from-shape was dropped. The marker
    // is the sound discriminator, so a key-only image is refused loudly — before the column loop.
    expect(() =>
      assertOldImageComplete(shape(), "key", required, { id: "5", room_id: null }),
    ).toThrow(LiveServerError);
    try {
      assertOldImageComplete(shape(), "key", required, { id: "5", room_id: null });
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_OLD_IMAGE_INCOMPLETE");
      expect((error as LiveServerError).details).toMatchObject({
        table: "messages",
        oldImageKind: "key",
      });
    }
  });

  it("throws (marker) when no old tuple was sent ('none' — a DEFAULT update)", () => {
    expect(() => assertOldImageComplete(shape(), "none", [], {})).toThrow(LiveServerError);
    try {
      assertOldImageComplete(shape(), "none", [], {});
    } catch (error) {
      expect((error as LiveServerError).details).toMatchObject({ oldImageKind: "none" });
    }
  });

  it("throws (column presence) when a required column is undefined in an otherwise-FULL tuple (unchanged external-TOAST 'u')", () => {
    // FULL guarantees the column is IN the tuple, not that its value was sent: an unchanged externally
    // TOASTed value arrives as 'u' → undefined even under FULL (marker still 'full'). Only this check
    // catches it — the marker passed. A silent drop here would be the exact leak the guard prevents.
    expect(() =>
      assertOldImageComplete(shape(), "full", required, { id: "5", room_id: undefined }),
    ).toThrow(LiveServerError);
    try {
      assertOldImageComplete(shape(), "full", required, { id: "5", room_id: undefined });
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_OLD_IMAGE_INCOMPLETE");
      expect((error as LiveServerError).details).toMatchObject({
        table: "messages",
        column: "room_id",
      });
    }
  });
});

describe("classifyChange — insert", () => {
  const def = shape();
  const coerce = coercer(def);

  it("emits an insert when the new row matches the shape", () => {
    const change: ReplicationChange = {
      op: "insert",
      table: "messages",
      newImage: { id: "5", room_id: "1", body: "hi" },
      ...stamp,
    };
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "insert",
      key: "5",
      row: { id: 5, room_id: 1, body: "hi" },
    });
  });

  it("emits nothing when the new row does not match (never in this client's slice)", () => {
    const change: ReplicationChange = {
      op: "insert",
      table: "messages",
      newImage: { id: "5", room_id: "2", body: "hi" },
      ...stamp,
    };
    expect(classifyChange(def, change, coerce)).toBeUndefined();
  });
});

describe("classifyChange — delete", () => {
  const def = shape();
  const coerce = coercer(def);

  it("emits a delete when the removed row was in the shape", () => {
    const change: ReplicationChange = {
      op: "delete",
      table: "messages",
      oldImage: { id: "5", room_id: "1", body: "hi" },
      oldImageKind: "full",
      ...stamp,
    };
    expect(classifyChange(def, change, coerce)).toEqual({ op: "delete", key: "5" });
  });

  it("emits nothing when the removed row was never in the shape", () => {
    const change: ReplicationChange = {
      op: "delete",
      table: "messages",
      oldImage: { id: "5", room_id: "2", body: "hi" },
      oldImageKind: "full",
      ...stamp,
    };
    expect(classifyChange(def, change, coerce)).toBeUndefined();
  });
});

describe("classifyChange — update (the in/out/stay matrix)", () => {
  const def = shape();
  const coerce = coercer(def);

  // These full-image updates model REPLICA IDENTITY FULL (an 'O' tuple), so the marker is 'full'.
  // classifyChange itself ignores the marker (the guard lives in prepareShapeClassifier); it is set
  // to the honest value for the image being passed.
  const update = (oldImage: RowImage, newImage: RowImage): ReplicationChange => ({
    op: "update",
    table: "messages",
    oldImage,
    newImage,
    oldImageKind: "full",
    ...stamp,
  });

  it("stayed IN → update with the new row", () => {
    const change = update(
      { id: "5", room_id: "1", body: "a" },
      { id: "5", room_id: "1", body: "b" },
    );
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "update",
      key: "5",
      row: { id: 5, room_id: 1, body: "b" },
    });
  });

  it("moved IN (out→in) → insert", () => {
    const change = update(
      { id: "5", room_id: "2", body: "a" },
      { id: "5", room_id: "1", body: "a" },
    );
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "insert",
      key: "5",
      row: { id: 5, room_id: 1, body: "a" },
    });
  });

  it("moved OUT (in→out) → delete-from-shape (the leak-stopping case)", () => {
    const change = update(
      { id: "5", room_id: "1", body: "a" },
      { id: "5", room_id: "2", body: "a" },
    );
    expect(classifyChange(def, change, coerce)).toEqual({ op: "delete", key: "5" });
  });

  it("outside both before and after → nothing", () => {
    const change = update(
      { id: "5", room_id: "2", body: "a" },
      { id: "5", room_id: "3", body: "a" },
    );
    expect(classifyChange(def, change, coerce)).toBeUndefined();
  });

  it("fills an unchanged-TOAST column (undefined in NEW) from the OLD image", () => {
    // body is unchanged-TOAST (undefined) in NEW; the shipped row must carry its old value.
    const change = update(
      { id: "5", room_id: "1", body: "kept" },
      { id: "5", room_id: "1", body: undefined },
    );
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "update",
      key: "5",
      row: { id: 5, room_id: 1, body: "kept" },
    });
  });

  it("classifies membership correctly when the FILTER column is unchanged-TOAST in NEW (uses old value)", () => {
    // room_id (the filter column) not retransmitted → must fall back to old (still 1 = in-shape).
    const change = update(
      { id: "5", room_id: "1", body: "a" },
      { id: "5", room_id: undefined, body: "b" },
    );
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "update",
      key: "5",
      row: { id: 5, room_id: 1, body: "b" },
    });
  });

  it("refuses a key change on a row that stays in the shape (would strand the old key)", () => {
    const change = update(
      { id: "5", room_id: "1", body: "a" },
      { id: "6", room_id: "1", body: "a" },
    );
    expect(() => classifyChange(def, change, coerce)).toThrow(LiveServerError);
    try {
      classifyChange(def, change, coerce);
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_PRIMARY_KEY_CHANGED");
    }
  });

  it("does NOT refuse a differing key when the row was OUT before (moved in — no stale entry)", () => {
    // out→in: old key is irrelevant (never in the store), so a differing key is a plain insert.
    const change = update(
      { id: "5", room_id: "2", body: "a" },
      { id: "6", room_id: "1", body: "a" },
    );
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "insert",
      key: "6",
      row: { id: 6, room_id: 1, body: "a" },
    });
  });
});

describe("classifyChange — update with an ABSENT old image (REPLICA IDENTITY DEFAULT, key unchanged)", () => {
  // pgoutput sends NO old tuple for a DEFAULT update whose key did not change → oldImage is `{}`.
  // Coercing that would fabricate a NaN key; membership can't have changed (the key is immutable),
  // so the classifier must derive `wasIn` from the NEW row and emit a plain `update`.
  const emptyOldUpdate = (newImage: RowImage): ReplicationChange => ({
    op: "update",
    table: "messages",
    oldImage: {},
    newImage,
    oldImageKind: "none", // a DEFAULT update whose immutable key did not change → no old tuple
    ...stamp,
  });

  it("emits an update (not a spurious PRIMARY_KEY_CHANGED) for a filterless shape", () => {
    const def = shape([]); // filterless: always in-shape — the most basic 'sync this table' case
    const change = emptyOldUpdate({ id: "5", room_id: "9", body: "edited" });

    expect(classifyChange(def, change, coercer(def))).toEqual({
      op: "update",
      key: "5",
      row: { id: 5, room_id: 9, body: "edited" },
    });
  });

  it("emits an update (not an insert) for a key-only-predicate shape whose row stays in", () => {
    const def = shape([{ column: "id", op: "eq", value: 5 }]);
    const change = emptyOldUpdate({ id: "5", room_id: "9", body: "edited" });

    expect(classifyChange(def, change, coercer(def))).toEqual({
      op: "update",
      key: "5",
      row: { id: 5, room_id: 9, body: "edited" },
    });
  });

  it("emits nothing for a key-only-predicate shape whose row is outside (both before and after)", () => {
    const def = shape([{ column: "id", op: "eq", value: 5 }]);
    const change = emptyOldUpdate({ id: "7", room_id: "9", body: "edited" });

    expect(classifyChange(def, change, coercer(def))).toBeUndefined();
  });
});

describe("prepareShapeClassifier — the guarded entry point", () => {
  // The non-key (room_id) shape's required old-image columns; the engine derives these from the table.
  const REQ = ["id", "room_id"] as const;

  it("refuses to bind a non-key-predicate shape without REPLICA IDENTITY FULL (the guard cannot be skipped)", () => {
    expect(() => prepareShapeClassifier(shape(), true, false, coercer(shape()), REQ)).toThrow(
      LiveServerError,
    );
    try {
      prepareShapeClassifier(shape(), true, false, coercer(shape()), REQ);
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT");
    }
  });

  // L-5c46b49b (c) — the DELETE-leak variant is prevented by REFUSING the unsafe config at
  // registration: a shape keyed on a UNIQUE non-PK column (room_id) off a non-FULL table cannot bind,
  // so the classifier that would emit a PK-keyed delete the client store never held is never created.
  // (Under FULL, the delete IS bound and keys by the unique key — see the delete test below.)
  it("refuses to bind a UNIQUE non-PK-keyed shape without REPLICA IDENTITY FULL (fail-closed — no DELETE leak / update strand)", () => {
    const def = uniqueKeyShape([]);
    expect(() => prepareShapeClassifier(def, false, false, coercer(def), ["room_id"])).toThrow(
      LiveServerError,
    );
    try {
      prepareShapeClassifier(def, false, false, coercer(def), ["room_id"]);
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT");
    }
  });

  // L-5c46b49b (b) — the update-key-change strand. Before the fix this shape registered without FULL
  // and an update changing the unique key emitted a plain `update` under the NEW key, leaving the OLD
  // row stranded. With the fix it is only servable under FULL, where the real old image lets the
  // existing key-change guard fire (loud, never stranded).
  it("under FULL, a UNIQUE non-PK key that changes value fires PRIMARY_KEY_CHANGED (was: silently stranded)", () => {
    const def = uniqueKeyShape([]);
    const classify = prepareShapeClassifier(def, false, true, coercer(def), ["room_id"]);
    const change: ReplicationChange = {
      op: "update",
      table: "messages",
      oldImage: { id: "5", room_id: "1", body: "a" },
      newImage: { id: "5", room_id: "2", body: "a" }, // the unique key changed 1 → 2
      oldImageKind: "full",
      ...stamp,
    };
    expect(() => classify(change)).toThrow(LiveServerError);
    try {
      classify(change);
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_PRIMARY_KEY_CHANGED");
    }
  });

  // The sound delete path a non-FULL DEFAULT table could NOT provide: under FULL the old image carries
  // the unique key, so the delete-from-shape is keyed by it (room_id=7) — exactly what the client store
  // holds. (Under DEFAULT the old tuple is the PK only, so the delete would miss → the guard above
  // refuses that config so this can never happen unsafely.)
  it("under FULL, a DELETE of a UNIQUE non-PK-keyed row keys by the unique key (no leak)", () => {
    const def = uniqueKeyShape([]);
    const classify = prepareShapeClassifier(def, false, true, coercer(def), ["room_id"]);
    const change: ReplicationChange = {
      op: "delete",
      table: "messages",
      oldImage: { id: "5", room_id: "7", body: "a" },
      oldImageKind: "full",
      ...stamp,
    };
    expect(classify(change)).toEqual({ op: "delete", key: "7" });
  });

  it("binds a guarded classifier that delegates to classifyChange when the guard passes", () => {
    const def = shape();
    const classify = prepareShapeClassifier(def, true, true, coercer(def), REQ);
    const change: ReplicationChange = {
      op: "insert",
      table: "messages",
      newImage: { id: "5", room_id: "1", body: "hi" },
      ...stamp,
    };
    expect(classify(change)).toEqual({
      op: "insert",
      key: "5",
      row: { id: 5, room_id: 1, body: "hi" },
    });
  });

  it("binds a PK-keyed key-only-predicate shape regardless of replica identity", () => {
    const def = shape([{ column: "id", op: "eq", value: 5 }]);
    const classify = prepareShapeClassifier(def, true, false, coercer(def), []);
    const change: ReplicationChange = {
      op: "insert",
      table: "messages",
      newImage: { id: "5", room_id: "9", body: "hi" },
      ...stamp,
    };
    expect(classify(change)).toEqual({
      op: "insert",
      key: "5",
      row: { id: 5, room_id: 9, body: "hi" },
    });
  });

  // The folded runtime guard: the bound closure self-applies assertOldImageComplete (marker + column
  // presence) per change, so the guard is no longer forgettable engine glue — a direct caller gets it.
  describe("folds the per-change old-image guard (chief-arch convergence)", () => {
    const def = shape(); // non-key predicate on room_id → needs the FULL old image
    const classify = prepareShapeClassifier(def, true, true, coercer(def), REQ);

    it("throws OLD_IMAGE_INCOMPLETE on an update whose old tuple went key-only (FULL→DEFAULT downgrade)", () => {
      const change: ReplicationChange = {
        op: "update",
        table: "messages",
        oldImage: { id: "5", room_id: null, body: null },
        oldImageKind: "key",
        newImage: { id: "5", room_id: "2", body: "x" },
        ...stamp,
      };
      expect(() => classify(change)).toThrow(LiveServerError);
      try {
        classify(change);
      } catch (error) {
        expect((error as LiveServerError).code).toBe("LIVE_SERVER_OLD_IMAGE_INCOMPLETE");
      }
    });

    it("throws OLD_IMAGE_INCOMPLETE on a DELETE whose old tuple went key-only (the delete-from-shape leak)", () => {
      // Under the old value-based check this passed (room_id null ≠ undefined) → matchesShape(null)
      // false → the delete-from-shape was dropped and the row leaked. The marker refuses it loudly.
      const change: ReplicationChange = {
        op: "delete",
        table: "messages",
        oldImage: { id: "5", room_id: null, body: null },
        oldImageKind: "key",
        ...stamp,
      };
      expect(() => classify(change)).toThrow(LiveServerError);
    });

    it("throws OLD_IMAGE_INCOMPLETE on an update with no old tuple at all ('none')", () => {
      const change: ReplicationChange = {
        op: "update",
        table: "messages",
        oldImage: {},
        oldImageKind: "none",
        newImage: { id: "5", room_id: "1", body: "x" },
        ...stamp,
      };
      expect(() => classify(change)).toThrow(LiveServerError);
    });

    it("throws OLD_IMAGE_INCOMPLETE on a FULL DELETE whose predicate column is an unchanged external-TOAST 'u' (marker still full)", () => {
      // The regression the red-team + protocol reviewers converged on: FULL marks the tuple 'full' but
      // an unchanged externally-TOASTed room_id arrives as 'u' → undefined. The marker check passes;
      // only the column-presence check catches it — else matchesShape(undefined) drops a delete → leak.
      const change: ReplicationChange = {
        op: "delete",
        table: "messages",
        oldImage: { id: "5", room_id: undefined, body: "kept" },
        oldImageKind: "full",
        ...stamp,
      };
      expect(() => classify(change)).toThrow(LiveServerError);
      try {
        classify(change);
      } catch (error) {
        expect((error as LiveServerError).code).toBe("LIVE_SERVER_OLD_IMAGE_INCOMPLETE");
        expect((error as LiveServerError).details).toMatchObject({ column: "room_id" });
      }
    });

    it("does NOT apply the old-image guard to a key-only-predicate shape (it needs no old image)", () => {
      const keyOnly = shape([{ column: "id", op: "eq", value: 5 }]);
      const classifyKeyOnly = prepareShapeClassifier(keyOnly, true, false, coercer(keyOnly), []);
      // A key-only 'K' update: the guard is skipped, and classifyChange decides from the new row.
      const change: ReplicationChange = {
        op: "update",
        table: "messages",
        oldImage: { id: "5", room_id: null, body: null },
        oldImageKind: "key",
        newImage: { id: "5", room_id: "9", body: "edited" },
        ...stamp,
      };
      expect(classifyKeyOnly(change)).toEqual({
        op: "update",
        key: "5",
        row: { id: 5, room_id: 9, body: "edited" },
      });
    });
  });
});
