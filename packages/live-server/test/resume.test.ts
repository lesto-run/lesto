import { describe, expect, it } from "vitest";

import type { ShapeChange } from "@lesto/live-protocol";

import {
  compareLsn,
  decodeResumeCursor,
  encodeResumeCursor,
  RESYNC_CURSOR,
  ShapeReplayRing,
} from "../src/resume";
import type { SystemIdentity } from "../src/replication";

// ---------------------------------------------------------------------------
// The cursor codec — `(systemId, timelineId, LSN)` on the SSE `id:` line
// ---------------------------------------------------------------------------

describe("encodeResumeCursor / decodeResumeCursor", () => {
  it("round-trips a cursor", () => {
    const cursor = { systemId: "7231197149", timelineId: 3, lsn: "1A/2B3C" };
    const encoded = encodeResumeCursor(cursor);

    expect(encoded).toBe("v1:7231197149:3:1A/2B3C");
    expect(decodeResumeCursor(encoded)).toEqual(cursor);
  });

  it("decodes `undefined` (no Last-Event-ID) to `undefined` — the re-snapshot floor", () => {
    expect(decodeResumeCursor(undefined)).toBeUndefined();
  });

  it("rejects a v0 (poll-path) cursor — it can never resume", () => {
    expect(decodeResumeCursor("v0:5")).toBeUndefined();
  });

  it("the resync sentinel is non-resumable — it decodes to `undefined`, forcing a re-snapshot (L-802b3e7b)", () => {
    // The frame every `resync` is stamped with. Decoding it to `undefined` is the load-bearing
    // property: a reconnect presenting it proves NO continuity and re-snapshots, so a purged slice
    // is never replayed onto. (It is a `v0:`-prefixed 2-part token, so it can never be 4-part valid.)
    expect(decodeResumeCursor(RESYNC_CURSOR)).toBeUndefined();
  });

  it("rejects a wrong version prefix", () => {
    expect(decodeResumeCursor("v2:sys:1:0/1")).toBeUndefined();
  });

  it("rejects a token without exactly four parts", () => {
    expect(decodeResumeCursor("v1:sys:1")).toBeUndefined(); // too few
    expect(decodeResumeCursor("v1:sys:1:0/1:extra")).toBeUndefined(); // too many
  });

  it("rejects an empty systemId", () => {
    expect(decodeResumeCursor("v1::1:0/1")).toBeUndefined();
  });

  it("rejects a non-integer timelineId", () => {
    expect(decodeResumeCursor("v1:sys:x:0/1")).toBeUndefined();
    expect(decodeResumeCursor("v1:sys:1.5:0/1")).toBeUndefined();
    expect(decodeResumeCursor("v1:sys:-1:0/1")).toBeUndefined();
  });

  it("rejects a malformed LSN", () => {
    expect(decodeResumeCursor("v1:sys:1:notanlsn")).toBeUndefined();
    expect(decodeResumeCursor("v1:sys:1:0-1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LSN comparison — high/low word aware
// ---------------------------------------------------------------------------

describe("compareLsn", () => {
  it("orders by numeric WAL position, honoring the high/low-word split", () => {
    expect(compareLsn("0/1", "0/2")).toBe(-1);
    expect(compareLsn("0/2", "0/1")).toBe(1);
    expect(compareLsn("0/1", "0/1")).toBe(0);
    // A higher high-word beats any low-word — a naive string compare would order these wrong.
    expect(compareLsn("1/0", "0/FFFFFFFF")).toBe(1);
    expect(compareLsn("0/0", "0/A")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// ShapeReplayRing — the per-shape, LSN-keyed replay ring
// ---------------------------------------------------------------------------

const SYS_A: SystemIdentity = { systemId: "sysA", timelineId: 1 };
const insert = (key: string): ShapeChange => ({ op: "insert", key, row: { id: key } });

/** A cursor at `lsn` for identity `id` (defaults to SYS_A). */
function at(lsn: string, id: SystemIdentity = SYS_A) {
  return { ...id, lsn };
}

describe("ShapeReplayRing", () => {
  it("resyncs before any change is recorded (no identity yet)", () => {
    const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

    expect(ring.reconcile(at("0/1"))).toEqual({ kind: "resync" });
    expect(ring.latestLsn()).toBeUndefined();
  });

  it("replays inclusively from the client's LSN, and reports the latest LSN", () => {
    const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

    ring.record(SYS_A, "0/1", insert("a"));
    ring.record(SYS_A, "0/2", insert("b"));
    ring.record(SYS_A, "0/3", insert("c"));

    expect(ring.latestLsn()).toBe("0/3");

    // Inclusive of `0/2`: the client re-applies its own last change (idempotent) plus everything after.
    expect(ring.reconcile(at("0/2"))).toEqual({
      kind: "replay",
      changes: [
        { lsn: "0/2", change: insert("b") },
        { lsn: "0/3", change: insert("c") },
      ],
    });
  });

  it("replays nothing when the client is at or ahead of the latest LSN", () => {
    const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

    ring.record(SYS_A, "0/1", insert("a"));

    expect(ring.reconcile(at("0/9"))).toEqual({ kind: "replay", changes: [] });
  });

  it("resyncs a cursor from a DIFFERENT cluster (systemId mismatch)", () => {
    const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

    ring.record(SYS_A, "0/1", insert("a"));

    expect(ring.reconcile(at("0/1", { systemId: "sysB", timelineId: 1 }))).toEqual({
      kind: "resync",
    });
  });

  it("resyncs a cursor from a SAME-cluster failover (timelineId incremented, systemId unchanged)", () => {
    const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

    ring.record(SYS_A, "0/1", insert("a"));

    // systemId matches — a `systemId`-only check would wrongly replay — but the timeline moved.
    expect(ring.reconcile(at("0/1", { systemId: "sysA", timelineId: 2 }))).toEqual({
      kind: "resync",
    });
  });

  it("resets under a new identity (mid-life failover), stranding a pre-failover cursor", () => {
    const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

    ring.record(SYS_A, "0/5", insert("a"));

    const afterFailover: SystemIdentity = { systemId: "sysA", timelineId: 2 };
    ring.record(afterFailover, "0/6", insert("b"));

    // The pre-failover cursor no longer matches the ring's (now timeline-2) identity → resync.
    expect(ring.reconcile(at("0/5", SYS_A))).toEqual({ kind: "resync" });

    // A cursor on the NEW timeline replays from the post-failover entries only.
    expect(ring.reconcile(at("0/6", afterFailover))).toEqual({
      kind: "replay",
      changes: [{ lsn: "0/6", change: insert("b") }],
    });
  });

  it("re-snapshots a cursor aged past retention — evicted by COUNT", () => {
    // maxEntries 2, age effectively unbounded → only count eviction fires.
    const ring = new ShapeReplayRing({ maxEntries: 2, maxAgeMs: 1_000_000, now: () => 0 });

    ring.record(SYS_A, "0/1", insert("a"));
    ring.record(SYS_A, "0/2", insert("b"));
    ring.record(SYS_A, "0/3", insert("c")); // evicts 0/1 → maxEvictedLsn = 0/1

    // At/below the evicted floor → cannot prove continuity → resync.
    expect(ring.reconcile(at("0/1"))).toEqual({ kind: "resync" });

    // Above the floor → still replayable from the retained entries.
    expect(ring.reconcile(at("0/2"))).toEqual({
      kind: "replay",
      changes: [
        { lsn: "0/2", change: insert("b") },
        { lsn: "0/3", change: insert("c") },
      ],
    });
  });

  it("re-snapshots a cursor aged past retention — evicted by AGE", () => {
    let clock = 0;
    // maxEntries huge → only age eviction fires; maxAgeMs 100.
    const ring = new ShapeReplayRing({ maxEntries: 1_000, maxAgeMs: 100, now: () => clock });

    ring.record(SYS_A, "0/1", insert("a")); // at t=0
    clock = 1_000;
    ring.record(SYS_A, "0/2", insert("b")); // at t=1000 → 0/1 (at=0 < cutoff 900) evicted

    expect(ring.reconcile(at("0/1"))).toEqual({ kind: "resync" }); // aged out
    expect(ring.reconcile(at("0/2"))).toEqual({
      kind: "replay",
      changes: [{ lsn: "0/2", change: insert("b") }],
    });
  });

  it("keeps recording when nothing is evicted (drop === 0)", () => {
    const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000_000, now: () => 0 });

    ring.record(SYS_A, "0/1", insert("a"));
    ring.record(SYS_A, "0/2", insert("b"));

    expect(ring.reconcile(at("0/1"))).toEqual({
      kind: "replay",
      changes: [
        { lsn: "0/1", change: insert("a") },
        { lsn: "0/2", change: insert("b") },
      ],
    });
  });

  it("defaults its clock to Date.now when none is injected", () => {
    // No `now`: exercises the `?? Date.now` default. A single record then a same-identity replay
    // must succeed regardless of the wall clock (maxAgeMs is generous).
    const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 60_000 });

    ring.record(SYS_A, "0/1", insert("a"));

    expect(ring.reconcile(at("0/1"))).toEqual({
      kind: "replay",
      changes: [{ lsn: "0/1", change: insert("a") }],
    });
  });

  // latestLsnFor — the identity-gated latest LSN the engine stamps a snapshot cursor from. It
  // returns the latest LSN ONLY when the caller's live identity matches the ring's; every mismatch
  // (and the pre-first-change state) returns `undefined`, so a snapshot cursor can never carry the
  // new identity with a pre-failover (stale-timeline) LSN.
  describe("latestLsnFor", () => {
    it("returns `undefined` before any change is recorded (no identity yet)", () => {
      const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

      expect(ring.latestLsnFor(SYS_A)).toBeUndefined();
    });

    it("returns the latest LSN when the live identity matches the ring's", () => {
      const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

      ring.record(SYS_A, "0/1", insert("a"));
      ring.record(SYS_A, "0/2", insert("b"));

      expect(ring.latestLsnFor(SYS_A)).toBe("0/2");
    });

    it("returns `undefined` for a DIFFERENT cluster (systemId mismatch)", () => {
      const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

      ring.record(SYS_A, "0/1", insert("a"));

      expect(ring.latestLsnFor({ systemId: "sysB", timelineId: 1 })).toBeUndefined();
    });

    it("returns `undefined` after a SAME-cluster failover (timelineId mismatch)", () => {
      const ring = new ShapeReplayRing({ maxEntries: 10, maxAgeMs: 1_000, now: () => 0 });

      ring.record(SYS_A, "0/1", insert("a"));

      // systemId matches — a `systemId`-only check would wrongly stamp the stale LSN — but the
      // WAL timeline moved, so the LSN is meaningless on the new identity.
      expect(ring.latestLsnFor({ systemId: "sysA", timelineId: 2 })).toBeUndefined();
    });
  });
});
