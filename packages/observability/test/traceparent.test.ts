import { describe, expect, it } from "vitest";

import { formatTraceparent, parseTraceparent, TRACEPARENT_HEADER } from "../src/index";

// A valid 32-hex trace id and 16-hex parent id, from the W3C spec example.
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";

describe("parseTraceparent", () => {
  it("parses a valid W3C traceparent into its trace, parent, and flags", () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-01`)).toEqual({
      traceId: TRACE,
      parentId: PARENT,
      flags: "01",
    });
  });

  it("carries the flags byte through verbatim (an unsampled 00)", () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-00`)?.flags).toBe("00");
  });

  it("returns undefined for an absent header", () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
  });

  it("rejects the wrong field count", () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-01-extra`)).toBeUndefined();
  });

  it("rejects an unsupported version (a future format we will not guess)", () => {
    expect(parseTraceparent(`01-${TRACE}-${PARENT}-01`)).toBeUndefined();
    expect(parseTraceparent(`ff-${TRACE}-${PARENT}-01`)).toBeUndefined();
  });

  it("rejects a malformed trace id (wrong width, non-hex, uppercase)", () => {
    expect(parseTraceparent(`00-abc-${PARENT}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${"g".repeat(32)}-${PARENT}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE.toUpperCase()}-${PARENT}-01`)).toBeUndefined();
  });

  it("rejects the all-zero trace id sentinel", () => {
    expect(parseTraceparent(`00-${"0".repeat(32)}-${PARENT}-01`)).toBeUndefined();
  });

  it("rejects a malformed parent id (wrong width, non-hex)", () => {
    expect(parseTraceparent(`00-${TRACE}-abc-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE}-${"z".repeat(16)}-01`)).toBeUndefined();
  });

  it("rejects the all-zero parent id sentinel", () => {
    expect(parseTraceparent(`00-${TRACE}-${"0".repeat(16)}-01`)).toBeUndefined();
  });

  it("rejects a malformed flags byte", () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-1`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-zz`)).toBeUndefined();
  });
});

describe("formatTraceparent", () => {
  it("formats a spec-valid 00 header, sampled by default", () => {
    expect(formatTraceparent(TRACE, PARENT)).toBe(`00-${TRACE}-${PARENT}-01`);
  });

  it("truncates a 32-hex Volo spanId to the 16-hex parent-id field", () => {
    const spanId = "b".repeat(32);

    expect(formatTraceparent(TRACE, spanId)).toBe(`00-${TRACE}-${"b".repeat(16)}-01`);
  });

  it("truncates an over-width traceId to 32 hex", () => {
    const wide = "a".repeat(40);

    expect(formatTraceparent(wide, PARENT)).toBe(`00-${"a".repeat(32)}-${PARENT}-01`);
  });

  it("honours an explicit flags byte", () => {
    expect(formatTraceparent(TRACE, PARENT, "00")).toBe(`00-${TRACE}-${PARENT}-00`);
  });

  it("round-trips: a formatted header parses back to the same ids", () => {
    const header = formatTraceparent(TRACE, "b".repeat(32));

    const parsed = parseTraceparent(header);

    expect(parsed?.traceId).toBe(TRACE);
    expect(parsed?.parentId).toBe("b".repeat(16));
  });
});

describe("TRACEPARENT_HEADER", () => {
  it("is the lowercase canonical header name", () => {
    expect(TRACEPARENT_HEADER).toBe("traceparent");
  });
});
