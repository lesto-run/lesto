import { describe, expect, it } from "vitest";

import { assembleContext } from "../src/ai-context";
import type { ContextSnapshot } from "../src/ai-context";

/**
 * The read-only context assembler (ADR 0033 Inc 4a).
 *
 * `assembleContext` is a pure, total transform: it builds the bounded typed payload the
 * overlay + bridge share, degrading gracefully when a page exposes only the route, and
 * carrying ONLY the four permitted fields (a positive field allowlist enforced by explicit
 * construction, so an unmodelled snapshot key can never leak to the model).
 */

describe("assembleContext", () => {
  it("carries every field when the full snapshot is present", () => {
    const snapshot: ContextSnapshot = {
      route: "/posts/1",
      handlerLocation: "app/routes/posts/[id]/page.tsx:12",
      traceId: "trace-abc",
      collections: ["posts", "authors"],
    };

    expect(assembleContext(snapshot)).toEqual({
      route: "/posts/1",
      handlerLocation: "app/routes/posts/[id]/page.tsx:12",
      traceId: "trace-abc",
      collections: ["posts", "authors"],
    });
  });

  it("degrades to route-only when the page exposes no handler location, trace, or collections", () => {
    const payload = assembleContext({ route: "/about" });

    // Only the required route survives; the optional fields are OMITTED (not `undefined`-stamped).
    expect(payload).toEqual({ route: "/about" });
    expect("handlerLocation" in payload).toBe(false);
    expect("traceId" in payload).toBe(false);
    expect("collections" in payload).toBe(false);
  });

  it("carries the handler location alone when only data-lesto-loc is present", () => {
    const payload = assembleContext({ route: "/x", handlerLocation: "app/routes/x/page.tsx:3" });

    expect(payload).toEqual({ route: "/x", handlerLocation: "app/routes/x/page.tsx:3" });
  });

  it("carries the trace id alone when only a request trace is present", () => {
    const payload = assembleContext({ route: "/x", traceId: "t-9" });

    expect(payload).toEqual({ route: "/x", traceId: "t-9" });
  });

  it("carries an empty collections list distinctly from an absent one", () => {
    // An app with the content tool wired but no collections yields `[]` — present-but-empty,
    // which must survive as `collections: []`, not degrade to absent.
    const payload = assembleContext({ route: "/x", collections: [] });

    expect(payload.collections).toEqual([]);
    expect("collections" in payload).toBe(true);
  });

  it("copies ONLY the allowlisted fields — an unmodelled snapshot key never leaks", () => {
    // A raw snapshot could carry an extra field at runtime; the explicit field-by-field
    // construction must drop it, so it can never ride out to the model.
    const rogue = {
      route: "/x",
      handlerLocation: "app/routes/x/page.tsx:1",
      cookie: "session=secret",
      env: { AWS_SECRET_ACCESS_KEY: "leak" },
    } as unknown as ContextSnapshot;

    const payload = assembleContext(rogue);

    expect(payload).toEqual({ route: "/x", handlerLocation: "app/routes/x/page.tsx:1" });
    expect("cookie" in payload).toBe(false);
    expect("env" in payload).toBe(false);
  });
});
