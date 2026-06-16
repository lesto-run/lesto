import { describe, expect, it, vi } from "vitest";

import {
  CLIENT_ERRORS_ROUTE,
  clientErrorsHandler,
  defaultClientErrorSink,
  MAX_CLIENT_ERROR_BYTES,
  normalizeClientError,
} from "../src/client-errors";
import type { ClientErrorEvent } from "../src/client-errors";
import { Context } from "../src/handler-context";
import type { AnyKeelResponse, KeelRequest } from "../src/types";

/** Build a Context around a POST body, the way a route handler receives it. */
function postContext(body: unknown): Context {
  const request: KeelRequest = {
    method: "POST",
    path: CLIENT_ERRORS_ROUTE,
    params: {},
    query: {},
    headers: {},
    body,
  };

  return new Context(request);
}

/**
 * Invoke the handler with no middleware `next` — a terminal handler ignores it.
 *
 * The handler is synchronous and always answers, so the result is a concrete
 * {@link AnyKeelResponse}; we narrow the wide `Handler` return for the assertions.
 */
function call(handler: ReturnType<typeof clientErrorsHandler>, body: unknown): AnyKeelResponse {
  return handler(postContext(body), () => {
    throw new Error("next must not be called");
  }) as AnyKeelResponse;
}

describe("normalizeClientError", () => {
  it("reads the component lists and derives counts from them when none are given", () => {
    expect(normalizeClientError({ failed: ["Cart"], missing: ["Nav", "Footer"] })).toEqual({
      failed: ["Cart"],
      missing: ["Nav", "Footer"],
      failedCount: 1,
      missingCount: 2,
    });
  });

  it("uses explicit counts when present (the client sampled or truncated the lists)", () => {
    expect(
      normalizeClientError({ failed: ["Cart"], missing: [], failedCount: 9, missingCount: 3 }),
    ).toEqual({ failed: ["Cart"], missing: [], failedCount: 9, missingCount: 3 });
  });

  it("drops non-string entries and treats a non-array list as empty (lenient)", () => {
    expect(normalizeClientError({ failed: ["Cart", 7, null], missing: "nope" })).toEqual({
      failed: ["Cart"],
      missing: [],
      failedCount: 1,
      missingCount: 0,
    });
  });

  it("rejects garbage counts and falls back to the list length", () => {
    expect(
      normalizeClientError({
        failed: ["A"],
        missing: [],
        failedCount: -3,
        missingCount: Number.NaN,
      }),
    ).toMatchObject({ failedCount: 1, missingCount: 0 });
  });

  it("floors a fractional count", () => {
    expect(normalizeClientError({ failed: [], missing: [], failedCount: 2.9 })).toMatchObject({
      failedCount: 2,
    });
  });

  it("yields empty lists and zero counts for an empty body", () => {
    expect(normalizeClientError({})).toEqual({
      failed: [],
      missing: [],
      failedCount: 0,
      missingCount: 0,
    });
  });
});

describe("defaultClientErrorSink", () => {
  it("writes one structured, PII-free JSON line", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const event: ClientErrorEvent = {
      failed: ["Cart"],
      missing: ["Nav"],
      failedCount: 1,
      missingCount: 1,
    };

    defaultClientErrorSink(event);

    expect(JSON.parse(errorSpy.mock.calls[0]?.[0] as string)).toEqual({
      level: "error",
      event: "client.island_error",
      failed: ["Cart"],
      missing: ["Nav"],
      failed_count: 1,
      missing_count: 1,
    });

    errorSpy.mockRestore();
  });
});

describe("clientErrorsHandler", () => {
  it("normalizes a beacon, forwards it to the sink, and answers a bodiless 204", () => {
    const seen: ClientErrorEvent[] = [];

    const handler = clientErrorsHandler((event) => seen.push(event));

    const response = call(handler, { failed: ["Cart"], missing: [] });

    expect(response).toEqual({ status: 204, headers: {}, body: "" });
    expect(seen).toEqual([{ failed: ["Cart"], missing: [], failedCount: 1, missingCount: 0 }]);
  });

  it("refuses a non-object body with a 400, never reaching the sink", () => {
    const seen: ClientErrorEvent[] = [];

    const handler = clientErrorsHandler((event) => seen.push(event));

    expect(call(handler, "not-an-object")).toMatchObject({ status: 400 });
    expect(call(handler, ["array"])).toMatchObject({ status: 400 });
    expect(call(handler, null)).toMatchObject({ status: 400 });

    expect(seen).toEqual([]);
  });

  it("refuses an oversized beacon with a coded 413, never reaching the sink", () => {
    const seen: ClientErrorEvent[] = [];

    const handler = clientErrorsHandler((event) => seen.push(event));

    // A `failed` list whose JSON form is over the cap.
    const huge = { failed: ["x".repeat(MAX_CLIENT_ERROR_BYTES + 100)], missing: [] };

    const response = call(handler, huge);

    expect(response.status).toBe(413);
    expect(response.headers["x-keel-error"]).toBe("WEB_CLIENT_ERROR_BODY_TOO_LARGE");
    expect(seen).toEqual([]);
  });

  it("accepts a beacon right at the size boundary", () => {
    const seen: ClientErrorEvent[] = [];

    const handler = clientErrorsHandler((event) => seen.push(event));

    // Comfortably under the cap — proves the bound is a ceiling, not a floor.
    const response = call(handler, { failed: ["Cart"], missing: ["Nav"] });

    expect(response.status).toBe(204);
    expect(seen).toHaveLength(1);
  });

  it("treats an un-serializable body as size-zero, then refuses it as a non-object only if it is one", () => {
    const seen: ClientErrorEvent[] = [];

    const handler = clientErrorsHandler((event) => seen.push(event));

    // A circular object cannot serialize: jsonByteLength returns undefined, so the
    // size check is skipped — but it IS a plain object, so it normalizes (its
    // own enumerable string lists, none here) and the sink receives an empty event.
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    const response = call(handler, circular);

    expect(response.status).toBe(204);
    expect(seen).toEqual([{ failed: [], missing: [], failedCount: 0, missingCount: 0 }]);
  });

  it("treats a body that serializes to undefined (a non-object) as a 400", () => {
    const seen: ClientErrorEvent[] = [];

    const handler = clientErrorsHandler((event) => seen.push(event));

    // `undefined` JSON-serializes to the literal `undefined` (size 0), then fails
    // the object guard — a 400, never the sink.
    expect(call(handler, undefined).status).toBe(400);
    expect(seen).toEqual([]);
  });
});
