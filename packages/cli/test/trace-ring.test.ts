import { describe, expect, it } from "vitest";

import type { SpanData } from "@lesto/observability";
import type { AccessEntry } from "@lesto/runtime";

import { createDevState } from "../src/dev-state";
import {
  createTraceRing,
  DEFAULT_TRACE_RING_CAPACITY,
  DEFAULT_TRACE_SPAN_CAPACITY,
} from "../src/trace-ring";

/** A finished span, shaped as the tracer and the browser receiver both hand one over. */
const span = (
  traceId: string,
  name: string,
  attributes: Record<string, unknown> = {},
): SpanData => ({
  traceId,
  spanId: name.padEnd(16, "0").slice(0, 16),
  name,
  startedAt: 1_000,
  endedAt: 1_005,
  attributes,
  status: "ok",
});

/** An access entry as the runtime builds one, carrying the trace it ran on. */
const access = (requestId: string, traceId: string): AccessEntry => ({
  method: "GET",
  path: "/posts",
  status: 200,
  ms: 1,
  requestId,
  traceId,
});

/** A request span, as the runtime mints one. */
const requestSpan = (traceId: string): SpanData =>
  span(traceId, "http.request", {
    "http.path": "/posts",
  });

describe("createTraceRing", () => {
  describe("grouping", () => {
    it("groups spans under their trace id, oldest-first, across interleaved traces", () => {
      const ring = createTraceRing();

      ring.recordSpan(span("a".repeat(32), "http.request"));
      ring.recordSpan(span("b".repeat(32), "http.request"));
      ring.recordSpan(span("a".repeat(32), "db.query"));

      const found = ring.retainedTrace({ traceId: "a".repeat(32) });

      expect(found.retained).toBe(true);
      expect(found.traceId).toBe("a".repeat(32));
      expect(found.spans.map((s) => s.name)).toEqual(["http.request", "db.query"]);
      expect(found.truncated).toBe(false);
    });

    it("retains a browser span beside the server spans of the same trace", () => {
      // The whole point of the join: the receiver's payloads and the tracer's own
      // spans share one trace id, so one read answers "what happened on this page".
      const ring = createTraceRing();
      const traceId = "c".repeat(32);

      ring.recordSpan(span(traceId, "http.request"));
      ring.recordSpan(span(traceId, "browser.navigation"));
      ring.recordSpan(span(traceId, "browser.web_vital"));

      expect(ring.retainedTrace({ traceId }).spans.map((s) => s.name)).toEqual([
        "http.request",
        "browser.navigation",
        "browser.web_vital",
      ]);
    });
  });

  describe("lookup", () => {
    it("answers a never-seen trace id as not retained, never as an error", () => {
      const ring = createTraceRing();

      expect(ring.retainedTrace({ traceId: "d".repeat(32) })).toEqual({
        retained: false,
        spans: [],
        truncated: false,
      });
    });

    it("ignores a requestId — the ring is keyed by traceId alone", () => {
      // Resolution belongs to whoever holds BOTH rings (`createDevState`), so the
      // ring itself never has to trust anything about a span's contents.
      const ring = createTraceRing();

      ring.recordSpan(requestSpan("a".repeat(32)));

      expect(ring.retainedTrace({ requestId: "req-1" }).traceId).toBe("a".repeat(32));
    });

    it("returns the most recently written trace when neither id is given", () => {
      const ring = createTraceRing();

      ring.recordSpan(span("a".repeat(32), "http.request"));
      ring.recordSpan(span("b".repeat(32), "http.request"));
      // A late child span on the FIRST trace makes it the most recent again.
      ring.recordSpan(span("a".repeat(32), "db.query"));

      expect(ring.retainedTrace({}).traceId).toBe("a".repeat(32));
    });

    it("answers an empty ring as not retained", () => {
      expect(createTraceRing().retainedTrace({}).retained).toBe(false);
    });

    it("hands back a copy, so a caller cannot mutate the retained trace", () => {
      const ring = createTraceRing();

      ring.recordSpan(span("a".repeat(32), "http.request"));

      const found = ring.retainedTrace({ traceId: "a".repeat(32) });

      (found.spans as SpanData[]).push(span("a".repeat(32), "forged"));

      expect(ring.retainedTrace({ traceId: "a".repeat(32) }).spans).toHaveLength(1);
    });
  });

  describe("bounds", () => {
    it("evicts the LEAST-RECENTLY-WRITTEN trace, not the oldest-created one", () => {
      // The invariant that matters: a slow request whose child spans keep arriving
      // must survive a burst of short ones. An oldest-created rule would drop it.
      const ring = createTraceRing({ traceCapacity: 2 });

      ring.recordSpan(span("a".repeat(32), "http.request"));
      ring.recordSpan(span("b".repeat(32), "http.request"));

      // Touch `a` again — it is now the most recent, so `b` is the eviction target.
      ring.recordSpan(span("a".repeat(32), "db.query"));
      ring.recordSpan(span("c".repeat(32), "http.request"));

      expect(ring.retainedTrace({ traceId: "a".repeat(32) }).retained).toBe(true);
      expect(ring.retainedTrace({ traceId: "c".repeat(32) }).retained).toBe(true);
      expect(ring.retainedTrace({ traceId: "b".repeat(32) }).retained).toBe(false);
    });

    it("drops a trace's OLDEST spans past the per-trace cap and says it truncated", () => {
      const ring = createTraceRing({ spanCapacity: 2 });
      const traceId = "a".repeat(32);

      ring.recordSpan(span(traceId, "first"));
      ring.recordSpan(span(traceId, "second"));

      expect(ring.retainedTrace({ traceId }).truncated).toBe(false);

      ring.recordSpan(span(traceId, "third"));

      const found = ring.retainedTrace({ traceId });

      expect(found.spans.map((s) => s.name)).toEqual(["second", "third"]);
      // A trace that quietly lost its head would read as a complete trace.
      expect(found.truncated).toBe(true);
    });

    it("says truncated when a REBUILT trace is one the cap already dropped", () => {
      // The realistic shape: a browser's RUM batch POSTs at page hide, long after
      // its request span, by which time a busy dev session may have evicted the
      // trace. Rebuilding the bucket silently would report a one-span trace as
      // complete.
      const ring = createTraceRing({ traceCapacity: 1 });

      ring.recordSpan(span("a".repeat(32), "http.request"));
      ring.recordSpan(span("b".repeat(32), "http.request"));

      expect(ring.retainedTrace({ traceId: "a".repeat(32) }).retained).toBe(false);

      ring.recordSpan(span("a".repeat(32), "browser.navigation"));

      const rebuilt = ring.retainedTrace({ traceId: "a".repeat(32) });

      expect(rebuilt.retained).toBe(true);
      expect(rebuilt.spans.map((s) => s.name)).toEqual(["browser.navigation"]);
      expect(rebuilt.truncated).toBe(true);
    });

    it("forgets an eviction record too, so a very old trace rebuilds as un-truncated", () => {
      // The one hole in the `truncated` flag, pinned so the docs cannot drift from
      // it: the eviction record is bounded like the traces themselves, so a trace
      // dropped long enough ago rebuilds looking complete.
      const ring = createTraceRing({ traceCapacity: 1 });

      ring.recordSpan(span("a".repeat(32), "http.request"));
      ring.recordSpan(span("b".repeat(32), "http.request"));
      ring.recordSpan(span("c".repeat(32), "http.request"));

      // `a` was evicted first, so its record is the one the bound dropped.
      ring.recordSpan(span("a".repeat(32), "browser.navigation"));

      expect(ring.retainedTrace({ traceId: "a".repeat(32) }).truncated).toBe(false);
    });

    it("defaults both caps to the module constants", () => {
      const ring = createTraceRing();
      const traceId = "a".repeat(32);

      for (let i = 0; i < DEFAULT_TRACE_SPAN_CAPACITY; i += 1) {
        ring.recordSpan(span(traceId, `span-${i}`));
      }

      expect(ring.retainedTrace({ traceId }).truncated).toBe(false);

      ring.recordSpan(span(traceId, "one-too-many"));

      expect(ring.retainedTrace({ traceId }).truncated).toBe(true);

      const fresh = createTraceRing();

      for (let i = 0; i < DEFAULT_TRACE_RING_CAPACITY; i += 1) {
        fresh.recordSpan(span(String(i).padStart(32, "0"), "http.request"));
      }

      expect(fresh.retainedTrace({ traceId: "0".repeat(32) }).retained).toBe(true);

      fresh.recordSpan(span("f".repeat(32), "http.request"));

      expect(fresh.retainedTrace({ traceId: "0".repeat(32) }).retained).toBe(false);
    });
  });
});

