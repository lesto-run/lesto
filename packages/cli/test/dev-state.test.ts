import { describe, expect, it } from "vitest";

import { createDevState, DEFAULT_DEV_RING_CAPACITY } from "../src/dev-state";

import type { AccessEntry } from "@lesto/runtime";
import type { DevError } from "../src/run";

const entry = (requestId: string, overrides: Partial<AccessEntry> = {}): AccessEntry => ({
  method: "GET",
  path: "/posts",
  status: 200,
  ms: 3,
  requestId,
  ...overrides,
});

describe("createDevState", () => {
  describe("diagnostics", () => {
    it("is undefined before any error and returns the error once set", () => {
      const state = createDevState();
      expect(state.getDiagnostics()).toBeUndefined();

      const error: DevError = { source: "client-rebuild", message: "boom" };
      state.setError(error);

      expect(state.getDiagnostics()).toBe(error);
    });

    it("clears the error when set back to undefined (a later success)", () => {
      const state = createDevState();
      state.setError({ source: "app-reload", message: "broke" });
      state.setError(undefined);

      expect(state.getDiagnostics()).toBeUndefined();
    });
  });

  describe("log ring", () => {
    it("returns appended lines oldest-first, bounded by n", () => {
      const state = createDevState();
      state.appendLog("a");
      state.appendLog("b");
      state.appendLog("c");

      expect(state.recentLogs(2)).toEqual(["b", "c"]);
      expect(state.recentLogs(10)).toEqual(["a", "b", "c"]);
    });

    it("returns [] for a non-positive n", () => {
      const state = createDevState();
      state.appendLog("a");

      expect(state.recentLogs(0)).toEqual([]);
    });

    it("drops the oldest line past capacity", () => {
      const state = createDevState(2);
      state.appendLog("a");
      state.appendLog("b");
      state.appendLog("c");

      expect(state.recentLogs(10)).toEqual(["b", "c"]);
    });
  });

  describe("request ring + spanFor", () => {
    it("returns recent requests oldest-first, bounded by n", () => {
      const state = createDevState();
      state.recordRequest(entry("r1"));
      state.recordRequest(entry("r2"));

      expect(state.recentRequests(1).map((e) => e.requestId)).toEqual(["r2"]);
      expect(state.recentRequests(5).map((e) => e.requestId)).toEqual(["r1", "r2"]);
    });

    it("looks a retained request up by id", () => {
      const state = createDevState();
      const record = entry("r1", { status: 404 });
      state.recordRequest(record);

      expect(state.spanFor("r1")).toBe(record);
    });

    it("returns undefined for an aged-out or never-seen requestId", () => {
      const state = createDevState(1);
      state.recordRequest(entry("old"));
      state.recordRequest(entry("new")); // evicts "old" at capacity 1

      expect(state.spanFor("old")).toBeUndefined();
      expect(state.spanFor("never")).toBeUndefined();
      expect(state.spanFor("new")?.requestId).toBe("new");
    });
  });

  it("defaults to a positive bounded capacity", () => {
    expect(DEFAULT_DEV_RING_CAPACITY).toBeGreaterThan(0);

    const state = createDevState();
    for (let index = 0; index < DEFAULT_DEV_RING_CAPACITY + 5; index += 1) {
      state.appendLog(`l${index}`);
    }

    expect(state.recentLogs(DEFAULT_DEV_RING_CAPACITY + 100)).toHaveLength(
      DEFAULT_DEV_RING_CAPACITY,
    );
  });
});
