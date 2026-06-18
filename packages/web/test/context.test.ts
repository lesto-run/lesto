import { describe, expect, it } from "vitest";

import { currentContext, currentRequestSpan, runWithContext } from "../src/index";

import type { RequestContext, RequestContextSpan } from "../src/index";

/** A minimal span standing in for `@volo/observability`'s `Span`, structurally. */
function fakeSpan(): RequestContextSpan {
  return {
    data: { traceId: "t".repeat(32), spanId: "s".repeat(32) },
    setAttribute: () => undefined,
    setStatus: () => undefined,
    end: () => undefined,
  };
}

describe("request context", () => {
  it("exposes the active context inside runWithContext", () => {
    const context: RequestContext = { requestId: "abc", ip: "1.2.3.4", protocol: "https" };

    const seen = runWithContext(context, () => currentContext());

    expect(seen).toBe(context);
    expect(seen?.requestId).toBe("abc");
  });

  it("returns undefined outside any request", () => {
    expect(currentContext()).toBeUndefined();
  });

  it("returns the value the callback produced", () => {
    const result = runWithContext({ requestId: "x" }, () => 42);

    expect(result).toBe(42);
  });

  it("carries the context across an await", async () => {
    const seen = await runWithContext({ requestId: "deep" }, async () => {
      await Promise.resolve();

      return currentContext()?.requestId;
    });

    expect(seen).toBe("deep");
  });

  it("tears the context down after the call — no leak to the next caller", () => {
    runWithContext({ requestId: "first" }, () => {
      expect(currentContext()?.requestId).toBe("first");
    });

    // Outside the run, the context is gone — not lingering as "first".
    expect(currentContext()).toBeUndefined();
  });

  it("isolates two interleaved requests — neither sees the other's context", async () => {
    // Two requests share the event loop (the long-lived-worker hazard). Each
    // yields at an await; we capture what each observes *after* the other has
    // also entered its run. If the store leaked, the later run would clobber the
    // earlier one's view. AsyncLocalStorage keeps them strictly separate.
    const release: { resolve?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      release.resolve = resolve;
    });

    const a = runWithContext({ requestId: "A" }, async () => {
      // Park inside A's context until B has also entered its own run.
      await gate;

      return currentContext()?.requestId;
    });

    const b = runWithContext({ requestId: "B" }, async () => {
      // B opens its context, then lets A proceed; both are now in flight.
      release.resolve?.();

      await Promise.resolve();

      return currentContext()?.requestId;
    });

    const [seenA, seenB] = await Promise.all([a, b]);

    expect(seenA).toBe("A");
    expect(seenB).toBe("B");
  });

  it("exposes the request span inside the context, and undefined outside one", () => {
    const span = fakeSpan();

    const seen = runWithContext({ requestId: "traced", span }, () => currentRequestSpan());

    expect(seen).toBe(span);

    // Outside any request — no context, no span.
    expect(currentRequestSpan()).toBeUndefined();
  });

  it("returns undefined for the span when the context has no tracer wired", () => {
    const seen = runWithContext({ requestId: "untraced" }, () => currentRequestSpan());

    expect(seen).toBeUndefined();
  });

  it("supports the extensible store via the index signature", () => {
    const seen = runWithContext({ requestId: "ext" }, () => {
      const context = currentContext();

      // A feature stashes its own key without the type having to enumerate it.
      if (context !== undefined) {
        context["user"] = { id: 7 };
      }

      return currentContext()?.["user"];
    });

    expect(seen).toEqual({ id: 7 });
  });
});