describe("createDevState — the composed trace ring", () => {
  it("resolves a requestId through the traceId the RUNTIME stamped on the access entry", () => {
    // The correlation the dev tools advertise, and the only place it happens: a
    // span attribute would do the same job but is settable by any caller of the
    // public, unauthenticated browser-spans receiver.
    const state = createDevState();

    state.recordSpan(requestSpan("a".repeat(32)));
    state.recordRequest(access("req-1", "a".repeat(32)));

    const found = state.retainedTrace({ requestId: "req-1" });

    expect(found.retained).toBe(true);
    expect(found.traceId).toBe("a".repeat(32));
  });

  it("answers a requestId the access ring never saw as not retained", () => {
    const state = createDevState();

    state.recordSpan(requestSpan("a".repeat(32)));

    expect(state.retainedTrace({ requestId: "req-missing" }).retained).toBe(false);
  });

  it("answers a request served UNTRACED as not retained", () => {
    // A 400 on an unparsable target, an in-flight shed, or a long-lived stream's
    // first byte all emit an access line with no span behind it.
    const state = createDevState();

    state.recordSpan(requestSpan("a".repeat(32)));
    state.recordRequest({ method: "GET", path: "/x", status: 400, ms: 1, requestId: "req-raw" });

    expect(state.retainedTrace({ requestId: "req-raw" }).retained).toBe(false);
  });

  it("does NOT resolve a requestId a SPAN merely claims in its attributes", () => {
    const state = createDevState();

    state.recordSpan(requestSpan("a".repeat(32)));
    state.recordRequest(access("req-1", "a".repeat(32)));

    // A forged browser span naming the same request must not redirect the lookup.
    state.recordSpan(span("b".repeat(32), "browser.navigation", { "lesto.request_id": "req-1" }));

    expect(state.retainedTrace({ requestId: "req-1" }).traceId).toBe("a".repeat(32));
  });

  it("retains a trace for every request the request ring still reports", () => {
    // The advertised workflow is `get_recent_requests` → `get_trace`, so a trace
    // window shorter than the request window would answer `retained: false` for
    // most of what the other tool just listed.
    const state = createDevState(2);

    for (const [index, traceId] of ["a", "b", "c"].map((c) => c.repeat(32)).entries()) {
      state.recordSpan(requestSpan(traceId));
      state.recordRequest(access(`req-${index}`, traceId));
    }

    for (const entry of state.recentRequests(10)) {
      expect(state.retainedTrace({ requestId: entry.requestId }).retained).toBe(true);
    }
  });

  it("honors an explicit trace-ring cap override", () => {
    const state = createDevState(200, { traceCapacity: 1 });

    state.recordSpan(span("a".repeat(32), "http.request"));
    state.recordSpan(span("b".repeat(32), "http.request"));

    expect(state.retainedTrace({ traceId: "a".repeat(32) }).retained).toBe(false);
    expect(state.retainedTrace({ traceId: "b".repeat(32) }).retained).toBe(true);
  });
});
